import { randomUUID } from "node:crypto";
import { ChatplusClient } from "./channels/chatplus.js";
import { DrawingClient, drawingRetryAfterSeconds, drawingSevereFailureReason, drawingUpstreamText } from "./channels/drawing.js";
import { mirrorImageUrls } from "./image-store.js";
import { checkProxyReachability, safeProxyEndpoint } from "./proxy.js";
import { getTask, listTasks, loadConfig, recordTaskStat, updateAccountStatus, upsertTask } from "./storage.js";

const CHAT_COOLDOWN_MS = 30 * 60 * 1000;
const defaultTaskConcurrency = { chat: 3, drawingImage: 2, chatImage: 2 };
const scheduledChatTasks = new Set();
const scheduledImageTasks = new Set();
const activeTaskCounts = new Map();
const activeDrawingModelCounts = new Map();
const activeSubmittedTaskIds = new Set();
const activeAccountAuthTasks = new Map();
const activeChatplusAccountWork = new Map();
const activeChatQuotaProbes = new Set();
const clientCache = new Map();
const accountRoutingState = new Map();
const accountRecoveryTasks = new Map();
const accountRecoveryRetryAt = new Map();
const ACCOUNT_RECOVERY_RETRY_MS = 30 * 1000;
const CHAT_USAGE_RECOVERY_CHECK_MS = 60 * 60 * 1000;
const DRAWING_FAILURE_LIMIT = 3;
const DRAWING_COOLDOWN_MS = 30 * 60 * 1000;
const DRAWING_SUBMIT_WAIT_TIMEOUT_SEC = 180;
const FAST_QUOTA_REFRESH_TIMEOUT_MS = 5000;
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

function taskSlotLimit(slot, target = {}) {
  const accountLimit = Number(target?.account?.concurrency?.[slot]);
  if (Number.isFinite(accountLimit) && accountLimit > 0) return accountLimit;
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

function activeCountForModelSlot(slot, modelKey) {
  const prefix = `${slot}:${modelKey}:`;
  let total = activeTaskCounts.get(`${slot}:${modelKey}`) || 0;
  for (const [key, count] of activeTaskCounts.entries()) {
    if (String(key).startsWith(prefix)) total += count;
  }
  return total;
}

function activeCountForDrawingModel(modelKey) {
  return activeDrawingModelCounts.get(modelRequestKey(modelKey)) || 0;
}

function activeCountForAccountSlot(slot, accountId) {
  const prefix = `${slot}:`;
  const suffix = `:${accountId}`;
  let total = 0;
  for (const [key, count] of activeTaskCounts.entries()) {
    const text = String(key);
    if (text === `${slot}:${accountId}` || (text.startsWith(prefix) && text.endsWith(suffix))) {
      total += count;
    }
  }
  return total;
}

function taskConcurrencyTotal(value = {}) {
  return Number(value.chat || 0) + Number(value.drawingImage || 0) + Number(value.chatImage || 0);
}

function targetRuntimeAvailable(target, taskType) {
  if (!target?.channel || !target?.account) return false;
  if (target.channel.enabled === false || target.account.enabled === false) return false;
  const status = targetQuotaStatus(target);
  const confirmedQuotaBlocks = targetConfirmedQuotaBlocksTask(target, taskType);
  const quotaProbeReady = target?.channel?.type === "chatplus"
    && String(status.status || "").toLowerCase() === "quota_empty"
    && (
      !confirmedQuotaBlocks
      || targetConfirmedQuotaRetryDue(target)
    );
  if (confirmedQuotaBlocks && !quotaProbeReady) return false;
  if (taskType === "chat" && accountCooling(target.account) && !quotaProbeReady) return false;
  if (statusCooling(status) && !quotaProbeReady) return false;
  return quotaProbeReady || status.status === "ok" || status.status === "cooldown";
}

function targetSupportsChatModel(target, modelKey) {
  if (target?.channel?.type !== "chatplus") return false;
  const requestedKey = modelRequestKey(modelKey);
  if (!requestedKey) return true;
  const settings = target.channel.settings || {};
  const routes = Array.isArray(settings.chatModels) ? settings.chatModels : [];
  if (routes.length) {
    return routes.some((route) =>
      route?.enabled !== false
      && [
        route?.key,
        route?.name,
        route?.model
      ].some((value) => modelRequestKey(value) === requestedKey)
    );
  }
  return requestedKey === (modelRequestKey(settings.defaultChatModel) || "gpt");
}

function targetSupportsRuntimeModel(target, taskType, modelKey) {
  if (taskType === "chat") return targetSupportsChatModel(target, modelKey);
  if (target?.channel?.type === "drawing") return ["gpt", "gemini"].includes(modelRequestKey(modelKey));
  return targetSupportsChatModel(target, modelKey);
}

function runtimeTargets(config, taskType, channelType, availableOnly = false, modelKey = "") {
  const targets = selectTargets(config, "auto", taskType, { includeCooling: true })
    .filter((target) => target.channel.type === channelType)
    .filter((target) => !modelKey || targetSupportsRuntimeModel(target, taskType, modelKey))
    .filter((target) => !availableOnly || targetRuntimeAvailable(target, taskType));
  return [...new Map(targets.map((target) => [target.account.id, target])).values()];
}

function runtimeSlotCapacity(config, taskType, channelType, slot, availableOnly = false, modelKey = "") {
  return runtimeTargets(config, taskType, channelType, availableOnly, modelKey)
    .reduce((total, target) => total + taskSlotLimit(slot, target), 0);
}

function runtimeAccountConcurrency(config, availableOnly = false) {
  const capacity = {
    chat: runtimeSlotCapacity(config, "chat", "chatplus", "chat", availableOnly),
    drawingImage: runtimeSlotCapacity(config, "text2img", "drawing", "drawingImage", availableOnly),
    chatImage: runtimeSlotCapacity(config, "text2img", "chatplus", "chatImage", availableOnly)
  };
  return {
    ...capacity,
    total: taskConcurrencyTotal(capacity)
  };
}

function runtimeChatModelKeys(config) {
  const keys = new Set();
  for (const channel of config.channels || []) {
    if (channel.enabled === false) continue;
    if (
      channel.type === "drawing"
      || (channel.type === "shareai" && channelAbilityEnabled(channel, "drawing"))
    ) {
      keys.add("gpt");
      keys.add("gemini");
    }
    const chatChannel = channel.type === "shareai"
      ? (channelAbilityEnabled(channel, "chatplus") ? shareAIAbilityChannel(channel, "chatplus") : null)
      : channel.type === "chatplus" ? channel : null;
    if (!chatChannel) continue;
    const settings = chatChannel.settings || {};
    const routes = Array.isArray(settings.chatModels) ? settings.chatModels : [];
    for (const route of routes) {
      const key = modelRequestKey(route?.key || route?.name || route?.model);
      if (key && route?.enabled !== false) keys.add(key);
    }
    if (!routes.length) {
      const defaultKey = modelRequestKey(settings.defaultChatModel);
      if (defaultKey) keys.add(defaultKey);
    }
  }
  return [...keys];
}

function runtimeModelConcurrency(config, availableOnly = false) {
  const sharedDrawingRunning = activeCountForSlot("drawingImage");
  return Object.fromEntries(runtimeChatModelKeys(config).map((modelKey) => {
    const configured = {
      chat: runtimeSlotCapacity(config, "chat", "chatplus", "chat", availableOnly, modelKey),
      drawingImage: runtimeSlotCapacity(config, "text2img", "drawing", "drawingImage", availableOnly, modelKey),
      chatImage: runtimeSlotCapacity(config, "text2img", "chatplus", "chatImage", availableOnly, modelKey)
    };
    const available = availableOnly
      ? configured
        : {
          chat: runtimeSlotCapacity(config, "chat", "chatplus", "chat", true, modelKey),
          drawingImage: runtimeSlotCapacity(config, "text2img", "drawing", "drawingImage", true, modelKey),
          chatImage: runtimeSlotCapacity(config, "text2img", "chatplus", "chatImage", true, modelKey)
        };
    const running = {
      chat: activeCountForModelSlot("chat", modelKey),
      drawingImage: activeCountForDrawingModel(modelKey),
      chatImage: activeCountForModelSlot("chatImage", modelKey)
    };
    const configuredImage = configured.drawingImage + configured.chatImage;
    const availableImage = available.drawingImage + available.chatImage;
    const runningImage = running.drawingImage + running.chatImage;
    const sharedDrawingBlocking = ["gpt", "gemini"].includes(modelKey) ? sharedDrawingRunning : 0;
    const blockingImage = sharedDrawingBlocking + running.chatImage;
    return [modelKey, {
      concurrency: {
        ...configured,
        total: taskConcurrencyTotal(configured)
      },
      available: {
        ...available,
        total: taskConcurrencyTotal(available)
      },
      running: {
        ...running,
        total: taskConcurrencyTotal(running)
      },
      categories: {
        chat: runtimeCategory(configured, available, running, ["chat"]),
        image: {
          configured: configuredImage,
          available: availableImage,
          running: runningImage,
          idle: Math.max(0, availableImage - blockingImage)
        }
      }
    }];
  }));
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
  const configured = runtimeAccountConcurrency(config);
  const available = runtimeAccountConcurrency(config, true);
  const models = runtimeModelConcurrency(config);
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
  for (const [modelKey, modelStatus] of Object.entries(models)) {
    modelStatus.waiting = {
      image: tasks.filter((task) =>
        task.status === "waiting_upstream"
        && task.taskType !== "chat"
        && storedTaskModelKey(task) === modelKey
      ).length,
      chat: tasks.filter((task) =>
        task.status === "waiting_upstream"
        && task.taskType === "chat"
        && task.channelType === "chatplus"
        && storedTaskModelKey(task) === modelKey
      ).length
    };
  }
  return {
    concurrency: configured,
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
    models,
    waiting
  };
}

function taskSlotLabel(slot) {
  if (slot === "chat") return "对话";
  if (slot === "chatImage") return "聊天生图";
  return "生图站";
}

function targetChatModelKey(target = {}, input = {}) {
  if (target?.channel?.type !== "chatplus") return "";
  const lock = requestedModelLock(input);
  if (["gpt-image", "gemini-image"].includes(lock.type)) return lock.key;
  if (lock.type === "chat" && lock.key) return modelRequestKey(lock.key);
  const settings = target.channel.settings || {};
  const defaultKey = modelRequestKey(settings.defaultChatModel);
  if (defaultKey) return defaultKey;
  const route = (Array.isArray(settings.chatModels) ? settings.chatModels : []).find((item) => item?.default && item?.enabled !== false)
    || (Array.isArray(settings.chatModels) ? settings.chatModels.find((item) => item?.enabled !== false) : null);
  return modelRequestKey(route?.key || route?.name || route?.model) || "gpt";
}

function targetImageModelKey(target = {}, input = {}) {
  const requestedKey = requestedImageModelKey(input, target?.channel?.settings || {});
  if (["gpt", "grok", "gemini"].includes(requestedKey)) return requestedKey;
  return target?.channel?.type === "chatplus"
    ? targetChatModelKey(target, input)
    : drawingModelFamily(target?.channel?.settings?.defaultModelId) || "gpt";
}

function imageInputForTarget(target = {}, input = {}) {
  if (target?.channel?.type !== "chatplus") return input;
  return {
    ...input,
    model: targetImageModelKey(target, input)
  };
}

function storedTaskModelKey(task = {}) {
  const rawKey = modelRequestKey(task.raw?.modelFamily || task.raw?.chatModel || task.chatModel);
  if (rawKey === "gpt" || rawKey === "grok" || rawKey === "gemini") return rawKey;
  if (rawKey.includes("gemini")) return "gemini";
  if (rawKey.includes("grok")) return "grok";
  if (rawKey.includes("gpt")) return "gpt";
  const modelKey = modelRequestKey(task.modelId);
  const drawingFamily = drawingModelFamily(modelKey);
  if (drawingFamily) return drawingFamily;
  if (modelKey === "gpt" || modelKey === "grok" || modelKey === "gemini") return modelKey;
  if (modelKey.includes("gemini")) return "gemini";
  if (modelKey.includes("grok")) return "grok";
  if (modelKey.includes("gpt")) return "gpt";
  return "gpt";
}

function storedTaskChatModelKey(task = {}) {
  return storedTaskModelKey(task);
}

function taskSlotKey(slot, target = {}, input = {}) {
  const accountId = String(target?.account?.id || "").trim();
  const modelKey = ["chat", "chatImage"].includes(slot) ? targetChatModelKey(target, input) : "";
  return [slot, modelKey, accountId].filter(Boolean).join(":") || slot;
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

function storedTaskSlot(task = {}) {
  if (task.taskType === "chat") return "chat";
  return task.channelType === "chatplus" ? "chatImage" : "drawingImage";
}

function taskHoldsDurableSlot(task = {}) {
  return isPendingTask(task.status)
    && task.raw?.submitted === true
    && savedTaskExternalId(task);
}

async function durableTaskSlotState(slot, target = {}, input = {}) {
  const accountId = String(target?.account?.id || "").trim();
  if (!accountId) return { total: 0, active: 0 };
  const modelKey = ["chat", "chatImage"].includes(slot) ? targetChatModelKey(target, input) : "";
  const tasks = await listTasks();
  const holdingTasks = tasks.filter((task) =>
    String(task.accountId || "") === accountId
    && storedTaskSlot(task) === slot
    && (!modelKey || storedTaskChatModelKey(task) === modelKey)
    && taskHoldsDurableSlot(task)
  );
  return {
    total: holdingTasks.length,
    active: holdingTasks.filter((task) => activeSubmittedTaskIds.has(task.id)).length
  };
}

async function taskSlotOccupancy(slot, target = {}, input = {}) {
  const key = taskSlotKey(slot, target, input);
  const durableState = await durableTaskSlotState(slot, target, input);
  const count = activeTaskCounts.get(key) || 0;
  return count + durableState.total - Math.min(durableState.active, count);
}

function busyTaskError(slot, target = {}) {
  const error = new Error(`${taskSlotBusyLabel(slot, target)}任务正在处理中，请稍后再试。`);
  error.status = 429;
  error.busy = true;
  return error;
}

async function tryReserveTaskSlot(slot, target = {}, input = {}) {
  const key = taskSlotKey(slot, target, input);
  const durableState = await durableTaskSlotState(slot, target, input);
  const count = activeTaskCounts.get(key) || 0;
  const occupied = count + durableState.total - Math.min(durableState.active, count);
  if (occupied >= taskSlotLimit(slot, target)) return null;
  activeTaskCounts.set(key, count + 1);
  const drawingModelKey = slot === "drawingImage" ? targetImageModelKey(target, input) : "";
  if (drawingModelKey) {
    activeDrawingModelCounts.set(
      drawingModelKey,
      activeCountForDrawingModel(drawingModelKey) + 1
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (activeTaskCounts.get(key) || 0) - 1);
    if (next) activeTaskCounts.set(key, next);
    else activeTaskCounts.delete(key);
    if (drawingModelKey) {
      const nextModelCount = Math.max(0, activeCountForDrawingModel(drawingModelKey) - 1);
      if (nextModelCount) activeDrawingModelCounts.set(drawingModelKey, nextModelCount);
      else activeDrawingModelCounts.delete(drawingModelKey);
    }
  };
}

function accountSessionKey(account = {}, modelKey = "") {
  const baseKey = [
    String(account.username || account.id || "").trim().toLowerCase(),
    String(account.proxyUrl || account.proxy || "").trim()
  ].join("::");
  return modelKey ? `${baseKey}::${modelKey}` : baseKey;
}

async function runChatplusAccountWork(channel, account, work, options = {}) {
  if (channel?.type !== "chatplus") return work();
  const quotaProbeKey = options.quotaProbe === true ? accountSessionKey(account) : "";
  if (quotaProbeKey && activeChatQuotaProbes.has(quotaProbeKey)) {
    throw busyTaskError(options.slot || "chat", { channel, account });
  }
  if (quotaProbeKey) activeChatQuotaProbes.add(quotaProbeKey);

  try {
    if (options.parallel === true) return await work();

    const key = accountSessionKey(account, options.modelKey);
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
  } finally {
    if (quotaProbeKey) activeChatQuotaProbes.delete(quotaProbeKey);
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
  return getClient(config, channel, account);
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
        geminiDrawingModelId: Number(settings.geminiDrawingModelId || 2),
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
      defaultModelId: Number(settings.defaultModelId || 1),
      geminiDrawingModelId: Number(settings.geminiDrawingModelId || 2)
    }
  };
}

function channelAbilityEnabled(channel, ability) {
  const enabled = channel?.settings?.enabledAbilities;
  if (!enabled || typeof enabled !== "object") return true;
  return enabled[ability] !== false;
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
  const abilities = requested ? [requested] : taskType === "chat" ? ["chatplus"] : ["drawing", "chatplus"];
  return abilities.filter((ability) => channelAbilityEnabled(channel, ability));
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

function isExplicitChatQuotaError(error) {
  return Boolean(
    error?.quotaConfirmedByUpstream === true
      && (error?.quotaEmpty || error?.imageQuotaExhausted)
  );
}

function isTerminalTaskFailureError(error) {
  return Boolean(error?.upstreamExplicitFailure);
}

function accountStatusFromError(error, options = {}) {
  const explicitChatQuotaOnly = options.explicitChatQuotaOnly === true;
  const quotaEmpty = explicitChatQuotaOnly
    ? isExplicitChatQuotaError(error)
    : isQuotaEmptyError(error);
  if (quotaEmpty) {
    const requestedCooldown = error?.cooldownUntil || error?.quotaResetAt || null;
    const requestedCooldownTime = Date.parse(requestedCooldown || "");
    const cooldownUntil = explicitChatQuotaOnly && (
      !Number.isFinite(requestedCooldownTime)
      || requestedCooldownTime <= Date.now()
    )
      ? new Date(Date.now() + CHAT_USAGE_RECOVERY_CHECK_MS).toISOString()
      : requestedCooldown;
    return {
      status: "quota_empty",
      ...(explicitChatQuotaOnly
        ? { quota: null, balance: null, used: null }
        : {
            ...(error?.quota !== null && error?.quota !== undefined ? { quota: error.quota } : {}),
            ...(error?.balance !== null && error?.balance !== undefined ? { balance: error.balance } : { balance: 0 }),
            ...(error?.used !== null && error?.used !== undefined ? { used: error.used } : {})
          }),
      quotaResetAt: error?.quotaResetAt || "",
      cooldownUntil,
      quotaReason: error?.quotaReason || "",
      quotaModel: error?.quotaModel || "",
      quotaConfirmedByUpstream: explicitChatQuotaOnly || error?.quotaConfirmedByUpstream === true,
      period: error?.period || "",
      message: error?.message || "额度不足"
    };
  }
  if (isDisconnectedError(error)) {
    return {
      status: "disconnected",
      message: error?.message || "登录掉线，系统稍后会自动重登。"
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

export async function clearAccountCooldown(accountId) {
  const config = await loadRuntimeConfig();
  const account = config.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("账号不存在。");
  const channel = config.channels.find((item) => item.id === account.channelId);
  if (!channel) throw new Error("账号所属渠道不存在。");

  const patch = {
    status: "ok",
    cooldownUntil: null,
    cooldownReason: "",
    upstreamFailureCode: "",
    upstreamFailureStreak: 0,
    message: "已手动解除绘图冷却"
  };

  if (channel.type === "shareai") {
    if (!channelAbilityEnabled(channel, "drawing")) throw new Error("这个渠道没有启用绘图站。");
    await updateTargetAccountStatus(account.id, shareAIAbilityChannel(channel, "drawing"), patch);
    return { accountId: account.id, ability: "drawing", status: "ok" };
  }

  if (channel.type === "drawing") {
    await updateTargetAccountStatus(account.id, channel, patch);
    return { accountId: account.id, ability: "drawing", status: "ok" };
  }

  throw new Error("这个账号不是绘图账号，不能解除绘图冷却。");
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
  const requested = task.channelId || task.channelType || "";
  const channel = config.channels.find((item) =>
    item.type === "shareai"
      && [item.id, `${item.id}:drawing`, `${item.id}:chatplus`].includes(String(requested))
  ) || config.channels.find((item) => item.type === "shareai" && item.enabled !== false)
    || config.channels.find((item) => item.type === "shareai");
  if (!channel) return null;
  const ability = requestedAbility(channel, requested) || (task.channelType === "chatplus" ? "chatplus" : task.channelType === "drawing" ? "drawing" : "");
  return ability && channelAbilityEnabled(channel, ability) ? shareAIAbilityChannel(channel, ability) : null;
}

function inferRefreshTarget(config, task) {
  let channel = config.channels.find((item) => item.id === task.channelId);
  if (!channel && String(task.channelId || "").includes(":")) {
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

function refreshTargetDisabled(channel, account) {
  return channel?.enabled === false || account?.enabled === false;
}

function disabledRefreshMessage(channel, account) {
  if (account?.enabled === false) {
    return "账号已停用，系统已停止刷新这个旧任务，不会再登录该账号。";
  }
  if (channel?.enabled === false) {
    return "渠道已停用，系统已停止刷新这个旧任务。";
  }
  return "任务所属账号或渠道已停用，系统已停止刷新这个旧任务。";
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

function taskConversationId(task) {
  return task.raw?.conversationId
    || task.raw?.conversation_id
    || task.responseJson?.conversationId
    || task.responseJson?.conversation_id
    || task.externalId
    || "";
}

function upstreamConversationUrl(channel, conversationId) {
  const baseUrl = String(channel?.settings?.baseUrl || "https://www.chatplus.cc").trim().replace(/\/+$/, "");
  return baseUrl && conversationId ? `${baseUrl}/c/${encodeURIComponent(conversationId)}` : "";
}

function upstreamDetailTitle(raw = {}) {
  return String(raw.title || raw.conversation?.title || raw.mapping?.title || "").trim();
}

export async function inspectUpstreamTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");

  const config = await loadRuntimeConfig();
  const { channel, account } = inferRefreshTarget(config, task);
  if (channel.type !== "chatplus") {
    const error = new Error("这个任务不是聊天生图，不能读取上游聊天详情。");
    error.status = 400;
    throw error;
  }

  const externalId = taskConversationId(task) || taskExternalId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) {
    const error = new Error("这个任务还没有保存上游对话编号。");
    error.status = 400;
    throw error;
  }

  const client = getWorkClient(config, channel, account);
  if (typeof client.getTask !== "function") {
    const error = new Error("当前上游不支持读取会话详情。");
    error.status = 400;
    throw error;
  }

  const result = await runChatplusAccountWork(channel, account, () => client.getTask(externalId, {
    carId: task.raw?.selectedCarId,
    carType: task.raw?.selectedCarType
  }));
  const raw = result.raw || {};
  const conversationId = String(raw.conversationId || raw.conversation_id || externalId).trim();

  return {
    taskId: task.id,
    sourceTaskId: task.sourceTaskId || task.requestMeta?.sourceTaskId || "",
    externalId,
    conversationId,
    conversationUrl: upstreamConversationUrl(channel, conversationId),
    title: upstreamDetailTitle(raw) || upstreamDetailTitle(task.raw || {}),
    status: result.status || task.status || "",
    imageCount: Number(result.imageCount || 0),
    imageUrls: result.imageUrls || [],
    errorMessage: result.errorMessage || task.errorMessage || task.responseJson?.message || "",
    channelId: channel.id,
    channelName: channel.name,
    accountId: account.id,
    accountName: account.name,
    carId: String(task.raw?.selectedCarId || raw.selectedCarId || "").trim(),
    carType: String(task.raw?.selectedCarType || raw.selectedCarType || "").trim(),
    raw
  };
}

function resultUpstreamText(result = {}) {
  const text = String(result.upstreamText || drawingUpstreamText(result.raw) || "");
  return text.trim() ? text : "";
}

function taskErrorMessage(result, task) {
  const upstreamText = ["failed", "cancelled"].includes(result.status)
    ? resultUpstreamText(result)
    : "";
  const itemError = (result.raw?.items || [])
    .map((item) => item?.error_message || item?.message || "")
    .filter(Boolean)
    .join("；");
  return upstreamText || result.errorMessage || itemError || task.errorMessage || "";
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

function isTerminalRefreshError(error) {
  return error?.code === "INVALID_UPSTREAM_RESPONSE";
}

function failedRefreshResult(task, externalId, error) {
  return {
    externalId,
    taskNo: task.taskNo || "",
    status: "failed",
    prompt: task.prompt || "",
    taskType: task.taskType || "",
    modelId: task.modelId || "",
    ratio: task.ratio || "",
    imageCount: task.imageCount ?? 0,
    imageUrls: [],
    errorMessage: error?.message || "上游任务刷新失败。",
    raw: {
      ...(task.raw || {}),
      refreshError: true,
      refreshErrorAt: new Date().toISOString(),
      refreshStatus: error?.status || error?.statusCode || "",
      refreshCode: error?.code || "",
      refreshPayload: error?.payload || null
    }
  };
}

function usableImageResultUrls(urls = []) {
  return [...new Set((Array.isArray(urls) ? urls : []).filter((value) => {
    const source = String(value || "").trim();
    if (!source) return false;
    try {
      return !/^\/image_generation_content\/\d+$/i.test(new URL(source).pathname.replace(/\/+$/, ""));
    } catch {
      return !/(?:^|\/)image_generation_content\/\d+(?:$|[?#])/i.test(source);
    }
  }))];
}

async function mirrorTaskImages(result, config, client = null) {
  const imageUrls = usableImageResultUrls(result?.imageUrls);
  if (!imageUrls.length) return result;
  const downloadImage = typeof result?.downloadImage === "function"
    ? result.downloadImage
    : typeof client?.downloadResultImage === "function"
      ? (url, options = {}) => client.downloadResultImage(url, {
          ...options,
          carId: result?.raw?.selectedCarId,
          carType: result?.raw?.selectedCarType
        })
      : undefined;
  const mirroredUrls = await mirrorImageUrls(imageUrls, config, { downloadImage });
  return {
    ...result,
    imageCount: mirroredUrls.length,
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
  if (channelType === "chatplus" || !channelType) {
    Object.assign(patch, {
      quota: null,
      balance: null,
      used: null,
      quotaResetAt: "",
      cooldownUntil: null,
      quotaReason: "",
      quotaConfirmedByUpstream: false,
      period: ""
    });
  }
  await updateTargetAccountStatus(accountId, channel, patch);
}

function drawingFailureTextFromResult(result = {}) {
  const itemErrors = (result?.raw?.items || [])
    .flatMap((item) => [item?.error_message || item?.message || "", item?.result_text || item?.resultText || ""])
    .filter(Boolean);
  return [result.errorMessage, resultUpstreamText(result), ...itemErrors].filter(Boolean).join("；");
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
    await updateTargetAccountStatus(account.id, channel, accountStatusFromError(error, {
      explicitChatQuotaOnly: channel?.type === "chatplus"
    }));
    return;
  }
  await withAccountAuthLock(account, () => (
    updateTargetAccountStatus(account.id, channel, drawingRateLimitPatch(retryAfterSeconds))
  ));
}

async function updateAccountAfterTask(account, channel, result = {}) {
  if (channel?.type === "chatplus") {
    const config = await loadRuntimeConfig();
    const currentAccount = config.accounts.find((item) => item.id === account.id) || account;
    const ability = channelAbilityKey(channel);
    const currentStatus = ability
      ? currentAccount.meta?.abilities?.[ability] || {}
      : currentAccount;
    if (
      result.taskType === "chat"
      && currentStatus.status === "quota_empty"
      && currentStatus.quotaConfirmedByUpstream === true
      && currentStatus.quotaReason === "image_quota"
    ) {
      return false;
    }
    await markAccountAvailable(account.id, channel);
    return false;
  }
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
    upstreamText: resultUpstreamText(result) || task.upstreamText || "",
    errorMessage: taskErrorMessage(result, task),
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : task.completedAt || null,
    requestJson: task.requestJson || null,
    responseJson: attachResponseSourceTaskId(taskResponseJson(result), task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)),
    raw: {
      ...(task.raw || {}),
      ...(result.raw || {})
    }
  };
}

async function interruptDisabledRefreshTask(task, channel, account) {
  const interruptedAt = new Date().toISOString();
  const message = disabledRefreshMessage(channel, account);
  const interruptedTask = {
    ...task,
    status: "interrupted",
    errorMessage: "",
    responseJson: { ok: null, message },
    raw: {
      ...(task.raw || {}),
      interrupted: true,
      interruptedAt,
      interruptedReason: message,
      disabledRefreshSkipped: true
    },
    completedAt: interruptedAt
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
}

async function interruptUnrecoverableGeminiTask(task) {
  const interruptedAt = new Date().toISOString();
  const message = "这个旧 Gemini 任务没有保存返回内容，无法自动恢复；任务已停止，不计入失败。";
  const interruptedTask = {
    ...task,
    status: "interrupted",
    errorMessage: "",
    responseJson: { ok: null, message },
    completedAt: interruptedAt,
    raw: {
      ...(task.raw || {}),
      interrupted: true,
      interruptedAt,
      interruptedReason: message,
      geminiResultMissing: true
    }
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
}

export async function refreshTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");
  if (!needsTaskRefresh(task)) return task;

  const config = await loadRuntimeConfig();
  const { channel, account } = inferRefreshTarget(config, task);
  if (refreshTargetDisabled(channel, account)) {
    return interruptDisabledRefreshTask(task, channel, account);
  }
  const client = getWorkClient(config, channel, account);
  if (typeof client.getTask !== "function") return task;

  const externalId = taskExternalId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) return task;

  const taskStillActive = scheduledImageTasks.has(task.id) || activeSubmittedTaskIds.has(task.id);
  const originalImageUrls = storedOriginalImageUrls(task);
  if (originalImageUrls.length) {
    if (taskStillActive) return task;
    try {
      const result = await mirrorTaskImages({
        externalId,
        status: "success",
        prompt: task.prompt,
        taskType: task.taskType,
        modelId: task.modelId,
        ratio: task.ratio,
        imageCount: originalImageUrls.length,
        imageUrls: originalImageUrls,
        raw: {
          ...(task.raw || {}),
          originalImageUrls,
          imageMirrorPending: false
        }
      }, config, client);
      const nextTask = mergeRefreshedTask(task, result, channel, account);
      await upsertTask(nextTask);
      await recordTaskStat(nextTask);
      await updateAccountAfterTask(account, channel, nextTask);
      return nextTask;
    } catch (error) {
      return keepSubmittedTaskRecoverable(task, error, task.attempts || []);
    }
  }

  if (storedTaskModelKey(task) === "gemini" && task.raw?.submitted === true) {
    if (taskStillActive) return task;
    return interruptUnrecoverableGeminiTask(task);
  }

  let refreshedResult;
  try {
    refreshedResult = await runChatplusAccountWork(channel, account, () => client.getTask(externalId, {
      carId: task.raw?.selectedCarId,
      carType: task.raw?.selectedCarType
    }));
  } catch (error) {
    if (!isTerminalRefreshError(error)) throw error;
    refreshedResult = failedRefreshResult(task, externalId, error);
  }
  const result = await mirrorTaskImages(refreshedTaskWaitState(task, refreshedResult, config.waitTimeoutSec), config, client);
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
  const current = await getTask(task.id);
  if (!current || !isLostLocalChatTask(current)) return current || task;
  return failQueuedTask(current, new Error("这个旧对话任务已经没有后台执行进程，已停止。"), current.attempts || []);
}

function isLostLocalImageTask(task) {
  return task.taskType !== "chat"
    && isPendingTask(task.status)
    && task.raw?.queued === true
    && !savedTaskExternalId(task)
    && !scheduledImageTasks.has(task.id);
}

async function interruptLostLocalImageTask(task) {
  const current = await getTask(task.id);
  if (!current || !isLostLocalImageTask(current)) return current || task;
  const interruptedAt = new Date().toISOString();
  const message = "服务重启时任务被中断，尚未保存上游任务编号，无法确认最终结果；此任务不计失败。";
  const interruptedTask = {
    ...current,
    status: "interrupted",
    errorMessage: "",
    responseJson: { ok: null, message },
    raw: {
      ...(current.raw || {}),
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
  return channel.type === "shareai" && channel.id === "shareai" && account.channelId === "shareai";
}

function modelRequestKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

const chatModelRequestKeys = new Set(["gpt", "grok", "gemini"]);
const gptImageModelRequestKeys = new Set(["1", "gpt-image-2", "chatgpt-image-2"]);
const geminiImageModelRequestKeys = new Set([
  "2",
  "3",
  "nano-banana-pro",
  "nano-banana"
]);
const drawingModelRequestKeys = new Set([
  ...gptImageModelRequestKeys,
  ...geminiImageModelRequestKeys
]);

function drawingModelFamily(value) {
  const key = modelRequestKey(value);
  if (gptImageModelRequestKeys.has(key) || key === "gpt") return "gpt";
  if (geminiImageModelRequestKeys.has(key) || key === "gemini") return "gemini";
  return "";
}

function requestedModelLock(input = {}) {
  const explicitModel = input.model || input.chat_model || input.chatModel || "";
  const explicitKey = modelRequestKey(explicitModel);
  if (explicitKey && explicitKey !== "auto") {
    if (chatModelRequestKeys.has(explicitKey)) return { type: "chat", key: explicitKey };
    if (gptImageModelRequestKeys.has(explicitKey)) return { type: "gpt-image", key: "gpt" };
    if (geminiImageModelRequestKeys.has(explicitKey)) return { type: "gemini-image", key: "gemini" };
    if (drawingModelRequestKeys.has(explicitKey)) return { type: "drawing" };
    return { type: "chat", key: explicitKey };
  }

  const imageModelKey = modelRequestKey(input.model_id ?? input.modelId ?? "");
  if (!imageModelKey || imageModelKey === "auto") return { type: "auto" };
  if (gptImageModelRequestKeys.has(imageModelKey)) return { type: "gpt-image", key: "gpt" };
  if (geminiImageModelRequestKeys.has(imageModelKey)) return { type: "gemini-image", key: "gemini" };
  return { type: "drawing" };
}

function requestedImageModelKey(input = {}, settings = {}) {
  const lock = requestedModelLock(input);
  if (["gpt-image", "gemini-image"].includes(lock.type)) return lock.key;
  if (lock.type === "chat" && ["gpt", "grok", "gemini"].includes(lock.key)) return lock.key;
  return drawingModelFamily(
    input.model_id
      ?? input.modelId
      ?? input.model
      ?? settings.defaultModelId
      ?? 1
  ) || "gpt";
}

function requestedChannelForInput(config, input = {}) {
  const requestedChannel = String(input.channel || "").trim();
  if (requestedChannel) return requestedChannel;
  return requestedModelLock(input).type === "auto" ? config.defaultChannel || "auto" : "auto";
}

function targetMatchesRequestedModel(target, taskType, input = {}) {
  const lock = requestedModelLock(input);
  if (taskType === "chat") {
    if (["gpt-image", "gemini-image"].includes(lock.type)) {
      return targetSupportsChatModel(target, lock.key);
    }
    return lock.type !== "chat" || targetSupportsChatModel(target, lock.key);
  }
  if (lock.type === "auto") return true;
  if (lock.type === "chat") {
    if (!["gpt", "gemini"].includes(lock.key)) {
      return target.channel.type === "chatplus" && targetSupportsChatModel(target, lock.key);
    }
    return target.channel.type === "drawing"
      || (target.channel.type === "chatplus" && targetSupportsChatModel(target, lock.key));
  }
  if (["gpt-image", "gemini-image"].includes(lock.type)) {
    return target.channel.type === "drawing"
      || (target.channel.type === "chatplus" && targetSupportsChatModel(target, lock.key));
  }
  if (lock.type === "drawing") return target.channel.type === "drawing";
  return true;
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

function orderTargetsByImageSource(config, taskType, targets) {
  if (taskType === "chat") return targets;
  const preferred = config.imageSourcePriority === "drawing" ? "drawing" : "chatplus";
  return [
    ...targets.filter((target) => target.channel.type === preferred),
    ...targets.filter((target) => target.channel.type !== preferred)
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
  const matchedTargets = targets.filter((target) => targetMatchesRequestedModel(target, taskType, options.input));
  return orderTargetsByImageSource(config, taskType, matchedTargets);
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
    upstreamText: resultUpstreamText(result),
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

function targetQuotaEmpty(target) {
  const status = targetQuotaStatus(target);
  const quotaEmpty = String(status.status || "").toLowerCase() === "quota_empty";
  if (target?.channel?.type !== "chatplus") return quotaEmpty;
  return quotaEmpty && status.quotaConfirmedByUpstream === true;
}

function statusAccountUsageEmpty(status = {}) {
  return String(status.status || "").toLowerCase() === "quota_empty"
    && status.quotaReason === "chat_usage_limit"
    && status.quotaConfirmedByUpstream === true;
}

function targetAccountUsageEmpty(target) {
  return statusAccountUsageEmpty(targetQuotaStatus(target));
}

function targetLastCheckAt(target, status = {}) {
  const checkedAt = Date.parse(status.lastCheckAt || target?.account?.lastCheckAt || "");
  return Number.isFinite(checkedAt) ? checkedAt : 0;
}

function chatRecoveryUsage(status = {}) {
  const referenceUsage = status.meta?.referenceUsage;
  if (referenceUsage && typeof referenceUsage === "object") {
    const keys = [
      status.quotaModel,
      status.meta?.chatModel,
      status.quotaReason === "image_quota" ? "gemini" : "",
      "gpt"
    ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    for (const key of new Set(keys)) {
      if (referenceUsage[key] && typeof referenceUsage[key] === "object") {
        return referenceUsage[key];
      }
    }
  }
  const directUsage = status.meta?.recoveryUsage;
  return directUsage && typeof directUsage === "object" ? directUsage : null;
}

function targetConfirmedQuotaBlocksTask(target, taskType) {
  if (target?.channel?.type !== "chatplus" || !targetQuotaEmpty(target)) return false;
  const status = targetQuotaStatus(target);
  return status.quotaReason !== "image_quota" || taskType !== "chat";
}

function targetConfirmedQuotaRetryDue(target) {
  const status = targetQuotaStatus(target);
  const cooldownAt = Date.parse(status.cooldownUntil || "");
  if (Number.isFinite(cooldownAt) && cooldownAt > Date.now()) return false;
  const recoveryUsage = chatRecoveryUsage(status);
  const recoveryBalance = Number(recoveryUsage?.balance);
  if (Number.isFinite(recoveryBalance) && recoveryBalance > 0) return true;
  const resetAt = Date.parse(
    status.quotaReason === "image_quota"
      ? status.imageQuotaResetAt || status.quotaResetAt || recoveryUsage?.quotaResetAt || ""
      : status.quotaResetAt || recoveryUsage?.quotaResetAt || ""
  );
  if (Number.isFinite(resetAt)) return resetAt <= Date.now();
  if (Number.isFinite(cooldownAt)) return cooldownAt <= Date.now();
  return Date.now() - targetLastCheckAt(target, status) >= CHAT_USAGE_RECOVERY_CHECK_MS;
}

function admissionTargets(targets, taskType, options = {}) {
  const skipKnownQuotaEmpty = options.skipKnownQuotaEmpty === true;
  return targets.filter((target) => !(
    targetKnownUnavailable(target)
      || (
        targetConfirmedQuotaBlocksTask(target, taskType)
        && !targetConfirmedQuotaRetryDue(target)
      )
      || (
        skipKnownQuotaEmpty
        && taskType !== "chat"
        && target.channel.type !== "chatplus"
        && targetQuotaEmpty(target)
      )
  ));
}

function targetRecoveryKey(target) {
  return `${target?.channel?.id || "channel"}:${target?.account?.id || "account"}`;
}

function targetNeedsRecovery(target) {
  const quotaStatus = targetQuotaStatus(target);
  const status = String(quotaStatus.status || "unknown").toLowerCase();
  if (target?.channel?.type === "chatplus") {
    if (status === "quota_empty") {
      return targetQuotaEmpty(target) && targetConfirmedQuotaRetryDue(target);
    }
    return (
      accountCooling(target.account)
      || ["error", "failed", "disconnected"].includes(status)
    );
  }
  if (status === "quota_empty") {
    const resetAt = Date.parse(
      quotaStatus.quotaReason === "image_quota"
        ? quotaStatus.imageQuotaResetAt || quotaStatus.quotaResetAt || ""
        : quotaStatus.quotaResetAt || quotaStatus.cooldownUntil || ""
    );
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) return true;
    return false;
  }
  return ["error", "failed", "disconnected"].includes(status);
}

async function recoverTarget(config, target) {
  if (refreshTargetDisabled(target?.channel, target?.account)) return null;
  const key = targetRecoveryKey(target);
  const active = accountRecoveryTasks.get(key);
  if (active) return active;
  if ((accountRecoveryRetryAt.get(key) || 0) > Date.now()) return null;

  const recovery = (async () => {
    const currentStatus = targetQuotaStatus(target);
    try {
      const checked = successfulAccountCheckStatus(
        await runChatplusAccountWork(
          target.channel,
          target.account,
          () => getClient(config, target.channel, target.account).check({
            model: target.channel.type === "chatplus" ? currentStatus.quotaModel || "" : ""
          })
        )
      );
      const status = target.channel.type === "chatplus"
        ? preserveConfirmedChatQuota(currentStatus, checked)
        : checked;
      await updateTargetAccountStatus(target.account.id, target.channel, {
        ...status,
        cooldownUntil: status.status === "ok" ? null : status.cooldownUntil
      });
      if (status.status === "ok") {
        accountRecoveryRetryAt.delete(key);
        return status;
      }
      if (status.status === "quota_empty") {
        accountRecoveryRetryAt.delete(key);
        return status;
      }
      accountRecoveryRetryAt.set(key, Date.now() + ACCOUNT_RECOVERY_RETRY_MS);
      return null;
    } catch (error) {
      const errorStatus = accountStatusFromError(error, {
        explicitChatQuotaOnly: target.channel.type === "chatplus"
      });
      const status = target.channel.type === "chatplus"
        ? preserveConfirmedChatQuota(currentStatus, errorStatus)
        : errorStatus;
      await updateTargetAccountStatus(target.account.id, target.channel, status);
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
  const targets = selectTargets(config, "auto", "img2img", { includeCooling: true });
  const recoveryTargets = [...new Map(
    targets
      .filter(targetNeedsRecovery)
      .map((target) => [targetRecoveryKey(target), target])
  ).values()];

  return Promise.all(recoveryTargets.map(async (target) => {
    const status = await recoverTarget(config, target);
    return {
      accountId: target.account.id,
      channelId: target.channel.id,
      recovered: status?.status === "ok",
      status: status?.status || targetQuotaStatus(target).status || "unknown"
    };
  }));
}

async function selectReadyTargets(config, requestedChannel, taskType, options = {}) {
  const targets = selectTargets(config, requestedChannel, taskType, {
    ...options,
    includeCooling: true
  });
  const ready = admissionTargets(targets, taskType, options).filter((target) => !(
    (
      targetAbilityCooling(target)
      && !(target.channel.type === "chatplus" && !targetQuotaEmpty(target))
    )
      || (
        target.channel.type === "chatplus"
        && accountCooling(target.account)
        && targetQuotaStatus(target).status !== "quota_empty"
      )
  ));
  const recoveryTargets = options.skipRecovery
    ? []
    : targets.filter((target) => targetNeedsRecovery(target) && !ready.some((item) => sameTarget(item, target)));
  if (!recoveryTargets.length) return ready;

  const recoveries = recoveryTargets.map((target) => recoverTarget(config, target));
  if (ready.length) {
    Promise.all(recoveries).catch((error) => console.error(error));
    return ready;
  }
  const recovered = await Promise.all(recoveries);
  return recoveryTargets.filter((_target, index) => (
    recovered[index]?.status === "ok"
      || (taskType === "chat" && recovered[index]?.status === "quota_empty" && !statusAccountUsageEmpty(recovered[index]))
  ));
}

export async function reserveImageTaskAdmission(input = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", {
    accountId: requestedAccountId,
    skipKnownQuotaEmpty: true,
    input
  });
  if (!targets.length) {
    throw noUsableTargetError("img2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }
  const reserved = await reserveFirstAvailableTarget(targets, "img2img", {
    input
  });
  return {
    ...reserved,
    modelKey: targetImageModelKey(reserved.target, input)
  };
}

export function attachImageAdmissionToRequest(admission, request) {
  const raw = request?.raw || request;
  if (!admission?.release || typeof raw?.once !== "function") return admission;

  let handedOff = false;
  let listening = true;
  const releaseReservedSlot = admission.release;
  const detach = () => {
    if (!listening) return;
    listening = false;
    raw.removeListener?.("aborted", releaseBeforeHandoff);
    raw.removeListener?.("error", releaseBeforeHandoff);
    raw.removeListener?.("close", releaseIfUploadIncomplete);
  };
  const release = () => {
    detach();
    releaseReservedSlot();
  };
  const releaseBeforeHandoff = () => {
    if (!handedOff) release();
  };
  const releaseIfUploadIncomplete = () => {
    if (raw.complete !== true) releaseBeforeHandoff();
  };

  raw.once("aborted", releaseBeforeHandoff);
  raw.once("error", releaseBeforeHandoff);
  raw.once("close", releaseIfUploadIncomplete);

  if (raw.aborted === true || (raw.destroyed === true && raw.complete !== true)) {
    releaseBeforeHandoff();
  }

  return {
    ...admission,
    release,
    handoff() {
      handedOff = true;
      detach();
    }
  };
}

export async function assertImageTaskAdmission(input = {}) {
  const reserved = await reserveImageTaskAdmission(input);
  reserved.release();
  return true;
}

function noUsableTargetError(taskType, options = {}) {
  const allTargets = options.config
    ? selectTargets(options.config, options.requestedChannel || "auto", taskType, {
      accountId: options.accountId || "",
      includeCooling: true,
      input: options.input || {}
    })
    : [];
  const chatTargets = allTargets.filter((target) => target.channel.type === "chatplus");
  const chatUsageEmpty = chatTargets.length > 0
    && chatTargets.length === allTargets.length
    && chatTargets.every(targetAccountUsageEmpty);

  if (chatUsageEmpty) {
    const quotaResetAt = chatTargets
      .map((target) => targetQuotaStatus(target).quotaResetAt || "")
      .filter((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now())
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
    const resetText = quotaResetAt.replace("T", " ").replace("+08:00", "");
    const error = new Error(resetText
      ? `聊天额度已用完，请等待 ${resetText} 刷新后再试。`
      : "聊天额度已用完，请等待额度刷新后再试。");
    error.status = 429;
    error.code = "CHAT_USAGE_LIMIT";
    error.quotaEmpty = true;
    error.quotaResetAt = quotaResetAt;
    return error;
  }

  const error = new Error(taskType === "chat"
    ? "当前没有可用的对话账号，请先检测账号状态。"
    : "当前没有可用的生图账号，请先检测账号状态或等待额度恢复。");
  error.status = 503;
  return error;
}

function shouldRefreshQuotaBeforeUse(target, taskType) {
  if (target.channel.type === "chatplus") return false;
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
    const patch = accountStatusFromError(error, {
      explicitChatQuotaOnly: target.channel.type === "chatplus"
    });
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

async function refreshQuotaBeforeUseFast(config, target, attempts, timeoutMs = FAST_QUOTA_REFRESH_TIMEOUT_MS) {
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

async function reserveFirstAvailableTarget(targets, taskType, options = {}) {
  const attempts = [];
  for (const target of targets) {
    if (options.confirmBeforeReserve && !(await options.confirmBeforeReserve(target, attempts))) continue;
    const slot = targetTaskSlot(target, taskType);
    const release = await tryReserveTaskSlot(slot, target, options.input || {});
    if (release) return { target, release, attempts };
    attempts.push(targetBusyAttempt(target, taskType));
  }
  if (attempts.length && attempts.every((attempt) => attempt.quotaEmpty)) {
    throw targetsFailedError(attempts);
  }
  const details = attemptErrorMessage(attempts);
  const error = new Error(details ? `并发上限：${details}` : "并发上限");
  error.status = 429;
  error.code = "CONCURRENCY_LIMIT";
  error.busy = true;
  error.attempts = attempts;
  throw error;
}

function consumeAdmissionReservation(admission, targets, input = {}) {
  if (!admission?.release) return null;
  const target = targets.find((item) => sameTarget(item, admission.target));
  const preferredType = targets[0]?.channel?.type || "";
  const requestedModelKey = target ? targetImageModelKey(target, input) : "";
  if (
    !target
    || (preferredType && target.channel.type !== preferredType)
    || (admission.modelKey && admission.modelKey !== requestedModelKey)
  ) {
    admission.release();
    return null;
  }
  return {
    target,
    release: admission.release,
    handoff: admission.handoff,
    attempts: Array.isArray(admission.attempts) ? admission.attempts : []
  };
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
  const quotaExhausted = attempts.length > 0 && attempts.every((item) => item.quotaEmpty);
  const chatUsageExhausted = quotaExhausted && attempts.every((item) => (
    /chatplus|聊天生图/.test(`${item.channelId || ""} ${item.channelName || ""}`)
      && /聊天(?:使用次数|额度).{0,24}(?:用完|耗尽|上限)|使用次数已达上限|usage count has reached the limit|usage.*limit/i.test(String(item.message || ""))
  ));
  const details = attemptErrorMessage(attempts);
  let message = `所有渠道都失败：${details}`;
  if (concurrencyLimited) message = details ? `并发上限：${details}` : "并发上限";
  else if (chatUsageExhausted) message = "聊天额度已用完，请等待额度刷新后再试。";
  const error = new Error(message);
  error.attempts = attempts;
  if (concurrencyLimited) {
    error.status = 429;
    error.code = "CONCURRENCY_LIMIT";
    error.busy = true;
  }
  if (quotaExhausted) {
    error.status = 429;
    error.code = chatUsageExhausted ? "CHAT_USAGE_LIMIT" : "QUOTA_EXHAUSTED";
    error.quotaEmpty = true;
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
    modelId: input.model_id || input.modelId || input.model || "",
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
    raw: {
      queued: true,
      ...(taskType !== "chat"
        ? { modelFamily: targetImageModelKey(target, input) }
        : {}),
      ...(raw || {}),
      ...(target.channel.type === "chatplus"
        ? { chatModel: targetChatModelKey(target, input) }
        : {})
    },
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
  const upstreamText = String(error.upstreamText || "").trim();
  const sourceTaskId = task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson);
  const failedTask = {
    ...task,
    status: "failed",
    upstreamText: upstreamText || task.upstreamText || "",
    errorMessage: error.message || readableAttemptError(attempts) || "任务失败",
    statusCode,
    attempts,
    responseJson: {
      ok: false,
      message: responseMessage,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      ...(statusCode ? { status: statusCode } : {}),
      ...(code ? { code } : {}),
      ...(upstreamText ? { upstreamText } : {}),
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
  if (!isFinishedTask(status) && task.raw?.submitted === true && savedTaskExternalId(nextTask)) {
    nextTask.raw = {
      ...(nextTask.raw || {}),
      queued: false,
      submitted: true,
      submittedAt: task.raw.submittedAt || nextTask.raw?.submittedAt || new Date().toISOString()
    };
  }
  await upsertTask(nextTask);
  if (isFinishedTask(nextTask.status)) await recordTaskStat(nextTask);
  await updateAccountAfterTask(account, channel, nextTask);
  scheduleDrawingQuotaRefresh(account, channel);
  return nextTask;
}

async function persistSubmittedTask(task, result, channel, account, attempts) {
  if (!savedTaskExternalId(result)) return task;
  const upstreamCompleted = result?.status === "success";
  if (isFinishedTask(result?.status) && !upstreamCompleted) return task;
  const submittedTask = mergeRefreshedTask(task, {
    ...result,
    status: upstreamCompleted ? "processing" : result.status || "processing"
  }, channel, account);
  submittedTask.attempts = attempts;
  submittedTask.completedAt = null;
  submittedTask.raw = {
    ...(submittedTask.raw || {}),
    queued: false,
    submitted: true,
    submittedAt: task.raw?.submittedAt || new Date().toISOString(),
    ...(upstreamCompleted
      ? {
          upstreamCompleted: true,
          upstreamStatus: result.status,
          originalImageUrls: usableImageResultUrls(result.imageUrls)
        }
      : {})
  };
  await upsertTask(submittedTask);
  activeSubmittedTaskIds.add(submittedTask.id);
  return submittedTask;
}

function storedOriginalImageUrls(task = {}) {
  const urls = [
    ...(Array.isArray(task.raw?.originalImageUrls) ? task.raw.originalImageUrls : []),
    ...(task.raw?.upstreamCompleted && Array.isArray(task.imageUrls) ? task.imageUrls : [])
  ];
  return usableImageResultUrls(urls);
}

async function keepSubmittedTaskRecoverable(task, error, attempts = []) {
  const originalImageUrls = storedOriginalImageUrls(task);
  const now = new Date().toISOString();
  const message = originalImageUrls.length
    ? "图片已经生成，正在重新保存到服务器。"
    : "任务已经提交，但结果保存中断，系统会继续尝试。";
  const nextTask = {
    ...task,
    status: "waiting_upstream",
    imageCount: originalImageUrls.length || Number(task.imageCount || 0),
    imageUrls: originalImageUrls.length ? originalImageUrls : task.imageUrls || [],
    errorMessage: "",
    attempts,
    responseJson: attachResponseSourceTaskId(
      { ok: null, message },
      task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)
    ),
    completedAt: null,
    raw: {
      ...(task.raw || {}),
      queued: false,
      submitted: true,
      waitingUpstream: true,
      waitingSince: task.raw?.waitingSince || now,
      imageMirrorPending: originalImageUrls.length > 0,
      ...(originalImageUrls.length ? { originalImageUrls } : {}),
      resultSaveError: error?.message || "结果保存中断。",
      resultSaveErrorCode: error?.code || "",
      resultSaveErrorAt: now
    }
  };
  await upsertTask(nextTask);
  return nextTask;
}

async function runQueuedTextTask(task, input, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { input });
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
        release = await tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target, input);
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
          const chatplusConcurrentSubmit = channel.type === "chatplus" && options.chatplusConcurrentSubmit !== false;
          let result = await client.createTextTask({
            ...imageInputForTarget(target, input),
            onSubmitted,
            ...(channel.type === "chatplus" ? { concurrentSubmit: chatplusConcurrentSubmit } : {}),
            waitForImages: options.waitForChatplusImages === true
          });
          taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
          scheduleDrawingQuotaRefresh(account, channel);
          if (channel.type === "drawing" && !isFinishedTask(result.status)) {
            result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
          }
          result = await mirrorTaskImages(result, config, client);
          return finishQueuedTask(taskState, result, channel, account, attempts);
        }, {
          parallel: options.chatplusConcurrentSubmit !== false && options.noChatplusQueue !== true,
          noQueue: options.noChatplusQueue,
          slot: targetTaskSlot(target, "text2img"),
          modelKey: targetChatModelKey(target, input),
          quotaProbe: targetConfirmedQuotaBlocksTask(target, "text2img") && targetConfirmedQuotaRetryDue(target),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        if (savedTaskExternalId(taskState)) {
          if (isTerminalTaskFailureError(error)) {
            pushAttempt(attempts, target, error.message || "调用失败");
            return failQueuedTask(taskState, error, attempts);
          }
          return keepSubmittedTaskRecoverable(taskState, error, attempts);
        }
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败");
          continue;
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          busy: Boolean(error.busy),
          quotaEmpty: channel.type === "chatplus"
            ? isExplicitChatQuotaError(error)
            : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy) {
          await updateTargetStatusAfterError(account, channel, error);
        }
      } finally {
        activeSubmittedTaskIds.delete(taskState.id);
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
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", { accountId: requestedAccountId, input });
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
      }
      let taskState = task;
      try {
        if (!(await ensureTargetReady(config, target, "img2img", attempts, {
          skipQuotaRefresh: options.fastQuotaRefresh || options.noChatplusQueue
        }))) continue;
        if (!release) {
          release = await tryReserveTaskSlot(targetTaskSlot(target, "img2img"), target, input);
          if (!release) {
            attempts.push(targetBusyAttempt(target, "img2img"));
            continue;
          }
        }
        const finishedTask = await runChatplusAccountWork(channel, account, async () => {
          const client = getWorkClient(config, channel, account);
          const onSubmitted = async (submittedResult) => {
            taskState = await persistSubmittedTask(taskState, submittedResult, channel, account, attempts);
          };
          const chatplusConcurrentSubmit = channel.type === "chatplus" && options.chatplusConcurrentSubmit !== false;
          let result = await submitImageTask(client, {
            ...imageInputForTarget(target, input),
            onSubmitted,
            ...(channel.type === "chatplus" ? { concurrentSubmit: chatplusConcurrentSubmit } : {}),
            waitForImages: options.waitForChatplusImages === true
          }, files);
          taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
          scheduleDrawingQuotaRefresh(account, channel);
          if (channel.type === "drawing" && !isFinishedTask(result.status)) {
            result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
          }
          result = await mirrorTaskImages(result, config, client);
          return finishQueuedTask(taskState, result, channel, account, attempts);
        }, {
          parallel: options.chatplusConcurrentSubmit !== false && options.noChatplusQueue !== true,
          noQueue: options.noChatplusQueue,
          slot: targetTaskSlot(target, "img2img"),
          modelKey: targetChatModelKey(target, input),
          quotaProbe: targetConfirmedQuotaBlocksTask(target, "img2img") && targetConfirmedQuotaRetryDue(target),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        if (savedTaskExternalId(taskState)) {
          if (isTerminalTaskFailureError(error)) {
            pushAttempt(attempts, target, error.message || "调用失败");
            return failQueuedTask(taskState, error, attempts);
          }
          return keepSubmittedTaskRecoverable(taskState, error, attempts);
        }
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败");
          continue;
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          busy: Boolean(error.busy),
          quotaEmpty: channel.type === "chatplus"
            ? isExplicitChatQuotaError(error)
            : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy) {
          await updateTargetStatusAfterError(account, channel, error);
        }
      } finally {
        activeSubmittedTaskIds.delete(taskState.id);
        release?.();
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
  await updateAccountAfterTask(account, channel, nextTask);
  return nextTask;
}

async function runChatCompletionTask(task, input) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId, input });
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
        const result = await mirrorTaskImages(await client.createChatCompletion(input), config, client);
        const responseJson = chatCompletionResponseJson({ result, channel });
        const finishedTask = await finishChatTask(task, result, channel, account, attempts, responseJson);
          return { result, channel, account, task: finishedTask, responseJson };
      }, {
        modelKey: targetChatModelKey(target, input),
        quotaProbe: targetConfirmedQuotaBlocksTask(target, "chat") && targetConfirmedQuotaRetryDue(target)
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
      if (channel.type === "chatplus" && isExplicitChatQuotaError(error)) {
        await updateTargetAccountStatus(account.id, channel, accountStatusFromError(error, {
          explicitChatQuotaOnly: true
        }));
      } else if (channel.type === "chatplus" && isChatBlockedError(error)) {
        await markChatCooldown(account.id, channel, error);
      } else {
        await updateTargetAccountStatus(account.id, channel, accountStatusFromError(error, {
          explicitChatQuotaOnly: channel.type === "chatplus"
        }));
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
  const requestedChannel = requestedChannelForInput(config, input);
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { balanced: true, input });
  if (!targets.length) throw noUsableTargetError("text2img", { config, requestedChannel, input });

  const reserved = await reserveFirstAvailableTarget(targets, "text2img", { input });
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
export async function queueImageTask({ input = {}, file, files: inputFiles, requestMeta = {}, admission = null }) {
  if (!cleanPrompt(input)) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", { accountId: requestedAccountId, balanced: true, input });
  if (!targets.length) {
    throw noUsableTargetError("img2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }

  const reserved = consumeAdmissionReservation(admission, targets, input)
    || await reserveFirstAvailableTarget(targets, "img2img", { input });
  const task = queuedTask({ input: { ...input, files }, target: reserved.target, taskType: "img2img", requestMeta });
  try {
    reserved.handoff?.();
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
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId, balanced: true, input });
  if (!targets.length) {
    throw noUsableTargetError("chat", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }

  const reserved = await reserveFirstAvailableTarget(targets, "chat", { input });
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

function preserveConfirmedChatQuota(currentStatus = {}, nextStatus = {}) {
  if (
    String(currentStatus.status || "").toLowerCase() !== "quota_empty"
    || currentStatus.quotaConfirmedByUpstream !== true
  ) {
    return nextStatus;
  }
  const recoveryUsage = chatRecoveryUsage(nextStatus);
  const recoveryBalance = Number(recoveryUsage?.balance);
  if (
    String(nextStatus.status || "").toLowerCase() === "ok"
    && Number.isFinite(recoveryBalance)
    && recoveryBalance > 0
  ) {
    return {
      ...nextStatus,
      quota: null,
      balance: null,
      used: null,
      quotaResetAt: "",
      imageQuotaResetAt: "",
      cooldownUntil: null,
      quotaReason: "",
      quotaModel: "",
      quotaConfirmedByUpstream: false,
      period: ""
    };
  }

  const recoveryResetAt = recoveryUsage?.quotaResetAt || "";
  const resetAt = recoveryResetAt || currentStatus.quotaResetAt || "";
  const resetTime = Date.parse(resetAt);
  const successfulCheck = String(nextStatus.status || "").toLowerCase() === "ok";
  const cooldownUntil = successfulCheck
    ? Number.isFinite(resetTime) && resetTime > Date.now()
      ? resetAt
      : new Date(Date.now() + CHAT_USAGE_RECOVERY_CHECK_MS).toISOString()
    : currentStatus.cooldownUntil || nextStatus.cooldownUntil || null;
  return {
    ...nextStatus,
    status: "quota_empty",
    quota: null,
    balance: null,
    used: null,
    quotaResetAt: resetAt,
    imageQuotaResetAt: currentStatus.quotaReason === "image_quota"
      ? recoveryResetAt || currentStatus.imageQuotaResetAt || resetAt
      : currentStatus.imageQuotaResetAt || "",
    cooldownUntil,
    quotaReason: currentStatus.quotaReason || "chat_usage_limit",
    quotaModel: currentStatus.quotaModel || nextStatus.meta?.chatModel || "",
    quotaConfirmedByUpstream: true,
    period: currentStatus.period || "",
    message: currentStatus.message || "使用次数已用完，等待真实请求确认恢复",
    meta: {
      ...(currentStatus.meta || {}),
      ...(nextStatus.meta || {})
    }
  };
}

function isAccountCheckTimeoutError(error) {
  const message = String(error?.message || "");
  return error?.accountCheckTimeout === true
    || error?.code === "ACCOUNT_CHECK_TIMEOUT"
    || /聊天站响应慢|请求超时|检测超时|timeout|timed out|ETIMEDOUT|AbortError/i.test(message);
}

function successfulAccountCheckStatus(status = {}) {
  return {
    ...status,
    meta: {
      ...(status.meta || {}),
      accountCheck: {
        status: "ok",
        consecutiveTimeouts: 0,
        step: "",
        checkedAt: new Date().toISOString()
      }
    }
  };
}

function accountCheckTimeoutStatus(currentStatus = {}, error) {
  const previousCheck = currentStatus.meta?.accountCheck || {};
  const consecutiveTimeouts = Number(previousCheck.consecutiveTimeouts || 0) + 1;
  const step = String(error?.accountCheckStep || "账号检测");
  const preservePreviousStatus = consecutiveTimeouts < 2
    && ["ok", "quota_empty", "cooldown"].includes(String(currentStatus.status || "").toLowerCase());
  const message = preservePreviousStatus
    ? `${step}超时，已自动复查一次；暂时沿用上次状态。`
    : `${step}连续两次检测超时，请稍后再次检测。`;

  return {
    ...currentStatus,
    status: preservePreviousStatus ? currentStatus.status : "error",
    message,
    meta: {
      ...(currentStatus.meta || {}),
      accountCheck: {
        status: preservePreviousStatus ? "timeout" : "failed",
        consecutiveTimeouts,
        step,
        checkedAt: new Date().toISOString()
      }
    }
  };
}

async function checkShareAIAbility(config, channel, account, ability) {
  const abilityChannel = shareAIAbilityChannel(channel, ability);
  const client = getClient(config, abilityChannel, account);
  const currentStatus = ability === "chatplus"
    ? account.meta?.abilities?.chatplus || {}
    : account.meta?.abilities?.drawing || {};
  try {
    const checked = await runChatplusAccountWork(abilityChannel, account, () => client.check());
    const data = ability === "chatplus"
      ? preserveConfirmedChatQuota(currentStatus, successfulAccountCheckStatus(checked))
      : checked;
    return { ok: true, data };
  } catch (error) {
    if (ability === "chatplus" && isAccountCheckTimeoutError(error)) {
      return {
        ok: false,
        data: accountCheckTimeoutStatus(currentStatus, error)
      };
    }
    const errorStatus = ability === "chatplus"
      ? accountStatusFromError(error, { explicitChatQuotaOnly: true })
      : accountStatusFromError(error);
    const data = ability === "chatplus"
      ? preserveConfirmedChatQuota(currentStatus, {
          ...errorStatus,
          message: readableCheckErrorMessage(error),
          expireAt: ""
        })
      : {
          ...errorStatus,
          quota: errorStatus.quota ?? null,
          balance: errorStatus.balance ?? null,
          quotaResetAt: errorStatus.quotaResetAt || "",
          expireAt: "",
          message: readableCheckErrorMessage(error)
        };
    return {
      ok: false,
      data
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

function combinedEnabledShareAIStatus(results) {
  const drawing = results.drawing?.data || {};
  const chatplus = results.chatplus?.data || {};
  const statuses = [drawing.status, chatplus.status].filter(Boolean);
  const disconnected = statuses.includes("disconnected");
  const ok = statuses.includes("ok");
  const failed = statuses.some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = statuses.includes("quota_empty");
  const messages = [
    results.drawing ? `绘图站：${drawing.message || (results.drawing.ok ? "可用" : "不可用")}` : "",
    results.chatplus ? `聊天：${chatplus.message || (results.chatplus.ok ? "可用" : "不可用")}` : ""
  ].filter(Boolean);

  return {
    status: disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : "error",
    quota: drawing.quota ?? chatplus.quota ?? null,
    balance: drawing.balance ?? chatplus.balance ?? null,
    quotaResetAt: drawing.quotaResetAt || chatplus.quotaResetAt || "",
    expireAt: drawing.expireAt || chatplus.expireAt || "",
    message: messages.join("；") || "检测失败",
    cooldownUntil: chatplus.status === "ok" ? null : chatplus.cooldownUntil || undefined,
    meta: {
      abilities: {
        ...(results.drawing ? { drawing } : {}),
        ...(results.chatplus ? { chatplus } : {})
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
  if (account.enabled === false) {
    return {
      status: account.status || "disabled",
      quota: account.quota ?? null,
      balance: account.balance ?? null,
      quotaResetAt: account.quotaResetAt || "",
      expireAt: account.expireAt || "",
      message: "账号已停用，已跳过检测，不会登录该账号。",
      disabled: true,
      checkSkipped: true
    };
  }
  const activeSlots = ["chat", "drawingImage", "chatImage"].reduce((result, slot) => {
    const count = activeCountForAccountSlot(slot, account.id);
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
  const proxyAbility = channel.type === "shareai"
    ? channelAbilityEnabled(channel, "drawing") ? "drawing" : "chatplus"
    : "";
  const proxyResult = await checkAccountProxy(
    account,
    channel.type === "shareai" ? shareAIAbilityChannel(channel, proxyAbility) : channel
  );
  if (channel.type === "shareai") {
    const abilities = ["drawing", "chatplus"].filter((ability) => channelAbilityEnabled(channel, ability));
    const checked = await Promise.all(abilities.map(async (ability) => [
      ability,
      await checkShareAIAbility(config, channel, account, ability)
    ]));
    const results = Object.fromEntries(checked);
    const status = preserveDrawingCooldown(
      account,
      withProxyCheckMeta(combinedEnabledShareAIStatus(results), proxyResult)
    );
    await updateAccountStatus(account.id, status);
    if (status.status !== "ok") throw new Error(status.message || "检测失败");
    return status;
  }
  const client = getClient(config, channel, account);
  try {
    const checked = successfulAccountCheckStatus(
      await runChatplusAccountWork(channel, account, () => client.check())
    );
    const status = channel.type === "chatplus"
      ? preserveConfirmedChatQuota(account, checked)
      : checked;
    const nextStatus = withProxyCheckMeta({
      ...status,
      cooldownUntil: status.status === "ok" ? null : status.cooldownUntil
    }, proxyResult);
    await updateAccountStatus(account.id, nextStatus);
    return nextStatus;
  } catch (error) {
    if (channel.type === "chatplus" && isAccountCheckTimeoutError(error)) {
      const status = withProxyCheckMeta(accountCheckTimeoutStatus(account, error), proxyResult);
      await updateAccountStatus(account.id, status);
      if (status.status === "error") throw new Error(status.message);
      return status;
    }
    const message = readableCheckErrorMessage(error);
    const errorStatus = accountStatusFromError(error, {
      explicitChatQuotaOnly: channel.type === "chatplus"
    });
    const checkedStatus = {
      ...errorStatus,
      quota: channel.type === "chatplus" ? null : errorStatus.quota ?? null,
      balance: channel.type === "chatplus" ? null : errorStatus.balance ?? null,
      quotaResetAt: errorStatus.quotaResetAt || "",
      expireAt: "",
      message
    };
    const status = withProxyCheckMeta(
      channel.type === "chatplus"
        ? preserveConfirmedChatQuota(account, checkedStatus)
        : checkedStatus,
      proxyResult
    );
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
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: requestedAccountId, balanced: true, input });
  if (!targets.length) {
    throw noUsableTargetError("chat", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }

  const reserved = await reserveFirstAvailableTarget(targets, "chat", { input });
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
  const requestedChannel = requestedChannelForInput(config, input);
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { balanced: true, input });
  if (!targets.length) throw noUsableTargetError("text2img", { config, requestedChannel, input });

  const attempts = [];
  for (const target of targets) {
    const { channel, account } = target;
    let submitted = false;
    const release = await tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target, input);
    if (!release) {
      attempts.push(targetBusyAttempt(target, "text2img"));
      continue;
    }
    try {
      const finishedTask = await runChatplusAccountWork(channel, account, async () => {
        if (!(await ensureTargetReady(config, target, "text2img", attempts))) return null;
        const client = getWorkClient(config, channel, account);
        const chatplusConcurrentSubmit = wait && channel.type === "chatplus";
        let result = await client.createTextTask({
          ...imageInputForTarget(target, input),
          onSubmitted: () => {
            submitted = true;
          },
          ...(channel.type === "chatplus" ? { concurrentSubmit: chatplusConcurrentSubmit } : {}),
          waitForImages: wait
        });
        if (wait && channel.type === "drawing") result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
        result = await mirrorTaskImages(result, config, client);
        const task = wrapTask({ result, channel, account, attempts, requestJson: taskRequestJson(input), requestMeta });
        await upsertTask(task);
        if (isFinishedTask(task.status)) await recordTaskStat(task);
        await updateAccountAfterTask(account, channel, task);
        scheduleDrawingQuotaRefresh(account, channel);
        return task;
      }, {
        parallel: wait && channel.type === "chatplus",
        noQueue: wait && channel.type !== "chatplus",
        slot: targetTaskSlot(target, "text2img"),
        modelKey: targetChatModelKey(target, input),
        quotaProbe: targetConfirmedQuotaBlocksTask(target, "text2img") && targetConfirmedQuotaRetryDue(target),
        blockingSlots: ["chatImage"]
      });
      if (finishedTask) return finishedTask;
    } catch (error) {
      if (submitted) throw error;
      if (isTerminalTaskFailureError(error)) {
        pushAttempt(attempts, target, error.message || "调用失败");
        continue;
      }
      pushAttempt(attempts, target, error.message || "调用失败", {
        busy: Boolean(error.busy),
        quotaEmpty: channel.type === "chatplus"
          ? isExplicitChatQuotaError(error)
          : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
      });
      if (!error.busy) await updateTargetStatusAfterError(account, channel, error);
    } finally {
      release();
    }
  }
  throw targetsFailedError(attempts);
}
export async function createImageTask({ input = {}, file, files: inputFiles, wait = false, requestMeta = {}, admission = null }) {
  if (!String(input.prompt || "").trim()) {
    const error = new Error("请输入改图要求。");
    error.status = 400;
    throw error;
  }
  const files = imageFiles(inputFiles || file);
  assertImageFileCount(files, 3);
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", {
    accountId: requestedAccountId,
    balanced: wait,
    skipRecovery: wait,
    input
  });
  if (!targets.length) {
    throw noUsableTargetError("img2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }
  const reserved = consumeAdmissionReservation(admission, targets, input);

  if (wait) {
    const task = queuedTask({ input: { ...input, files }, target: reserved?.target || targets[0], taskType: "img2img", requestMeta });
    try {
      reserved?.handoff?.();
      await upsertTask(task);
    } catch (error) {
      reserved?.release();
      throw error;
    }
    scheduledImageTasks.add(task.id);
    let finalTask;
    try {
      finalTask = await runQueuedImageTask(task, input, files, reserved, {
        fastQuotaRefresh: true,
        waitForChatplusImages: true
      });
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
      error.upstreamText = responseJson.upstreamText || finalTask.upstreamText || "";
      error.responseJson = responseJson;
      error.task = finalTask;
      throw error;
    }
    return finalTask;
  }

  return queueImageTask({ input, files, requestMeta, admission: reserved });
}
