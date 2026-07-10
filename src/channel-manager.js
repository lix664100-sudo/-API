import { randomUUID } from "node:crypto";
import { ChatplusClient } from "./channels/chatplus.js";
import { DrawingClient } from "./channels/drawing.js";
import { getTask, listTasks, loadConfig, updateAccountStatus, upsertTask } from "./storage.js";

const CHAT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_CHAT_TASKS = 1;
const MAX_CONCURRENT_DRAWING_TASKS = 3;
const MAX_CONCURRENT_CHAT_IMAGE_TASKS = 1;
const chatAccountQueues = new Map();
const scheduledChatTasks = new Set();
const activeTaskCounts = { chat: 0, drawingImage: 0, chatImage: 0 };

function taskSlotLimit(slot) {
  if (slot === "chat") return MAX_CONCURRENT_CHAT_TASKS;
  if (slot === "chatImage") return MAX_CONCURRENT_CHAT_IMAGE_TASKS;
  return MAX_CONCURRENT_DRAWING_TASKS;
}

function taskSlotLabel(slot) {
  if (slot === "chat") return "对话";
  if (slot === "chatImage") return "聊天生图";
  return "生图站";
}

function targetTaskSlot(target, taskType = "text2img") {
  if (taskType === "chat") return "chat";
  return target?.channel?.type === "chatplus" ? "chatImage" : "drawingImage";
}

function busyTaskError(slot) {
  const error = new Error(`${taskSlotLabel(slot)}任务正在处理中，请稍后再试。`);
  error.status = 429;
  error.busy = true;
  return error;
}

function tryReserveTaskSlot(slot) {
  const max = taskSlotLimit(slot);
  if (activeTaskCounts[slot] >= max) return null;
  activeTaskCounts[slot] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTaskCounts[slot] = Math.max(0, activeTaskCounts[slot] - 1);
  };
}

function reserveTaskSlot(slot) {
  const release = tryReserveTaskSlot(slot);
  if (!release) throw busyTaskError(slot);
  return release;
}

async function withTaskSlot(type, work) {
  const release = reserveTaskSlot(type);
  try {
    return await work();
  } finally {
    release();
  }
}

function getClient(config, channel, account) {
  if (channel.type === "chatplus") return new ChatplusClient({ config, channel, account });
  if (channel.type === "drawing") return new DrawingClient({ config, channel, account });
  throw new Error(`未知渠道：${channel.type}`);
}

function isPendingTask(status) {
  return ["processing", "queued", "pending", "unknown"].includes(status);
}

function isFinishedTask(status) {
  return ["success", "failed", "cancelled"].includes(status);
}

function needsTaskRefresh(task) {
  return isPendingTask(task.status) || (task.status === "failed" && !task.errorMessage);
}

function accountCooling(account) {
  const until = Date.parse(account?.cooldownUntil || "");
  return Number.isFinite(until) && until > Date.now();
}

function cooldownRemainingText(cooldownUntil) {
  const ms = Math.max(0, Date.parse(cooldownUntil || "") - Date.now());
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} 分钟`;
}

function cooldownError(account) {
  const error = new Error(`聊天账号正在冷却，约 ${cooldownRemainingText(account.cooldownUntil)} 后再试。`);
  error.status = 429;
  return error;
}

function isChatBlockedError(error) {
  const text = `${error?.message || ""} ${error?.code || ""} ${error?.status || ""}`;
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|其他设备登|ssl\/tls|schannel|handshake|connection closed|connection timed out|server closed abruptly|close_notify|econnreset|etimedout|err_connection_closed/i.test(text);
}

function isChatLoginStateText(text) {
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|其他设备登/i.test(String(text || ""));
}

function readableChatFailure(attempts) {
  const details = attemptErrorMessage(attempts);
  if (isChatLoginStateText(details)) {
    return "聊天站登录状态没有完整通过，系统已自动重新登录并换车，但仍然失败。请先检测聊天账号，或稍后再试。";
  }
  return `所有对话渠道都失败：${details}`;
}

async function markChatCooldown(accountId, error) {
  const cooldownUntil = new Date(Date.now() + CHAT_COOLDOWN_MS).toISOString();
  await updateAccountStatus(accountId, {
    status: "error",
    cooldownUntil,
    message: isChatLoginStateText(error?.message)
      ? `聊天站登录状态被上游拒绝，已冷却到 ${cooldownUntil}，系统稍后会自动再试。`
      : `上游拒绝或断开，已冷却到 ${cooldownUntil}。${error?.message || ""}`.trim()
  });
}

function queueChatForAccount(accountId, work) {
  const previous = chatAccountQueues.get(accountId) || Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const tail = run.catch(() => {}).finally(() => {
    if (chatAccountQueues.get(accountId) === tail) chatAccountQueues.delete(accountId);
  });
  chatAccountQueues.set(accountId, tail);
  return run;
}

function firstAccountForChannel(config, channelId) {
  return config.accounts
    .filter((account) => account.enabled !== false && account.channelId === channelId)
    .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99))[0];
}

function inferRefreshTarget(config, task) {
  let channel = config.channels.find((item) => item.id === task.channelId);
  if (!channel && task.channelType) {
    channel = config.channels.find((item) => item.type === task.channelType && item.enabled !== false);
  }
  if (!channel && (task.taskType || task.raw?.task_type || task.taskNo || task.raw?.task_no)) {
    channel = config.channels.find((item) => item.type === "drawing" && item.enabled !== false);
  }
  if (!channel) throw new Error("找不到这个任务所属的渠道。");

  let account = config.accounts.find((item) => item.id === task.accountId);
  if (!account) account = firstAccountForChannel(config, channel.id);
  if (!account) throw new Error("这个渠道还没有可用账号。");
  return { channel, account };
}

function taskExternalId(task) {
  return task.externalId || task.raw?.id || task.id || task.raw?.task_id || task.taskNo || task.raw?.task_no;
}

function taskErrorMessage(result, task) {
  const itemError = (result.raw?.items || [])
    .map((item) => item?.error_message || item?.message || "")
    .filter(Boolean)
    .join("；");
  return result.errorMessage || itemError || task.errorMessage || "";
}

async function markAccountAvailable(accountId) {
  await updateAccountStatus(accountId, {
    status: "ok",
    message: "最近调用成功",
    cooldownUntil: null
  });
}

function mergeRefreshedTask(task, result, channel, account) {
  const status = result.status || task.status;
  return {
    ...task,
    externalId: result.externalId || task.externalId,
    taskNo: result.taskNo || task.taskNo,
    status,
    prompt: result.prompt || task.prompt,
    taskType: result.taskType || task.taskType,
    modelId: result.modelId ?? task.modelId,
    ratio: result.ratio || task.ratio,
    imageCount: result.imageCount ?? task.imageCount,
    imageUrls: result.imageUrls || task.imageUrls || [],
    errorMessage: taskErrorMessage(result, task),
    channelId: task.channelId || channel.id,
    channelName: task.channelName || channel.name,
    channelType: task.channelType || channel.type,
    accountId: task.accountId || account.id,
    accountName: task.accountName || account.name,
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : task.completedAt || null,
    requestJson: task.requestJson || null,
    responseJson: taskResponseJson(result),
    raw: result.raw || task.raw || result
  };
}

export async function refreshTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");
  if (!needsTaskRefresh(task)) return task;

  const config = await loadConfig();
  const { channel, account } = inferRefreshTarget(config, task);
  const client = getClient(config, channel, account);
  if (typeof client.getTask !== "function") return task;

  const externalId = taskExternalId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) return task;

  const result = await client.getTask(externalId);
  const nextTask = mergeRefreshedTask(task, result, channel, account);
  await upsertTask(nextTask);
  return nextTask;
}

function isLostLocalChatTask(task) {
  return task.taskType === "chat" && isPendingTask(task.status) && task.raw?.queued && !scheduledChatTasks.has(task.id);
}

async function failLostLocalChatTask(task) {
  return failQueuedTask(task, new Error("这个旧对话任务已经没有后台执行进程，已停止。"), task.attempts || []);
}

export async function refreshProcessingTasks() {
  const tasks = await listTasks();
  const results = [];
  for (const task of tasks.filter(needsTaskRefresh)) {
    try {
      if (isLostLocalChatTask(task)) {
        results.push({ id: task.id, ok: true, data: await failLostLocalChatTask(task) });
        continue;
      }
      results.push({ id: task.id, ok: true, data: await refreshTask(task.id) });
    } catch (error) {
      results.push({ id: task.id, ok: false, message: error.message });
    }
  }
  return results;
}

function selectTargets(config, requestedChannel = "auto", taskType = "text2img", options = {}) {
  const channels = config.channels
    .filter((channel) => channel.enabled !== false)
    .filter((channel) => requestedChannel === "auto" || channel.id === requestedChannel)
    .filter((channel) => !(taskType === "chat" && channel.type === "drawing"))
    .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));

  const targets = [];
  for (const channel of channels) {
    const accounts = config.accounts
      .filter((account) => account.enabled !== false && account.channelId === channel.id)
      .filter((account) => channel.type !== "chatplus" || options.includeCooling || !accountCooling(account))
      .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
    for (const account of accounts) targets.push({ channel, account });
  }
  return targets;
}

function noChatTargetsError(config, requestedChannel) {
  const allTargets = selectTargets(config, requestedChannel, "chat", { includeCooling: true });
  const cooling = allTargets.find((target) => accountCooling(target.account));
  return cooling ? cooldownError(cooling.account) : new Error("没有可用的对话渠道或账号。");
}

function wrapTask({ result, channel, account, attempts, requestJson = null }) {
  const status = result.status || "unknown";
  return {
    id: `task-${randomUUID()}`,
    externalId: result.externalId,
    status,
    prompt: result.prompt,
    taskType: result.taskType,
    modelId: result.modelId,
    ratio: result.ratio,
    imageCount: result.imageCount,
    imageUrls: result.imageUrls || [],
    errorMessage: taskErrorMessage(result, {}),
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    attempts,
    requestJson,
    responseJson: taskResponseJson(result),
    completedAt: isFinishedTask(status) ? new Date().toISOString() : null,
    raw: result.raw || result
  };
}

function attemptErrorMessage(attempts) {
  return attempts.map((item) => `${item.channelName}/${item.accountName}：${item.message}`).join("；");
}

function sameTarget(left, right) {
  return left?.channel?.id === right?.channel?.id && left?.account?.id === right?.account?.id;
}

function targetBusyAttempt(target, taskType) {
  const slot = targetTaskSlot(target, taskType);
  return {
    channelId: target.channel.id,
    channelName: target.channel.name,
    accountId: target.account.id,
    accountName: target.account.name,
    message: busyTaskError(slot).message,
    busy: true
  };
}

function reserveFirstAvailableTarget(targets, taskType) {
  const attempts = [];
  for (const target of targets) {
    const slot = targetTaskSlot(target, taskType);
    const release = tryReserveTaskSlot(slot);
    if (release) return { target, release, attempts };
    attempts.push(targetBusyAttempt(target, taskType));
  }
  const error = new Error(`所有渠道都忙，请稍后再试：${attemptErrorMessage(attempts)}`);
  error.status = 429;
  error.busy = true;
  error.attempts = attempts;
  throw error;
}

function orderedTargets(targets, reserved) {
  if (!reserved?.target) return targets;
  return [
    reserved.target,
    ...targets.filter((target) => !sameTarget(target, reserved.target))
  ];
}

function allAttemptsBusy(attempts) {
  return attempts.length > 0 && attempts.every((item) => item.busy);
}

function targetsFailedError(attempts) {
  const error = new Error(
    allAttemptsBusy(attempts)
      ? `所有渠道都忙，请稍后再试：${attemptErrorMessage(attempts)}`
      : `所有渠道都失败：${attemptErrorMessage(attempts)}`
  );
  if (allAttemptsBusy(attempts)) {
    error.status = 429;
    error.busy = true;
  }
  return error;
}

function cleanPrompt(input) {
  return String(input?.prompt || "").trim();
}

function imageFiles(inputFiles) {
  return Array.isArray(inputFiles) ? inputFiles.filter(Boolean) : inputFiles ? [inputFiles] : [];
}

function assertImageFileCount(files, maxFiles = 3) {
  if (!files.length) {
    const error = new Error("请上传源图。");
    error.status = 400;
    throw error;
  }
  if (files.length > maxFiles) {
    const error = new Error(`最多只能上传 ${maxFiles} 张源图。`);
    error.status = 400;
    throw error;
  }
}

function contentPartText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.image_url || part.type === "image_url") return "";
  return String(part.text || part.content || "").trim();
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(contentPartText).filter(Boolean).join("\n").trim();
  return contentPartText(content);
}

function chatImageCount(input = {}) {
  const uploaded = imageFiles(input.files || input.file).length;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  let embedded = 0;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    embedded += content.filter((part) => part?.image_url || part?.type === "image_url").length;
  }
  return uploaded + embedded;
}

function chatPreviewUrls(input = {}) {
  return imageFiles(input.files || input.file)
    .map((file) => file.previewUrl || "")
    .filter(Boolean);
}

function cleanChatPrompt(input = {}) {
  const direct = String(input.message || input.prompt || input.content || "").trim();
  if (direct) return direct;
  if (Array.isArray(input.messages)) {
    const text = input.messages.map(messageText).filter(Boolean).join("\n").trim();
    if (text) return text;
  }
  return chatImageCount(input) ? "图片对话" : "";
}

function assertChatInput(input = {}) {
  if (chatImageCount(input) > 5) {
    const error = new Error("对话最多只能上传 5 张图片。");
    error.status = 400;
    throw error;
  }
  if (!cleanChatPrompt(input)) {
    const error = new Error("请输入对话内容，或上传图片。");
    error.status = 400;
    throw error;
  }
}

function jsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "function") return undefined;
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Uint8Array) return `[${item.constructor.name} ${item.byteLength} bytes]`;
      return item;
    }));
  } catch {
    return String(value);
  }
}

function taskFileJson(file) {
  return {
    filename: file?.filename || file?.name || "",
    mimetype: file?.mimetype || file?.type || "",
    previewUrl: file?.previewUrl || ""
  };
}

function taskRequestJson(input = {}) {
  const { file, files, ...fields } = input || {};
  const requestJson = jsonValue(fields) || {};
  const fileItems = imageFiles(files || file).map(taskFileJson);
  if (fileItems.length) requestJson.files = fileItems;
  return requestJson;
}

function taskResponseJson(value = {}) {
  return jsonValue(value) || {};
}

function queuedTask({ input, target, taskType, prompt, imageCount, inputImageUrls, raw }) {
  return {
    id: `task-${randomUUID()}`,
    status: "processing",
    prompt: prompt ?? cleanPrompt(input),
    taskType,
    modelId: input.model_id || input.modelId || "",
    ratio: input.ratio_label || input.ratio || "",
    imageCount: imageCount ?? Number(input.image_count || input.n || 1),
    imageUrls: [],
    inputImageUrls: inputImageUrls || [],
    errorMessage: "",
    channelId: target.channel.id,
    channelName: target.channel.name,
    channelType: target.channel.type,
    accountId: target.account.id,
    accountName: target.account.name,
    attempts: [],
    requestJson: taskRequestJson(input),
    responseJson: null,
    raw: { queued: true, ...(raw || {}) },
    completedAt: null,
    createdAt: new Date().toISOString()
  };
}

function readableAttemptError(attempts) {
  return attempts.map((item) => `${item.channelName}/${item.accountName}：${item.message}`).join("；");
}

async function failQueuedTask(task, error, attempts = []) {
  const responseMessage = error.message || readableAttemptError(attempts) || "任务失败";
  const failedTask = {
    ...task,
    status: "failed",
    errorMessage: error.message || readableAttemptError(attempts) || "任务失败",
    attempts,
    responseJson: {
      ok: false,
      message: responseMessage,
      attempts: taskResponseJson(attempts)
    },
    completedAt: new Date().toISOString()
  };
  await upsertTask(failedTask);
  return failedTask;
}

async function finishQueuedTask(task, result, channel, account, attempts) {
  const status = result.status || task.status;
  const nextTask = {
    ...wrapTask({ result, channel, account, attempts, requestJson: task.requestJson }),
    id: task.id,
    status,
    createdAt: task.createdAt,
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : null
  };
  await upsertTask(nextTask);
  await markAccountAvailable(account.id);
  return nextTask;
}

async function runQueuedTextTask(task, input, reserved = null) {
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "text2img");
  const attempts = [...(reserved?.attempts || [])];
  let reservedRelease = reserved?.release || null;
  try {
    for (const target of orderedTargets(targets, reserved)) {
      const { channel, account } = target;
      let release = null;
      const usingReserved = reservedRelease && sameTarget(target, reserved?.target);
      if (usingReserved) {
        release = reservedRelease;
        reservedRelease = null;
      } else {
        release = tryReserveTaskSlot(targetTaskSlot(target, "text2img"));
        if (!release) {
          attempts.push(targetBusyAttempt(target, "text2img"));
          continue;
        }
      }
      try {
        const client = getClient(config, channel, account);
        let result = await client.createTextTask(input);
        if (channel.type === "drawing" && !isFinishedTask(result.status)) {
          result = await client.waitForTask(result.externalId);
        }
        return finishQueuedTask(task, result, channel, account, attempts);
      } catch (error) {
        attempts.push({
          channelId: channel.id,
          channelName: channel.name,
          accountId: account.id,
          accountName: account.name,
          message: error.message || "调用失败"
        });
        if (!error.busy) {
          await updateAccountStatus(account.id, {
            status: "error",
            message: error.message || "调用失败"
          });
        }
      } finally {
        release();
      }
    }
  } finally {
    if (reservedRelease) reservedRelease();
  }
  return failQueuedTask(task, targetsFailedError(attempts), attempts);
}

async function submitImageTask(client, input, files) {
  if (typeof client.createImageTask !== "function") {
    throw new Error("This channel does not support image editing.");
  }
  if (typeof client.uploadImage !== "function") {
    return client.createImageTask({ ...input, files });
  }
  const uploads = [];
  for (const file of files) uploads.push(await client.uploadImage(file));
  return client.createImageTask({
    ...input,
    source_upload_ids: uploads.map((upload) => upload.uploadId)
  });
}

async function runQueuedImageTask(task, input, files, reserved = null) {
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "img2img");
  const attempts = [...(reserved?.attempts || [])];
  let reservedRelease = reserved?.release || null;
  try {
    for (const target of orderedTargets(targets, reserved)) {
      const { channel, account } = target;
      let release = null;
      const usingReserved = reservedRelease && sameTarget(target, reserved?.target);
      if (usingReserved) {
        release = reservedRelease;
        reservedRelease = null;
      } else {
        release = tryReserveTaskSlot(targetTaskSlot(target, "img2img"));
        if (!release) {
          attempts.push(targetBusyAttempt(target, "img2img"));
          continue;
        }
      }
      try {
        const client = getClient(config, channel, account);
        let result = await submitImageTask(client, input, files);
        if (channel.type === "drawing" && !isFinishedTask(result.status)) {
          result = await client.waitForTask(result.externalId);
        }
        return finishQueuedTask(task, result, channel, account, attempts);
      } catch (error) {
        attempts.push({
          channelId: channel.id,
          channelName: channel.name,
          accountId: account.id,
          accountName: account.name,
          message: error.message || "调用失败"
        });
        if (!error.busy) {
          await updateAccountStatus(account.id, {
            status: "error",
            message: error.message || "调用失败"
          });
        }
      } finally {
        release();
      }
    }
  } finally {
    if (reservedRelease) reservedRelease();
  }
  return failQueuedTask(task, targetsFailedError(attempts), attempts);
}

async function finishChatTask(task, result, channel, account, attempts, responseJson = null) {
  const nextTask = {
    ...task,
    externalId: result.externalId || task.externalId,
    status: "success",
    taskType: "chat",
    modelId: result.model || task.modelId || "",
    imageCount: result.raw?.imageCount ?? task.imageCount ?? 0,
    imageUrls: result.imageUrls || task.imageUrls || [],
    inputImageUrls: task.inputImageUrls || [],
    responseText: result.content || "",
    errorMessage: "",
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    attempts,
    responseJson: responseJson || chatCompletionResponseJson({ result, channel }),
    completedAt: new Date().toISOString(),
    raw: result.raw || result
  };
  await upsertTask(nextTask);
  await markAccountAvailable(account.id);
  return nextTask;
}

async function runChatCompletionTask(task, input) {
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "chat");
  const attempts = [];
  if (!targets.length) {
    const error = noChatTargetsError(config, requestedChannel);
    error.task = await failQueuedTask(task, error, attempts);
    throw error;
  }
  for (const target of targets) {
    const { channel, account } = target;
    try {
      const client = getClient(config, channel, account);
      if (typeof client.createChatCompletion !== "function") {
        throw new Error("这个渠道暂不支持对话。");
      }
      const result = await client.createChatCompletion(input);
      const responseJson = chatCompletionResponseJson({ result, channel });
      const finishedTask = await finishChatTask(task, result, channel, account, attempts, responseJson);
      return { result, channel, account, task: finishedTask, responseJson };
    } catch (error) {
      const status = Number(error.status || error.statusCode || 0);
      attempts.push({
        channelId: channel.id,
        channelName: channel.name,
        accountId: account.id,
        accountName: account.name,
        message: error.message || "调用失败"
      });
      if (channel.type === "chatplus" && isChatBlockedError(error)) {
        await markChatCooldown(account.id, error);
      } else {
        await updateAccountStatus(account.id, {
          status: "error",
          message: error.message || "调用失败"
        });
      }
      if (status >= 400 && status < 500 && !isChatBlockedError(error)) {
        error.task = await failQueuedTask(task, error, attempts);
        throw error;
      }
    }
  }

  const error = new Error(readableChatFailure(attempts));
  error.task = await failQueuedTask(task, error, attempts);
  throw error;
}

function runInBackground(work) {
  setTimeout(() => {
    work().catch((error) => {
      console.error(error);
    });
  }, 0);
}

export async function queueTextTask(input = {}) {
  if (!cleanPrompt(input)) {
    const error = new Error("请输入生图描述。");
    error.status = 400;
    throw error;
  }
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "text2img");
  if (!targets.length) throw new Error("没有可用的文生图渠道或账号。");

  const reserved = reserveFirstAvailableTarget(targets, "text2img");
  const task = queuedTask({ input, target: reserved.target, taskType: "text2img" });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved.release();
    throw error;
  }
  runInBackground(async () => {
    await runQueuedTextTask(task, input, reserved);
  });
  return task;
}
export async function queueImageTask({ input = {}, file, files: inputFiles }) {
  if (!cleanPrompt(input)) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "img2img");
  if (!targets.length) throw new Error("图生图目前没有可用渠道。");

  const reserved = reserveFirstAvailableTarget(targets, "img2img");
  const task = queuedTask({ input: { ...input, files }, target: reserved.target, taskType: "img2img" });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved.release();
    throw error;
  }
  runInBackground(async () => {
    await runQueuedImageTask(task, input, files, reserved);
  });
  return task;
}
export async function queueChatCompletion(input = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "chat");
  if (!targets.length) throw noChatTargetsError(config, requestedChannel);

  const release = reserveTaskSlot("chat");
  const task = queuedTask({
    input,
    target: targets[0],
    taskType: "chat",
    prompt: cleanChatPrompt(input),
    imageCount: chatImageCount(input),
    inputImageUrls: chatPreviewUrls(input),
    raw: { endpoint: "/v1/chat/completions" }
  });
  try {
    await upsertTask(task);
  } catch (error) {
    release();
    throw error;
  }
  scheduledChatTasks.add(task.id);
  runInBackground(async () => {
    try {
      await queueChatForAccount(task.accountId, () => runChatCompletionTask(task, input));
    } finally {
      scheduledChatTasks.delete(task.id);
      release();
    }
  });
  return task;
}
export async function checkAccount(accountId) {
  const config = await loadConfig();
  const account = config.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("账号不存在。");
  const channel = config.channels.find((item) => item.id === account.channelId);
  if (!channel) throw new Error("账号所属渠道不存在。");
  const client = getClient(config, channel, account);
  try {
    const status = await client.check();
    const nextStatus = { ...status, cooldownUntil: null };
    await updateAccountStatus(account.id, nextStatus);
    return nextStatus;
  } catch (error) {
    const status = {
      status: "error",
      quota: null,
      balance: null,
      expireAt: "",
      message: error.message || "检测失败"
    };
    await updateAccountStatus(account.id, status);
    throw error;
  }
}

export async function checkAllAccounts() {
  const config = await loadConfig();
  const results = [];
  for (const account of config.accounts) {
    try {
      results.push({ accountId: account.id, ok: true, data: await checkAccount(account.id) });
    } catch (error) {
      results.push({ accountId: account.id, ok: false, message: error.message });
    }
  }
  return results;
}

function chatCompletionResponseJson({ result, channel }) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model || "auto",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.content
        },
        finish_reason: "stop"
      }
    ],
    usage: result.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    },
    channel: {
      id: channel.id,
      name: channel.name
    },
    raw: taskResponseJson(result.raw || {})
  };
}

function chatCompletionResponse({ result, channel, task, responseJson }) {
  return {
    ...(responseJson || chatCompletionResponseJson({ result, channel })),
    task
  };
}

export async function createChatCompletion(input = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "chat");
  if (!targets.length) throw noChatTargetsError(config, requestedChannel);

  return withTaskSlot("chat", async () => {
    const task = queuedTask({
      input,
      target: targets[0],
      taskType: "chat",
      prompt: cleanChatPrompt(input),
      imageCount: chatImageCount(input),
      inputImageUrls: chatPreviewUrls(input),
      raw: { endpoint: "/v1/chat/completions" }
    });
    await upsertTask(task);
    scheduledChatTasks.add(task.id);
    try {
      const result = await queueChatForAccount(task.accountId, () => runChatCompletionTask(task, input));
      return chatCompletionResponse(result);
    } finally {
      scheduledChatTasks.delete(task.id);
    }
  });
}
export async function createTextTask(input = {}, wait = false) {
  if (!String(input.prompt || "").trim()) {
    const error = new Error("请输入生图描述。");
    error.status = 400;
    throw error;
  }
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "text2img");
  if (!targets.length) throw new Error("没有可用的文生图渠道或账号。");

  const attempts = [];
  for (const target of targets) {
    const { channel, account } = target;
    const release = tryReserveTaskSlot(targetTaskSlot(target, "text2img"));
    if (!release) {
      attempts.push(targetBusyAttempt(target, "text2img"));
      continue;
    }
    try {
      const client = getClient(config, channel, account);
      let result = await client.createTextTask(input);
      if (wait && channel.type === "drawing") result = await client.waitForTask(result.externalId);
      const task = wrapTask({ result, channel, account, attempts, requestJson: taskRequestJson(input) });
      await upsertTask(task);
      await markAccountAvailable(account.id);
      return task;
    } catch (error) {
      attempts.push({ channelId: channel.id, channelName: channel.name, accountId: account.id, accountName: account.name, message: error.message || "调用失败" });
      if (!error.busy) await updateAccountStatus(account.id, { status: "error", message: error.message || "调用失败" });
    } finally {
      release();
    }
  }
  throw targetsFailedError(attempts);
}
export async function createImageTask({ input = {}, file, files: inputFiles, wait = false }) {
  if (!String(input.prompt || "").trim()) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = selectTargets(config, requestedChannel, "img2img");
  if (!targets.length) throw new Error("图生图目前没有可用渠道。");

  const attempts = [];
  for (const target of targets) {
    const { channel, account } = target;
    const release = tryReserveTaskSlot(targetTaskSlot(target, "img2img"));
    if (!release) {
      attempts.push(targetBusyAttempt(target, "img2img"));
      continue;
    }
    try {
      const client = getClient(config, channel, account);
      let result = await submitImageTask(client, input, files);
      if (wait && channel.type === "drawing") result = await client.waitForTask(result.externalId);
      const task = wrapTask({ result, channel, account, attempts, requestJson: taskRequestJson({ ...input, files }) });
      await upsertTask(task);
      await markAccountAvailable(account.id);
      return task;
    } catch (error) {
      attempts.push({ channelId: channel.id, channelName: channel.name, accountId: account.id, accountName: account.name, message: error.message || "调用失败" });
      if (!error.busy) await updateAccountStatus(account.id, { status: "error", message: error.message || "调用失败" });
    } finally {
      release();
    }
  }
  throw targetsFailedError(attempts);
}
