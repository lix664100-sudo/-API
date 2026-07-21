import { randomUUID } from "node:crypto";
import { ChatplusClient } from "./channels/chatplus.js";
import { DrawingClient, drawingRetryAfterSeconds, drawingSevereFailureReason } from "./channels/drawing.js";
import { mirrorImageUrls } from "./image-store.js";
import { checkProxyReachability, safeProxyEndpoint } from "./proxy.js";
import { getTask, listTasks, loadConfig, recordTaskStat, updateAccountStatus, upsertTask } from "./storage.js";

const CHAT_COOLDOWN_MS = 30 * 60 * 1000;
const defaultTaskConcurrency = { chat: 3, drawingImage: 2, chatImage: 2 };
const scheduledChatTasks = new Set();
const scheduledImageTasks = new Set();
const activeTaskCounts = new Map();
const activeAccountAuthTasks = new Map();
const activeChatplusAccountWork = new Map();
const clientCache = new Map();
const accountRoutingState = new Map();
const accountRecoveryTasks = new Map();
const accountRecoveryRetryAt = new Map();
const ACCOUNT_RECOVERY_RETRY_MS = 30 * 1000;
const DRAWING_FAILURE_LIMIT = 3;
const DRAWING_COOLDOWN_MS = 30 * 60 * 1000;
const DRAWING_SUBMIT_WAIT_TIMEOUT_SEC = 180;
let activeTaskConcurrency = { ...defaultTaskConcurrency };

function normalizeSourceTaskId(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "").trim();
  return text.slice(0, 200);
}

function sourceTaskIdFrom(value = {}) {
  const source = value || {};
  return normalizeSourceTaskId(
    source.sourceTaskId
      || source.source_task_id
      || source.clientTaskId
      || source.client_task_id
      || source.taskId
      || source.task_id
      || source.xtwTaskId
      || source.xtw_task_id
  );
}

function attachSourceTaskId(value = {}, sourceTaskId = "") {
  if (!sourceTaskId) return value;
  return {
    ...value,
    sourceTaskId,
    client_task_id: value.client_task_id || sourceTaskId
  };
}

function attachResponseSourceTaskId(value = {}, sourceTaskId = "") {
  if (!sourceTaskId || !value || typeof value !== "object") return value;
  return {
    ...value,
    sourceTaskId
  };
}

function taskRequestMeta(value = {}) {
  const sourceTaskId = sourceTaskIdFrom(value);
  return {
    callerIp: String(value.callerIp || "").trim(),
    calledAt: value.calledAt || new Date().toISOString(),
    forwardedFor: String(value.forwardedFor || "").trim(),
    ...(sourceTaskId ? { sourceTaskId } : {})
  };
}

function accountProxyValue(account = {}) {
  return account.proxyUrl || account.proxy || "";
}

function taskNetworkMeta(account = {}) {
  const endpoint = safeProxyEndpoint(accountProxyValue(account));
  const check = account.meta?.proxyCheck || {};
  const checkHost = String(check.proxyHost || "").trim();
  const sameProxy = !checkHost || !endpoint.proxyHost || checkHost === endpoint.proxyHost;
  const realIp = endpoint.proxyConfigured && sameProxy ? String(check.realIp || "").trim() : "";
  return realIp
    ? {
        ...endpoint,
        proxyLabel: realIp,
        proxyRealIp: realIp,
        proxyOriginalLabel: endpoint.proxyLabel
      }
    : endpoint;
}

function proxyCheckMeta(result) {
  return {
    status: result.ok ? "ok" : "failed",
    ip: result.realIp || "",
    realIp: result.realIp || "",
    proxyHost: result.proxyHost || "",
    proxyLabel: result.proxyLabel || "",
    checkedAt: result.checkedAt || new Date().toISOString(),
    message: result.ok ? "" : result.message || "代理不可用"
  };
}

function withProxyCheckMeta(status, proxyResult) {
  if (!proxyResult) return status;
  return {
    ...status,
    meta: {
      ...(status.meta || {}),
      proxyCheck: proxyCheckMeta(proxyResult)
    }
  };
}

function normalizeTaskConcurrency(value = {}) {
  return {
    chat: Math.min(20, Math.max(1, Number(value.chat || defaultTaskConcurrency.chat))),
    drawingImage: Math.min(20, Math.max(1, Number(value.drawingImage || defaultTaskConcurrency.drawingImage))),
    chatImage: Math.min(20, Math.max(1, Number(value.chatImage || defaultTaskConcurrency.chatImage)))
  };
}

async function loadRuntimeConfig() {
  const config = await loadConfig();
  activeTaskConcurrency = normalizeTaskConcurrency(config.concurrency);
  return config;
}

function taskSlotLimit(slot) {
  return activeTaskConcurrency[slot] || defaultTaskConcurrency[slot] || 1;
}

function activeCountForSlot(slot) {
  const prefix = `${slot}:`;
  let total = activeTaskCounts.get(slot) || 0;
  for (const [key, count] of activeTaskCounts.entries()) {
    if (String(key).startsWith(prefix)) total += count;
  }
  return total;
}

function taskConcurrencyTotal(value = {}) {
  return Number(value.chat || 0) + Number(value.drawingImage || 0) + Number(value.chatImage || 0);
}

function targetRuntimeAvailable(target, taskType) {
  if (!target?.channel || !target?.account) return false;
  if (target.channel.enabled === false || target.account.enabled === false) return false;
  if (taskType === "chat" && accountCooling(target.account)) return false;
  const status = targetQuotaStatus(target);
  if (statusCooling(status)) return false;
  return status.status === "ok" || status.status === "cooldown";
}

function runtimeTargetAccountCount(config, taskType, channelType, availableOnly = false) {
  const accountIds = selectTargets(config, "auto", taskType, { includeCooling: true })
    .filter((target) => target.channel.type === channelType)
    .filter((target) => !availableOnly || targetRuntimeAvailable(target, taskType))
    .map((target) => target.account.id);
  return new Set(accountIds).size;
}

function runtimeAccountConcurrency(config, concurrency, availableOnly = false) {
  const capacity = {
    chat: runtimeTargetAccountCount(config, "chat", "chatplus", availableOnly) * concurrency.chat,
    drawingImage: runtimeTargetAccountCount(config, "text2img", "drawing", availableOnly) * concurrency.drawingImage,
    chatImage: runtimeTargetAccountCount(config, "text2img", "chatplus", availableOnly) * concurrency.chatImage
  };
  return {
    ...capacity,
    total: taskConcurrencyTotal(capacity)
  };
}

function runtimeCategory(configured, available, running, slots) {
  const sum = (source) => slots.reduce((total, slot) => total + Number(source?.[slot] || 0), 0);
  const configuredTotal = sum(configured);
  const availableTotal = sum(available);
  const runningTotal = sum(running);
  return {
    configured: configuredTotal,
    available: availableTotal,
    running: runningTotal,
    idle: Math.max(0, availableTotal - runningTotal)
  };
}

export async function getRuntimeStatus() {
  const config = await loadConfig();
  const concurrency = normalizeTaskConcurrency(config.concurrency);
  activeTaskConcurrency = concurrency;
  const configured = runtimeAccountConcurrency(config, concurrency);
  const available = runtimeAccountConcurrency(config, concurrency, true);
  const running = {
    chat: activeCountForSlot("chat"),
    drawingImage: activeCountForSlot("drawingImage"),
    chatImage: activeCountForSlot("chatImage")
  };
  const tasks = await listTasks();
  const waiting = {
    image: tasks.filter((task) => task.status === "waiting_upstream" && task.taskType !== "chat").length,
    chat: tasks.filter((task) => task.status === "waiting_upstream" && task.taskType === "chat").length
  };
  waiting.total = waiting.image + waiting.chat;
  return {
    concurrency: {
      ...concurrency,
      total: configured.total
    },
    available: {
      ...available
    },
    running: {
      ...running,
      total: taskConcurrencyTotal(running)
    },
    categories: {
      image: runtimeCategory(configured, available, running, ["drawingImage", "chatImage"]),
      chat: runtimeCategory(configured, available, running, ["chat"])
    },
    waiting
  };
}

function taskSlotLabel(slot) {
  if (slot === "chat") return "对话";
  if (slot === "chatImage") return "聊天生图";
  return "生图站";
}

function taskSlotKey(slot, target = {}) {
  const accountId = String(target?.account?.id || "").trim();
  return accountId ? `${slot}:${accountId}` : slot;
}

function taskSlotBusyLabel(slot, target = {}) {
  const accountName = String(target?.account?.name || target?.account?.username || "").trim();
  return !accountName
    ? taskSlotLabel(slot)
    : `${accountName}的${taskSlotLabel(slot)}`;
}

function targetTaskSlot(target, taskType = "text2img") {
  if (taskType === "chat") return "chat";
  return target?.channel?.type === "chatplus" ? "chatImage" : "drawingImage";
}

function busyTaskError(slot, target = {}) {
  const error = new Error(`${taskSlotBusyLabel(slot, target)}任务正在处理中，请稍后再试。`);
  error.status = 429;
  error.busy = true;
  return error;
}

function tryReserveTaskSlot(slot, target = {}) {
  const max = taskSlotLimit(slot);
  const key = taskSlotKey(slot, target);
  const count = activeTaskCounts.get(key) || 0;
  if (count >= max) return null;
  activeTaskCounts.set(key, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (activeTaskCounts.get(key) || 0) - 1);
    if (next) activeTaskCounts.set(key, next);
    else activeTaskCounts.delete(key);
  };
}

function accountSessionKey(account = {}) {
  return [
    String(account.username || account.id || "").trim().toLowerCase(),
    String(account.proxyUrl || account.proxy || "").trim()
  ].join("::");
}

async function runChatplusAccountWork(channel, account, work, options = {}) {
  if (channel?.type !== "chatplus") return work();

  const key = accountSessionKey(account);
  const active = activeChatplusAccountWork.get(key);
  const previous = active?.promise || null;
  const blockingSlots = Array.isArray(options.blockingSlots) ? options.blockingSlots : null;
  const activeSlot = active?.slot || "";
  const shouldBlock = options.noQueue && previous && (!blockingSlots || blockingSlots.includes(activeSlot));
  if (shouldBlock) {
    throw busyTaskError(options.slot || "chatImage", { channel, account });
  }
  const previousWork = previous || Promise.resolve();
  const current = previousWork.catch(() => {}).then(work);
  activeChatplusAccountWork.set(key, {
    promise: current,
    slot: options.slot || activeSlot
  });
  try {
    return await current;
  } finally {
    if (activeChatplusAccountWork.get(key)?.promise === current) activeChatplusAccountWork.delete(key);
  }
}

async function withAccountAuthLock(account, work) {
  const key = accountSessionKey(account);
  const previous = activeAccountAuthTasks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  activeAccountAuthTasks.set(key, current);
  try {
    return await current;
  } finally {
    if (activeAccountAuthTasks.get(key) === current) activeAccountAuthTasks.delete(key);
  }
}

function clientCacheKey(channel, account) {
  return [
    channel.type,
    channel.parentId || channel.id,
    channel.ability || "",
    account.id || account.username || ""
  ].join("::");
}

function clientContext(config, channel, account) {
  return {
    config,
    channel,
    account,
    sessionLock: (work) => withAccountAuthLock(account, work)
  };
}

function getClient(config, channel, account) {
  const key = clientCacheKey(channel, account);
  const current = clientCache.get(key);
  const context = clientContext(config, channel, account);
  if (current) {
    if (typeof current.updateContext === "function") current.updateContext(context);
    return current;
  }
  let client = null;
  if (channel.type === "chatplus") client = new ChatplusClient(context);
  else if (channel.type === "drawing") client = new DrawingClient(context);
  else throw new Error(`未知渠道：${channel.type}`);
  clientCache.set(key, client);
  return client;
}

function getWorkClient(config, channel, account) {
  if (channel.type !== "chatplus") return getClient(config, channel, account);
  return new ChatplusClient({
    ...clientContext(config, channel, account),
    sessionLock: async (work) => work()
  });
}

function shareAIAbilityChannel(channel, ability) {
  const settings = channel?.settings || {};
  if (ability === "chatplus") {
    return {
      ...channel,
      id: `${channel.id}:chatplus`,
      parentId: channel.id,
      ability: "chatplus",
      name: `${channel.name}/聊天生图`,
      type: "chatplus",
      settings: {
        baseUrl: settings.chatBaseUrl || "https://www.chatplus.cc",
        defaultChatModel: settings.defaultChatModel || "gpt",
        chatModels: settings.chatModels || [],
        autoCarSelection: true,
        autoCarSelectionMigrated: true
      }
    };
  }
  return {
    ...channel,
    id: `${channel.id}:drawing`,
    parentId: channel.id,
    ability: "drawing",
    name: `${channel.name}/绘图站`,
    type: "drawing",
    settings: {
      baseUrl: settings.drawingBaseUrl || "https://drawing.aishare.icu",
      defaultModelId: Number(settings.defaultModelId || 1)
    }
  };
}

function requestedAbility(channel, requestedChannel) {
  const requested = String(requestedChannel || "");
  const legacy = channel?.settings?.legacyChannelIds || {};
  if ([legacy.drawing, "drawing", `${channel.id}:drawing`].includes(requested)) return "drawing";
  if ([legacy.chatplus, "chatplus", `${channel.id}:chatplus`].includes(requested)) return "chatplus";
  return "";
}

function shareAIAbilitiesForTask(channel, requestedChannel, taskType) {
  const requested = requestedAbility(channel, requestedChannel);
  if (requested) return [requested];
  if (taskType === "chat") return ["chatplus"];
  return ["drawing", "chatplus"];
}

function isPendingTask(status) {
  return ["processing", "queued", "pending", "unknown", "waiting_upstream"].includes(status);
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

function statusCooling(status) {
  const until = Date.parse(status?.cooldownUntil || "");
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

function isDisconnectedError(error) {
  return isChatLoginStateText([
    error?.message || "",
    error?.code || "",
    error?.status || error?.statusCode || "",
    error?.body || "",
    JSON.stringify(error?.payload || {})
  ].join(" "));
}

function isQuotaEmptyText(text) {
  return /(?:积分|余额|额度|配额).{0,18}(?:不足|不够|用完|耗尽|为\s*0|已满|上限|限制)|(?:quota|credit|balance|limit).{0,28}(?:insufficient|exhausted|empty|reached|used up)/i.test(String(text || ""));
}

function isQuotaEmptyError(error) {
  return Boolean(
    error?.quotaEmpty
      || error?.imageQuotaExhausted
      || isQuotaEmptyText(`${error?.message || ""} ${error?.body || ""} ${JSON.stringify(error?.payload || {})}`)
  );
}

function isTerminalTaskFailureError(error) {
  return Boolean(error?.upstreamExplicitFailure);
}

function accountStatusFromError(error) {
  if (isDisconnectedError(error)) {
    return {
      status: "disconnected",
      message: error?.message || "登录掉线，系统稍后会自动重登。"
    };
  }
  if (isQuotaEmptyError(error)) {
    return {
      status: "quota_empty",
      quotaResetAt: error?.quotaResetAt || "",
      message: error?.message || "额度不足"
    };
  }
  return {
    status: "error",
    message: error?.message || "调用失败"
  };
}

function readableChatFailure(attempts) {
  const details = attemptErrorMessage(attempts);
  if (isChatLoginStateText(details)) {
    return "聊天站掉线，系统已自动重登和换车，但仍然失败。请检测聊天账号，或稍后再试。";
  }
  return `所有对话渠道都失败：${details}`;
}

function channelAbilityKey(channel) {
  return channel?.parentId && channel?.ability ? channel.ability : "";
}

function combinedAbilityMessage(drawing, chatplus, fallback = "") {
  return [
    drawing?.message ? `绘图站：${drawing.message}` : "",
    chatplus?.message ? `聊天：${chatplus.message}` : ""
  ].filter(Boolean).join("；") || fallback;
}

async function updateTargetAccountStatus(accountId, channel, patch) {
  const ability = channelAbilityKey(channel);
  if (!ability) return updateAccountStatus(accountId, patch);

  const config = await loadRuntimeConfig();
  const account = config.accounts.find((item) => item.id === accountId);
  if (!account) return updateAccountStatus(accountId, patch);

  const abilities = {
    ...(account.meta?.abilities || {})
  };
  abilities[ability] = {
    ...(abilities[ability] || {}),
    ...patch,
    lastCheckAt: new Date().toISOString()
  };

  const drawing = abilities.drawing || {};
  const chatplus = abilities.chatplus || {};
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return updateAccountStatus(accountId, {
    status: disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : patch.status || account.status || "unknown",
    quota: drawing.quota ?? account.quota ?? null,
    balance: drawing.balance ?? account.balance ?? null,
    quotaResetAt: drawing.quotaResetAt || chatplus.quotaResetAt || account.quotaResetAt || "",
    expireAt: drawing.expireAt || chatplus.expireAt || account.expireAt || "",
    cooldownUntil: chatplus.cooldownUntil || null,
    message: combinedAbilityMessage(drawing, chatplus, patch.message || account.message || ""),
    meta: {
      ...(account.meta || {}),
      abilities
    }
  });
}

async function markChatCooldown(accountId, channel, error) {
  const cooldownUntil = new Date(Date.now() + CHAT_COOLDOWN_MS).toISOString();
  const disconnected = isDisconnectedError(error);
  await updateTargetAccountStatus(accountId, channel, {
    status: disconnected ? "disconnected" : "error",
    cooldownUntil,
    message: disconnected
      ? `聊天站掉线，已冷却到 ${cooldownUntil}，系统稍后会自动重登。`
      : `上游拒绝或断开，已冷却到 ${cooldownUntil}。${error?.message || ""}`.trim()
  });
}

function firstAccountForChannel(config, channelId) {
  return config.accounts
    .filter((account) => account.enabled !== false && (account.channelId === channelId || (channelId === "shareai" && account.channelId === "shareai")))
    .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99))[0];
}

function shareAIRefreshChannel(config, task) {
  const channel = config.channels.find((item) => item.type === "shareai" && item.enabled !== false)
    || config.channels.find((item) => item.type === "shareai");
  if (!channel) return null;
  const requested = task.channelId || task.channelType || "";
  const ability = requestedAbility(channel, requested) || (task.channelType === "chatplus" ? "chatplus" : task.channelType === "drawing" ? "drawing" : "");
  return ability ? shareAIAbilityChannel(channel, ability) : null;
}

function inferRefreshTarget(config, task) {
  let channel = config.channels.find((item) => item.id === task.channelId);
  if (!channel && String(task.channelId || "").startsWith("shareai:")) {
    channel = shareAIRefreshChannel(config, task);
  }
  if (!channel) {
    channel = shareAIRefreshChannel(config, task);
  }
  if (!channel && ["drawing", "chatplus"].includes(task.channelType || task.channelId)) {
    channel = shareAIRefreshChannel(config, task);
  }
  if (!channel && task.channelType) {
    channel = config.channels.find((item) => item.type === task.channelType && item.enabled !== false);
  }
  if (!channel && (task.taskType || task.raw?.task_type || task.taskNo || task.raw?.task_no)) {
    channel = config.channels.find((item) => item.type === "drawing" && item.enabled !== false) || shareAIRefreshChannel(config, { ...task, channelType: "drawing" });
  }
  if (!channel) throw new Error("找不到这个任务所属的渠道。");

  let account = config.accounts.find((item) => item.id === task.accountId);
  if (!account) account = firstAccountForChannel(config, channel.parentId || channel.id);
  if (!account) throw new Error("这个渠道还没有可用账号。");
  return { channel, account };
}

function savedTaskExternalId(task) {
  return task.externalId
    || task.raw?.id
    || task.raw?.conversationId
    || task.raw?.conversation_id
    || task.raw?.task_id
    || task.taskNo
    || task.raw?.task_no
    || "";
}

function taskExternalId(task) {
  return savedTaskExternalId(task) || task.id;
}

function taskErrorMessage(result, task) {
  const itemError = (result.raw?.items || [])
    .map((item) => item?.error_message || item?.message || "")
    .filter(Boolean)
    .join("；");
  return result.errorMessage || itemError || task.errorMessage || "";
}

function refreshedTaskWaitState(task, result, timeoutSec) {
  if (isFinishedTask(result?.status)) return result;
  const seconds = Math.min(3600, Math.max(30, Number(timeoutSec || 300)));
  const submittedAt = Date.parse(task.raw?.submittedAt || task.createdAt || "");
  const waitExpired = Number.isFinite(submittedAt) && Date.now() - submittedAt >= seconds * 1000;
  if (task.status !== "waiting_upstream" && !waitExpired) return result;
  return {
    ...result,
    status: "waiting_upstream",
    errorMessage: "",
    raw: {
      ...(result.raw || {}),
      waitingUpstream: true,
      waitingSince: task.raw?.waitingSince || new Date().toISOString()
    }
  };
}

async function mirrorTaskImages(result, config) {
  const imageUrls = Array.isArray(result?.imageUrls) ? result.imageUrls.filter(Boolean) : [];
  if (!imageUrls.length) return result;
  const mirroredUrls = await mirrorImageUrls(imageUrls, config);
  return {
    ...result,
    imageUrls: mirroredUrls,
    raw: {
      ...(result.raw || {}),
      originalImageUrls: imageUrls
    }
  };
}

async function markAccountAvailable(accountId, channel = "") {
  const channelType = typeof channel === "string" ? channel : channel?.type || "";
  const patch = {
    status: "ok",
    message: "最近调用成功"
  };
  if (channelType === "chatplus" || !channelType) patch.cooldownUntil = null;
  await updateTargetAccountStatus(accountId, channel, patch);
}

function drawingFailureTextFromResult(result = {}) {
  const itemErrors = (result?.raw?.items || [])
    .map((item) => item?.error_message || item?.message || "")
    .filter(Boolean);
  return [result.errorMessage, ...itemErrors].filter(Boolean).join("；");
}

function drawingRateLimitPatch(retryAfterSeconds) {
  return {
    status: "cooldown",
    cooldownUntil: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
    cooldownReason: "drawing_rate_limited",
    upstreamFailureCode: "",
    upstreamFailureStreak: 0,
    message: `上传过于频繁，按上游要求暂停绘图 ${retryAfterSeconds} 秒。`
  };
}

function drawingSevereFailureText(reason) {
  const code = String(reason || "").match(/^upstream_(\d{3})$/)?.[1];
  if (code) return `绘图站上游服务异常（${code}）`;
  if (reason === "relay_text") return "绘图站中转返回异常文本";
  if (reason === "relay_timeout") return "绘图站中转请求超时";
  return "绘图站上游服务异常";
}

async function updateTargetStatusAfterError(account, channel, error) {
  const retryAfterSeconds = channel?.type === "drawing"
    ? drawingRetryAfterSeconds(error?.message)
    : 0;
  if (!retryAfterSeconds) {
    await updateTargetAccountStatus(account.id, channel, accountStatusFromError(error));
    return;
  }
  await withAccountAuthLock(account, () => (
    updateTargetAccountStatus(account.id, channel, drawingRateLimitPatch(retryAfterSeconds))
  ));
}

async function updateAccountAfterTask(account, channel, result = {}) {
  if (channel?.type !== "drawing" || !isFinishedTask(result.status)) {
    await markAccountAvailable(account.id, channel);
    return false;
  }

  return withAccountAuthLock(account, async () => {
    const config = await loadRuntimeConfig();
    const currentAccount = config.accounts.find((item) => item.id === account.id) || account;
    const drawing = currentAccount.meta?.abilities?.drawing || {};
    if (statusCooling(drawing)) return true;

    const failureText = result.status === "failed" ? drawingFailureTextFromResult(result) : "";
    const retryAfterSeconds = drawingRetryAfterSeconds(failureText);
    const severeFailureReason = drawingSevereFailureReason(failureText);
    const previousStreak = drawing.status === "cooldown"
      ? 0
      : Math.max(0, Number(drawing.upstreamFailureStreak || 0));

    if (retryAfterSeconds) {
      await updateTargetAccountStatus(account.id, channel, drawingRateLimitPatch(retryAfterSeconds));
      return true;
    }

    if (severeFailureReason) {
      const severeFailureText = drawingSevereFailureText(severeFailureReason);
      const upstreamFailureStreak = previousStreak + 1;
      if (upstreamFailureStreak >= DRAWING_FAILURE_LIMIT) {
        const cooldownUntil = new Date(Date.now() + DRAWING_COOLDOWN_MS).toISOString();
        await updateTargetAccountStatus(account.id, channel, {
          status: "cooldown",
          cooldownUntil,
          cooldownReason: "drawing_upstream_error",
          upstreamFailureCode: severeFailureReason,
          upstreamFailureStreak,
          message: `${severeFailureText}连续失败 ${DRAWING_FAILURE_LIMIT} 次，绘图已冷却 30 分钟。`
        });
        return true;
      }

      await updateTargetAccountStatus(account.id, channel, {
        status: "ok",
        cooldownUntil: null,
        cooldownReason: "",
        upstreamFailureCode: severeFailureReason,
        upstreamFailureStreak,
        message: `${severeFailureText}，连续失败 ${upstreamFailureStreak}/${DRAWING_FAILURE_LIMIT} 次。`
      });
      return false;
    }

    await updateTargetAccountStatus(account.id, channel, {
      status: "ok",
      cooldownUntil: null,
      cooldownReason: "",
      upstreamFailureCode: "",
      upstreamFailureStreak: 0,
      message: result.status === "success" ? "最近绘图调用成功" : "绘图账号可继续使用"
    });
    return false;
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
    responseJson: attachResponseSourceTaskId(taskResponseJson(result), task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)),
    raw: {
      ...(task.raw || {}),
      ...(result.raw || {})
    }
  };
}

export async function refreshTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");
  if (!needsTaskRefresh(task)) return task;

  const config = await loadRuntimeConfig();
  const { channel, account } = inferRefreshTarget(config, task);
  const client = getWorkClient(config, channel, account);
  if (typeof client.getTask !== "function") return task;

  const externalId = taskExternalId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) return task;

  const refreshedResult = await runChatplusAccountWork(channel, account, () => client.getTask(externalId, {
    carId: task.raw?.selectedCarId,
    carType: task.raw?.selectedCarType
  }));
  const result = await mirrorTaskImages(refreshedTaskWaitState(task, refreshedResult, config.waitTimeoutSec), config);
  const nextTask = mergeRefreshedTask(task, result, channel, account);
  await upsertTask(nextTask);
  if (isFinishedTask(nextTask.status)) {
    await recordTaskStat(nextTask);
    await updateAccountAfterTask(account, channel, nextTask);
  }
  return nextTask;
}

function isLostLocalChatTask(task) {
  return task.taskType === "chat" && isPendingTask(task.status) && task.raw?.queued && !scheduledChatTasks.has(task.id);
}

async function failLostLocalChatTask(task) {
  return failQueuedTask(task, new Error("这个旧对话任务已经没有后台执行进程，已停止。"), task.attempts || []);
}

function isLostLocalImageTask(task) {
  return task.taskType !== "chat"
    && isPendingTask(task.status)
    && task.raw?.queued === true
    && !savedTaskExternalId(task)
    && !scheduledImageTasks.has(task.id);
}

async function interruptLostLocalImageTask(task) {
  const interruptedAt = new Date().toISOString();
  const message = "服务重启时任务被中断，尚未保存上游任务编号，无法确认最终结果；此任务不计失败。";
  const interruptedTask = {
    ...task,
    status: "interrupted",
    errorMessage: "",
    responseJson: { ok: null, message },
    raw: {
      ...(task.raw || {}),
      queued: false,
      interrupted: true,
      interruptedAt,
      interruptedReason: message
    },
    completedAt: interruptedAt
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
}

export async function refreshProcessingTasks() {
  const tasks = await listTasks();
  const results = [];
  for (const task of tasks.filter(needsTaskRefresh)) {
    try {
      if (isLostLocalImageTask(task)) {
        results.push({ id: task.id, ok: true, data: await interruptLostLocalImageTask(task) });
        continue;
      }
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

function channelMatchesRequest(channel, requestedChannel = "auto") {
  if (requestedChannel === "auto" || channel.id === requestedChannel) return true;
  if (channel.type !== "shareai") return false;
  return Boolean(requestedAbility(channel, requestedChannel));
}

function accountMatchesChannel(account, channel) {
  if (account.channelId === channel.id) return true;
  return channel.type === "shareai" && account.channelId === "shareai";
}

function accountRoutingWeight(account) {
  const weight = Math.round(Number(account?.routingWeight || 1));
  return Math.min(100, Math.max(1, Number.isFinite(weight) ? weight : 1));
}

function balancedAccountOrder(accounts, routingKey) {
  if (accounts.length < 2) return accounts;

  const activeIds = new Set(accounts.map((account) => account.id));
  const signature = accounts.map((account) => `${account.id}:${accountRoutingWeight(account)}`).join("|");
  const currentState = accountRoutingState.get(routingKey);
  const scores = currentState?.signature === signature ? currentState.scores : new Map();
  for (const accountId of scores.keys()) {
    if (!activeIds.has(accountId)) scores.delete(accountId);
  }

  const totalWeight = accounts.reduce((total, account) => total + accountRoutingWeight(account), 0);
  for (const account of accounts) {
    scores.set(account.id, (scores.get(account.id) || 0) + accountRoutingWeight(account));
  }

  const selected = accounts.reduce((best, account) =>
    (scores.get(account.id) || 0) > (scores.get(best.id) || 0) ? account : best
  );
  scores.set(selected.id, (scores.get(selected.id) || 0) - totalWeight);
  accountRoutingState.set(routingKey, { signature, scores });

  return [
    selected,
    ...accounts
      .filter((account) => account.id !== selected.id)
      .sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0))
  ];
}

function selectTargets(config, requestedChannel = "auto", taskType = "text2img", options = {}) {
  const requestedAccountId = String(options.accountId || "").trim();
  const channels = config.channels
    .filter((channel) => channel.enabled !== false)
    .filter((channel) => channelMatchesRequest(channel, requestedChannel))
    .filter((channel) => !(taskType === "chat" && channel.type === "drawing"))
    .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));

  const targets = [];
  for (const channel of channels) {
    const accounts = config.accounts
      .filter((account) => account.enabled !== false && accountMatchesChannel(account, channel))
      .filter((account) => !requestedAccountId || account.id === requestedAccountId)
      .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
    if (channel.type === "shareai") {
      for (const ability of shareAIAbilitiesForTask(channel, requestedChannel, taskType)) {
        const abilityAccounts = accounts.filter((account) =>
          !(ability === "chatplus" && !options.includeCooling && accountCooling(account))
        );
        const orderedAccounts = options.balanced && !requestedAccountId
          ? balancedAccountOrder(abilityAccounts, `${channel.id}:${ability}:${taskType}`)
          : abilityAccounts;
        for (const account of orderedAccounts) {
          targets.push({ channel: shareAIAbilityChannel(channel, ability), account });
        }
      }
      continue;
    }
    const channelAccounts = accounts.filter((account) =>
      !(channel.type === "chatplus" && !options.includeCooling && accountCooling(account))
    );
    const orderedAccounts = options.balanced && !requestedAccountId
      ? balancedAccountOrder(channelAccounts, `${channel.id}:${taskType}`)
      : channelAccounts;
    for (const account of orderedAccounts) {
      targets.push({ channel, account });
    }
  }
  return targets;
}

function noChatTargetsError(config, requestedChannel) {
  const allTargets = selectTargets(config, requestedChannel, "chat", { includeCooling: true });
  const cooling = allTargets.find((target) => accountCooling(target.account));
  return cooling ? cooldownError(cooling.account) : new Error("没有可用的对话渠道或账号。");
}

function wrapTask({ result, channel, account, attempts, requestJson = null, requestMeta = {} }) {
  const status = result.status || "unknown";
  const meta = taskRequestMeta(requestMeta);
  const sourceTaskId = meta.sourceTaskId || sourceTaskIdFrom(requestJson);
  const requestMetaPayload = sourceTaskId && !meta.sourceTaskId ? { ...meta, sourceTaskId } : meta;
  const requestPayload = attachSourceTaskId(requestJson, sourceTaskId);
  return {
    id: `task-${randomUUID()}`,
    ...(sourceTaskId ? { sourceTaskId } : {}),
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
    requestMeta: requestMetaPayload,
    network: taskNetworkMeta(account),
    attempts,
    requestJson: requestPayload,
    responseJson: attachResponseSourceTaskId(taskResponseJson(result), sourceTaskId),
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
    message: busyTaskError(slot, target).message,
    busy: true
  };
}

function targetQuotaStatus(target) {
  const ability = channelAbilityKey(target?.channel);
  const abilityStatus = ability ? target?.account?.meta?.abilities?.[ability] || {} : null;
  return abilityStatus && Object.keys(abilityStatus).length ? abilityStatus : target?.account || {};
}

function targetAbilityCooling(target) {
  return statusCooling(targetQuotaStatus(target));
}

function targetKnownUnavailable(target) {
  const status = String(targetQuotaStatus(target).status || "unknown").toLowerCase();
  return ["error", "failed", "disconnected", "disabled"].includes(status);
}

function admissionTargets(targets) {
  return targets.filter((target) => !targetKnownUnavailable(target));
}

function targetRecoveryKey(target) {
  return `${target?.channel?.id || "channel"}:${target?.account?.id || "account"}`;
}

function targetNeedsRecovery(target) {
  const status = String(targetQuotaStatus(target).status || "unknown").toLowerCase();
  return (
    target?.channel?.type === "chatplus" && accountCooling(target.account)
  ) || ["error", "failed", "disconnected"].includes(status);
}

async function recoverTarget(config, target) {
  const key = targetRecoveryKey(target);
  const active = accountRecoveryTasks.get(key);
  if (active) return active;
  if ((accountRecoveryRetryAt.get(key) || 0) > Date.now()) return null;

  const recovery = (async () => {
    try {
      const status = await runChatplusAccountWork(
        target.channel,
        target.account,
        () => getClient(config, target.channel, target.account).check()
      );
      await updateTargetAccountStatus(target.account.id, target.channel, {
        ...status,
        cooldownUntil: null
      });
      if (["ok", "quota_empty"].includes(status.status)) {
        accountRecoveryRetryAt.delete(key);
        return status;
      }
      accountRecoveryRetryAt.set(key, Date.now() + ACCOUNT_RECOVERY_RETRY_MS);
      return null;
    } catch (error) {
      await updateTargetAccountStatus(target.account.id, target.channel, accountStatusFromError(error));
      accountRecoveryRetryAt.set(key, Date.now() + ACCOUNT_RECOVERY_RETRY_MS);
      return null;
    } finally {
      accountRecoveryTasks.delete(key);
    }
  })();
  accountRecoveryTasks.set(key, recovery);
  return recovery;
}

export async function recoverUnavailableChatAccounts() {
  const config = await loadRuntimeConfig();
  const targets = selectTargets(config, "auto", "chat", { includeCooling: true });
  const recoveryTargets = [...new Map(
    targets
      .filter((target) => target.channel.type === "chatplus" && targetNeedsRecovery(target))
      .map((target) => [targetRecoveryKey(target), target])
  ).values()];

  return Promise.all(recoveryTargets.map(async (target) => {
    const status = await recoverTarget(config, target);
    return {
      accountId: target.account.id,
      channelId: target.channel.id,
      recovered: ["ok", "quota_empty"].includes(status?.status),
      status: status?.status || targetQuotaStatus(target).status || "unknown"
    };
  }));
}

async function selectReadyTargets(config, requestedChannel, taskType, options = {}) {
  const targets = selectTargets(config, requestedChannel, taskType, {
    ...options,
    includeCooling: true
  });
  const ready = admissionTargets(targets).filter((target) => !(
    targetAbilityCooling(target)
      || (target.channel.type === "chatplus" && accountCooling(target.account))
  ));
  const recoveryTargets = options.skipRecovery ? [] : targets.filter(targetNeedsRecovery);
  if (!recoveryTargets.length) return ready;

  const recoveries = recoveryTargets.map((target) => recoverTarget(config, target));
  if (ready.length) {
    Promise.all(recoveries).catch((error) => console.error(error));
    return ready;
  }
  const recovered = await Promise.all(recoveries);
  return recoveryTargets.filter((_target, index) => (
    recovered[index]?.status === "ok"
      || (taskType === "chat" && recovered[index]?.status === "quota_empty")
  ));
}

function noUsableTargetError(taskType) {
  const error = new Error(taskType === "chat"
    ? "当前没有可用的对话账号，请先检测账号状态。"
    : "当前没有可用的生图账号，请先检测账号状态或等待额度恢复。");
  error.status = 503;
  return error;
}

function shouldRefreshQuotaBeforeUse(target, taskType) {
  if (taskType === "chat") return false;
  return target.channel.type === "drawing" || targetQuotaStatus(target).status === "quota_empty";
}

function pushAttempt(attempts, target, message, extra = {}) {
  attempts.push({
    channelId: target.channel.id,
    channelName: target.channel.name,
    accountId: target.account.id,
    accountName: target.account.name,
    message,
    ...extra
  });
}

async function updateTargetStatusForWork(target, patch) {
  const update = () => updateTargetAccountStatus(target.account.id, target.channel, patch);
  return target.channel.type === "drawing"
    ? withAccountAuthLock(target.account, update)
    : update();
}

async function refreshQuotaBeforeUse(config, target, attempts) {
  try {
    const status = await getClient(config, target.channel, target.account).check();
    const previousStatus = targetQuotaStatus(target);
    const expiredDrawingCooldown = target.channel.type === "drawing"
      && previousStatus.status === "cooldown"
      && !statusCooling(previousStatus);
    await updateTargetStatusForWork(target, {
      ...status,
      cooldownUntil: status.status === "ok" ? null : status.cooldownUntil,
      ...(expiredDrawingCooldown
        ? { cooldownReason: "", upstreamFailureCode: "", upstreamFailureStreak: 0 }
        : {})
    });
    if (status.status === "quota_empty") {
      pushAttempt(attempts, target, `${status.message || "额度不足"}，已自动刷新额度后跳过。`, { quotaEmpty: true });
      return false;
    }
    return true;
  } catch (error) {
    const patch = accountStatusFromError(error);
    await updateTargetStatusForWork(target, patch);
    pushAttempt(
      attempts,
      target,
      patch.status === "quota_empty"
        ? `${patch.message || "额度不足"}，已自动刷新额度后跳过。`
        : `自动刷新额度失败：${patch.message || "检测失败"}`,
      { quotaEmpty: patch.status === "quota_empty" }
    );
    return false;
  }
}

async function refreshQuotaBeforeUseFast(config, target, attempts, timeoutMs = 500) {
  const localAttempts = [];
  const refresh = refreshQuotaBeforeUse(config, target, localAttempts)
    .then((ready) => ({ ready }))
    .catch((error) => ({ error }));
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  const result = await Promise.race([refresh, timeout]);
  if (result.timeout) {
    pushAttempt(attempts, target, "额度检测超时，已快速跳过。", { quotaEmpty: true });
    refresh.catch((error) => console.error(error));
    return false;
  }
  attempts.push(...localAttempts);
  if (result.error) throw result.error;
  return result.ready;
}

async function refreshDrawingQuota(account, channel) {
  if (channel.type !== "drawing") return;
  const config = await loadRuntimeConfig();
  const currentAccount = config.accounts.find((item) => item.id === account.id) || account;
  const status = await getClient(config, channel, currentAccount).check();
  await withAccountAuthLock(account, async () => {
    const latestConfig = await loadRuntimeConfig();
    const latestAccount = latestConfig.accounts.find((item) => item.id === account.id) || account;
    const drawing = latestAccount.meta?.abilities?.drawing || {};
    await updateTargetAccountStatus(account.id, channel, statusCooling(drawing)
      ? {
          ...status,
          status: "cooldown",
          cooldownUntil: drawing.cooldownUntil,
          cooldownReason: drawing.cooldownReason,
          upstreamFailureCode: drawing.upstreamFailureCode,
          upstreamFailureStreak: drawing.upstreamFailureStreak,
          message: drawing.message
        }
      : status);
  });
}

function scheduleDrawingQuotaRefresh(account, channel) {
  if (channel.type !== "drawing") return;
  runInBackground(() => refreshDrawingQuota(account, channel));
}

function proxyTargetUrl(channel = {}) {
  return channel.settings?.baseUrl
    || (channel.type === "drawing" ? "https://drawing.aishare.icu" : "https://www.chatplus.cc");
}

async function saveProxyCheck(account, result) {
  const config = await loadConfig();
  const current = config.accounts.find((item) => item.id === account.id) || account;
  await updateAccountStatus(account.id, {
    meta: {
      ...(current.meta || {}),
      proxyCheck: proxyCheckMeta(result)
    }
  });
}

async function ensureProxyReady(target, attempts) {
  const proxyValue = accountProxyValue(target.account);
  if (!String(proxyValue).trim()) return true;

  const result = await checkProxyReachability(proxyValue, proxyTargetUrl(target.channel));
  await saveProxyCheck(target.account, result);
  if (result.ok) return true;

  pushAttempt(attempts, target, `${result.message || "代理不可用"}，已跳过这个账号。`, { proxyFailed: true });
  return false;
}

async function checkAccountProxy(account, channel) {
  const proxyValue = accountProxyValue(account);
  if (!String(proxyValue).trim()) return null;

  const result = await checkProxyReachability(proxyValue, proxyTargetUrl(channel));
  if (!result.ok) {
    await saveProxyCheck(account, result);
    throw new Error(result.message || "代理不可用");
  }
  return result;
}

async function ensureTargetReady(config, target, taskType, attempts, options = {}) {
  if (!(await ensureProxyReady(target, attempts))) return false;
  if (!shouldRefreshQuotaBeforeUse(target, taskType)) return true;
  if (options.skipQuotaRefresh) {
    return refreshQuotaBeforeUseFast(config, target, attempts);
  }
  return refreshQuotaBeforeUse(config, target, attempts);
}

function reserveFirstAvailableTarget(targets, taskType) {
  const attempts = [];
  for (const target of targets) {
    const slot = targetTaskSlot(target, taskType);
    const release = tryReserveTaskSlot(slot, target);
    if (release) return { target, release, attempts };
    attempts.push(targetBusyAttempt(target, taskType));
  }
  const details = attemptErrorMessage(attempts);
  const error = new Error(details ? `并发上限：${details}` : "并发上限");
  error.status = 429;
  error.code = "CONCURRENCY_LIMIT";
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

function concurrencyLimitReached(attempts) {
  return attempts.some((item) => item.busy)
    && attempts.every((item) => item.busy || item.quotaEmpty);
}

function targetsFailedError(attempts) {
  const concurrencyLimited = concurrencyLimitReached(attempts);
  const details = attemptErrorMessage(attempts);
  const error = new Error(
    concurrencyLimited
      ? (details ? `并发上限：${details}` : "并发上限")
      : `所有渠道都失败：${details}`
  );
  error.attempts = attempts;
  if (concurrencyLimited) {
    error.status = 429;
    error.code = "CONCURRENCY_LIMIT";
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
    previewUrl: file?.previewUrl || "",
    fieldname: file?.fieldname || ""
  };
}

function taskRequestJson(input = {}) {
  const { file, files, ...fields } = input || {};
  const requestJson = jsonValue(fields) || {};
  const fileItems = imageFiles(files || file).map(taskFileJson);
  if (fileItems.length) {
    requestJson.received_image_count = fileItems.length;
    requestJson.files = fileItems;
  }
  return requestJson;
}

function taskResponseJson(value = {}) {
  return jsonValue(value) || {};
}

function queuedTask({ input, target, taskType, prompt, imageCount, inputImageUrls, raw, requestMeta = {} }) {
  const meta = taskRequestMeta(requestMeta);
  const sourceTaskId = meta.sourceTaskId || sourceTaskIdFrom(input);
  const requestMetaPayload = sourceTaskId && !meta.sourceTaskId ? { ...meta, sourceTaskId } : meta;
  const requestJson = attachSourceTaskId(taskRequestJson(input), sourceTaskId);
  return {
    id: `task-${randomUUID()}`,
    ...(sourceTaskId ? { sourceTaskId } : {}),
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
    requestMeta: requestMetaPayload,
    network: taskNetworkMeta(target.account),
    attempts: [],
    requestJson,
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
  const statusCode = Number(error.status || error.statusCode || 0) || null;
  const code = error.code || (statusCode === 429 ? "CONCURRENCY_LIMIT" : "");
  const sourceTaskId = task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson);
  const failedTask = {
    ...task,
    status: "failed",
    errorMessage: error.message || readableAttemptError(attempts) || "任务失败",
    statusCode,
    attempts,
    responseJson: {
      ok: false,
      message: responseMessage,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      ...(statusCode ? { status: statusCode } : {}),
      ...(code ? { code } : {}),
      attempts: taskResponseJson(attempts)
    },
    completedAt: new Date().toISOString()
  };
  await upsertTask(failedTask);
  await recordTaskStat(failedTask);
  return failedTask;
}

async function finishQueuedTask(task, result, channel, account, attempts) {
  const status = result.status || task.status;
  const nextTask = {
    ...wrapTask({ result, channel, account, attempts, requestJson: task.requestJson, requestMeta: task.requestMeta }),
    id: task.id,
    status,
    createdAt: task.createdAt,
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : null
  };
  await upsertTask(nextTask);
  if (isFinishedTask(nextTask.status)) await recordTaskStat(nextTask);
  await updateAccountAfterTask(account, channel, nextTask);
  scheduleDrawingQuotaRefresh(account, channel);
  return nextTask;
}

async function persistSubmittedTask(task, result, channel, account, attempts) {
  if (!savedTaskExternalId(result) || isFinishedTask(result?.status)) return task;
  const submittedTask = mergeRefreshedTask(task, {
    ...result,
    status: result.status || "processing"
  }, channel, account);
  submittedTask.attempts = attempts;
  submittedTask.raw = {
    ...(submittedTask.raw || {}),
    queued: false,
    submitted: true,
    submittedAt: task.raw?.submittedAt || new Date().toISOString()
  };
  await upsertTask(submittedTask);
  return submittedTask;
}

async function runQueuedTextTask(task, input, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = await selectReadyTargets(config, requestedChannel, "text2img");
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
        release = tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target);
        if (!release) {
          attempts.push(targetBusyAttempt(target, "text2img"));
          continue;
        }
      }
      let taskState = task;
      try {
        const finishedTask = await runChatplusAccountWork(channel, account, async () => {
          if (!(await ensureTargetReady(config, target, "text2img", attempts))) return null;
          const client = getWorkClient(config, channel, account);
          const onSubmitted = async (submittedResult) => {
            taskState = await persistSubmittedTask(taskState, submittedResult, channel, account, attempts);
          };
          let result = await client.createTextTask({ ...input, onSubmitted });
          taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
          scheduleDrawingQuotaRefresh(account, channel);
          if (channel.type === "drawing" && !isFinishedTask(result.status)) {
            result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
          }
          result = await mirrorTaskImages(result, config);
          return finishQueuedTask(taskState, result, channel, account, attempts);
        }, {
          noQueue: options.noChatplusQueue,
          slot: targetTaskSlot(target, "text2img"),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败");
          return failQueuedTask(taskState, error, attempts);
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          busy: Boolean(error.busy),
          quotaEmpty: Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy) {
          await updateTargetStatusAfterError(account, channel, error);
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

function waitingUpstreamResult(result, lastResult = null, lastError = null) {
  const source = lastResult || result || {};
  return {
    ...result,
    ...source,
    externalId: source.externalId || result?.externalId,
    status: "waiting_upstream",
    imageUrls: source.imageUrls || result?.imageUrls || [],
    errorMessage: "",
    raw: {
      ...(result?.raw || {}),
      ...(source.raw || {}),
      waitingUpstream: true,
      waitingSince: new Date().toISOString(),
      lastPollMessage: lastError?.message || ""
    }
  };
}

function drawingSubmitWaitTimeoutSec(config = {}) {
  const configured = Math.min(3600, Math.max(30, Number(config.waitTimeoutSec || 300)));
  return Math.min(configured, DRAWING_SUBMIT_WAIT_TIMEOUT_SEC);
}

async function waitForUpstreamTask(client, result, timeoutSec) {
  if (isFinishedTask(result?.status) || !result?.externalId || typeof client.getTask !== "function") return result;
  const seconds = Math.min(3600, Math.max(30, Number(timeoutSec || 300)));
  const deadline = Date.now() + seconds * 1000;
  let lastResult = result;
  let lastError = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      lastResult = await client.getTask(result.externalId);
      lastError = null;
      if (isFinishedTask(lastResult?.status)) return lastResult;
    } catch (error) {
      lastError = error;
    }
  }
  return waitingUpstreamResult(result, lastResult, lastError);
}

async function runQueuedImageTask(task, input, files, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", { accountId: requestedAccountId });
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
        release = tryReserveTaskSlot(targetTaskSlot(target, "img2img"), target);
        if (!release) {
          attempts.push(targetBusyAttempt(target, "img2img"));
          continue;
        }
      }
      let taskState = task;
      try {
        const finishedTask = await runChatplusAccountWork(channel, account, async () => {
          if (!(await ensureTargetReady(config, target, "img2img", attempts, {
            skipQuotaRefresh: options.noChatplusQueue
          }))) return null;
          const client = getWorkClient(config, channel, account);
          const onSubmitted = async (submittedResult) => {
            taskState = await persistSubmittedTask(taskState, submittedResult, channel, account, attempts);
          };
          let result = await submitImageTask(client, { ...input, onSubmitted }, files);
          taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
          scheduleDrawingQuotaRefresh(account, channel);
          if (channel.type === "drawing" && !isFinishedTask(result.status)) {
            result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
          }
          result = await mirrorTaskImages(result, config);
          return finishQueuedTask(taskState, result, channel, account, attempts);
        }, {
          noQueue: options.noChatplusQueue,
          slot: targetTaskSlot(target, "img2img"),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败");
          return failQueuedTask(taskState, error, attempts);
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          busy: Boolean(error.busy),
          quotaEmpty: Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy) {
          await updateTargetStatusAfterError(account, channel, error);
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
    network: taskNetworkMeta(account),
    attempts,
    responseJson: responseJson || chatCompletionResponseJson({ result, channel }),
    completedAt: new Date().toISOString(),
    raw: result.raw || result
  };
  await upsertTask(nextTask);
  await recordTaskStat(nextTask);
  await markAccountAvailable(account.id, channel);
  return nextTask;
}

async function runChatCompletionTask(task, input) {
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId });
  const preferredTarget = requestedAccountId
    ? null
    : targets.find((target) => target.account.id === task.accountId && target.channel.id === task.channelId);
  const orderedChatTargets = preferredTarget
    ? [preferredTarget, ...targets.filter((target) => !sameTarget(target, preferredTarget))]
    : targets;
  const attempts = [];
  if (!targets.length) {
    const error = noChatTargetsError(config, requestedChannel);
    error.task = await failQueuedTask(task, error, attempts);
    throw error;
  }
  for (const target of orderedChatTargets) {
    const { channel, account } = target;
    try {
      const finished = await runChatplusAccountWork(channel, account, async () => {
        if (!(await ensureTargetReady(config, target, "chat", attempts))) return null;
        const client = getWorkClient(config, channel, account);
        if (typeof client.createChatCompletion !== "function") {
          throw new Error("这个渠道暂不支持对话。");
        }
        const result = await mirrorTaskImages(await client.createChatCompletion(input), config);
        const responseJson = chatCompletionResponseJson({ result, channel });
        const finishedTask = await finishChatTask(task, result, channel, account, attempts, responseJson);
        return { result, channel, account, task: finishedTask, responseJson };
      });
      if (finished) return finished;
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
        await markChatCooldown(account.id, channel, error);
      } else {
        await updateTargetAccountStatus(account.id, channel, accountStatusFromError(error));
      }
      if (status === 400 && !isChatBlockedError(error)) {
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

export async function queueTextTask(input = {}, requestMeta = {}) {
  if (!cleanPrompt(input)) {
    const error = new Error("请输入生图描述。");
    error.status = 400;
    throw error;
  }
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { balanced: true });
  if (!targets.length) throw noUsableTargetError("text2img");

  const reserved = reserveFirstAvailableTarget(targets, "text2img");
  const task = queuedTask({ input, target: reserved.target, taskType: "text2img", requestMeta });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved.release();
    throw error;
  }
  scheduledImageTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runQueuedTextTask(task, input, reserved);
    } finally {
      scheduledImageTasks.delete(task.id);
    }
  });
  return task;
}
export async function queueImageTask({ input = {}, file, files: inputFiles, requestMeta = {} }) {
  if (!cleanPrompt(input)) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", { accountId: requestedAccountId, balanced: true });
  if (!targets.length) throw noUsableTargetError("img2img");

  const reserved = reserveFirstAvailableTarget(targets, "img2img");
  const task = queuedTask({ input: { ...input, files }, target: reserved.target, taskType: "img2img", requestMeta });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved.release();
    throw error;
  }
  scheduledImageTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runQueuedImageTask(task, input, files, reserved);
    } finally {
      scheduledImageTasks.delete(task.id);
    }
  });
  return task;
}
export async function queueChatCompletion(input = {}, requestMeta = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId, balanced: true });
  if (!targets.length) throw noUsableTargetError("chat");

  const reserved = reserveFirstAvailableTarget(targets, "chat");
  const task = queuedTask({
    input,
    target: reserved.target,
    taskType: "chat",
    prompt: cleanChatPrompt(input),
    imageCount: chatImageCount(input),
    inputImageUrls: chatPreviewUrls(input),
    raw: { endpoint: "/v1/chat/completions" },
    requestMeta
  });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved.release();
    throw error;
  }
  scheduledChatTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runChatCompletionTask(task, input);
    } finally {
      scheduledChatTasks.delete(task.id);
      reserved.release();
    }
  });
  return task;
}

async function checkShareAIAbility(config, channel, account, ability) {
  const abilityChannel = shareAIAbilityChannel(channel, ability);
  const client = getClient(config, abilityChannel, account);
  try {
    const data = await runChatplusAccountWork(abilityChannel, account, () => client.check());
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      data: {
        status: isDisconnectedError(error) ? "disconnected" : isQuotaEmptyError(error) ? "quota_empty" : "error",
        quota: null,
        balance: null,
        quotaResetAt: error?.quotaResetAt || "",
        expireAt: "",
        message: readableCheckErrorMessage(error)
      }
    };
  }
}

function readableCheckErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (/proxy/i.test(message) && /timeout|timed out|ETIMEDOUT|Failed connect/i.test(message)) {
    return "目标网站打不开，可能是服务器 IP 被限制或代理不可用。";
  }
  if (/检测超时|timeout|timed out|ETIMEDOUT|AbortError/i.test(message)) {
    return "目标网站打不开，可能是服务器 IP 被限制或代理不可用。";
  }
  if (/Failed connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return "目标网站打不开，可能是服务器 IP 被限制或代理不可用。";
  }
  return message || "检测失败";
}

function combinedShareAIStatus(results) {
  const drawing = results.drawing.data;
  const chatplus = results.chatplus.data;
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return {
    status: disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : "error",
    quota: drawing.quota ?? null,
    balance: drawing.balance ?? null,
    quotaResetAt: drawing.quotaResetAt || chatplus.quotaResetAt || "",
    expireAt: drawing.expireAt || chatplus.expireAt || "",
    message: [
      `绘图站：${drawing.message || (results.drawing.ok ? "可用" : "不可用")}`,
      `聊天：${chatplus.message || (results.chatplus.ok ? "可用" : "不可用")}`
    ].join("；"),
    cooldownUntil: chatplus.status === "ok" ? null : undefined,
    meta: {
      abilities: {
        drawing,
        chatplus
      }
    }
  };
}

function preserveDrawingCooldown(account, status) {
  const currentDrawing = account.meta?.abilities?.drawing || {};
  if (!statusCooling(currentDrawing)) return status;
  const abilities = status.meta?.abilities || {};
  const drawing = {
    ...(abilities.drawing || {}),
    status: "cooldown",
    cooldownUntil: currentDrawing.cooldownUntil,
    cooldownReason: currentDrawing.cooldownReason,
    upstreamFailureCode: currentDrawing.upstreamFailureCode,
    upstreamFailureStreak: currentDrawing.upstreamFailureStreak,
    message: currentDrawing.message
  };
  return {
    ...status,
    message: combinedAbilityMessage(drawing, abilities.chatplus, status.message),
    meta: {
      ...(status.meta || {}),
      abilities: {
        ...abilities,
        drawing
      }
    }
  };
}

export async function checkAccount(accountId) {
  const config = await loadRuntimeConfig();
  const account = config.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("账号不存在。");
  const channel = config.channels.find((item) => item.id === account.channelId);
  if (!channel) throw new Error("账号所属渠道不存在。");
  const activeSlots = ["chat", "drawingImage", "chatImage"].reduce((result, slot) => {
    const count = activeTaskCounts.get(`${slot}:${account.id}`) || 0;
    if (count) result[slot] = count;
    return result;
  }, {});
  if (Object.keys(activeSlots).length) {
    return {
      status: account.status || "unknown",
      quota: account.quota ?? null,
      balance: account.balance ?? null,
      quotaResetAt: account.quotaResetAt || "",
      expireAt: account.expireAt || "",
      message: "账号正在处理任务，本次检测已跳过，当前状态保持不变。",
      busy: true,
      checkSkipped: true,
      activeSlots
    };
  }
  const proxyResult = await checkAccountProxy(
    account,
    channel.type === "shareai" ? shareAIAbilityChannel(channel, "drawing") : channel
  );
  if (channel.type === "shareai") {
    const [drawing, chatplus] = await Promise.all([
      checkShareAIAbility(config, channel, account, "drawing"),
      checkShareAIAbility(config, channel, account, "chatplus")
    ]);
    const results = { drawing, chatplus };
    const status = preserveDrawingCooldown(
      account,
      withProxyCheckMeta(combinedShareAIStatus(results), proxyResult)
    );
    await updateAccountStatus(account.id, status);
    if (status.status !== "ok") throw new Error(status.message || "检测失败");
    return status;
  }
  const client = getClient(config, channel, account);
  try {
    const status = await runChatplusAccountWork(channel, account, () => client.check());
    const nextStatus = withProxyCheckMeta({ ...status, cooldownUntil: null }, proxyResult);
    await updateAccountStatus(account.id, nextStatus);
    return nextStatus;
  } catch (error) {
    const message = readableCheckErrorMessage(error);
    const status = withProxyCheckMeta({
      status: isDisconnectedError(error) ? "disconnected" : isQuotaEmptyError(error) ? "quota_empty" : "error",
      quota: null,
      balance: null,
      quotaResetAt: error?.quotaResetAt || "",
      expireAt: "",
      message
    }, proxyResult);
    await updateAccountStatus(account.id, status);
    throw new Error(message);
  }
}

export async function checkAllAccounts() {
  const config = await loadRuntimeConfig();
  const results = [];
  for (const account of config.accounts) {
    if (account.enabled === false) {
      results.push({ accountId: account.id, ok: false, skipped: true, message: "账号已停用，已跳过检测。" });
      continue;
    }
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

export async function createChatCompletion(input = {}, requestMeta = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId, balanced: true });
  if (!targets.length) throw noUsableTargetError("chat");

  const reserved = reserveFirstAvailableTarget(targets, "chat");
  try {
    const task = queuedTask({
      input,
      target: reserved.target,
      taskType: "chat",
      prompt: cleanChatPrompt(input),
      imageCount: chatImageCount(input),
      inputImageUrls: chatPreviewUrls(input),
      raw: { endpoint: "/v1/chat/completions" },
      requestMeta
    });
    await upsertTask(task);
    scheduledChatTasks.add(task.id);
    try {
      const result = await runChatCompletionTask(task, input);
      return chatCompletionResponse(result);
    } finally {
      scheduledChatTasks.delete(task.id);
    }
  } finally {
    reserved.release();
  }
}
export async function createTextTask(input = {}, wait = false, requestMeta = {}) {
  if (!String(input.prompt || "").trim()) {
    const error = new Error("请输入生图描述。");
    error.status = 400;
    throw error;
  }
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { balanced: true });
  if (!targets.length) throw noUsableTargetError("text2img");

  const attempts = [];
  for (const target of targets) {
    const { channel, account } = target;
    const release = tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target);
    if (!release) {
      attempts.push(targetBusyAttempt(target, "text2img"));
      continue;
    }
    try {
      const finishedTask = await runChatplusAccountWork(channel, account, async () => {
        if (!(await ensureTargetReady(config, target, "text2img", attempts))) return null;
        const client = getWorkClient(config, channel, account);
        let result = await client.createTextTask(input);
        if (wait && channel.type === "drawing") result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
        result = await mirrorTaskImages(result, config);
        const task = wrapTask({ result, channel, account, attempts, requestJson: taskRequestJson(input), requestMeta });
        await upsertTask(task);
        if (isFinishedTask(task.status)) await recordTaskStat(task);
        await updateAccountAfterTask(account, channel, task);
        scheduleDrawingQuotaRefresh(account, channel);
        return task;
      }, {
        noQueue: wait,
        slot: targetTaskSlot(target, "text2img"),
        blockingSlots: ["chatImage"]
      });
      if (finishedTask) return finishedTask;
    } catch (error) {
      if (isTerminalTaskFailureError(error)) throw error;
      pushAttempt(attempts, target, error.message || "调用失败", {
        busy: Boolean(error.busy),
        quotaEmpty: Boolean(error.quotaEmpty || isQuotaEmptyError(error))
      });
      if (!error.busy) await updateTargetStatusAfterError(account, channel, error);
    } finally {
      release();
    }
  }
  throw targetsFailedError(attempts);
}
export async function createImageTask({ input = {}, file, files: inputFiles, wait = false, requestMeta = {} }) {
  if (!String(input.prompt || "").trim()) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadRuntimeConfig();
  const requestedChannel = input.channel || config.defaultChannel || "auto";
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", {
    accountId: requestedAccountId,
    balanced: wait,
    skipRecovery: wait
  });
  if (!targets.length) throw noUsableTargetError("img2img");

  if (wait) {
    const reserved = reserveFirstAvailableTarget(targets, "img2img");
    const task = queuedTask({ input: { ...input, files }, target: reserved.target, taskType: "img2img", requestMeta });
    try {
      await upsertTask(task);
    } catch (error) {
      reserved.release();
      throw error;
    }
    scheduledImageTasks.add(task.id);
    let finalTask;
    try {
      finalTask = await runQueuedImageTask(task, input, files, reserved, { noChatplusQueue: true });
    } finally {
      scheduledImageTasks.delete(task.id);
    }
    if (finalTask.status === "failed") {
      const responseJson = finalTask.responseJson || {};
      const message = responseJson.message || finalTask.errorMessage || "图生图任务失败。";
      const error = new Error(message);
      const statusCode = Number(finalTask.statusCode || responseJson.status || responseJson.statusCode || 0);
      error.status = statusCode || (String(message).includes("并发上限") ? 429 : 502);
      error.code = responseJson.code || (error.status === 429 ? "CONCURRENCY_LIMIT" : undefined);
      error.attempts = finalTask.attempts || responseJson.attempts || [];
      error.responseJson = responseJson;
      error.task = finalTask;
      throw error;
    }
    return finalTask;
  }

  return queueImageTask({ input, files, requestMeta });
}
