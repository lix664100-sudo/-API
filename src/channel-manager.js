import { createHash, randomUUID } from "node:crypto";
import {
  ChatplusClient,
  isChatImageIntermediateResponse,
  isImagePolicyFailureMessage,
  normalizeImageCarCooldown
} from "./channels/chatplus.js";
import {
  DrawingClient,
  drawingBalanceInsufficient,
  drawingRetryAfterSeconds,
  drawingSevereFailureReason,
  drawingUpstreamText
} from "./channels/drawing.js";
import { mirrorImageUrls } from "./image-store.js";
import { assertInputImageCount, MAX_INPUT_IMAGE_COUNT } from "./image-limits.js";
import { createFastTaskRefresher } from "./fast-task-refresher.js";
import { subscribeChatplusConversationUpdates } from "./chatplus-conversation-updates.js";
import {
  isProxyConnectionError,
  normalizeProxyUrl,
  proxyExpired,
  proxyCircuitState,
  runWithProxyCircuit,
  safeProxyEndpoint
} from "./proxy.js";
import {
  getTask,
  listChatplusConversationUpdates,
  listActiveTasks,
  listTodayAccountRoutingUsage,
  loadConfig,
  recordTaskStat,
  storeChatplusConversationUpdate,
  updateAccountMeta,
  updateAccountStatus,
  upsertTask
} from "./storage.js";
import { estimateChatTokenUsage } from "./token-usage.js";
import {
  applyQuotaProtectionStates,
  normalizeQuotaProtectionSettings,
  quotaProtectionBlocked,
  quotaProtectionNearLimit,
  quotaProtectionRecheckDue,
  quotaProtectionStateFor
} from "./quota-protection.js";

const CHAT_COOLDOWN_MS = 30 * 60 * 1000;
const defaultTaskConcurrency = { chat: 3, drawingImage: 2, chatImage: 2 };
const scheduledChatTasks = new Set();
const scheduledImageTasks = new Set();
const activeTaskCounts = new Map();
const activeRoutingLoads = new Map();
const routingBalanceWindows = new Map();
const activeDrawingModelCounts = new Map();
const activeSubmittedTaskIds = new Set();
const activeAccountAuthTasks = new Map();
const activeChatplusAccountWork = new Map();
const activeTaskRefreshes = new Map();
const taskRefreshSessions = new Map();
const activeChatQuotaProbes = new Set();
const clientCache = new Map();
const accountRecoveryTasks = new Map();
const accountRecoveryRetryAt = new Map();
const activeAccountChecks = new Map();
const persistedProxyStatuses = new Map();
const proxyStatusWrites = new Map();
const taskSlotWaiters = new Set();
const ACCOUNT_RECOVERY_RETRY_MS = 30 * 1000;
const ACCOUNT_CHECK_CONCURRENCY = 3;
const CHAT_USAGE_RECOVERY_CHECK_MS = 60 * 60 * 1000;
const CHAT_USAGE_OBSERVATION_MS = 5 * 60 * 1000;
const DRAWING_QUOTA_RECOVERY_CHECK_MS = 60 * 60 * 1000;
const DRAWING_FAILURE_LIMIT = 3;
const DRAWING_COOLDOWN_MS = 30 * 60 * 1000;
const DRAWING_SUBMIT_WAIT_TIMEOUT_SEC = 180;
const FAST_QUOTA_REFRESH_TIMEOUT_MS = 5000;
const FAST_TASK_REFRESH_TIMEOUT_SEC = 8;
const FAST_TASK_REFRESH_DEADLINE_MS = 30 * 1000;
const TASK_REFRESH_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_TASK_REFRESH_SESSIONS = 5000;
const UPSTREAM_RESULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const IMAGE_MIRROR_RECOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const IMAGE_MIRROR_RECOVERY_MAX_ATTEMPTS = 20;
export function imagePreSubmitRetryDelays(value = process.env.IMAGE_PRE_SUBMIT_RETRY_DELAYS_MS) {
  const configured = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(0, 3);
  return configured.length ? configured : [5000, 15000, 30000];
}

const IMAGE_PRE_SUBMIT_RETRY_DELAYS_MS = imagePreSubmitRetryDelays();
const TASK_SLOT_RECHECK_MS = 1000;
const PROXY_GUARDED_CLIENT_METHODS = new Set([
  "check",
  "createChatCompletion",
  "createImageTask",
  "createTextTask",
  "getTask",
  "uploadImage"
]);
let activeTaskConcurrency = { ...defaultTaskConcurrency };
let routingReservationQueue = Promise.resolve();

subscribeChatplusConversationUpdates(({ conversationId, payload, fingerprint }) => (
  storeChatplusConversationUpdate(conversationId, fingerprint, payload)
));

// These snapshots contain account cookies. Keep them only in this process so
// polling a submitted task does not repeat the portal login and car switch.
function cloneTaskRefreshSession(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const cookies = Array.isArray(snapshot.cookies)
    ? snapshot.cookies.filter((item) => typeof item === "string").map((item) => item.slice(0, 16_384))
    : [];
  if (!cookies.length) return null;
  return {
    baseUrl: String(snapshot.baseUrl || "").slice(0, 2_000),
    cookies,
    portalLoggedIn: snapshot.portalLoggedIn === true,
    carId: String(snapshot.carId || "").slice(0, 500),
    carType: String(snapshot.carType || "chatgpt").slice(0, 100),
    defaultModel: String(snapshot.defaultModel || "").slice(0, 500),
    geminiSession: snapshot.geminiSession && typeof snapshot.geminiSession === "object"
      ? { ...snapshot.geminiSession }
      : {}
  };
}

function pruneTaskRefreshSessions(now = Date.now()) {
  for (const [taskId, entry] of taskRefreshSessions) {
    if (!entry || entry.expiresAt <= now) taskRefreshSessions.delete(taskId);
  }
}

function rememberTaskRefreshSession(taskId, snapshot) {
  const key = String(taskId || "").trim();
  const copy = cloneTaskRefreshSession(snapshot);
  if (!key || !copy) return;
  pruneTaskRefreshSessions();
  taskRefreshSessions.delete(key);
  while (taskRefreshSessions.size >= MAX_TASK_REFRESH_SESSIONS) {
    const oldestTaskId = taskRefreshSessions.keys().next().value;
    if (!oldestTaskId) break;
    taskRefreshSessions.delete(oldestTaskId);
  }
  taskRefreshSessions.set(key, {
    snapshot: copy,
    expiresAt: Date.now() + TASK_REFRESH_SESSION_TTL_MS
  });
}

function taskRefreshSession(taskId) {
  const key = String(taskId || "").trim();
  const entry = taskRefreshSessions.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    taskRefreshSessions.delete(key);
    return null;
  }
  return cloneTaskRefreshSession(entry.snapshot);
}

function forgetTaskRefreshSession(taskId) {
  taskRefreshSessions.delete(String(taskId || "").trim());
}

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
    message: result.ok ? "" : result.message || "代理不可用",
    cooldownUntil: result.cooldownUntil || "",
    attemptCount: Number(result.attemptCount || 0),
    latencyMs: Number(result.latencyMs || 0)
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

function taskSlotLimit(slot, target = {}, input = {}) {
  const accountLimit = Number(target?.account?.concurrency?.[slot]);
  const configured = Number.isFinite(accountLimit) && accountLimit > 0
    ? accountLimit
    : activeTaskConcurrency[slot] || defaultTaskConcurrency[slot] || 1;
  return targetQuotaProtectionNearLimit(target, input) ? Math.min(1, configured) : configured;
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

function durableRunningCount(tasks, slot, modelKey = "") {
  const requestedModelKey = modelRequestKey(modelKey);
  return tasks.filter((task) => (
    taskHoldsDurableSlot(task)
    && !activeSubmittedTaskIds.has(task.id)
    && storedTaskSlot(task) === slot
    && (!requestedModelKey || storedTaskModelKey(task) === requestedModelKey)
  )).length;
}

function runningCountForSlot(tasks, slot) {
  return activeCountForSlot(slot) + durableRunningCount(tasks, slot);
}

function runningCountForModelSlot(tasks, slot, modelKey) {
  const active = slot === "drawingImage"
    ? activeCountForDrawingModel(modelKey)
    : activeCountForModelSlot(slot, modelKey);
  return active + durableRunningCount(tasks, slot, modelKey);
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

function targetRuntimeAvailable(target, taskType, input = {}) {
  if (!target?.channel || !target?.account) return false;
  if (target.channel.enabled === false || target.account.enabled === false) return false;
  const status = targetQuotaStatusForTask(target, input);
  if (
    target.channel.type === "drawing"
    && String(status.status || "").toLowerCase() === "ok"
    && drawingBalanceInsufficient(status.balance)
  ) {
    return false;
  }
  if (targetQuotaProtectionBlocksTask(target, input)) return false;
  if (targetSubscriptionExpired(target, input)) return false;
  const confirmedQuotaBlocks = targetConfirmedQuotaBlocksTask(target, taskType, input);
  const quotaProbeReady = target?.channel?.type === "chatplus"
    && String(status.status || "").toLowerCase() === "quota_empty"
    && (
      !confirmedQuotaBlocks
      || targetConfirmedQuotaRetryDue(target, input)
    );
  if (confirmedQuotaBlocks && !quotaProbeReady) return false;
  if (taskType === "chat" && targetAccountCoolingBlocksTask(target, input) && !quotaProbeReady) return false;
  if (statusCooling(status) && !quotaProbeReady) return false;
  return quotaProbeReady || status.status === "ok" || status.status === "cooldown";
}

function targetSupportsChatModel(target, modelKey) {
  if (target?.channel?.type !== "chatplus") return false;
  const requestedKey = geminiModelFamily(modelKey) || modelRequestKey(modelKey);
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
    .filter((target) => !availableOnly || targetRuntimeAvailable(target, taskType, modelKey ? { model: modelKey } : {}));
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

function runtimeModelConcurrency(config, availableOnly = false, tasks = []) {
  const sharedDrawingRunning = runningCountForSlot(tasks, "drawingImage");
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
      chat: runningCountForModelSlot(tasks, "chat", modelKey),
      drawingImage: runningCountForModelSlot(tasks, "drawingImage", modelKey),
      chatImage: runningCountForModelSlot(tasks, "chatImage", modelKey)
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

function routingUnavailableReason(target, taskType, input = {}) {
  if (target?.channel?.enabled === false || target?.account?.enabled === false) return "已停用";
  if (targetQuotaProtectionBlocksTask(target, input)) return "额度保护";
  if (targetSubscriptionMissing(target, input)) return "未订阅";
  if (targetSubscriptionExpired(target, input)) return "套餐已过期";
  const status = targetQuotaStatusForTask(target, input);
  if (
    target?.channel?.type === "drawing"
    && String(status.status || "").toLowerCase() === "ok"
    && drawingBalanceInsufficient(status.balance)
  ) {
    return "额度不足";
  }
  if (targetConfirmedQuotaBlocksTask(target, taskType, input)) return "额度不足";
  if (targetAccountCoolingBlocksTask(target, input) || statusCooling(status)) return "暂停中";
  const value = String(status.status || "unknown").toLowerCase();
  if (value === "activation_required") return "未激活";
  if (value === "disconnected") return "自动换线中";
  if (["error", "failed"].includes(value)) return "异常";
  if (value === "disabled") return "已停用";
  if (value === "unknown") return "尚未检测";
  return "暂不可用";
}

function runtimeRoutingStatus(config, usage) {
  const routeSets = [
    { taskType: "text2img", input: {}, channelType: "drawing" },
    { taskType: "text2img", input: {}, channelType: "chatplus" },
    { taskType: "chat", input: {}, channelType: "chatplus" }
  ];
  const entries = routeSets.flatMap(({ taskType, input, channelType }) => (
    selectTargets(config, "auto", taskType, { includeCooling: true, input })
      .filter((target) => target.channel.type === channelType)
      .map((target) => {
        const slot = targetTaskSlot(target, taskType);
        const modelKey = ["chat", "chatImage"].includes(slot)
          ? targetChatModelKey(target, input) || "gpt"
          : "";
        return {
          target,
          taskType,
          input,
          slot,
          modelKey,
          groupKey: routingGroupKey(target, taskType, input),
          available: targetRuntimeAvailable(target, taskType, input)
        };
      })
  ));
  const uniqueEntries = [...new Map(entries.map((entry) => [
    `${entry.target.account.id}:${entry.groupKey}`,
    entry
  ])).values()];
  const groups = new Map();
  for (const entry of uniqueEntries) {
    const group = groups.get(entry.groupKey) || [];
    group.push(entry);
    groups.set(entry.groupKey, group);
  }
  const accounts = {};
  for (const entry of uniqueEntries) {
    const accountId = String(entry.target.account.id || "");
    const group = groups.get(entry.groupKey) || [];
    const availableGroup = group.filter((item) => item.available);
    const totalWeight = availableGroup.reduce(
      (total, item) => total + accountRoutingWeight(item.target.account),
      0
    );
    const targetPercent = entry.available && totalWeight
      ? Math.round((accountRoutingWeight(entry.target.account) / totalWeight) * 100)
      : 0;
    const slotUsage = usage?.accounts?.[accountId]?.routing?.[entry.slot] || {};
    const submitted = entry.modelKey
      ? slotUsage.models?.[entry.modelKey] || { auto: 0, explicit: 0 }
      : { auto: Number(slotUsage.auto || 0), explicit: Number(slotUsage.explicit || 0) };
    const accountRouting = accounts[accountId] || { slots: {} };
    accountRouting.slots[entry.slot] = {
      available: entry.available,
      reason: entry.available ? "" : routingUnavailableReason(entry.target, entry.taskType, entry.input),
      targetPercent,
      weight: accountRoutingWeight(entry.target.account),
      modelKey: entry.modelKey,
      submitted: {
        auto: Number(submitted.auto || 0),
        explicit: Number(submitted.explicit || 0)
      }
    };
    accounts[accountId] = accountRouting;
  }
  return { day: usage?.day || "", accounts };
}

export async function getRuntimeStatus() {
  const config = await loadConfig();
  const concurrency = normalizeTaskConcurrency(config.concurrency);
  activeTaskConcurrency = concurrency;
  const configured = runtimeAccountConcurrency(config);
  const available = runtimeAccountConcurrency(config, true);
  const [tasks, routingUsage] = await Promise.all([
    listActiveTasks(),
    listTodayAccountRoutingUsage()
  ]);
  const enabledChannels = (config.channels || []).filter((channel) => channel.enabled !== false);
  const runtimeAccountIds = new Set((config.accounts || [])
    .filter((account) => account.enabled !== false)
    .filter((account) => enabledChannels.some((channel) => accountMatchesChannel(account, channel)))
    .map((account) => String(account.id || "")));
  const runtimeTasks = tasks.filter((task) => runtimeAccountIds.has(String(task.accountId || "")));
  const models = runtimeModelConcurrency(config, false, runtimeTasks);
  const running = {
    chat: runningCountForSlot(runtimeTasks, "chat"),
    drawingImage: runningCountForSlot(runtimeTasks, "drawingImage"),
    chatImage: runningCountForSlot(runtimeTasks, "chatImage")
  };
  const waiting = {
    image: tasks.filter((task) => task.status === "waiting_upstream" && task.taskType !== "chat").length,
    chat: tasks.filter((task) => task.status === "waiting_upstream" && task.taskType === "chat").length
  };
  waiting.total = waiting.image + waiting.chat;
  const queued = {
    image: tasks.filter((task) => task.status === "queued" && task.taskType !== "chat").length,
    chat: tasks.filter((task) => task.status === "queued" && task.taskType === "chat").length
  };
  queued.total = queued.image + queued.chat;
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
    modelStatus.queued = {
      image: tasks.filter((task) =>
        task.status === "queued"
        && task.taskType !== "chat"
        && storedTaskModelKey(task) === modelKey
      ).length,
      chat: tasks.filter((task) =>
        task.status === "queued"
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
    waiting,
    queued,
    routing: runtimeRoutingStatus(config, routingUsage)
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

function providerInput(input = {}) {
  const { allowDisabledAccountTest: _allowDisabledAccountTest, ...providerInput } = input;
  return providerInput;
}

function imageInputForTarget(target = {}, input = {}) {
  const cleanedInput = providerInput(input);
  if (target?.channel?.type !== "chatplus") return cleanedInput;
  return {
    ...cleanedInput,
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

function routingLoadKey(slot, target = {}, input = {}) {
  const modelKey = ["chat", "chatImage"].includes(slot) ? targetChatModelKey(target, input) : "";
  return [slot, modelKey, String(target?.account?.id || "").trim()].filter(Boolean).join(":");
}

function requestedRoutingLoad(slot, input = {}) {
  if (slot === "chat") return 1;
  const requested = Math.floor(Number(input.image_count || input.n || 1));
  return Math.min(100, Math.max(1, Number.isFinite(requested) ? requested : 1));
}

function activeRoutingLoad(slot, target = {}, input = {}) {
  return activeRoutingLoads.get(routingLoadKey(slot, target, input)) || 0;
}

function updateActiveRoutingLoad(slot, target, input, difference) {
  const key = routingLoadKey(slot, target, input);
  const next = Math.max(0, (activeRoutingLoads.get(key) || 0) + difference);
  if (next) activeRoutingLoads.set(key, next);
  else activeRoutingLoads.delete(key);
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
  if (!accountId) return { total: 0, active: 0, tasks: [] };
  const modelKey = ["chat", "chatImage"].includes(slot) ? targetChatModelKey(target, input) : "";
  const tasks = await listActiveTasks();
  const holdingTasks = tasks.filter((task) =>
    String(task.accountId || "") === accountId
    && storedTaskSlot(task) === slot
    && (!modelKey || storedTaskChatModelKey(task) === modelKey)
    && taskHoldsDurableSlot(task)
  );
  return {
    total: holdingTasks.length,
    active: holdingTasks.filter((task) => activeSubmittedTaskIds.has(task.id)).length,
    tasks: holdingTasks
  };
}

async function submittedImageCarIdsForTarget(target = {}, input = {}) {
  if (target?.channel?.type !== "chatplus") return [];
  const state = await durableTaskSlotState("chatImage", target, input);
  return [...new Set(state.tasks
    .map((task) => String(task.raw?.selectedCarId || "").trim())
    .filter(Boolean))];
}

async function taskSlotOccupancy(slot, target = {}, input = {}) {
  const key = taskSlotKey(slot, target, input);
  const durableState = await durableTaskSlotState(slot, target, input);
  const count = activeTaskCounts.get(key) || 0;
  return count + durableState.total - Math.min(durableState.active, count);
}

function busyTaskStatusLabel(status) {
  return {
    processing: "处理中",
    queued: "排队中",
    pending: "等待处理",
    unknown: "状态待确认",
    waiting_upstream: "等待上游"
  }[String(status || "")] || "处理中";
}

function busyTaskTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(time);
}

function busyTaskError(slot, target = {}, blockingTask = null) {
  const blockingTaskId = String(blockingTask?.id || "").trim();
  const blockingTime = busyTaskTime(blockingTask?.createdAt || blockingTask?.updatedAt);
  const blockingDetail = blockingTaskId
    ? `占用任务：${blockingTaskId}（${busyTaskStatusLabel(blockingTask.status)}${blockingTime ? `，${blockingTime}` : ""}）。`
    : "";
  const error = new Error(`${taskSlotBusyLabel(slot, target)}任务正在处理中。${blockingDetail}请稍后再试。`);
  error.status = 429;
  error.busy = true;
  if (blockingTaskId) {
    error.blockingTaskId = blockingTaskId;
    error.blockingTaskStatus = String(blockingTask.status || "");
    error.blockingTaskCreatedAt = blockingTask.createdAt || blockingTask.updatedAt || "";
  }
  return error;
}

async function tryReserveTaskSlot(slot, target = {}, input = {}) {
  const key = taskSlotKey(slot, target, input);
  const durableState = await durableTaskSlotState(slot, target, input);
  const count = activeTaskCounts.get(key) || 0;
  const occupied = count + durableState.total - Math.min(durableState.active, count);
  if (occupied >= taskSlotLimit(slot, target, input)) return null;
  activeTaskCounts.set(key, count + 1);
  const routingLoad = requestedRoutingLoad(slot, input);
  updateActiveRoutingLoad(slot, target, input, routingLoad);
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
    updateActiveRoutingLoad(slot, target, input, -routingLoad);
    if (drawingModelKey) {
      const nextModelCount = Math.max(0, activeCountForDrawingModel(drawingModelKey) - 1);
      if (nextModelCount) activeDrawingModelCounts.set(drawingModelKey, nextModelCount);
      else activeDrawingModelCounts.delete(drawingModelKey);
    }
    for (const notify of [...taskSlotWaiters]) notify();
  };
}

function waitForTaskSlotChange() {
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      taskSlotWaiters.delete(finish);
      if (timer) clearTimeout(timer);
      resolve();
    };
    taskSlotWaiters.add(finish);
    timer = setTimeout(finish, TASK_SLOT_RECHECK_MS);
  });
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
  let quotaProbe = options.quotaProbe === true;
  let currentAccount = account;
  const quotaInput = options.modelKey ? { model: options.modelKey } : options.input || {};
  if (options.taskType) {
    const latestConfig = await loadRuntimeConfig();
    currentAccount = latestConfig.accounts.find((item) => item.id === account.id) || account;
    const currentTarget = { channel, account: currentAccount };
    if (targetConfirmedQuotaBlocksTask(currentTarget, options.taskType, quotaInput)) {
      if (!targetConfirmedQuotaRetryDue(currentTarget, quotaInput)) {
        throw confirmedQuotaBlockedError(currentTarget, quotaInput);
      }
      quotaProbe = true;
    }
  }
  const quotaProbeKey = quotaProbe
    ? accountSessionKey(currentAccount, options.modelKey || targetChatModelKey({ channel, account: currentAccount }, quotaInput))
    : "";
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

async function persistProCarRestriction(channel, account, restriction = {}) {
  if (!account?.id) return;
  const ability = channelAbilityKey(channel);
  const until = String(restriction.until || "").trim();
  await updateAccountMeta(account.id, (accountMeta) => {
    if (ability) {
      const abilities = { ...(accountMeta.abilities || {}) };
      const abilityStatus = { ...(abilities[ability] || {}) };
      abilities[ability] = {
        ...abilityStatus,
        meta: {
          ...(abilityStatus.meta || {}),
          proCarsUnavailable: true,
          proCarsUnavailableReason: "plan_mismatch",
          proCarsUnavailableUntil: until
        }
      };
      return { ...accountMeta, abilities };
    }
    return {
      ...accountMeta,
      chatplusProCarsUnavailable: true,
      chatplusProCarsUnavailableReason: "plan_mismatch",
      chatplusProCarsUnavailableUntil: until
    };
  });
}

async function clearProCarRestriction(channel, account) {
  if (!account?.id) return;
  const ability = channelAbilityKey(channel);
  await updateAccountMeta(account.id, (accountMeta) => {
    if (ability) {
      const abilities = { ...(accountMeta.abilities || {}) };
      const abilityStatus = { ...(abilities[ability] || {}) };
      const abilityMeta = { ...(abilityStatus.meta || {}) };
      delete abilityMeta.proCarsUnavailable;
      delete abilityMeta.proCarsUnavailableReason;
      delete abilityMeta.proCarsUnavailableUntil;
      abilities[ability] = { ...abilityStatus, meta: abilityMeta };
      return { ...accountMeta, abilities };
    }
    const nextMeta = { ...accountMeta };
    delete nextMeta.chatplusProCarsUnavailable;
    delete nextMeta.chatplusProCarsUnavailableReason;
    delete nextMeta.chatplusProCarsUnavailableUntil;
    return nextMeta;
  });
}

function activeImageCarCooldowns(value = {}, now = Date.now()) {
  const entries = Object.values(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .map((item) => normalizeImageCarCooldown(item, now))
    .filter((item) => {
      const until = Date.parse(item?.cooldownUntil || "");
      return String(item?.carId || "").trim() && Number.isFinite(until) && until > now;
    })
    .sort((a, b) => Date.parse(b.cooldownUntil) - Date.parse(a.cooldownUntil))
    .slice(0, 300);
  return Object.fromEntries(entries.map((item) => [
    `${String(item.carType || "chatgpt").trim()}:${String(item.carId).trim()}`,
    item
  ]));
}

async function persistImageCarCooldown(channel, account, cooldown = {}) {
  const carId = String(cooldown.carId || "").trim();
  const carType = String(cooldown.carType || "chatgpt").trim();
  if (!account?.id || !carId) return;
  const key = `${carType}:${carId}`;
  const cooldownUntil = String(cooldown.cooldownUntil || "").trim();
  const ability = channelAbilityKey(channel);

  await updateAccountMeta(account.id, (accountMeta) => {
    if (ability) {
      const abilities = { ...(accountMeta.abilities || {}) };
      const abilityStatus = { ...(abilities[ability] || {}) };
      const abilityMeta = { ...(abilityStatus.meta || {}) };
      const cooldowns = activeImageCarCooldowns(abilityMeta.imageCarCooldowns);
      if (Date.parse(cooldownUntil) > Date.now()) {
        cooldowns[key] = {
          carId,
          carType,
          cooldownUntil,
          reason: String(cooldown.reason || "image_failure"),
          message: String(cooldown.message || "").replace(/\s+/g, " ").trim().slice(0, 300),
          ...(Number(cooldown.failureCount || 0) > 0
            ? { failureCount: Math.max(1, Math.round(Number(cooldown.failureCount))) }
            : {}),
          updatedAt: new Date().toISOString()
        };
      } else {
        delete cooldowns[key];
      }
      abilityMeta.imageCarCooldowns = activeImageCarCooldowns(cooldowns);
      abilities[ability] = { ...abilityStatus, meta: abilityMeta };
      return { ...accountMeta, abilities };
    }

    const cooldowns = activeImageCarCooldowns(accountMeta.chatplusImageCarCooldowns);
    if (Date.parse(cooldownUntil) > Date.now()) {
      cooldowns[key] = {
        carId,
        carType,
        cooldownUntil,
        reason: String(cooldown.reason || "image_failure"),
        message: String(cooldown.message || "").replace(/\s+/g, " ").trim().slice(0, 300),
        ...(Number(cooldown.failureCount || 0) > 0
          ? { failureCount: Math.max(1, Math.round(Number(cooldown.failureCount))) }
          : {}),
        updatedAt: new Date().toISOString()
      };
    } else {
      delete cooldowns[key];
    }
    return { ...accountMeta, chatplusImageCarCooldowns: activeImageCarCooldowns(cooldowns) };
  });
}

function clientContext(config, channel, account) {
  return {
    config,
    channel,
    account,
    sessionLock: (work) => withAccountAuthLock(account, work),
    onProCarsUnavailable: (restriction) => persistProCarRestriction(channel, account, restriction),
    onProCarsAvailable: () => clearProCarRestriction(channel, account),
    onImageCarCooldown: (cooldown) => persistImageCarCooldown(channel, account, cooldown)
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
  const client = getClient(config, channel, account);
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !PROXY_GUARDED_CLIENT_METHODS.has(property)) return value;
      return (...args) => runAccountProxyWork(
        account,
        () => value.apply(target, args)
      );
    }
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
        geminiDrawingModelId: Number(settings.geminiDrawingModelId || 2),
        quotaProtection: normalizeQuotaProtectionSettings(settings.quotaProtection),
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
      geminiDrawingModelId: Number(settings.geminiDrawingModelId || 2),
      quotaProtection: normalizeQuotaProtectionSettings(settings.quotaProtection)
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

function isRecoverableChatImageFailure(task = {}) {
  if (task.channelType !== "chatplus" || task.raw?.submitted !== true) return false;
  if (!["img2img", "text2img"].includes(task.taskType)) return false;
  const messages = [
    task.errorMessage,
    task.responseJson?.message,
    task.upstreamText,
    task.responseJson?.upstreamText,
    task.raw?.upstreamText
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return messages.some(isChatImageIntermediateResponse);
}

function isFinishedTask(status) {
  return ["success", "failed", "cancelled"].includes(status);
}

function needsTaskRefresh(task = {}) {
  return isPendingTask(task.status)
    || (task.status === "failed" && (!task.errorMessage || isRecoverableChatImageFailure(task)));
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
  if (isCarPoolUnavailableError(error)) return true;
  const text = `${error?.message || ""} ${error?.code || ""} ${error?.status || ""}`;
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|其他设备登|ssl\/tls|schannel|handshake|connection closed|connection timed out|server closed abruptly|close_notify|econnreset|etimedout|err_connection_closed/i.test(text);
}

function isChatLoginStateText(text) {
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|其他设备登/i.test(String(text || ""));
}

function isCarPoolUnavailableError(error) {
  return error?.carPoolUnavailable === true
    || error?.authScope === "car"
    || error?.code === "CHAT_CAR_POOL_UNAVAILABLE";
}

function carPoolUnavailableMessage() {
  return "上游共享车位暂时不可用，系统稍后会自动重试。";
}

function isChatSubscriptionMissingError(error) {
  if (error?.subscriptionMissing === true || error?.code === "CHAT_SUBSCRIPTION_MISSING") return true;
  const text = [
    error?.message || "",
    error?.body || "",
    JSON.stringify(error?.payload || {})
  ].join(" ");
  if (/(?:订阅|套餐).{0,12}(?:已?过期|无效)|(?:subscription|plan).{0,20}(?:expired|invalid|not valid)/i.test(text)) return false;
  return /用户没有有效的\s*(?:chatgpt|gpt|gemini|grok)?\s*订阅|没有可用的\s*(?:chatgpt|gpt|gemini|grok)?\s*套餐|(?:未订阅|没有订阅|无订阅).{0,12}(?:套餐)?|no valid.{0,20}(?:subscription|plan)|not subscribed|subscription required/i.test(text);
}

function isChatSubscriptionExpiredError(error) {
  if (error?.subscriptionExpired === true || error?.code === "CHAT_SUBSCRIPTION_EXPIRED") return true;
  const text = [
    error?.message || "",
    error?.body || "",
    JSON.stringify(error?.payload || {})
  ].join(" ");
  return /(?:chatgpt|gpt|gemini|grok)?.{0,18}(?:订阅|套餐).{0,12}(?:已?过期|无效)|(?:subscription|plan).{0,20}(?:expired|invalid|not valid)/i.test(text);
}

function chatSubscriptionModel(error) {
  const key = String(error?.subscriptionModel || "").trim().toLowerCase();
  const name = String(error?.subscriptionModelName || "").trim()
    || ({ gpt: "GPT", grok: "Grok", gemini: "Gemini" }[key] || "当前模型");
  return { key, name };
}

function isDisconnectedError(error) {
  if (isCarPoolUnavailableError(error)) return false;
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

function isExplicitChatAccountUsageError(error) {
  return isExplicitChatQuotaError(error) && error?.quotaReason === "chat_usage_limit";
}

function isTerminalTaskFailureError(error) {
  return Boolean(error?.upstreamExplicitFailure);
}

function isCancelledTaskError(error) {
  const status = String(error?.upstreamStatus || error?.status || error?.state || error?.taskStatus || "")
    .trim()
    .toLowerCase();
  return ["cancelled", "canceled"].includes(status)
    || String(error?.code || "").trim().toLowerCase() === "upstream_task_cancelled"
    || /上游已取消任务/.test(String(error?.message || ""));
}

function imageSubmissionFailure(error) {
  if (error?.imageSubmissionAttempted !== true) return error;
  if (isCancelledTaskError(error)) {
    const failure = new Error(error?.message || "上游已取消任务。");
    failure.status = Number(error?.status || error?.statusCode || 0) || 502;
    failure.code = "UPSTREAM_TASK_CANCELLED";
    failure.imageTaskCancelled = true;
    failure.imageSubmissionAttempted = true;
    failure.imageSubmissionConfirmed = error?.imageSubmissionConfirmed === true;
    failure.failureType = "upstream_cancelled";
    failure.failureReason = failure.message;
    failure.upstreamText = error?.upstreamText || failure.message;
    failure.upstreamModel = error?.upstreamModel || "";
    failure.upstreamStatus = "cancelled";
    failure.upstreamExplicitFailure = true;
    failure.selectedCarId = error?.selectedCarId || "";
    failure.selectedCarType = error?.selectedCarType || "";
    failure.conversationId = error?.conversationId || error?.externalId || "";
    failure.carAttempts = Array.isArray(error?.carAttempts) ? error.carAttempts : [];
    return failure;
  }
  const policyFailure = isImagePolicyFailureMessage(
    error?.failureReason || error?.upstreamText || error?.body || error?.message
  );
  const report = imageFailureReport({}, error, {
    submitted: error?.imageSubmissionConfirmed === true
  });
  const failure = new Error(policyFailure ? report.failureReason : report.message);
  failure.status = policyFailure ? 400 : Number(error?.status || error?.statusCode || 0) || 502;
  failure.code = policyFailure
    ? "content_policy"
    : error?.code || (report.submissionConfirmed ? "UPSTREAM_NO_IMAGE" : "IMAGE_SUBMISSION_NOT_CONFIRMED");
  failure.imageSubmissionAttempted = true;
  failure.imageSubmissionConfirmed = report.submissionConfirmed;
  failure.failureType = report.failureType;
  failure.failureReason = report.failureReason;
  failure.failureStage = report.failureStage;
  failure.upstreamText = report.upstreamText;
  failure.upstreamModel = error?.upstreamModel || "";
  failure.upstreamStatus = error?.upstreamStatus || "";
  failure.upstreamExplicitFailure = policyFailure || error?.upstreamExplicitFailure === true;
  failure.selectedCarId = error?.selectedCarId || "";
  failure.selectedCarType = error?.selectedCarType || "";
  failure.conversationId = error?.conversationId || error?.externalId || "";
  failure.carAttempts = Array.isArray(error?.carAttempts) ? error.carAttempts : [];
  return failure;
}

function accountStatusFromError(error, options = {}) {
  if (isChatSubscriptionMissingError(error)) {
    const model = chatSubscriptionModel(error);
    return {
      status: "subscription_missing",
      quota: null,
      balance: null,
      used: null,
      quotaResetAt: "",
      expireAt: "",
      cooldownUntil: null,
      quotaReason: "",
      quotaModel: model.key,
      quotaConfirmedByUpstream: false,
      message: `${model.name} 未订阅套餐，暂不参与任务分配。`,
      ...(model.key ? { meta: { chatModel: model.key } } : {})
    };
  }
  if (isChatSubscriptionExpiredError(error)) {
    const model = chatSubscriptionModel(error);
    return {
      status: "subscription_expired",
      quota: null,
      balance: null,
      used: null,
      quotaResetAt: "",
      expireAt: error?.expireAt || "",
      cooldownUntil: null,
      quotaReason: "",
      quotaModel: model.key,
      quotaConfirmedByUpstream: false,
      message: `${model.name === "当前模型" ? "GPT" : model.name} 套餐已过期，请续费后重新检测。`,
      ...(model.key ? { meta: { chatModel: model.key } } : {})
    };
  }
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
      quotaResetAt: error?.quotaResetAt || cooldownUntil || "",
      cooldownUntil,
      quotaReason: error?.quotaReason || "",
      quotaModel: error?.quotaModel || "",
      quotaConfirmedByUpstream: explicitChatQuotaOnly || error?.quotaConfirmedByUpstream === true,
      period: error?.period || "",
      message: error?.message || "额度不足"
    };
  }
  if (isCarPoolUnavailableError(error)) {
    return {
      status: "error",
      message: carPoolUnavailableMessage()
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
  if (attempts.length && attempts.every((item) => item.carPoolUnavailable === true)) {
    return "上游共享车位暂时不可用，本次请求未能提交。请稍后重试。";
  }
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
  const subscriptionExpired = [drawing.status, chatplus.status].includes("subscription_expired");
  const subscriptionMissing = [drawing.status, chatplus.status].includes("subscription_missing");
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return updateAccountStatus(accountId, {
    status: subscriptionExpired ? "subscription_expired" : subscriptionMissing ? "subscription_missing" : disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : patch.status || account.status || "unknown",
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
  if (isChatSubscriptionExpiredError(error)) {
    await updateTargetAccountStatus(accountId, channel, accountStatusFromError(error, {
      explicitChatQuotaOnly: true
    }));
    return;
  }
  const cooldownUntil = new Date(Date.now() + CHAT_COOLDOWN_MS).toISOString();
  const carPoolUnavailable = isCarPoolUnavailableError(error);
  const disconnected = isDisconnectedError(error);
  await updateTargetAccountStatus(accountId, channel, {
    status: disconnected ? "disconnected" : "error",
    cooldownUntil,
    message: carPoolUnavailable
      ? carPoolUnavailableMessage()
      : disconnected
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

function taskChatModel(task) {
  return String(
    task.raw?.chatModel
      || task.responseJson?.raw?.chatModel
      || task.responseJson?.chatModel
      || task.modelId
      || ""
  ).trim().toLowerCase();
}

function taskUsesGemini(task) {
  const model = taskChatModel(task);
  return model === "gemini" || model.startsWith("gemini-");
}

function validGeminiConversationId(value) {
  return /^c_[a-z0-9_-]{6,128}$/i.test(String(value || "").trim());
}

function taskConversationId(task) {
  const candidates = [
    task.raw?.conversationId,
    task.raw?.conversation_id,
    task.responseJson?.conversationId,
    task.responseJson?.conversation_id,
    task.externalId
  ];
  for (const candidate of candidates) {
    const id = String(candidate || "").trim();
    if (!id) continue;
    if (taskUsesGemini(task) && !validGeminiConversationId(id)) continue;
    return id;
  }
  return "";
}

function upstreamConversationUrl(channel, conversationId, options = {}) {
  const baseUrl = String(channel?.settings?.baseUrl || "https://www.chatplus.cc").trim().replace(/\/+$/, "");
  if (!baseUrl || !conversationId) return "";
  if (options.gemini === true) {
    const routeId = String(conversationId).replace(/^c_/i, "");
    return `${baseUrl}/app/${encodeURIComponent(routeId)}`;
  }
  return `${baseUrl}/c/${encodeURIComponent(conversationId)}`;
}

function upstreamDetailTitle(raw = {}) {
  return String(raw.title || raw.conversation?.title || raw.mapping?.title || "").trim();
}

export async function inspectUpstreamTask(taskId) {
  let task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");

  const config = await loadRuntimeConfig();
  const { channel, account } = inferRefreshTarget(config, task);
  if (channel.type !== "chatplus") {
    const error = new Error("这个任务不是聊天生图，不能读取上游聊天详情。");
    error.status = 400;
    throw error;
  }

  const externalId = taskConversationId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) {
    const error = new Error("这个任务还没有保存上游对话编号。");
    error.status = 400;
    throw error;
  }

  const storedImages = Array.isArray(task.imageUrls) ? task.imageUrls.filter(Boolean) : [];
  const useStoredResult = task.status === "success" && storedImages.length > 0;
  if (!useStoredResult) task = await refreshTask(task.id, { force: true });

  const raw = task.raw || {};
  const conversationId = String(raw.conversationId || raw.conversation_id || externalId).trim();
  const imageUrls = Array.isArray(task.imageUrls) ? task.imageUrls.filter(Boolean) : [];
  const gemini = taskUsesGemini(task);

  return {
    taskId: task.id,
    sourceTaskId: task.sourceTaskId || task.requestMeta?.sourceTaskId || "",
    externalId,
    conversationId,
    conversationUrl: upstreamConversationUrl(channel, conversationId, { gemini }),
    title: upstreamDetailTitle(raw),
    status: task.status || "",
    imageCount: Number(task.imageCount || imageUrls.length),
    imageUrls,
    errorMessage: task.status === "success"
      ? ""
      : task.upstreamText
        || raw.upstreamText
        || raw.refreshErrorMessage
        || task.errorMessage
        || task.responseJson?.message
        || "",
    channelId: channel.id,
    channelName: channel.name,
    accountId: account.id,
    accountName: account.name,
    carId: String(raw.selectedCarId || "").trim(),
    carType: String(raw.selectedCarType || (gemini ? "gemini" : "")).trim(),
    detailSource: useStoredResult ? "stored" : "upstream",
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
      waitingSince: task.raw?.waitingSince || task.raw?.submittedAt || task.createdAt || new Date().toISOString()
    }
  };
}

function isTerminalRefreshError(error) {
  return error?.code === "INVALID_UPSTREAM_RESPONSE";
}

function upstreamResultFingerprint(result = {}) {
  return JSON.stringify({
    status: result.status || "unknown",
    imageUrls: usableImageResultUrls(result.imageUrls),
    errorMessage: String(result.errorMessage || "").trim(),
    upstreamText: resultUpstreamText(result)
  });
}

function checkedRefreshResult(result = {}, task = {}, options = {}) {
  const checkedAt = new Date().toISOString();
  const fingerprint = upstreamResultFingerprint(result);
  const unchangedChecks = fingerprint === task.raw?.lastUpstreamFingerprint
    ? Number(task.raw?.unchangedUpstreamChecks || 0) + 1
    : 0;
  return {
    ...result,
    raw: {
      ...(result.raw || {}),
      refreshError: false,
      refreshErrorCount: 0,
      refreshErrorFirstAt: "",
      refreshErrorLastAt: "",
      refreshErrorMessage: "",
      refreshErrorCode: "",
      refreshErrorStatus: "",
      lastUpstreamCheckAt: checkedAt,
      lastUpstreamCheckStatus: result.status || "unknown",
      lastUpstreamFingerprint: fingerprint,
      unchangedUpstreamChecks: unchangedChecks,
      ...(options.reconnected ? { lastUpstreamReconnectAt: checkedAt } : {})
    }
  };
}

function upstreamReconnectDue(task = {}, finalCheck = false, now = Date.now()) {
  if (finalCheck) return true;
  if (Number(task.raw?.unchangedUpstreamChecks || 0) < 3) return false;
  const lastReconnectAt = Date.parse(task.raw?.lastUpstreamReconnectAt || "");
  return !Number.isFinite(lastReconnectAt) || now - lastReconnectAt >= 60_000;
}

function upstreamWaitStartedAt(task = {}) {
  const value = task.raw?.waitingSince || task.raw?.submittedAt || task.createdAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function upstreamResultWaitExpired(task, now = Date.now()) {
  if (task.status !== "waiting_upstream") return false;
  const startedAt = upstreamWaitStartedAt(task);
  return Number.isFinite(startedAt) && now - startedAt >= UPSTREAM_RESULT_WAIT_TIMEOUT_MS;
}

function refreshErrorRaw(task, error, now) {
  return {
    ...(task.raw || {}),
    refreshError: true,
    refreshErrorCount: Number(task.raw?.refreshErrorCount || 0) + 1,
    refreshErrorFirstAt: task.raw?.refreshErrorFirstAt || now,
    refreshErrorLastAt: now,
    refreshErrorMessage: error?.message || "暂时无法查询上游任务。",
    refreshErrorCode: error?.code || "",
    refreshErrorStatus: error?.status || error?.statusCode || "",
    lastUpstreamCheckAt: now,
    lastUpstreamCheckStatus: "error"
  };
}

function taskSourceTaskId(task = {}) {
  return task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson);
}

async function refreshTaskWithDeadline(work) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("读取上游结果超时，系统会继续自动查询。");
      error.code = "UPSTREAM_TASK_REFRESH_TIMEOUT";
      error.status = 504;
      reject(error);
    }, FAST_TASK_REFRESH_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function interruptExpiredUpstreamWait(task) {
  const interruptedAt = new Date().toISOString();
  const message = "连续 30 分钟未能确认生成结果，任务已停止自动查询；不计入失败，可手动重新查询。";
  const interruptedTask = {
    ...task,
    status: "interrupted",
    errorMessage: "",
    responseJson: attachResponseSourceTaskId({ ok: null, message }, taskSourceTaskId(task)),
    raw: {
      ...(task.raw || {}),
      waitingUpstream: false,
      upstreamWaitExpired: true,
      upstreamWaitExpiredAt: interruptedAt,
      manualRefreshAvailable: true,
      interrupted: true,
      interruptedAt,
      interruptedReason: message
    },
    completedAt: interruptedAt
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
}

function retryableInterruptedUpstreamTask(task = {}) {
  return task.status === "interrupted"
    && (
      task.raw?.upstreamWaitExpired === true
      || task.raw?.manualRefreshAvailable === true
      || task.raw?.imageMirrorGaveUp === true
    );
}

function autoRetryableInterruptedTask(task = {}) {
  return task.status === "interrupted"
    && task.raw?.disabledRefreshSkipped === true
    && task.raw?.manualRefreshAvailable === true
    && task.raw?.submitted === true
    && savedTaskExternalId(task);
}

async function keepUpstreamRefreshRecoverable(task, error, timeoutSec, options = {}) {
  const now = new Date().toISOString();
  const raw = refreshErrorRaw(task, error, now);
  if (options.manualRetry) {
    const message = "重新查询后仍无法确认生成结果；任务保持停止状态，不计入失败。";
    const interruptedTask = {
      ...task,
      status: "interrupted",
      errorMessage: "",
      responseJson: attachResponseSourceTaskId({ ok: null, message }, taskSourceTaskId(task)),
      raw: {
        ...raw,
        waitingUpstream: false,
        upstreamWaitExpired: true,
        manualRefreshAvailable: true,
        interrupted: true,
        manualRefreshAt: now,
        interruptedReason: message
      },
      completedAt: task.completedAt || now
    };
    await upsertTask(interruptedTask);
    return interruptedTask;
  }

  const waitState = refreshedTaskWaitState(task, {
    ...task,
    errorMessage: "",
    raw
  }, timeoutSec);
  const message = "暂时无法查询生成结果，系统会自动重试。";
  const waitingTask = {
    ...task,
    status: waitState.status || task.status,
    errorMessage: "",
    responseJson: attachResponseSourceTaskId({ ok: null, message }, taskSourceTaskId(task)),
    raw: {
      ...(task.raw || {}),
      ...(waitState.raw || raw)
    },
    completedAt: null
  };
  if (upstreamResultWaitExpired(waitingTask)) return interruptExpiredUpstreamWait(waitingTask);
  await upsertTask(waitingTask);
  return waitingTask;
}

async function keepInterruptedAfterManualRefresh(task, result, channel, account) {
  const checkedAt = new Date().toISOString();
  const message = "重新查询后，上游仍未返回最终结果；任务保持停止状态，不计入失败。";
  const refreshedTask = mergeRefreshedTask({ ...task, completedAt: null }, result, channel, account);
  const interruptedTask = {
    ...refreshedTask,
    status: "interrupted",
    errorMessage: "",
    responseJson: attachResponseSourceTaskId({ ok: null, message }, taskSourceTaskId(task)),
    raw: {
      ...(refreshedTask.raw || {}),
      waitingUpstream: false,
      upstreamWaitExpired: true,
      manualRefreshAvailable: true,
      interrupted: true,
      manualRefreshAt: checkedAt,
      interruptedAt: task.raw?.interruptedAt || checkedAt,
      interruptedReason: message
    },
    completedAt: task.completedAt || checkedAt
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
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

function isTemporaryGeneratedImageUrl(value) {
  const source = String(value || "").trim();
  if (!source) return false;
  try {
    return /^\/image_generation_content\/[^/]+$/i.test(new URL(source).pathname.replace(/\/+$/, ""));
  } catch {
    return /(?:^|\/)image_generation_content\/[^/?#]+(?:$|[?#])/i.test(source);
  }
}

function usableImageResultUrls(urls = []) {
  return [...new Set((Array.isArray(urls) ? urls : []).filter((value) => {
    const source = String(value || "").trim();
    return Boolean(source) && !isTemporaryGeneratedImageUrl(source);
  }))];
}

function taskRouteEntry(channel = {}, account = {}) {
  return {
    channelId: String(channel.id || "").trim(),
    channelName: String(channel.name || "").trim(),
    channelType: String(channel.type || "").trim(),
    accountId: String(account.id || "").trim(),
    accountName: String(account.name || account.username || "").trim()
  };
}

function normalizedTaskRoute(value = {}) {
  if (!value || typeof value !== "object") return null;
  const route = taskRouteEntry({
    id: value.channelId,
    name: value.channelName,
    type: value.channelType
  }, {
    id: value.accountId,
    name: value.accountName
  });
  return route.channelId || route.channelName || route.accountId || route.accountName ? route : null;
}

function taskRouteKey(route) {
  return [
    route.channelId || route.channelName,
    route.accountId || route.accountName
  ].join("::");
}

function mergeTaskRoutes(...groups) {
  const routes = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of Array.isArray(group) ? group : []) {
      const route = normalizedTaskRoute(value);
      if (!route) continue;
      const key = taskRouteKey(route);
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route);
    }
  }
  return routes;
}

function resultHasGeneratedImage(result = {}) {
  return String(result.status || "").toLowerCase() === "success"
    && result.taskType !== "chat"
    && (usableImageResultUrls(result.imageUrls).length > 0 || Number(result.imageCount || 0) > 0);
}

function markTaskSubmissionAttempt(task, channel, account, externalId = "") {
  const now = new Date().toISOString();
  const conversationId = String(externalId || task.externalId || "").trim();
  return {
    ...task,
    ...(conversationId ? { externalId: conversationId } : {}),
    submissionChannels: mergeTaskRoutes(task.submissionChannels, [taskRouteEntry(channel, account)]),
    raw: {
      ...(task.raw || {}),
      queued: false,
      submitted: true,
      submittedAt: task.raw?.submittedAt || now,
      ...(conversationId ? { conversationId } : {})
    }
  };
}

function mergeTaskStageTimings(...values) {
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    for (const entry of Array.isArray(value) ? value : []) {
      if (!entry || typeof entry !== "object") continue;
      const durationMs = Number(entry.durationMs);
      if (!String(entry.key || "").trim() || !Number.isFinite(durationMs) || durationMs < 0) continue;
      const key = String(entry.id || [entry.key, entry.startedAt, entry.finishedAt, entry.carId].join("::"));
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry, durationMs: Math.round(durationMs) });
    }
  }
  return entries.slice(-100);
}

function mergeTaskRaw(current = {}, incoming = {}) {
  const stageTimings = mergeTaskStageTimings(current?.stageTimings, incoming?.stageTimings);
  return {
    ...(current || {}),
    ...(incoming || {}),
    ...(stageTimings.length ? { stageTimings } : {})
  };
}

function clearActiveTaskStage(raw = {}) {
  const nextRaw = { ...(raw || {}) };
  delete nextRaw.activeStage;
  return nextRaw;
}

function completedTaskStage(key, label, startedAtMs, status = "success", error = null) {
  return {
    id: `stage-${randomUUID()}`,
    key,
    label,
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    ...(error?.message ? { message: String(error.message).replace(/\s+/g, " ").trim().slice(0, 300) } : {})
  };
}

async function persistTaskStage(task, stage) {
  const raw = mergeTaskRaw(task.raw, { stageTimings: [stage] });
  if (
    raw.activeStage
    && (
      (stage?.id && raw.activeStage.id === stage.id)
      || (!stage?.id && stage?.key && raw.activeStage.key === stage.key)
    )
  ) {
    delete raw.activeStage;
  }
  const nextTask = {
    ...task,
    raw
  };
  await upsertTask(nextTask);
  return nextTask;
}

async function persistTaskStageStart(task, stage, channel, account) {
  const startedTask = stage?.key === "upstream_generation"
    ? markTaskSubmissionAttempt(task, channel, account)
    : task;
  const nextTask = {
    ...startedTask,
    raw: mergeTaskRaw(startedTask.raw, {
      activeStage: stage,
      ...(stage?.carId ? { selectedCarId: stage.carId } : {}),
      ...(stage?.carType ? { selectedCarType: stage.carType } : {})
    })
  };
  await upsertTask(nextTask);
  return nextTask;
}

async function mirrorTaskImageUrls(imageUrls, config, downloadImage, validateDownload, onPhase) {
  return mirrorImageUrls(imageUrls, config, {
    downloadImage,
    attempts: 1,
    validateDownload,
    onPhase
  });
}

function createImageSavePhaseReporter(readTask, writeTask, channel, account) {
  return async (phase) => {
    try {
      if (!phase) {
        const current = readTask();
        if (!current?.raw?.activeStage) return;
        const cleared = { ...current, raw: clearActiveTaskStage(current.raw) };
        await upsertTask(cleared);
        writeTask(cleared);
        return;
      }
      const nextTask = await persistTaskStageStart(readTask(), {
        id: `stage-image-save-${phase.key}`,
        key: phase.key,
        label: phase.label,
        status: "processing",
        startedAt: new Date().toISOString()
      }, channel, account);
      writeTask(nextTask);
    } catch (error) {
      console.error("保存图片子阶段状态更新失败：", error);
    }
  };
}

async function mirrorTaskImages(result, config, client = null, options = {}) {
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
  const startedAt = Date.now();
  let mirroredUrls;
  const inputImageHashes = new Set(
    (options.inputImageHashes || result?.raw?.inputImageHashes || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/.test(value))
  );
  const validateDownload = inputImageHashes.size && result?.taskType === "img2img"
    ? ({ buffer }) => {
        const hash = createHash("sha256").update(buffer).digest("hex");
        if (!inputImageHashes.has(hash)) return;
        const error = new Error("上游返回的图片与原图相同，等待重新获取最终生成图。");
        error.code = "DUPLICATE_INPUT_IMAGE_RESULT";
        error.retryableImageResult = true;
        throw error;
      }
    : null;
  try {
    mirroredUrls = await mirrorTaskImageUrls(imageUrls, config, downloadImage, validateDownload, options.onImagePhase);
  } catch (error) {
    await options.onImagePhase?.(null);
    error.taskStageTiming = completedTaskStage("result_save", "保存图片", startedAt, "failed", error);
    throw error;
  }
  await options.onImagePhase?.(null);
  const saveTiming = completedTaskStage("result_save", "保存图片", startedAt);
  return {
    ...result,
    imageCount: mirroredUrls.length,
    imageUrls: mirroredUrls,
    raw: clearActiveTaskStage(mergeTaskRaw(result.raw, {
      originalImageUrls: imageUrls,
      imageMirrorPending: false,
      imageMirrorRecoveredAt: new Date().toISOString(),
      resultSaveError: "",
      resultSaveErrorCode: "",
      stageTimings: [saveTiming]
    }))
  };
}

export function imageTaskClientView(task = {}) {
  const succeeded = String(task.status || "").toLowerCase() === "success";
  const imageUrls = succeeded ? usableImageResultUrls(task.imageUrls) : [];
  return {
    id: task.id,
    ...(task.sourceTaskId ? { sourceTaskId: task.sourceTaskId } : {}),
    externalId: task.externalId || "",
    status: task.status || "unknown",
    taskType: task.taskType || "",
    modelId: task.modelId || "",
    imageCount: imageUrls.length,
    imageUrls,
    submissionChannels: mergeTaskRoutes(task.submissionChannels),
    generationChannels: mergeTaskRoutes(task.generationChannels),
    errorMessage: task.errorMessage || "",
    ...(task.responseJson?.failureType ? {
      failureType: task.responseJson.failureType,
      submissionConfirmed: task.responseJson.submissionConfirmed === true,
      failureReason: task.responseJson.failureReason || "",
      failureStage: task.responseJson.failureStage || null
    } : {}),
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null
  };
}

async function clearRecoveredChatModelUsage(accountId, channel, modelKey) {
  const normalizedModelKey = modelRequestKey(modelKey);
  if (!normalizedModelKey) return;
  const ability = channelAbilityKey(channel);
  await updateAccountMeta(accountId, (accountMeta) => {
    const currentStatus = ability
      ? accountMeta.abilities?.[ability] || {}
      : { meta: accountMeta };
    const statusMeta = { ...(currentStatus.meta || accountMeta || {}) };
    const referenceUsage = { ...(statusMeta.referenceUsage || {}) };
    const referenceBalance = referenceUsage[normalizedModelKey]?.balance;
    const referenceBalanceKnown = referenceBalance !== null
      && referenceBalance !== undefined
      && String(referenceBalance).trim() !== ""
      && Number.isFinite(Number(referenceBalance));
    const recoveryBalance = statusMeta.recoveryUsage?.balance;
    const recoveryBalanceKnown = recoveryBalance !== null
      && recoveryBalance !== undefined
      && String(recoveryBalance).trim() !== ""
      && Number.isFinite(Number(recoveryBalance));
    let changed = false;
    if (referenceBalanceKnown && Number(referenceBalance) <= 0) {
      delete referenceUsage[normalizedModelKey];
      statusMeta.referenceUsage = referenceUsage;
      changed = true;
    }
    if (
      modelRequestKey(statusMeta.chatModel) === normalizedModelKey
      && recoveryBalanceKnown
      && Number(recoveryBalance) <= 0
    ) {
      delete statusMeta.recoveryUsage;
      changed = true;
    }
    if (!changed) return accountMeta;
    if (!ability) return statusMeta;
    return {
      ...accountMeta,
      abilities: {
        ...(accountMeta.abilities || {}),
        [ability]: {
          ...currentStatus,
          meta: statusMeta
        }
      }
    };
  });
}

async function markAccountAvailable(accountId, channel = "", modelKey = "") {
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
  if (channelType === "chatplus" && modelKey) {
    await clearRecoveredChatModelUsage(accountId, channel, modelKey);
  }
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
    const patch = accountStatusFromError(error, {
      explicitChatQuotaOnly: channel?.type === "chatplus"
    });
    if (
      channel?.type === "chatplus"
      && patch.status === "quota_empty"
      && isExplicitChatAccountUsageError(error)
    ) {
      const config = await loadRuntimeConfig();
      const currentAccount = config.accounts.find((item) => item.id === account.id) || account;
      const currentStatus = targetQuotaStatus({ channel, account: currentAccount });
      const modelKey = modelRequestKey(
        patch.quotaModel
          || error?.quotaModel
          || targetChatModelKey({ channel, account: currentAccount })
      );
      const previousUsage = currentStatus.meta?.referenceUsage?.[modelKey] || {};
      patch.meta = {
        ...(currentStatus.meta || {}),
        chatModel: modelKey || currentStatus.meta?.chatModel || "",
        referenceUsage: {
          ...(currentStatus.meta?.referenceUsage || {}),
          ...(modelKey ? {
            [modelKey]: {
              ...previousUsage,
              quota: error?.quota ?? previousUsage.quota ?? null,
              used: error?.used ?? previousUsage.used ?? null,
              balance: error?.balance ?? 0,
              quotaResetAt: patch.quotaResetAt || previousUsage.quotaResetAt || "",
              period: error?.period || previousUsage.period || ""
            }
          } : {})
        }
      };
    }
    await updateTargetAccountStatus(account.id, channel, patch);
    return;
  }
  await withAccountAuthLock(account, () => (
    updateTargetAccountStatus(account.id, channel, drawingRateLimitPatch(retryAfterSeconds))
  ));
}

async function skipAccountAfterConfirmedUsageLimit(target, error, attempts) {
  if (
    target.channel.type !== "chatplus"
    || !isExplicitChatAccountUsageError(error)
    || error.imageSubmissionConfirmed === true
  ) {
    return false;
  }
  pushAttempt(attempts, target, error.message || "该账户额度已用完", {
    quotaEmpty: true,
    upstreamText: originalFailureText(error.upstreamText || error.body)
  });
  await updateTargetStatusAfterError(target.account, target.channel, error);
  return true;
}

async function updateAccountAfterTask(account, channel, result = {}) {
  if (channel?.type === "chatplus") {
    const ability = channelAbilityKey(channel);
    const protectionSettings = normalizeQuotaProtectionSettings(channel?.settings?.quotaProtection);
    if (!protectionSettings.enabled) {
      const config = await loadRuntimeConfig();
      const currentAccount = config.accounts.find((item) => item.id === account.id) || account;
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
      await markAccountAvailable(account.id, channel, storedTaskModelKey(result));
      return false;
    }
    if (!ability) {
      await markAccountAvailable(account.id, channel, storedTaskModelKey(result));
      return false;
    }

    const modelKey = storedTaskModelKey(result);
    const submitted = result.status === "success"
      || result.raw?.submitted === true
      || Boolean(savedTaskExternalId(result));
    await updateAccountMeta(account.id, (accountMeta) => {
      const abilities = { ...(accountMeta.abilities || {}) };
      const currentStatus = abilities[ability] || {};
      if (
        result.taskType === "chat"
        && currentStatus.status === "quota_empty"
        && currentStatus.quotaConfirmedByUpstream === true
        && currentStatus.quotaReason === "image_quota"
      ) {
        return accountMeta;
      }

      const currentMeta = { ...(currentStatus.meta || {}) };
      const referenceUsage = { ...(currentMeta.referenceUsage || {}) };
      const usage = modelKey ? referenceUsage[modelKey] : null;
      const knownBalance = usage?.balance !== null
        && usage?.balance !== undefined
        && String(usage.balance).trim() !== ""
        && Number.isFinite(Number(usage.balance));
      const knownQuota = usage?.quota !== null
        && usage?.quota !== undefined
        && String(usage.quota).trim() !== ""
        && Number.isFinite(Number(usage.quota));
      const protectionUsages = {};
      if (submitted && modelKey && knownBalance && knownQuota) {
        const previousProtection = quotaProtectionStateFor(currentStatus, modelKey);
        const previousProtectionMatches = quotaProtectionBlocked(
          { ...(previousProtection || {}), active: true },
          protectionSettings
        );
        const estimatedFrom = previousProtectionMatches && Number.isFinite(Number(previousProtection?.balance))
          ? Math.min(Number(usage.balance), Number(previousProtection.balance))
          : Number(usage.balance);
        const balance = Math.max(0, estimatedFrom - 1);
        protectionUsages[modelKey] = {
          ...usage,
          balance,
          used: Math.max(0, Number(usage.quota) - balance)
        };
      }

      const available = {
        ...currentStatus,
        status: "ok",
        quota: null,
        balance: null,
        used: null,
        quotaResetAt: "",
        cooldownUntil: null,
        quotaReason: "",
        quotaConfirmedByUpstream: false,
        period: "",
        message: "最近调用成功",
        lastCheckAt: new Date().toISOString(),
        meta: {
          ...currentMeta,
          ...(modelKey ? { chatModel: modelKey } : {}),
          referenceUsage
        }
      };
      const nextStatus = applyQuotaProtectionStates(
        available,
        currentStatus,
        protectionSettings,
        protectionUsages
      );
      abilities[ability] = nextStatus;
      return { ...accountMeta, abilities };
    });
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

      const quotaEmpty = drawingBalanceInsufficient(drawing.balance);
      await updateTargetAccountStatus(account.id, channel, {
        status: quotaEmpty ? "quota_empty" : "ok",
        cooldownUntil: null,
        cooldownReason: "",
        upstreamFailureCode: severeFailureReason,
        upstreamFailureStreak,
        message: quotaEmpty
          ? "绘图积分不足"
          : `${severeFailureText}，连续失败 ${upstreamFailureStreak}/${DRAWING_FAILURE_LIMIT} 次。`
      });
      return false;
    }

    const quotaEmpty = drawingBalanceInsufficient(drawing.balance);
    await updateTargetAccountStatus(account.id, channel, {
      status: quotaEmpty ? "quota_empty" : "ok",
      cooldownUntil: null,
      cooldownReason: "",
      upstreamFailureCode: "",
      upstreamFailureStreak: 0,
      message: quotaEmpty
        ? "绘图积分不足"
        : result.status === "success" ? "最近绘图调用成功" : "绘图账号可继续使用"
    });
    return false;
  });
}

function mergeRefreshedTask(task, result, channel, account) {
  const status = result.status || task.status;
  const route = taskRouteEntry(channel, account);
  const wasSubmitted = Boolean(task.raw?.submitted || savedTaskExternalId(task) || savedTaskExternalId(result));
  const mergedRaw = mergeTaskRaw(task.raw, result.raw);
  const taskType = result.taskType || task.taskType;
  const resultErrorMessage = taskErrorMessage(result, task);
  const failure = status === "failed" && taskType !== "chat"
    ? imageFailureReport({ ...task, taskType, raw: mergedRaw }, {
        message: resultErrorMessage,
        upstreamText: resultUpstreamText(result) || resultErrorMessage
      }, { submitted: wasSubmitted })
    : null;
  const submittedAtMs = Date.parse(task.raw?.submittedAt || "");
  const hasResultWaitTiming = (mergedRaw.stageTimings || []).some((entry) => entry.key === "result_wait");
  const resultWaitTiming = status === "success"
    && task.status !== "success"
    && !hasResultWaitTiming
    && Number.isFinite(submittedAtMs)
      ? completedTaskStage("result_wait", "等待图片完成", submittedAtMs)
      : null;
  return {
    ...task,
    externalId: result.externalId || task.externalId,
    taskNo: result.taskNo || task.taskNo,
    status,
    prompt: result.prompt || task.prompt,
    taskType,
    modelId: result.modelId ?? task.modelId,
    ratio: result.ratio || task.ratio,
    imageCount: result.imageCount ?? task.imageCount,
    imageUrls: result.imageUrls || task.imageUrls || [],
    upstreamText: failure?.upstreamText || resultUpstreamText(result) || task.upstreamText || "",
    errorMessage: status === "success" ? "" : failure?.message || resultErrorMessage,
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    submissionChannels: mergeTaskRoutes(task.submissionChannels, wasSubmitted ? [route] : []),
    generationChannels: mergeTaskRoutes(
      task.generationChannels,
      resultHasGeneratedImage({ ...result, status }) ? [route] : []
    ),
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : task.completedAt || null,
    requestJson: task.requestJson || null,
    responseJson: attachResponseSourceTaskId({
      ...taskResponseJson(result),
      ...(failure ? imageFailureResponseFields(failure) : {})
    }, task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)),
    raw: mergeTaskRaw(mergedRaw, {
      ...(failure ? imageFailureRawFields(failure) : {}),
      stageTimings: resultWaitTiming ? [resultWaitTiming] : []
    })
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
      disabledRefreshSkipped: true,
      manualRefreshAvailable: true
    },
    completedAt: interruptedAt
  };
  await upsertTask(interruptedTask);
  return interruptedTask;
}

async function interruptMissingRefreshTarget(task, error) {
  const interruptedAt = new Date().toISOString();
  const reason = /账号/.test(String(error?.message || ""))
    ? "任务所属渠道没有可用账号，系统已停止自动查询；不计入失败。账号恢复后可手动重新查询。"
    : "任务所属渠道已不存在，系统已停止自动查询；不计入失败。渠道恢复后可手动重新查询。";
  const interruptedTask = {
    ...task,
    status: "interrupted",
    errorMessage: "",
    responseJson: attachResponseSourceTaskId({ ok: null, message: reason }, taskSourceTaskId(task)),
    raw: {
      ...(task.raw || {}),
      waitingUpstream: false,
      refreshTargetMissing: true,
      refreshTargetMessage: error?.message || "",
      manualRefreshAvailable: true,
      interrupted: true,
      interruptedAt,
      interruptedReason: reason
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

async function refreshTaskOnce(taskId, options = {}) {
  const task = await getTask(taskId);
  if (!task) throw new Error("任务不存在。");
  const manualRetry = retryableInterruptedUpstreamTask(task);
  if (!needsTaskRefresh(task) && !manualRetry && options.force !== true) return task;

  const config = await loadRuntimeConfig();
  let channel;
  let account;
  try {
    ({ channel, account } = inferRefreshTarget(config, task));
  } catch (error) {
    if (!/找不到这个任务所属的渠道|这个渠道还没有可用账号/.test(String(error?.message || ""))) throw error;
    return interruptMissingRefreshTarget(task, error);
  }
  if (refreshTargetDisabled(channel, account)) {
    if (options.autoRetry === true) return task;
    return interruptDisabledRefreshTask(task, channel, account);
  }
  const client = getWorkClient(config, channel, account);
  if (typeof client.getTask !== "function") return task;

  const externalId = taskExternalId(task);
  if (!externalId || (task.raw?.queued && String(externalId).startsWith("task-"))) return task;

  const taskStillActive = scheduledImageTasks.has(task.id) || activeSubmittedTaskIds.has(task.id);
  const originalImageUrls = storedOriginalImageUrls(task);
  const hadTemporaryGeneratedImageUrl = Array.isArray(task.raw?.originalImageUrls)
    && task.raw.originalImageUrls.some(isTemporaryGeneratedImageUrl);
  let storedMirrorError = null;
  if (originalImageUrls.length) {
    if (taskStillActive) return task;
    if (imageMirrorRecoveryExpired(task) && !(manualRetry && hadTemporaryGeneratedImageUrl)) {
      const now = new Date().toISOString();
      return interruptExpiredImageMirror(
        task,
        new Error(task.raw?.resultSaveError || "上游图片地址已失效。"),
        Number(task.raw?.imageMirrorRetryCount || 0),
        imageMirrorRecoveryStartedAt(task, now),
        now
      );
    }
    try {
      let phaseTaskState = task;
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
      }, config, client, {
        inputImageHashes: task.raw?.inputImageHashes,
        onImagePhase: createImageSavePhaseReporter(
          () => phaseTaskState,
          (next) => { phaseTaskState = next; },
          channel,
          account
        )
      });
      const nextTask = mergeRefreshedTask(task, result, channel, account);
      await upsertTask(nextTask);
      await recordTaskStat(nextTask);
      await updateAccountAfterTask(account, channel, nextTask);
      return nextTask;
    } catch (error) {
      storedMirrorError = error;
    }
  }

  if (
    !storedMirrorError
    && storedTaskModelKey(task) === "gemini"
    && task.raw?.submitted === true
    && !validGeminiConversationId(externalId)
  ) {
    if (taskStillActive) return task;
    return interruptUnrecoverableGeminiTask(task);
  }

  let refreshedResult;
  let refreshReadSucceeded = false;
  const finalCheck = upstreamResultWaitExpired(task);
  const forceReconnect = upstreamReconnectDue(task, finalCheck);
  const persistedUpdates = channel.type === "chatplus"
    ? await listChatplusConversationUpdates(externalId)
    : [];
  const sessionSnapshot = channel.type === "chatplus" ? taskRefreshSession(task.id) : null;
  try {
    refreshedResult = await runChatplusAccountWork(channel, account, () => refreshTaskWithDeadline(() => client.getTask(externalId, {
      carId: task.raw?.selectedCarId,
      carType: task.raw?.selectedCarType,
      imageTask: task.taskType === "text2img" || task.taskType === "img2img",
      upstreamTaskId: task.raw?.upstreamTaskId,
      persistedUpdates,
      timeoutSec: FAST_TASK_REFRESH_TIMEOUT_SEC,
      forceReconnect,
      sessionSnapshot,
      onSessionSnapshot: (snapshot) => rememberTaskRefreshSession(task.id, snapshot)
    })), {
      parallel: channel.type === "chatplus" && Boolean(task.raw?.selectedCarId)
    });
    refreshReadSucceeded = true;
  } catch (error) {
    if (storedMirrorError) {
      return keepSubmittedTaskRecoverable(task, storedMirrorError, task.attempts || []);
    }
    if (!isTerminalRefreshError(error)) {
      return keepUpstreamRefreshRecoverable(task, error, config.waitTimeoutSec, { manualRetry });
    }
    refreshedResult = failedRefreshResult(task, externalId, error);
  }
  if (refreshReadSucceeded) {
    refreshedResult = checkedRefreshResult(refreshedResult, task, { reconnected: forceReconnect });
  }
  if (manualRetry && !isFinishedTask(refreshedResult?.status)) {
    return keepInterruptedAfterManualRefresh(task, refreshedResult, channel, account);
  }
  if (manualRetry) {
    refreshedResult = {
      ...refreshedResult,
      raw: {
        ...(refreshedResult.raw || {}),
        waitingUpstream: false,
        upstreamWaitExpired: false,
        upstreamWaitExpiredAt: "",
        manualRefreshAvailable: false,
        interrupted: false,
        interruptedAt: "",
        interruptedReason: ""
      }
    };
  }
  let refreshInput = refreshedTaskWaitState(task, refreshedResult, config.waitTimeoutSec);
  if (storedMirrorError) {
    const storedUrls = new Set(originalImageUrls);
    const replacementUrls = usableImageResultUrls(refreshedResult?.imageUrls)
      .filter((url) => !storedUrls.has(url));
    if (!replacementUrls.length) {
      return keepSubmittedTaskRecoverable(task, storedMirrorError, task.attempts || []);
    }
    refreshInput = {
      ...refreshInput,
      status: "success",
      imageCount: replacementUrls.length,
      imageUrls: replacementUrls
    };
  }

  if (!storedMirrorError && !isFinishedTask(refreshInput.status)) {
    const waitingTask = mergeRefreshedTask(task, refreshInput, channel, account);
    if (upstreamResultWaitExpired(waitingTask)) return interruptExpiredUpstreamWait(waitingTask);
  }

  let result;
  try {
    let phaseTaskState = task;
    result = await mirrorTaskImages(refreshInput, config, client, {
      inputImageHashes: task.raw?.inputImageHashes,
      onImagePhase: createImageSavePhaseReporter(
        () => phaseTaskState,
        (next) => { phaseTaskState = next; },
        channel,
        account
      )
    });
  } catch (error) {
    const replacementUrls = usableImageResultUrls(refreshInput.imageUrls);
    if (!replacementUrls.length && !storedMirrorError) throw error;
    return keepSubmittedTaskRecoverable({
      ...task,
      externalId: refreshedResult?.externalId || task.externalId,
      imageCount: replacementUrls.length,
      imageUrls: replacementUrls,
      raw: {
        ...(task.raw || {}),
        ...(refreshedResult?.raw || {}),
        upstreamCompleted: true,
        originalImageUrls: replacementUrls
      }
    }, error, task.attempts || []);
  }
  const mergeBaseTask = manualRetry ? { ...task, completedAt: null } : task;
  const nextTask = mergeRefreshedTask(mergeBaseTask, result, channel, account);
  await upsertTask(nextTask);
  if (isFinishedTask(nextTask.status)) {
    forgetTaskRefreshSession(nextTask.id);
    await recordTaskStat(nextTask);
    await updateAccountAfterTask(account, channel, nextTask);
  }
  return nextTask;
}

export async function refreshTask(taskId, options = {}) {
  const key = String(taskId || "");
  const active = activeTaskRefreshes.get(key);
  if (active) return active;
  const refresh = refreshTaskOnce(taskId, options).finally(() => {
    if (activeTaskRefreshes.get(key) === refresh) activeTaskRefreshes.delete(key);
  });
  activeTaskRefreshes.set(key, refresh);
  return refresh;
}

function fastTaskRefreshEligible(task = {}) {
  return Boolean(
    task.id
    && task.channelType === "chatplus"
    && ["img2img", "text2img"].includes(task.taskType)
    && task.raw?.submitted === true
    && savedTaskExternalId(task)
    && needsTaskRefresh(task)
  );
}

const fastTaskRefresher = createFastTaskRefresher({
  refresh: (taskId) => refreshTask(taskId),
  shouldContinue: fastTaskRefreshEligible,
  initialDelayMs: 2000,
  maxAttempts: 360
});

function scheduleFastTaskRefresh(task) {
  if (!fastTaskRefreshEligible(task)) return null;
  const refresh = fastTaskRefresher.schedule(task.id);
  refresh?.catch((error) => console.error(error));
  return refresh;
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
  const tasks = await listActiveTasks({ includeInterrupted: true });
  const pending = tasks.filter((item) => needsTaskRefresh(item) || autoRetryableInterruptedTask(item));
  const groups = new Map();
  for (const task of pending) {
    const selectedCar = task.channelType === "chatplus"
      ? `${task.raw?.selectedCarType || "chatgpt"}:${task.raw?.selectedCarId || "default"}`
      : "default";
    const key = `${task.channelType || "unknown"}:${task.accountId || task.id}:${selectedCar}`;
    const group = groups.get(key) || [];
    group.push(task);
    groups.set(key, group);
  }

  const results = [];
  const groupList = [...groups.values()];
  let nextGroupIndex = 0;
  const refreshGroup = async (group) => {
    for (const task of group) {
      try {
        if (isLostLocalImageTask(task)) {
          results.push({ id: task.id, ok: true, data: await interruptLostLocalImageTask(task) });
          continue;
        }
        if (isLostLocalChatTask(task)) {
          results.push({ id: task.id, ok: true, data: await failLostLocalChatTask(task) });
          continue;
        }
        const refreshed = await refreshTask(task.id, { autoRetry: autoRetryableInterruptedTask(task) });
        scheduleFastTaskRefresh(refreshed);
        results.push({ id: task.id, ok: true, data: refreshed });
      } catch (error) {
        results.push({ id: task.id, ok: false, message: error.message });
      }
    }
  };
  const workerCount = Math.min(20, groupList.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextGroupIndex < groupList.length) {
      const group = groupList[nextGroupIndex++];
      await refreshGroup(group);
    }
  }));
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

function geminiModelFamily(value) {
  const key = modelRequestKey(value);
  return key === "gemini" || key.startsWith("gemini-") ? "gemini" : "";
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
    if (geminiModelFamily(explicitKey)) return { type: "chat", key: "gemini" };
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

function requestedAccountIdForInput(input = {}) {
  return String(input.accountId || input.account_id || "").trim();
}

function strictAccountIdForInput(input = {}) {
  return requestedAccountIdForInput(input);
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

function completedRoutingLoad(usage, target, slot, input = {}) {
  const slotUsage = usage?.accounts?.[target?.account?.id]?.routing?.[slot] || {};
  if (!["chat", "chatImage"].includes(slot)) return Number(slotUsage.auto || 0);
  const modelKey = targetChatModelKey(target, input) || "gpt";
  return Number(slotUsage.models?.[modelKey]?.auto || 0);
}

function routingGroupKey(target, taskType, input = {}) {
  const slot = targetTaskSlot(target, taskType);
  const modelKey = ["chat", "chatImage"].includes(slot) ? targetChatModelKey(target, input) || "gpt" : "";
  return [target?.channel?.id || "channel", slot, modelKey].filter(Boolean).join(":");
}

function routingBalanceWindow(groupKey, group, usage, taskType, input = {}) {
  const signature = group
    .map((item) => `${item.target.account.id}:${accountRoutingWeight(item.target.account)}`)
    .sort()
    .join("|");
  let window = routingBalanceWindows.get(groupKey);
  if (!window || window.day !== usage.day || window.signature !== signature) {
    window = {
      day: usage.day,
      signature,
      baseline: Object.fromEntries(group.map((item) => {
        const slot = targetTaskSlot(item.target, taskType);
        return [item.target.account.id, completedRoutingLoad(usage, item.target, slot, input)];
      }))
    };
    routingBalanceWindows.set(groupKey, window);
  }
  return window;
}

async function orderTargetsByRoutingUsage(targets, taskType, input = {}) {
  if (!targets.length) return targets;
  const usage = await listTodayAccountRoutingUsage();
  const groups = new Map();

  targets.forEach((target, index) => {
    const key = routingGroupKey(target, taskType, input);
    const group = groups.get(key) || [];
    group.push({ target, index });
    groups.set(key, group);
  });

  const ordered = [...groups.entries()].flatMap(([groupKey, group]) => {
    const window = routingBalanceWindow(groupKey, group, usage, taskType, input);
    return group.map((item) => {
      const slot = targetTaskSlot(item.target, taskType);
      const completed = completedRoutingLoad(usage, item.target, slot, input);
      const baseline = Number(window.baseline[item.target.account.id] || 0);
      const load = Math.max(0, completed - baseline)
        + activeRoutingLoad(slot, item.target, input)
        + requestedRoutingLoad(slot, input);
      return {
        ...item,
        load,
        weight: accountRoutingWeight(item.target.account)
      };
    })
    .sort((left, right) => (
      left.load * right.weight - right.load * left.weight
      || left.index - right.index
    ))
    .map((item) => item.target);
  });
  const preferredAccountId = requestedAccountIdForInput(input);
  const preferred = preferredAccountId
    ? ordered.find((target) => target.account.id === preferredAccountId)
    : null;
  return preferred
    ? [preferred, ...ordered.filter((target) => !sameTarget(target, preferred))]
    : ordered;
}

function withRoutingReservationLock(work) {
  const run = routingReservationQueue.catch(() => {}).then(work);
  routingReservationQueue = run.then(() => undefined, () => undefined);
  return run;
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
  const allowDisabledAccountTest = options.allowDisabledAccountTest === true
    || options.input?.allowDisabledAccountTest === true;
  const channels = config.channels
    .filter((channel) => channel.enabled !== false)
    .filter((channel) => channelMatchesRequest(channel, requestedChannel))
    .filter((channel) => !(taskType === "chat" && channel.type === "drawing"))
    .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));

  const targets = [];
  for (const channel of channels) {
    const accounts = config.accounts
      .filter((account) => (allowDisabledAccountTest || account.enabled !== false) && accountMatchesChannel(account, channel))
      .filter((account) => !requestedAccountId || account.id === requestedAccountId)
      .sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
    if (channel.type === "shareai") {
      for (const ability of shareAIAbilitiesForTask(channel, requestedChannel, taskType)) {
        const abilityAccounts = accounts.filter((account) =>
          !(ability === "chatplus" && !options.includeCooling && accountCooling(account))
        );
        for (const account of abilityAccounts) {
          targets.push({ channel: shareAIAbilityChannel(channel, ability), account });
        }
      }
      continue;
    }
    const channelAccounts = accounts.filter((account) =>
      !(channel.type === "chatplus" && !options.includeCooling && accountCooling(account))
    );
    for (const account of channelAccounts) {
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
  const route = taskRouteEntry(channel, account);
  const submitted = Boolean(savedTaskExternalId(result));
  const resultErrorMessage = taskErrorMessage(result, {});
  const failure = status === "failed" && result.taskType !== "chat"
    ? imageFailureReport({ ...result, raw: result.raw || {}, submitted }, {
        message: resultErrorMessage,
        upstreamText: resultUpstreamText(result) || resultErrorMessage
      }, { submitted })
    : null;
  const meta = taskRequestMeta(requestMeta);
  const sourceTaskId = meta.sourceTaskId || sourceTaskIdFrom(requestJson);
  const requestMetaPayload = sourceTaskId && !meta.sourceTaskId ? { ...meta, sourceTaskId } : meta;
  const requestPayload = attachSourceTaskId(requestJson, sourceTaskId);
  const requestedModel = requestPayload?.model
    || requestPayload?.chat_model
    || requestPayload?.chatModel
    || requestPayload?.model_id
    || requestPayload?.modelId
    || "";
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
    upstreamText: failure?.upstreamText || resultUpstreamText(result),
    errorMessage: failure?.message || resultErrorMessage,
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    submissionChannels: submitted ? [route] : [],
    generationChannels: resultHasGeneratedImage({ ...result, status }) ? [route] : [],
    requestMeta: requestMetaPayload,
    network: taskNetworkMeta(account),
    attempts,
    requestJson: requestPayload,
    responseJson: attachResponseSourceTaskId({
      ...taskResponseJson(result),
      ...(failure ? imageFailureResponseFields(failure) : {})
    }, sourceTaskId),
    completedAt: isFinishedTask(status) ? new Date().toISOString() : null,
    raw: {
      ...(requestedModel !== "" ? { requestedModel } : {}),
      ...(result.raw || result),
      ...(failure ? imageFailureRawFields(failure) : {})
    }
  };
}

function attemptErrorMessage(attempts) {
  return attempts.map((item) => `${item.channelName}/${item.accountName}：${item.message}`).join("；");
}

function sameTarget(left, right) {
  return left?.channel?.id === right?.channel?.id && left?.account?.id === right?.account?.id;
}

async function targetBusyAttempt(target, taskType, input = {}) {
  const slot = targetTaskSlot(target, taskType);
  const durableState = await durableTaskSlotState(slot, target, input);
  const error = busyTaskError(slot, target, durableState.tasks[0] || null);
  return {
    channelId: target.channel.id,
    channelName: target.channel.name,
    accountId: target.account.id,
    accountName: target.account.name,
    message: error.message,
    busy: true,
    ...(error.blockingTaskId ? {
      blockingTaskId: error.blockingTaskId,
      blockingTaskStatus: error.blockingTaskStatus,
      blockingTaskCreatedAt: error.blockingTaskCreatedAt
    } : {})
  };
}

function targetQuotaStatus(target) {
  const ability = channelAbilityKey(target?.channel);
  const abilityStatus = ability ? target?.account?.meta?.abilities?.[ability] || {} : null;
  return abilityStatus && Object.keys(abilityStatus).length ? abilityStatus : target?.account || {};
}

function targetQuotaProtectionSettings(target = {}) {
  return normalizeQuotaProtectionSettings(target?.channel?.settings?.quotaProtection);
}

function targetQuotaProtectionKey(target = {}, input = {}) {
  return target?.channel?.type === "drawing"
    ? "drawing"
    : targetChatModelKey(target, input) || "gpt";
}

function statusQuotaProtectionState(target, status = {}, input = {}) {
  return quotaProtectionStateFor(status, targetQuotaProtectionKey(target, input));
}

function statusQuotaProtectionBlocksTask(target, status = {}, input = {}) {
  return quotaProtectionBlocked(
    statusQuotaProtectionState(target, status, input),
    targetQuotaProtectionSettings(target)
  );
}

function targetQuotaProtectionBlocksTask(target, input = {}) {
  return statusQuotaProtectionBlocksTask(target, targetQuotaStatusForTask(target, input), input);
}

function targetQuotaProtectionNearLimit(target, input = {}) {
  const status = targetQuotaStatusForTask(target, input);
  return quotaProtectionNearLimit(
    statusQuotaProtectionState(target, status, input),
    targetQuotaProtectionSettings(target)
  );
}

function targetQuotaProtectionNeedsInitialCheck(target, input = {}) {
  const settings = targetQuotaProtectionSettings(target);
  if (!settings.enabled) return false;
  const status = targetQuotaStatusForTask(target, input);
  const state = statusQuotaProtectionState(target, status, input);
  return !state
    || state.known !== true
    || !quotaProtectionBlocked({ ...state, active: true }, settings);
}

function targetQuotaProtectionRecoveryDue(target, input = {}, now = Date.now()) {
  if (!targetQuotaProtectionBlocksTask(target, input)) return false;
  return quotaProtectionRecheckDue(
    statusQuotaProtectionState(target, targetQuotaStatusForTask(target, input), input),
    now
  );
}

function applyCheckedQuotaProtection(channel, account, status = {}, previousStatus = null, options = {}) {
  const settings = normalizeQuotaProtectionSettings(channel?.settings?.quotaProtection);
  const previous = previousStatus || targetQuotaStatus({ channel, account });
  const usages = channel?.type === "drawing"
    ? {
        drawing: {
          quota: status.quota,
          balance: status.balance,
          quotaResetAt: status.quotaResetAt || ""
        }
      }
    : status.meta?.referenceUsage || {};
  return applyQuotaProtectionStates(status, previous, settings, usages, options);
}

function knownChatUsageBalance(value) {
  return value !== null
    && value !== undefined
    && String(value).trim() !== ""
    && Number.isFinite(Number(value));
}

function targetQuotaStatusForTask(target, input = {}) {
  const status = targetQuotaStatus(target);
  if (target?.channel?.type !== "chatplus") return status;

  const modelKey = targetChatModelKey(target, input);
  if (!modelKey) return status;
  const directModelKey = modelRequestKey(status.quotaModel || status.meta?.chatModel);
  const directQuotaEmpty = String(status.status || "").toLowerCase() === "quota_empty"
    && (
      status.quotaConfirmedByUpstream === true
      || (knownChatUsageBalance(status.balance) && Number(status.balance) <= 0)
    );
  const modelStatus = {
    ...status,
    quotaModel: modelKey,
    meta: {
      ...(status.meta || {}),
      chatModel: modelKey
    }
  };

  if (directQuotaEmpty && (!directModelKey || directModelKey === modelKey)) {
    return {
      ...modelStatus,
      quotaConfirmedByUpstream: true
    };
  }

  const usage = status.meta?.referenceUsage?.[modelKey];
  if (usage && knownChatUsageBalance(usage.balance) && Number(usage.balance) <= 0) {
    const resetAt = usage.quotaResetAt || "";
    const resetTime = Date.parse(resetAt);
    return {
      ...modelStatus,
      status: "quota_empty",
      quota: usage.quota ?? null,
      used: usage.used ?? null,
      balance: 0,
      quotaResetAt: resetAt,
      cooldownUntil: Number.isFinite(resetTime) && resetTime > Date.now()
        ? resetAt
        : status.cooldownUntil || null,
      quotaReason: "chat_usage_limit",
      quotaConfirmedByUpstream: true,
      period: usage.period || "",
      message: status.message || "该模型额度已用完，系统将在额度刷新后自动恢复。"
    };
  }

  if (directQuotaEmpty && directModelKey && directModelKey !== modelKey) {
    return {
      ...modelStatus,
      status: "ok",
      quota: usage?.quota ?? null,
      used: usage?.used ?? null,
      balance: usage?.balance ?? null,
      quotaResetAt: usage?.quotaResetAt || "",
      cooldownUntil: null,
      quotaReason: "",
      quotaConfirmedByUpstream: false,
      period: usage?.period || "",
      message: "该模型可用"
    };
  }

  return modelStatus;
}

function targetAccountCoolingBlocksTask(target, input = {}) {
  if (!accountCooling(target?.account)) return false;
  if (target?.channel?.type !== "chatplus") return true;
  const status = targetQuotaStatus(target);
  const blockedModelKey = modelRequestKey(status.quotaModel || status.meta?.chatModel);
  const requestedModelKey = targetChatModelKey(target, input);
  const modelSpecificQuota = String(status.status || "").toLowerCase() === "quota_empty"
    && status.quotaConfirmedByUpstream === true
    && blockedModelKey
    && requestedModelKey
    && blockedModelKey !== requestedModelKey;
  return !modelSpecificQuota;
}

function targetAbilityCooling(target, input = {}) {
  return statusCooling(targetQuotaStatusForTask(target, input));
}

function targetKnownUnavailable(target, input = {}, options = {}) {
  const status = String(targetQuotaStatus(target).status || "unknown").toLowerCase();
  return targetSubscriptionMissing(target, input)
    || targetSubscriptionExpired(target, input)
    || ["activation_required", "error", "failed", "disconnected"].includes(status)
    || (status === "disabled" && options.allowDisabledAccountTest !== true);
}

function targetQuotaEmpty(target) {
  const status = targetQuotaStatus(target);
  const quotaEmpty = String(status.status || "").toLowerCase() === "quota_empty";
  if (target?.channel?.type !== "chatplus") return quotaEmpty;
  return quotaEmpty && status.quotaConfirmedByUpstream === true;
}

function targetDrawingBalanceInsufficient(target) {
  const status = targetQuotaStatus(target);
  return target?.channel?.type === "drawing"
    && String(status.status || "").toLowerCase() === "ok"
    && drawingBalanceInsufficient(status.balance);
}

function statusAccountUsageEmpty(status = {}) {
  return String(status.status || "").toLowerCase() === "quota_empty"
    && status.quotaReason === "chat_usage_limit"
    && status.quotaConfirmedByUpstream === true;
}

function targetAccountUsageEmpty(target, input = {}) {
  return statusAccountUsageEmpty(targetQuotaStatusForTask(target, input));
}

function targetLastCheckAt(target, status = {}) {
  const checkedAt = Date.parse(status.lastCheckAt || target?.account?.lastCheckAt || "");
  return Number.isFinite(checkedAt) ? checkedAt : 0;
}

function chatUsagePeriodMs(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
  if (!match) return 0;
  const unitMs = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2].toLowerCase()];
  const duration = Number(match[1]) * unitMs;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function chatUsageRefreshDue(target, status = {}, now = Date.now()) {
  const referenceUsage = status.meta?.referenceUsage;
  if (!referenceUsage || typeof referenceUsage !== "object") return false;
  const lastCheckAt = targetLastCheckAt(target, status);
  return Object.values(referenceUsage).some((usage) => {
    if (!usage || typeof usage !== "object") return false;
    const resetAt = Date.parse(usage.quotaResetAt || "");
    if (Number.isFinite(resetAt) && resetAt <= now) {
      return lastCheckAt < resetAt || now - lastCheckAt >= CHAT_USAGE_OBSERVATION_MS;
    }
    return !Number.isFinite(resetAt)
      && chatUsagePeriodMs(usage.period)
      && now - lastCheckAt >= CHAT_USAGE_OBSERVATION_MS;
  });
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

function statusSubscriptionExpired(status = {}) {
  if (String(status.status || "").toLowerCase() === "subscription_expired") return true;
  const usage = chatRecoveryUsage(status);
  const expiresAt = Date.parse(usage?.expireAt || status.expireAt || "");
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function statusSubscriptionMissing(status = {}) {
  return String(status.status || "").toLowerCase() === "subscription_missing";
}

function targetSubscriptionMissing(target, input = {}) {
  if (statusSubscriptionMissing(target?.account || {})) return true;
  return target?.channel?.type === "chatplus"
    && statusSubscriptionMissing(targetQuotaStatusForTask(target, input));
}

function targetSubscriptionExpired(target, input = {}) {
  if (statusSubscriptionExpired(target?.account || {})) return true;
  return target?.channel?.type === "chatplus"
    && statusSubscriptionExpired(targetQuotaStatusForTask(target, input));
}

function targetConfirmedQuotaBlocksTask(target, taskType, input = {}) {
  if (target?.channel?.type !== "chatplus") return false;
  const status = targetQuotaStatusForTask(target, input);
  if (
    String(status.status || "").toLowerCase() !== "quota_empty"
    || status.quotaConfirmedByUpstream !== true
  ) {
    return false;
  }
  return status.quotaReason !== "image_quota" || taskType !== "chat";
}

function targetConfirmedQuotaRetryDue(target, input = {}) {
  const status = targetQuotaStatusForTask(target, input);
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
  if (chatUsagePeriodMs(recoveryUsage?.period)) {
    return Date.now() - targetLastCheckAt(target, status) >= CHAT_USAGE_OBSERVATION_MS;
  }
  return Date.now() - targetLastCheckAt(target, status) >= CHAT_USAGE_RECOVERY_CHECK_MS;
}

function confirmedQuotaBlockedError(target, input = {}) {
  const status = targetQuotaStatusForTask(target, input);
  const resetAt = status.quotaResetAt || status.cooldownUntil || "";
  const resetText = resetAt.replace("T", " ").replace("+08:00", "").replace(".000Z", "");
  const error = new Error(resetText
    ? `该账户额度已用完，请等待 ${resetText} 恢复后再试。`
    : "该账户额度已用完，请等待恢复后再试。");
  error.status = 429;
  error.code = "CHAT_USAGE_LIMIT";
  error.quotaEmpty = true;
  error.quotaReason = status.quotaReason || "chat_usage_limit";
  error.quotaModel = status.quotaModel || "";
  error.quotaConfirmedByUpstream = true;
  error.quotaResetAt = resetAt;
  error.cooldownUntil = status.cooldownUntil || resetAt || null;
  return error;
}

function admissionTargets(targets, taskType, options = {}) {
  return targets.filter((target) => !(
    targetKnownUnavailable(target, options.input, options)
      || targetQuotaProtectionBlocksTask(target, options.input)
      || (taskType !== "chat" && targetDrawingBalanceInsufficient(target))
      || (
        targetConfirmedQuotaBlocksTask(target, taskType, options.input)
        && !targetConfirmedQuotaRetryDue(target, options.input)
      )
      || (
        taskType !== "chat"
        && target.channel.type !== "chatplus"
        && targetQuotaEmpty(target)
      )
  ));
}

function targetRecoveryKey(target) {
  return `${target?.channel?.id || "channel"}:${target?.account?.id || "account"}`;
}

function targetHasActiveWork(target) {
  return ["chat", "drawingImage", "chatImage"]
    .some((slot) => activeCountForAccountSlot(slot, target?.account?.id) > 0);
}

function quotaRefreshState(status = {}) {
  const state = status.meta?.quotaRefresh;
  return state && typeof state === "object" ? state : {};
}

function targetQuotaRefreshDue(target, status = targetQuotaStatus(target), now = Date.now()) {
  const refresh = quotaRefreshState(status);
  const retryAt = Date.parse(refresh.retryAt || "");
  if (["failed", "waiting"].includes(refresh.status) && Number.isFinite(retryAt) && retryAt > now) {
    return false;
  }
  const startedAt = Date.parse(refresh.startedAt || "");
  if (refresh.status === "refreshing" && Number.isFinite(startedAt) && now - startedAt < 2 * 60 * 1000) {
    return false;
  }

  if (target?.channel?.type === "chatplus") {
    if (statusSubscriptionMissing(status)) return false;
    if (statusSubscriptionExpired(status)) return false;
    if (String(status.status || "").toLowerCase() === "quota_empty") {
      const recoveryInput = status.quotaModel ? { model: status.quotaModel } : {};
      return targetQuotaEmpty(target) && targetConfirmedQuotaRetryDue(target, recoveryInput);
    }
    return chatUsageRefreshDue(target, status, now);
  }

  const statusName = String(status.status || "").toLowerCase();
  if (!["ok", "quota_empty"].includes(statusName)) return false;
  if (Number.isFinite(retryAt)) return retryAt <= now;
  const resetAt = Date.parse(status.quotaResetAt || "");
  return Number.isFinite(resetAt) && resetAt <= now;
}

async function updateTargetQuotaRefreshState(target, state) {
  const ability = channelAbilityKey(target?.channel);
  await updateAccountMeta(target.account.id, (accountMeta) => {
    if (!ability) {
      return {
        ...accountMeta,
        quotaRefresh: state
      };
    }
    const abilities = { ...(accountMeta.abilities || {}) };
    const abilityStatus = { ...(abilities[ability] || {}) };
    abilities[ability] = {
      ...abilityStatus,
      meta: {
        ...(abilityStatus.meta || {}),
        quotaRefresh: state
      }
    };
    return { ...accountMeta, abilities };
  });
}

function quotaRefreshModelKey(target, status = {}) {
  return target?.channel?.type === "chatplus"
    ? modelRequestKey(status.quotaModel || status.meta?.chatModel)
    : "";
}

function completedQuotaRefreshStatus(target, status = {}, currentStatus = {}) {
  const now = Date.now();
  const modelKey = quotaRefreshModelKey(target, status) || quotaRefreshModelKey(target, currentStatus);
  let nextStatus = { ...status };
  let resetAt = Date.parse(nextStatus.quotaResetAt || "");

  if (target?.channel?.type === "drawing") {
    if (!Number.isFinite(resetAt) || resetAt <= now) {
      nextStatus = {
        ...nextStatus,
        quotaResetAt: "",
        quotaResetSource: ""
      };
      resetAt = Number.NaN;
    } else {
      nextStatus.quotaResetSource = "upstream";
    }
  }

  const waiting = target?.channel?.type === "drawing"
    && String(nextStatus.status || "").toLowerCase() === "quota_empty"
    && !Number.isFinite(resetAt);
  const missingResetTime = target?.channel?.type === "drawing" && !Number.isFinite(resetAt);
  const refresh = {
    status: waiting ? "waiting" : "success",
    finishedAt: new Date(now).toISOString(),
    retryAt: missingResetTime ? new Date(now + DRAWING_QUOTA_RECOVERY_CHECK_MS).toISOString() : "",
    modelKey,
    message: waiting
      ? "额度尚未恢复，系统稍后会自动复查。"
      : Number.isFinite(resetAt) || target?.channel?.type === "chatplus"
        ? "额度已更新。"
        : "额度已更新，但上游未提供新的重置时间。"
  };
  return {
    ...nextStatus,
    meta: {
      ...(nextStatus.meta || {}),
      quotaRefresh: refresh
    }
  };
}

function failedQuotaRefreshStatus(target, currentStatus = {}, errorStatus = {}, error) {
  const terminal = ["subscription_missing", "subscription_expired", "disconnected"].includes(String(errorStatus.status || "").toLowerCase());
  const base = terminal ? { ...currentStatus, ...errorStatus } : { ...currentStatus };
  const now = Date.now();
  return {
    ...base,
    meta: {
      ...(base.meta || {}),
      quotaRefresh: {
        status: "failed",
        finishedAt: new Date(now).toISOString(),
        retryAt: new Date(now + ACCOUNT_RECOVERY_RETRY_MS).toISOString(),
        modelKey: quotaRefreshModelKey(target, currentStatus),
        message: String(error?.message || errorStatus.message || "检测失败").replace(/\s+/g, " ").trim().slice(0, 300)
      }
    }
  };
}

function targetNeedsRecovery(target, input = {}) {
  if (accountRecoveryTasks.has(targetRecoveryKey(target))) return true;
  const quotaStatus = targetQuotaStatus(target);
  const status = String(quotaStatus.status || "unknown").toLowerCase();
  if (targetQuotaProtectionRecoveryDue(target, input)) return true;
  if (targetQuotaRefreshDue(target, quotaStatus)) return true;
  if (target?.channel?.type === "chatplus") {
    if (statusSubscriptionMissing(quotaStatus)) return false;
    if (statusSubscriptionExpired(quotaStatus)) return true;
    if (status === "quota_empty") return false;
    return (
      accountCooling(target.account)
      || ["error", "failed", "disconnected"].includes(status)
    );
  }
  if (status === "quota_empty" || targetDrawingBalanceInsufficient(target)) {
    const resetAt = Date.parse(
      quotaStatus.quotaReason === "image_quota"
        ? quotaStatus.imageQuotaResetAt || quotaStatus.quotaResetAt || ""
        : quotaStatus.quotaResetAt || quotaStatus.cooldownUntil || ""
    );
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) return true;
    return false;
  }
  return ["error", "failed", "disconnected", "subscription_expired"].includes(status);
}

async function recoverTarget(config, target, input = {}) {
  if (refreshTargetDisabled(target?.channel, target?.account)) return null;
  if (targetHasActiveWork(target)) return null;
  const key = targetRecoveryKey(target);
  const active = accountRecoveryTasks.get(key);
  if (active) return active;
  if ((accountRecoveryRetryAt.get(key) || 0) > Date.now()) return null;

  const recovery = (async () => {
    const currentStatus = targetQuotaStatus(target);
    const quotaRefresh = targetQuotaRefreshDue(target, currentStatus);
    if (quotaRefresh) {
      await updateTargetQuotaRefreshState(target, {
        status: "refreshing",
        startedAt: new Date().toISOString(),
        retryAt: "",
        modelKey: quotaRefreshModelKey(target, currentStatus),
        message: "正在向上游核对额度。"
      });
    }
    try {
      const rawStatus = await runChatplusAccountWork(
        target.channel,
        target.account,
        () => getWorkClient(config, target.channel, target.account).check({
          model: target.channel.type === "chatplus" ? currentStatus.quotaModel || "" : "",
          quotaOnly: target.channel.type === "chatplus"
            && ["ok", "quota_empty"].includes(String(currentStatus.status || "").toLowerCase())
        })
      );
      const checked = target.channel.type === "chatplus"
        ? successfulChatAccountCheckStatus(currentStatus, rawStatus)
        : successfulAccountCheckStatus(rawStatus);
      let status = target.channel.type === "chatplus"
        ? preserveConfirmedChatQuota(currentStatus, checked)
        : checked;
      status = applyCheckedQuotaProtection(target.channel, target.account, status, currentStatus);
      if (quotaRefresh) status = completedQuotaRefreshStatus(target, status, currentStatus);
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
      let status = target.channel.type === "chatplus"
        ? preserveConfirmedChatQuota(currentStatus, errorStatus)
        : errorStatus;
      if (quotaRefresh) status = failedQuotaRefreshStatus(target, currentStatus, status, error);
      await updateTargetAccountStatus(target.account.id, target.channel, status);
      const proxyRetryAt = Date.parse(error?.proxyCooldownUntil || "");
      accountRecoveryRetryAt.set(
        key,
        Number.isFinite(proxyRetryAt) && proxyRetryAt > Date.now()
          ? proxyRetryAt
          : Date.now() + ACCOUNT_RECOVERY_RETRY_MS
      );
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
  const tasks = await listActiveTasks();
  const busyAccountIds = new Set(tasks
    .filter(taskHoldsDurableSlot)
    .map((task) => String(task.accountId || ""))
    .filter(Boolean));
  const targets = selectTargets(config, "auto", "img2img", { includeCooling: true });
  const recoveryTargets = [...new Map(
    targets
      .filter((target) => !busyAccountIds.has(String(target.account.id || "")))
      .filter((target) => targetNeedsRecovery(target))
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
  const allowDisabledAccountTest = options.allowDisabledAccountTest === true
    || options.input?.allowDisabledAccountTest === true;
  const targets = selectTargets(config, requestedChannel, taskType, {
    ...options,
    allowDisabledAccountTest,
    includeCooling: true
  });
  const ready = admissionTargets(targets, taskType, { ...options, allowDisabledAccountTest }).filter((target) => {
    const taskStatus = targetQuotaStatusForTask(target, options.input);
    const taskQuotaEmpty = String(taskStatus.status || "").toLowerCase() === "quota_empty"
      && taskStatus.quotaConfirmedByUpstream === true;
    return !(
      (
        targetAbilityCooling(target, options.input)
        && !(target.channel.type === "chatplus" && !taskQuotaEmpty)
      )
        || (
          target.channel.type === "chatplus"
          && targetAccountCoolingBlocksTask(target, options.input)
          && String(taskStatus.status || "").toLowerCase() !== "quota_empty"
        )
    );
  });
  const recoveryTargets = options.skipRecovery || allowDisabledAccountTest
    ? []
    : targets.filter((target) => targetNeedsRecovery(target, options.input) && !ready.some((item) => sameTarget(item, target)));
  if (!recoveryTargets.length) return ready;

  const recoveries = recoveryTargets.map((target) => recoverTarget(config, target, options.input));
  if (ready.length) {
    Promise.all(recoveries).catch((error) => console.error(error));
    return ready;
  }
  const recovered = await Promise.all(recoveries);
  return recoveryTargets.filter((target, index) => (
    (
      recovered[index]?.status === "ok"
        || (taskType === "chat" && recovered[index]?.status === "quota_empty" && !statusAccountUsageEmpty(recovered[index]))
    )
      && !statusQuotaProtectionBlocksTask(target, recovered[index], options.input)
  ));
}

export async function reserveImageTaskAdmission(input = {}, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", {
    accountId: requestedAccountId,
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
  if (options.verifyReady !== true) {
    const reserved = await reserveFirstAvailableTarget(targets, "img2img", { input });
    return {
      ...reserved,
      modelKey: targetImageModelKey(reserved.target, input)
    };
  }

  let candidates = targets;
  const readinessAttempts = [];
  while (candidates.length) {
    let reserved;
    try {
      reserved = await reserveFirstAvailableTarget(candidates, "img2img", { input });
    } catch (error) {
      if (readinessAttempts.length) {
        error.attempts = [...readinessAttempts, ...(Array.isArray(error.attempts) ? error.attempts : [])];
        if (error.code === "CONCURRENCY_LIMIT") {
          const details = attemptErrorMessage(error.attempts);
          error.message = details ? `并发上限：${details}` : "并发上限";
        }
      }
      throw error;
    }

    const targetAttempts = [];
    let ready = false;
    try {
      ready = await ensureTargetReady(config, reserved.target, "img2img", targetAttempts, { input });
    } catch (error) {
      reserved.release();
      throw error;
    }
    if (ready) {
      return {
        ...reserved,
        attempts: [...readinessAttempts, ...(reserved.attempts || [])],
        modelKey: targetImageModelKey(reserved.target, input),
        readyChecked: true
      };
    }

    reserved.release();
    readinessAttempts.push(...(reserved.attempts || []), ...targetAttempts);
    candidates = candidates.filter((target) => !sameTarget(target, reserved.target));
  }

  throw targetsFailedError(readinessAttempts);
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
  const protectionTargets = allTargets.filter((target) => targetQuotaProtectionBlocksTask(target, options.input));
  if (allTargets.length && protectionTargets.length === allTargets.length) {
    const state = statusQuotaProtectionState(
      protectionTargets[0],
      targetQuotaStatusForTask(protectionTargets[0], options.input),
      options.input
    );
    const error = new Error(
      `当前账号已达到额度保护线：剩余 ${state?.remainingPercent ?? "-"}%，保护线 ${state?.thresholdPercent ?? "-"}%。`
    );
    error.status = 429;
    error.code = "QUOTA_PROTECTION";
    error.quotaProtected = true;
    return error;
  }
  const chatUsageEmpty = chatTargets.length > 0
    && chatTargets.length === allTargets.length
    && chatTargets.every((target) => targetAccountUsageEmpty(target, options.input));

  if (chatUsageEmpty) {
    const quotaResetAt = chatTargets
      .map((target) => targetQuotaStatusForTask(target, options.input).quotaResetAt || "")
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
  error.code = "NO_USABLE_ACCOUNT";
  return error;
}

function shouldRefreshQuotaBeforeUse(target, taskType, input = {}) {
  if (input.allowDisabledAccountTest === true) return false;
  if (target.channel.type === "chatplus") {
    return targetQuotaProtectionNeedsInitialCheck(target, input)
      || targetQuotaProtectionNearLimit(target, input);
  }
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

function attemptMetadataForError(error) {
  return {
    ...(isCarPoolUnavailableError(error) ? { carPoolUnavailable: true } : {}),
    ...(error?.upstreamModel ? { upstreamModel: error.upstreamModel } : {})
  };
}

async function updateTargetStatusForWork(target, patch) {
  const update = () => updateTargetAccountStatus(target.account.id, target.channel, patch);
  return target.channel.type === "drawing"
    ? withAccountAuthLock(target.account, update)
    : update();
}

async function refreshQuotaBeforeUse(config, target, attempts, input = {}) {
  try {
    const previousStatus = targetQuotaStatus(target);
    const rawStatus = await getWorkClient(config, target.channel, target.account).check(
      target.channel.type === "chatplus"
        ? { model: targetChatModelKey(target, input), quotaOnly: true }
        : undefined
    );
    const checked = target.channel.type === "chatplus"
      ? preserveConfirmedChatQuota(previousStatus, successfulChatAccountCheckStatus(previousStatus, rawStatus))
      : successfulAccountCheckStatus(rawStatus);
    const status = applyCheckedQuotaProtection(target.channel, target.account, checked, previousStatus);
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
    if (statusQuotaProtectionBlocksTask(target, status, input)) {
      const protection = statusQuotaProtectionState(target, status, input);
      pushAttempt(
        attempts,
        target,
        `额度保护已生效：剩余 ${protection.remainingPercent}%，保护线 ${protection.thresholdPercent}%。`,
        { quotaEmpty: true, quotaProtected: true }
      );
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

async function refreshQuotaBeforeUseFast(config, target, attempts, input = {}, timeoutMs = FAST_QUOTA_REFRESH_TIMEOUT_MS) {
  const localAttempts = [];
  const refresh = refreshQuotaBeforeUse(config, target, localAttempts, input)
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
  const rawStatus = await getWorkClient(config, channel, currentAccount).check();
  await withAccountAuthLock(account, async () => {
    const latestConfig = await loadRuntimeConfig();
    const latestAccount = latestConfig.accounts.find((item) => item.id === account.id) || account;
    const drawing = latestAccount.meta?.abilities?.drawing || {};
    const status = applyCheckedQuotaProtection(
      channel,
      latestAccount,
      successfulAccountCheckStatus(rawStatus),
      drawing
    );
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

async function saveProxyCheck(account, result, options = {}) {
  const proxyValue = accountProxyValue(account);
  const proxyKey = normalizeProxyUrl(proxyValue) || `account:${account.id}`;
  const signature = [
    result.ok ? "ok" : "failed",
    result.cooldownUntil || "",
    result.realIp || ""
  ].join("::");
  if (options.force !== true && persistedProxyStatuses.get(proxyKey) === signature) return;
  persistedProxyStatuses.set(proxyKey, signature);

  const previousWrite = proxyStatusWrites.get(proxyKey) || Promise.resolve();
  const currentWrite = previousWrite.catch(() => {}).then(async () => {
    const config = await loadConfig();
    const matchingIds = String(proxyValue || "").trim()
      ? config.accounts
          .filter((item) => normalizeProxyUrl(accountProxyValue(item)) === proxyKey)
          .map((item) => item.id)
      : [account.id];

    for (const accountId of matchingIds) {
      const latestConfig = await loadConfig();
      const current = latestConfig.accounts.find((item) => item.id === accountId);
      if (!current) continue;
      await updateAccountStatus(accountId, {
        meta: {
          ...(current.meta || {}),
          proxyCheck: proxyCheckMeta(result)
        }
      });
    }
  });
  proxyStatusWrites.set(proxyKey, currentWrite);

  try {
    await currentWrite;
  } catch (error) {
    if (persistedProxyStatuses.get(proxyKey) === signature) {
      persistedProxyStatuses.delete(proxyKey);
    }
    throw error;
  } finally {
    if (proxyStatusWrites.get(proxyKey) === currentWrite) proxyStatusWrites.delete(proxyKey);
  }
}

function automaticProxyCheckResult(account, ok, error = null, state = {}) {
  const previous = account.meta?.proxyCheck || {};
  return {
    ok,
    ...safeProxyEndpoint(accountProxyValue(account)),
    realIp: ok ? String(previous.realIp || previous.ip || "").trim() : "",
    checkedAt: new Date().toISOString(),
    message: ok ? "" : error?.message || "代理不可用",
    cooldownUntil: ok ? "" : state.retryAt || error?.proxyCooldownUntil || ""
  };
}

async function saveAutomaticProxyCheck(account, result) {
  try {
    await saveProxyCheck(account, result);
  } catch (error) {
    console.error("保存代理状态失败：", error);
  }
}

async function runAccountProxyWork(account, work) {
  const proxyValue = accountProxyValue(account);
  if (!String(proxyValue).trim()) return work();

  const before = proxyCircuitState(proxyValue);
  try {
    const value = await runWithProxyCircuit(proxyValue, work);
    if (before.status !== "closed" || account.meta?.proxyCheck?.status !== "ok") {
      await saveAutomaticProxyCheck(account, automaticProxyCheckResult(account, true));
    }
    return value;
  } catch (error) {
    const after = proxyCircuitState(proxyValue);
    if (error?.code === "PROXY_COOLDOWN" || (isProxyConnectionError(error) && after.status === "open")) {
      await saveAutomaticProxyCheck(account, automaticProxyCheckResult(account, false, error, after));
    }
    throw error;
  }
}

function checkedProxyError(result) {
  const error = new Error(result.message || "代理不可用");
  error.code = "PROXY_CHECK_FAILED";
  error.status = 503;
  error.proxyFailed = true;
  error.proxyCooldownUntil = result.cooldownUntil || "";
  return error;
}

async function validateAccountProxy(account) {
  const proxyValue = accountProxyValue(account);
  if (!String(proxyValue).trim()) return null;
  const endpoint = safeProxyEndpoint(proxyValue);
  const message = !endpoint.proxyHost
    ? "代理 IP 格式不正确"
    : proxyExpired(endpoint.expiresAt)
      ? "代理 IP 已到期"
      : "";
  if (!message) return null;
  const result = {
    ok: false,
    ...endpoint,
    realIp: "",
    checkedAt: new Date().toISOString(),
    attemptCount: 0,
    latencyMs: 0,
    message
  };
  await saveProxyCheck(account, result, { force: true });
  throw checkedProxyError(result);
}

async function ensureTargetReady(config, target, taskType, attempts, options = {}) {
  if (!shouldRefreshQuotaBeforeUse(target, taskType, options.input)) return true;
  if (options.skipQuotaRefresh) {
    return refreshQuotaBeforeUseFast(config, target, attempts, options.input);
  }
  return refreshQuotaBeforeUse(config, target, attempts, options.input);
}

async function reserveFirstAvailableTarget(targets, taskType, options = {}) {
  return withRoutingReservationLock(async () => {
    const attempts = [];
    const orderedTargets = await orderTargetsByRoutingUsage(targets, taskType, options.input || {});
    for (const target of orderedTargets) {
      if (options.confirmBeforeReserve && !(await options.confirmBeforeReserve(target, attempts))) continue;
      const slot = targetTaskSlot(target, taskType);
      const release = await tryReserveTaskSlot(slot, target, options.input || {});
      if (release) return { target, release, attempts, orderedTargets };
      attempts.push(await targetBusyAttempt(target, taskType, options.input || {}));
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
  });
}

async function tryReserveFirstAvailableTarget(targets, taskType, options = {}) {
  try {
    return await reserveFirstAvailableTarget(targets, taskType, options);
  } catch (error) {
    if (error?.code === "CONCURRENCY_LIMIT") return null;
    throw error;
  }
}

async function waitForFirstAvailableTarget(targets, taskType, options = {}) {
  const queuedAt = Date.now();
  while (true) {
    const reserved = await tryReserveFirstAvailableTarget(targets, taskType, options);
    if (reserved) {
      return {
        ...reserved,
        attempts: [],
        queueWaitMs: Math.max(0, Date.now() - queuedAt)
      };
    }
    await waitForTaskSlotChange();
  }
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
    readyChecked: admission.readyChecked === true,
    attempts: Array.isArray(admission.attempts) ? admission.attempts : [],
    orderedTargets: Array.isArray(admission.orderedTargets) ? admission.orderedTargets : []
  };
}

async function selectImageExecutionTargets(
  config,
  requestedChannel,
  requestedAccountId,
  input,
  admission,
  options = {}
) {
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", {
    ...options,
    accountId: requestedAccountId,
    input
  });
  const reserved = consumeAdmissionReservation(admission, targets, input);
  return { targets, reserved };
}

function orderedTargets(targets, reserved) {
  if (!reserved?.target) return targets;
  const preferredOrder = Array.isArray(reserved.orderedTargets)
    ? reserved.orderedTargets
      .map((ordered) => targets.find((target) => sameTarget(target, ordered)))
      .filter(Boolean)
    : [];
  const remaining = targets.filter((target) => !preferredOrder.some((ordered) => sameTarget(target, ordered)));
  const fallbackTargets = [...preferredOrder, ...remaining];
  return [
    reserved.target,
    ...fallbackTargets.filter((target) => !sameTarget(target, reserved.target))
  ];
}

function concurrencyLimitReached(attempts) {
  return attempts.some((item) => item.busy)
    && attempts.every((item) => item.busy || item.quotaEmpty);
}

function targetsFailedError(attempts) {
  const concurrencyLimited = concurrencyLimitReached(attempts);
  const quotaExhausted = attempts.length > 0 && attempts.every((item) => item.quotaEmpty);
  const carPoolUnavailable = attempts.length > 0
    && attempts.every((item) => item.carPoolUnavailable === true);
  const chatUsageExhausted = quotaExhausted && attempts.every((item) => (
    /chatplus|聊天生图/.test(`${item.channelId || ""} ${item.channelName || ""}`)
      && /聊天(?:使用次数|额度).{0,24}(?:用完|耗尽|上限)|使用次数已达上限|usage count has reached the limit|usage.*limit/i.test(String(item.message || ""))
  ));
  const details = attemptErrorMessage(attempts);
  let message = `所有渠道都失败：${details}`;
  if (concurrencyLimited) message = details ? `并发上限：${details}` : "并发上限";
  else if (chatUsageExhausted) message = "聊天额度已用完，请等待额度刷新后再试。";
  else if (carPoolUnavailable) message = "上游共享车位暂时不可用，任务未能提交。请稍后重试。";
  const error = new Error(message);
  error.attempts = attempts;
  error.upstreamModel = [...attempts].reverse().find((item) => item.upstreamModel)?.upstreamModel || "";
  error.upstreamText = [...attempts].reverse().find((item) => compactFailureText(item.upstreamText))?.upstreamText || "";
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
  if (carPoolUnavailable) {
    error.status = 503;
    error.code = "CHAT_CAR_POOL_UNAVAILABLE";
    error.carPoolUnavailable = true;
    error.authScope = "car";
  }
  return error;
}

function cleanPrompt(input) {
  return String(input?.prompt || "").trim();
}

function imageFiles(inputFiles) {
  return Array.isArray(inputFiles) ? inputFiles.filter(Boolean) : inputFiles ? [inputFiles] : [];
}

async function imageFileHashes(files = []) {
  const hashes = [];
  for (const file of imageFiles(files)) {
    if (typeof file?.toBuffer !== "function") continue;
    const buffer = await file.toBuffer();
    if (!buffer?.length) continue;
    hashes.push(createHash("sha256").update(buffer).digest("hex"));
  }
  return hashes;
}

function assertImageFileCount(files) {
  if (!files.length) {
    const error = new Error("请上传源图。");
    error.status = 400;
    throw error;
  }
  assertInputImageCount(files.length, `最多只能上传 ${MAX_INPUT_IMAGE_COUNT} 张源图。`);
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

function inputPreviewUrls(input = {}) {
  return imageFiles(input.files || input.file)
    .map((file) => file.previewUrl || "")
    .filter(Boolean);
}

function taskInputPreviewUrls(input = {}, extraUrls = []) {
  return [...new Set([
    ...inputPreviewUrls(input),
    ...(Array.isArray(extraUrls) ? extraUrls : [])
  ].filter(Boolean))];
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
  assertInputImageCount(
    chatImageCount(input),
    `对话最多只能上传 ${MAX_INPUT_IMAGE_COUNT} 张图片。`
  );
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
  const { file, files, allowDisabledAccountTest: _allowDisabledAccountTest, ...fields } = input || {};
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

function queuedTask({ input, target, taskType, prompt, imageCount, inputImageUrls, raw, requestMeta = {}, status = "processing" }) {
  const meta = taskRequestMeta(requestMeta);
  const sourceTaskId = meta.sourceTaskId || sourceTaskIdFrom(input);
  const requestMetaPayload = sourceTaskId && !meta.sourceTaskId ? { ...meta, sourceTaskId } : meta;
  const requestJson = attachSourceTaskId(taskRequestJson(input), sourceTaskId);
  const requestedModel = input.model || input.chat_model || input.chatModel || input.model_id || input.modelId || "";
  return {
    id: `task-${randomUUID()}`,
    ...(sourceTaskId ? { sourceTaskId } : {}),
    status,
    prompt: prompt ?? cleanPrompt(input),
    taskType,
    modelId: input.model_id || input.modelId || input.model || "",
    ratio: input.ratio_label || input.ratio || "",
    imageCount: imageCount ?? Number(input.image_count || input.n || 1),
    imageUrls: [],
    inputImageUrls: inputImageUrls || inputPreviewUrls(input),
    errorMessage: "",
    channelId: target.channel.id,
    channelName: target.channel.name,
    channelType: target.channel.type,
    accountId: target.account.id,
    accountName: target.account.name,
    submissionChannels: [],
    generationChannels: [],
    requestMeta: requestMetaPayload,
    network: taskNetworkMeta(target.account),
    attempts: [],
    requestJson,
    responseJson: null,
    raw: {
      queued: true,
      ...(requestedModel !== "" ? { requestedModel } : {}),
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

async function startQueuedTask(task, target, queueWaitMs = 0) {
  const startedAtMs = Date.parse(task.createdAt || "");
  const queueStage = completedTaskStage(
    "account_queue",
    "等待可用账号",
    Number.isFinite(startedAtMs) ? startedAtMs : Date.now()
  );
  const nextTask = {
    ...task,
    status: "processing",
    channelId: target.channel.id,
    channelName: target.channel.name,
    channelType: target.channel.type,
    accountId: target.account.id,
    accountName: target.account.name,
    network: taskNetworkMeta(target.account),
    raw: mergeTaskRaw(task.raw, {
      waitingForSlot: false,
      queueWaitMs: Math.max(Number(queueWaitMs || 0), queueStage.durationMs),
      stageTimings: [queueStage]
    })
  };
  await upsertTask(nextTask);
  return nextTask;
}

function readableAttemptError(attempts) {
  return attempts.map((item) => `${item.channelName}/${item.accountName}：${item.message}`).join("；");
}

function compactFailureText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function originalFailureText(value) {
  return String(value || "").trim();
}

function readableFailureReason(value) {
  const text = compactFailureText(value);
  if (!text) return "没有收到可用的错误说明";
  try {
    const payload = JSON.parse(text);
    const reason = [
      payload?.detail?.message,
      typeof payload?.detail === "string" ? payload.detail : "",
      payload?.message,
      payload?.error?.message,
      typeof payload?.error === "string" ? payload.error : ""
    ].find((item) => compactFailureText(item));
    if (reason) return compactFailureText(reason);
  } catch {
    // The upstream response can also be plain text.
  }
  return text;
}

function failedTaskStage(task = {}, error = {}) {
  const stages = [
    ...(Array.isArray(task?.raw?.stageTimings) ? task.raw.stageTimings : []),
    ...(error?.taskStageTiming ? [error.taskStageTiming] : [])
  ];
  const failed = [...stages].reverse().find((stage) => stage?.status === "failed");
  if (!failed) return null;
  return {
    key: String(failed.key || "").trim(),
    label: String(failed.label || failed.key || "").trim()
  };
}

function imageFailureReport(task = {}, error = {}, options = {}) {
  const submissionConfirmed = options.submitted !== undefined
    ? options.submitted === true
    : Boolean(task?.raw?.submitted || savedTaskExternalId(task) || error?.imageSubmissionConfirmed === true);
  const upstreamText = originalFailureText(
    error?.upstreamText
      || error?.body
      || error?.failureReason
      || error?.message
  );
  const failureReason = readableFailureReason(error?.failureReason || upstreamText || error?.message);
  const policyFailure = String(error?.code || "").toLowerCase() === "content_policy"
    || isImagePolicyFailureMessage(failureReason || upstreamText || error?.message);
  const failureStage = failedTaskStage(task, error);
  const stageText = !submissionConfirmed && failureStage?.label
    ? `，停在“${failureStage.label}”`
    : "";
  const returnUpstreamMessage = policyFailure && Boolean(failureReason);
  return {
    code: policyFailure ? "content_policy" : "",
    failureType: submissionConfirmed ? "upstream_no_image" : "submission_failed",
    submissionConfirmed,
    failureReason,
    failureStage,
    upstreamText,
    message: returnUpstreamMessage
      ? failureReason
      : submissionConfirmed
        ? `上游生成失败：图片和生图要求已完整提交，但上游没有返回图片。上游回复：${failureReason}`
        : `提交失败：图片和生图要求未完整提交到上游${stageText}。具体原因：${failureReason}`
  };
}

function imageFailureResponseFields(report) {
  return {
    ...(report.code ? { code: report.code } : {}),
    message: report.message,
    failureType: report.failureType,
    submissionConfirmed: report.submissionConfirmed,
    failureReason: report.failureReason,
    ...(report.failureStage ? { failureStage: report.failureStage } : {}),
    ...(report.upstreamText ? { upstreamText: report.upstreamText } : {})
  };
}

function imageFailureRawFields(report) {
  return {
    failureType: report.failureType,
    submissionConfirmed: report.submissionConfirmed,
    ...(report.failureStage ? { failureStage: report.failureStage } : {})
  };
}

async function failQueuedTask(task, error, attempts = [], stageTimings = []) {
  const cancelled = isCancelledTaskError(error);
  const systemRejection = error?.busy === true
    || error?.quotaEmpty === true
    || ["CONCURRENCY_LIMIT", "QUOTA_EXHAUSTED", "CHAT_USAGE_LIMIT", "QUOTA_PROTECTION"].includes(String(error?.code || ""));
  const failure = !cancelled && task.taskType !== "chat" && !systemRejection && !isCarPoolUnavailableError(error)
    ? imageFailureReport(task, error)
    : null;
  const responseMessage = failure?.message || error.message || readableAttemptError(attempts) || "任务失败";
  const statusCode = cancelled ? null : Number(error.status || error.statusCode || 0) || null;
  const code = error.code
    || (cancelled ? "UPSTREAM_TASK_CANCELLED" : "")
    || (statusCode === 429 ? "CONCURRENCY_LIMIT" : "")
    || (failure?.submissionConfirmed ? "UPSTREAM_NO_IMAGE" : failure ? "IMAGE_SUBMISSION_FAILED" : "");
  const upstreamText = failure?.upstreamText || originalFailureText(error.upstreamText || error.body);
  const sourceTaskId = task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson);
  const failedTask = {
    ...task,
    status: cancelled ? "cancelled" : "failed",
    upstreamText: upstreamText || task.upstreamText || "",
    errorMessage: responseMessage,
    statusCode,
    attempts,
    responseJson: {
      ok: false,
      message: responseMessage,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      ...(cancelled ? { taskStatus: "cancelled" } : {}),
      ...(statusCode ? { status: statusCode } : {}),
      ...(code ? { code } : {}),
      ...(failure ? imageFailureResponseFields(failure) : upstreamText ? { upstreamText } : {}),
      ...(Array.isArray(error?.carAttempts) && error.carAttempts.length
        ? { carAttempts: taskResponseJson(error.carAttempts) }
        : {}),
      attempts: taskResponseJson(attempts)
    },
    completedAt: new Date().toISOString(),
    raw: clearActiveTaskStage(mergeTaskRaw(task.raw, {
      queued: false,
      waitingForSlot: false,
      ...(error?.upstreamModel ? { upstreamModel: error.upstreamModel } : {}),
      ...(error?.selectedCarId ? { selectedCarId: error.selectedCarId } : {}),
      ...(error?.selectedCarType ? { selectedCarType: error.selectedCarType } : {}),
      ...(cancelled ? { upstreamStatus: "cancelled", imageTaskCancelled: true } : {}),
      ...(Array.isArray(error?.carAttempts) && error.carAttempts.length
        ? { carAttempts: taskResponseJson(error.carAttempts) }
        : {}),
      ...(failure ? imageFailureRawFields(failure) : {}),
      stageTimings: mergeTaskStageTimings(
        stageTimings,
        error?.stageTimings,
        error?.taskStageTiming ? [error.taskStageTiming] : []
      )
    }))
  };
  await upsertTask(failedTask);
  forgetTaskRefreshSession(failedTask.id);
  await recordTaskStat(failedTask);
  return failedTask;
}

async function finishQueuedTask(task, result, channel, account, attempts) {
  rememberTaskRefreshSession(task.id, result?.refreshSessionSnapshot);
  const status = result.status || task.status;
  const wrapped = wrapTask({ result, channel, account, attempts, requestJson: task.requestJson, requestMeta: task.requestMeta });
  const nextTask = {
    ...wrapped,
    id: task.id,
    status,
    createdAt: task.createdAt,
    submissionChannels: mergeTaskRoutes(task.submissionChannels, wrapped.submissionChannels),
    generationChannels: mergeTaskRoutes(task.generationChannels, wrapped.generationChannels),
    completedAt: isFinishedTask(status) ? task.completedAt || new Date().toISOString() : null,
    raw: isFinishedTask(status)
      ? clearActiveTaskStage(mergeTaskRaw(task.raw, { queued: false, waitingForSlot: false }, wrapped.raw))
      : mergeTaskRaw(task.raw, wrapped.raw)
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
  if (isFinishedTask(nextTask.status)) {
    forgetTaskRefreshSession(nextTask.id);
    await recordTaskStat(nextTask);
  }
  await updateAccountAfterTask(account, channel, nextTask);
  scheduleDrawingQuotaRefresh(account, channel);
  scheduleFastTaskRefresh(nextTask);
  return nextTask;
}

async function persistSubmittedTask(task, result, channel, account, attempts) {
  if (!savedTaskExternalId(result)) return task;
  const upstreamCompleted = result?.status === "success";
  if (isFinishedTask(result?.status) && !upstreamCompleted) return task;
  rememberTaskRefreshSession(task.id, result?.refreshSessionSnapshot);
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
  submittedTask.submissionChannels = mergeTaskRoutes(
    task.submissionChannels,
    [taskRouteEntry(channel, account)]
  );
  await upsertTask(submittedTask);
  activeSubmittedTaskIds.add(submittedTask.id);
  scheduleFastTaskRefresh(submittedTask);
  return submittedTask;
}

function storedOriginalImageUrls(task = {}) {
  const urls = [
    ...(Array.isArray(task.raw?.originalImageUrls) ? task.raw.originalImageUrls : []),
    ...(task.raw?.upstreamCompleted && Array.isArray(task.imageUrls) ? task.imageUrls : [])
  ];
  return usableImageResultUrls(urls);
}

function imageMirrorRecoveryStartedAt(task, now) {
  const saved = task.raw?.imageMirrorFirstFailedAt
    || (task.raw?.imageMirrorPending ? task.raw?.waitingSince : "")
    || task.raw?.resultSaveErrorAt;
  const parsed = Date.parse(saved || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now;
}

function imageMirrorRecoveryExpired(task, now = Date.now()) {
  const firstFailedAt = imageMirrorRecoveryStartedAt(task, new Date(now).toISOString());
  const recoveryAgeMs = now - Date.parse(firstFailedAt);
  return Number(task.raw?.imageMirrorRetryCount || 0) >= IMAGE_MIRROR_RECOVERY_MAX_ATTEMPTS
    || recoveryAgeMs >= IMAGE_MIRROR_RECOVERY_TIMEOUT_MS;
}

async function interruptExpiredImageMirror(task, error, retryCount, firstFailedAt, now) {
  const message = "图片已经生成，但上游图片地址失效，系统多次尝试后仍无法保存；任务已停止，不计入失败。";
  const nextTask = {
    ...task,
    status: "interrupted",
    imageCount: 0,
    imageUrls: [],
    errorMessage: "",
    responseJson: attachResponseSourceTaskId(
      { ok: null, message },
      task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)
    ),
    completedAt: now,
    raw: mergeTaskRaw(task.raw, {
      waitingUpstream: false,
      imageMirrorPending: false,
      imageMirrorGaveUp: true,
      imageMirrorRetryCount: retryCount,
      imageMirrorFirstFailedAt: firstFailedAt,
      resultSaveError: error?.message || "结果保存中断。",
      resultSaveErrorCode: error?.code || "",
      resultSaveErrorAt: now,
      interrupted: true,
      interruptedAt: now,
      interruptedReason: message,
      stageTimings: error?.taskStageTiming ? [error.taskStageTiming] : []
    })
  };
  await upsertTask(nextTask);
  return nextTask;
}

async function keepSubmittedTaskRecoverable(task, error, attempts = []) {
  const originalImageUrls = storedOriginalImageUrls(task);
  const now = new Date().toISOString();
  const retryCount = Number(task.raw?.imageMirrorRetryCount || 0) + 1;
  const firstFailedAt = imageMirrorRecoveryStartedAt(task, now);
  const recoveryAgeMs = Date.now() - Date.parse(firstFailedAt);
  if (
    originalImageUrls.length
    && (
      retryCount >= IMAGE_MIRROR_RECOVERY_MAX_ATTEMPTS
      || recoveryAgeMs >= IMAGE_MIRROR_RECOVERY_TIMEOUT_MS
    )
  ) {
    return interruptExpiredImageMirror(task, error, retryCount, firstFailedAt, now);
  }
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
    raw: mergeTaskRaw(task.raw, {
      queued: false,
      submitted: true,
      waitingUpstream: true,
      waitingSince: task.raw?.waitingSince || now,
      imageMirrorPending: originalImageUrls.length > 0,
      imageMirrorRetryCount: retryCount,
      imageMirrorFirstFailedAt: firstFailedAt,
      ...(originalImageUrls.length ? { originalImageUrls } : {}),
      resultSaveError: error?.message || "结果保存中断。",
      resultSaveErrorCode: error?.code || "",
      resultSaveErrorAt: now,
      stageTimings: error?.taskStageTiming ? [error.taskStageTiming] : []
    })
  };
  await upsertTask(nextTask);
  scheduleFastTaskRefresh(nextTask);
  return nextTask;
}

async function runQueuedTextTask(task, input, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = requestedAccountIdForInput(input);
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", {
    accountId: requestedAccountId,
    input
  });
  let taskReservation = reserved;
  let latestTask = task;
  if (!taskReservation && options.waitForSlot === true) {
    taskReservation = await waitForFirstAvailableTarget(targets, "text2img", { input });
    latestTask = await startQueuedTask(latestTask, taskReservation.target, taskReservation.queueWaitMs);
  }
  const attempts = [...(taskReservation?.attempts || [])];
  let reservedRelease = taskReservation?.release || null;
  try {
    for (const target of orderedTargets(targets, taskReservation)) {
      const { channel, account } = target;
      let release = null;
      const usingReserved = reservedRelease && sameTarget(target, taskReservation?.target);
      if (usingReserved) {
        release = reservedRelease;
        reservedRelease = null;
      } else {
        release = await tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target, input);
        if (!release) {
          attempts.push(await targetBusyAttempt(target, "text2img", input));
          continue;
        }
      }
      let taskState = latestTask;
      try {
        const finishedTask = await runChatplusAccountWork(channel, account, async () => {
          if (!(await ensureTargetReady(config, target, "text2img", attempts, { input }))) return null;
          const client = getWorkClient(config, channel, account);
          const onSubmitted = async (submittedResult) => {
            taskState = await persistSubmittedTask(taskState, submittedResult, channel, account, attempts);
            latestTask = taskState;
          };
          const onStage = async (stage) => {
            taskState = await persistTaskStage(taskState, stage);
            latestTask = taskState;
          };
          const chatplusConcurrentSubmit = channel.type === "chatplus" && options.chatplusConcurrentSubmit !== false;
          const excludedImageCarIds = await submittedImageCarIdsForTarget(target, input);
          let result = await client.createTextTask({
            ...imageInputForTarget(target, input),
            onSubmitted,
            onStage,
            ...(channel.type === "chatplus" ? { concurrentSubmit: chatplusConcurrentSubmit } : {}),
            ...(excludedImageCarIds.length ? { excludedImageCarIds } : {}),
            waitForImages: options.waitForChatplusImages === true
          });
          taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
          latestTask = taskState;
          scheduleDrawingQuotaRefresh(account, channel);
          if (channel.type === "drawing" && !isFinishedTask(result.status)) {
            result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
          }
          result = await mirrorTaskImages(result, config, client, {
            inputImageHashes: taskState.raw?.inputImageHashes,
            onImagePhase: createImageSavePhaseReporter(
              () => taskState,
              (next) => { taskState = next; latestTask = next; },
              channel,
              account
            )
          });
          return finishQueuedTask(taskState, result, channel, account, attempts);
        }, {
          taskType: "text2img",
          // ShareAI chat image sessions are account-scoped upstream; serialize one account.
          parallel: false,
          noQueue: options.noChatplusQueue,
          slot: targetTaskSlot(target, "text2img"),
          modelKey: targetChatModelKey(target, input),
          quotaProbe: targetConfirmedQuotaBlocksTask(target, "text2img", input)
            && targetConfirmedQuotaRetryDue(target, input),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        latestTask = taskState;
        if (savedTaskExternalId(taskState)) {
          if (isTerminalTaskFailureError(error)) {
            pushAttempt(attempts, target, error.message || "调用失败", attemptMetadataForError(error));
            return failQueuedTask(taskState, error, attempts);
          }
          return keepSubmittedTaskRecoverable(taskState, error, attempts);
        }
        if (await skipAccountAfterConfirmedUsageLimit(target, error, attempts)) continue;
        if (error.imageSubmissionAttempted === true) {
          const failure = imageSubmissionFailure(error);
          pushAttempt(attempts, target, failure.message, {
            ...attemptMetadataForError(failure),
            upstreamText: failure.upstreamText || ""
          });
          if (failure.imageSubmissionConfirmed === true) {
            taskState = markTaskSubmissionAttempt(
              taskState,
              channel,
              account,
              failure.conversationId || error.conversationId
            );
          }
          if (channel.type === "chatplus" && isExplicitChatQuotaError(error)) {
            await updateTargetStatusAfterError(account, channel, error);
          }
          return failQueuedTask(taskState, failure, attempts);
        }
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败", attemptMetadataForError(error));
          continue;
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          ...attemptMetadataForError(error),
          busy: Boolean(error.busy),
          upstreamText: originalFailureText(error.upstreamText || error.body),
          quotaEmpty: channel.type === "chatplus"
            ? isExplicitChatQuotaError(error)
            : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy && !error.imageCarQuotaExhausted) {
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
  return failQueuedTask(latestTask, targetsFailedError(attempts), attempts);
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

function retryableImagePreSubmitCarPoolFailure(task, error) {
  return isCarPoolUnavailableError(error)
    && error?.imageSubmissionAttempted !== true
    && error?.imageSubmissionConfirmed !== true
    && task?.raw?.submitted !== true
    && !savedTaskExternalId(task);
}

async function waitForImagePreSubmitRetry(task, error, attempts, retryNumber, delayMs) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const retryAt = new Date(startedAtMs + delayMs).toISOString();
  const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
  const stage = {
    id: `stage-${randomUUID()}`,
    key: "pre_submit_retry_wait",
    label: `共享车位暂时不可用，${delaySeconds} 秒后自动重试（${retryNumber}/${IMAGE_PRE_SUBMIT_RETRY_DELAYS_MS.length}）`,
    status: "processing",
    startedAt
  };
  const message = "任务尚未提交上游，系统正在重新连接共享车位，不会重复扣额度。";
  let nextTask = {
    ...task,
    status: "processing",
    errorMessage: "",
    attempts,
    responseJson: attachResponseSourceTaskId(
      { ok: null, message },
      task.sourceTaskId || task.requestMeta?.sourceTaskId || sourceTaskIdFrom(task.requestJson)
    ),
    completedAt: null,
    raw: mergeTaskRaw(task.raw, {
      preSubmitRetryPending: true,
      preSubmitRetryCount: retryNumber,
      preSubmitRetryAt: retryAt,
      preSubmitRetryReason: String(error?.message || "共享车位暂时不可用").replace(/\s+/g, " ").trim().slice(0, 300),
      activeStage: stage
    })
  };
  await upsertTask(nextTask);
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const raw = mergeTaskRaw(nextTask.raw, {
    preSubmitRetryPending: false,
    preSubmitRetryAt: "",
    stageTimings: [completedTaskStage(stage.key, stage.label, startedAtMs)]
  });
  if (raw.activeStage?.id === stage.id) delete raw.activeStage;
  nextTask = { ...nextTask, raw };
  await upsertTask(nextTask);
  return nextTask;
}

async function resetImagePreSubmitSession(config, target) {
  if (target?.channel?.type !== "chatplus") return;
  const client = getWorkClient(config, target.channel, target.account);
  const reset = async () => {
    client.invalidateSharedPortalSession?.();
    client.resetSession?.();
  };
  if (typeof client.sessionLock === "function") await client.sessionLock(reset);
  else await reset();
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
      if (error?.code === "PROXY_COOLDOWN") break;
    }
  }
  return waitingUpstreamResult(result, lastResult, lastError);
}

async function runQueuedImageTask(task, input, files, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const targets = await selectReadyTargets(config, requestedChannel, "img2img", { accountId: requestedAccountId, input });
  let taskReservation = reserved;
  let latestTask = task;
  if (!taskReservation && options.waitForSlot === true) {
    taskReservation = await waitForFirstAvailableTarget(targets, "img2img", { input });
    latestTask = await startQueuedTask(latestTask, taskReservation.target, taskReservation.queueWaitMs);
  }
  const attempts = [...(taskReservation?.attempts || [])];
  let reservedRelease = taskReservation?.release || null;
  try {
    const executionTargets = Array.isArray(options.orderedTargets)
      ? options.orderedTargets
      : orderedTargets(targets, taskReservation);
    let currentTargets = executionTargets;
    for (let retryRound = 0; currentTargets.length; retryRound += 1) {
      const retryTargets = [];
      let retryError = null;
      for (const target of currentTargets) {
        const { channel, account } = target;
        let release = null;
        const usingReserved = reservedRelease && sameTarget(target, taskReservation?.target);
        if (usingReserved) {
          release = reservedRelease;
          reservedRelease = null;
        }
        let taskState = latestTask;
        try {
          const readyAtAdmission = usingReserved && taskReservation?.readyChecked === true;
          if (!readyAtAdmission && !(await ensureTargetReady(config, target, "img2img", attempts, {
            skipQuotaRefresh: options.fastQuotaRefresh || options.noChatplusQueue,
            input
          }))) continue;
          if (!release) {
            release = await tryReserveTaskSlot(targetTaskSlot(target, "img2img"), target, input);
            if (!release) {
              attempts.push(await targetBusyAttempt(target, "img2img", input));
              continue;
            }
          }
          const finishedTask = await runChatplusAccountWork(channel, account, async () => {
            const client = getWorkClient(config, channel, account);
            const onSubmitted = async (submittedResult) => {
              taskState = await persistSubmittedTask(taskState, submittedResult, channel, account, attempts);
              latestTask = taskState;
            };
            const onStage = async (stage) => {
              taskState = await persistTaskStage(taskState, stage);
              latestTask = taskState;
            };
            const chatplusConcurrentSubmit = channel.type === "chatplus" && options.chatplusConcurrentSubmit !== false;
            const excludedImageCarIds = await submittedImageCarIdsForTarget(target, input);
            let result = await submitImageTask(client, {
              ...imageInputForTarget(target, input),
              onSubmitted,
              onStage,
              ...(channel.type === "chatplus" ? { concurrentSubmit: chatplusConcurrentSubmit } : {}),
              ...(excludedImageCarIds.length ? { excludedImageCarIds } : {}),
              waitForImages: options.waitForChatplusImages === true
            }, files);
            taskState = await persistSubmittedTask(taskState, result, channel, account, attempts);
            latestTask = taskState;
            scheduleDrawingQuotaRefresh(account, channel);
            if (channel.type === "drawing" && !isFinishedTask(result.status)) {
              result = await waitForUpstreamTask(client, result, drawingSubmitWaitTimeoutSec(config));
            }
            result = await mirrorTaskImages(result, config, client, {
              inputImageHashes: taskState.raw?.inputImageHashes,
              onImagePhase: createImageSavePhaseReporter(
                () => taskState,
                (next) => { taskState = next; latestTask = next; },
                channel,
                account
              )
            });
            return finishQueuedTask(taskState, result, channel, account, attempts);
          }, {
            taskType: "img2img",
            // ShareAI chat image sessions are account-scoped upstream; serialize one account.
            parallel: false,
            noQueue: options.noChatplusQueue,
            slot: targetTaskSlot(target, "img2img"),
            modelKey: targetChatModelKey(target, input),
            quotaProbe: targetConfirmedQuotaBlocksTask(target, "img2img", input)
              && targetConfirmedQuotaRetryDue(target, input),
            blockingSlots: ["chatImage"]
          });
          if (finishedTask) return finishedTask;
        } catch (error) {
          latestTask = taskState;
          if (savedTaskExternalId(taskState)) {
            if (isTerminalTaskFailureError(error)) {
              pushAttempt(attempts, target, error.message || "调用失败", attemptMetadataForError(error));
              return failQueuedTask(taskState, error, attempts);
            }
            return keepSubmittedTaskRecoverable(taskState, error, attempts);
          }
          if (await skipAccountAfterConfirmedUsageLimit(target, error, attempts)) continue;
          if (error.imageSubmissionAttempted === true) {
            const failure = imageSubmissionFailure(error);
            pushAttempt(attempts, target, failure.message, {
              ...attemptMetadataForError(failure),
              upstreamText: failure.upstreamText || ""
            });
            if (failure.imageSubmissionConfirmed === true) {
              taskState = markTaskSubmissionAttempt(
                taskState,
                channel,
                account,
                failure.conversationId || error.conversationId
              );
            }
            if (channel.type === "chatplus" && isExplicitChatQuotaError(error)) {
              await updateTargetStatusAfterError(account, channel, error);
            }
            return failQueuedTask(taskState, failure, attempts);
          }
          if (isTerminalTaskFailureError(error)) {
            pushAttempt(attempts, target, error.message || "调用失败", attemptMetadataForError(error));
            continue;
          }
          const retryablePreSubmitFailure = retryableImagePreSubmitCarPoolFailure(taskState, error);
          pushAttempt(attempts, target, error.message || "调用失败", {
            ...attemptMetadataForError(error),
            busy: Boolean(error.busy),
            upstreamText: originalFailureText(error.upstreamText || error.body),
            quotaEmpty: channel.type === "chatplus"
              ? isExplicitChatQuotaError(error)
              : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
          });
          if (retryablePreSubmitFailure) {
            retryTargets.push(target);
            retryError = error;
          }
          if (!error.busy && !error.imageCarQuotaExhausted) {
            await updateTargetStatusAfterError(account, channel, error);
          }
        } finally {
          activeSubmittedTaskIds.delete(taskState.id);
          release?.();
        }
      }
      if (!retryTargets.length || retryRound >= IMAGE_PRE_SUBMIT_RETRY_DELAYS_MS.length) break;
      latestTask = await waitForImagePreSubmitRetry(
        latestTask,
        retryError,
        attempts,
        retryRound + 1,
        IMAGE_PRE_SUBMIT_RETRY_DELAYS_MS[retryRound]
      );
      for (const target of retryTargets) await resetImagePreSubmitSession(config, target);
      currentTargets = retryTargets;
    }
  } finally {
    if (reservedRelease) reservedRelease();
  }
  return failQueuedTask(latestTask, targetsFailedError(attempts), attempts);
}

async function finishChatTask(task, result, channel, account, attempts, responseJson = null, stageTimings = []) {
  const route = taskRouteEntry(channel, account);
  const submittedTask = result.externalId ? markTaskSubmissionAttempt(task, channel, account) : task;
  const nextTask = {
    ...submittedTask,
    externalId: result.externalId || submittedTask.externalId,
    status: "success",
    taskType: "chat",
    modelId: result.model || submittedTask.modelId || "",
    imageCount: result.raw?.imageCount ?? submittedTask.imageCount ?? 0,
    imageUrls: result.imageUrls || submittedTask.imageUrls || [],
    inputImageUrls: submittedTask.inputImageUrls || [],
    responseText: result.content || "",
    errorMessage: "",
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    accountId: account.id,
    accountName: account.name,
    submissionChannels: mergeTaskRoutes(
      submittedTask.submissionChannels,
      result.externalId ? [route] : []
    ),
    generationChannels: mergeTaskRoutes(submittedTask.generationChannels),
    network: taskNetworkMeta(account),
    attempts,
    responseJson: responseJson || chatCompletionResponseJson({ result, channel }),
    completedAt: new Date().toISOString(),
    raw: clearActiveTaskStage(mergeTaskRaw(
      submittedTask.raw,
      { queued: false, waitingForSlot: false, stageTimings },
      result.raw || result
    ))
  };
  await upsertTask(nextTask);
  await recordTaskStat(nextTask);
  await updateAccountAfterTask(account, channel, nextTask);
  return nextTask;
}

async function runChatCompletionTask(task, input, reserved = null, options = {}) {
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = requestedAccountIdForInput(input);
  const targets = await selectReadyTargets(config, requestedChannel, "chat", {
    accountId: strictAccountIdForInput(input),
    input
  });
  let taskReservation = reserved;
  let latestTask = task;
  if (!targets.length) {
    taskReservation?.release?.();
    const error = noChatTargetsError(config, requestedChannel);
    error.task = await failQueuedTask(latestTask, error, taskReservation?.attempts || []);
    throw error;
  }
  if (!taskReservation && options.waitForSlot === true) {
    try {
      taskReservation = await waitForFirstAvailableTarget(targets, "chat", { input });
      latestTask = await startQueuedTask(latestTask, taskReservation.target, taskReservation.queueWaitMs);
    } catch (error) {
      error.task = await failQueuedTask(latestTask, error, error?.attempts || []);
      throw error;
    }
  }
  const preferredTarget = requestedAccountId
    ? targets.find((target) => target.account.id === requestedAccountId)
    : targets.find((target) => target.account.id === latestTask.accountId && target.channel.id === latestTask.channelId);
  const orderedChatTargets = taskReservation?.target
    ? orderedTargets(targets, taskReservation)
    : preferredTarget
      ? [preferredTarget, ...targets.filter((target) => !sameTarget(target, preferredTarget))]
      : targets;
  const attempts = [...(taskReservation?.attempts || [])];
  let chatStageTimings = [];
  let reservedRelease = taskReservation?.release || null;
  try {
    for (const target of orderedChatTargets) {
      const { channel, account } = target;
      let taskState = latestTask;
      let release = null;
      if (reservedRelease && sameTarget(target, taskReservation?.target)) {
        release = reservedRelease;
        reservedRelease = null;
      } else {
        release = await tryReserveTaskSlot(targetTaskSlot(target, "chat"), target, input);
        if (!release) {
          attempts.push(await targetBusyAttempt(target, "chat", input));
          continue;
        }
      }
      try {
        const finished = await runChatplusAccountWork(channel, account, async () => {
          if (!(await ensureTargetReady(config, target, "chat", attempts, { input }))) return null;
          const client = getWorkClient(config, channel, account);
          if (typeof client.createChatCompletion !== "function") {
            throw new Error("这个渠道暂不支持对话。");
          }
          const onStageStart = async (stage) => {
            taskState = await persistTaskStageStart(taskState, stage, channel, account);
            latestTask = taskState;
          };
          const onStage = async (stage) => {
            taskState = await persistTaskStage(taskState, stage);
            latestTask = taskState;
          };
          const upstreamResult = await client.createChatCompletion({
            ...providerInput(input),
            onStageStart,
            onStage,
            ...(channel.type === "chatplus" ? { concurrentSubmit: true } : {})
          });
          chatStageTimings = mergeTaskStageTimings(chatStageTimings, upstreamResult?.raw?.stageTimings);
          const result = await mirrorTaskImages({
            ...upstreamResult,
            usage: upstreamResult.usage || estimateChatTokenUsage(input, upstreamResult.content)
          }, config, client, {
            onImagePhase: createImageSavePhaseReporter(
              () => taskState,
              (next) => { taskState = next; latestTask = next; },
              channel,
              account
            )
          });
          const responseJson = chatCompletionResponseJson({ result, channel });
          const finishedTask = await finishChatTask(taskState, result, channel, account, attempts, responseJson, chatStageTimings);
          return { result, channel, account, task: finishedTask, responseJson };
        }, {
          taskType: "chat",
          parallel: channel.type === "chatplus",
          modelKey: targetChatModelKey(target, input),
          quotaProbe: targetConfirmedQuotaBlocksTask(target, "chat", input)
            && targetConfirmedQuotaRetryDue(target, input)
        });
        if (finished) return finished;
      } catch (error) {
        latestTask = taskState;
        chatStageTimings = mergeTaskStageTimings(chatStageTimings, error?.stageTimings);
        const status = Number(error.status || error.statusCode || 0);
        attempts.push({
          channelId: channel.id,
          channelName: channel.name,
          accountId: account.id,
          accountName: account.name,
          message: error.message || "调用失败",
          ...attemptMetadataForError(error),
          ...(error?.selectedCarId ? { carId: error.selectedCarId } : {}),
          ...(Array.isArray(error?.carAttempts) && error.carAttempts.length
            ? { carAttempts: taskResponseJson(error.carAttempts) }
            : {})
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
        if (error?.code === "UPSTREAM_CONVERSATION_NOT_CREATED") {
          error.task = await failQueuedTask(taskState, error, attempts, chatStageTimings);
          throw error;
        }
        if (status === 400 && !isChatBlockedError(error)) {
          error.task = await failQueuedTask(taskState, error, attempts, chatStageTimings);
          throw error;
        }
      } finally {
        release();
      }
    }
  } finally {
    reservedRelease?.();
  }

  const error = new Error(readableChatFailure(attempts));
  error.task = await failQueuedTask(latestTask, error, attempts, chatStageTimings);
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
  const requestedAccountId = requestedAccountIdForInput(input);
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", {
    accountId: requestedAccountId,
    input
  });
  if (!targets.length) {
    throw noUsableTargetError("text2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }

  const reserved = await reserveFirstAvailableTarget(targets, "text2img", { input });
  const target = reserved.target;
  const task = queuedTask({
    input,
    target,
    taskType: "text2img",
    requestMeta,
    status: "processing",
    raw: {}
  });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved?.release();
    throw error;
  }
  scheduledImageTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runQueuedTextTask(task, input, reserved, {
        waitForChatplusImages: false
      });
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
  assertImageFileCount(files);
  const inputImageHashes = await imageFileHashes(files);
  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const selection = await selectImageExecutionTargets(
    config,
    requestedChannel,
    requestedAccountId,
    input,
    admission
  );
  const targets = selection.targets;
  if (!targets.length) {
    throw noUsableTargetError("img2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }

  const reserved = selection.reserved || await reserveFirstAvailableTarget(targets, "img2img", { input });
  const target = reserved.target;
  const task = queuedTask({
    input: { ...input, files },
    target,
    taskType: "img2img",
    requestMeta,
    status: "processing",
    raw: inputImageHashes.length ? { inputImageHashes } : {}
  });
  try {
    reserved?.handoff?.();
    await upsertTask(task);
  } catch (error) {
    reserved?.release();
    throw error;
  }
  scheduledImageTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runQueuedImageTask(task, input, files, reserved, {
        waitForChatplusImages: false
      });
    } finally {
      scheduledImageTasks.delete(task.id);
    }
  });
  return task;
}
export async function queueChatCompletion(input = {}, requestMeta = {}, taskOptions = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const strictAccountId = strictAccountIdForInput(input);
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: strictAccountId, input });
  if (!targets.length) {
    throw noUsableTargetError("chat", {
      config,
      requestedChannel,
      accountId: strictAccountId,
      input
    });
  }

  const reserved = await tryReserveFirstAvailableTarget(targets, "chat", { input });
  const ordered = reserved?.orderedTargets?.length
    ? reserved.orderedTargets
    : await orderTargetsByRoutingUsage(targets, "chat", input);
  const target = reserved?.target || ordered[0] || targets[0];
  const waitingForSlot = !reserved;
  const task = queuedTask({
    input,
    target,
    taskType: "chat",
    prompt: cleanChatPrompt(input),
    imageCount: chatImageCount(input),
    inputImageUrls: taskInputPreviewUrls(input, taskOptions.inputImageUrls),
    raw: { endpoint: "/v1/chat/completions", waitingForSlot },
    requestMeta,
    status: waitingForSlot ? "queued" : "processing"
  });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved?.release();
    throw error;
  }
  scheduledChatTasks.add(task.id);
  runInBackground(async () => {
    try {
      await runChatCompletionTask(task, input, reserved, { waitForSlot: waitingForSlot });
    } finally {
      scheduledChatTasks.delete(task.id);
      reserved?.release();
    }
  });
  return task;
}

function preserveConfirmedChatQuota(currentStatus = {}, nextStatus = {}) {
  if (["subscription_missing", "subscription_expired"].includes(String(nextStatus.status || "").toLowerCase())) {
    return nextStatus;
  }
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
  const futureRetryAt = [
    nextStatus.cooldownUntil,
    nextStatus.quotaResetAt,
    recoveryResetAt,
    currentStatus.cooldownUntil,
    currentStatus.quotaResetAt
  ].find((value) => {
    const retryTime = Date.parse(value || "");
    return Number.isFinite(retryTime) && retryTime > Date.now();
  });
  const cooldownUntil = successfulCheck
    ? Number.isFinite(resetTime) && resetTime > Date.now()
      ? resetAt
      : new Date(Date.now() + CHAT_USAGE_RECOVERY_CHECK_MS).toISOString()
    : futureRetryAt || new Date(Date.now() + CHAT_USAGE_RECOVERY_CHECK_MS).toISOString();
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

function nextPeriodicResetAt(value, periodMs, now) {
  const resetAt = Date.parse(value || "");
  if (!Number.isFinite(resetAt) || !periodMs) return "";
  if (resetAt > now) return new Date(resetAt).toISOString();
  const elapsedPeriods = Math.floor((now - resetAt) / periodMs) + 1;
  return new Date(resetAt + elapsedPeriods * periodMs).toISOString();
}

function chatUsageRecovered(previous = {}, current = {}) {
  if (!knownChatUsageBalance(previous.balance) || !knownChatUsageBalance(current.balance)) return false;
  const previousQuota = Number(previous.quota);
  const currentQuota = Number(current.quota);
  if (Number.isFinite(previousQuota) && Number.isFinite(currentQuota) && previousQuota !== currentQuota) return false;
  const balanceIncreased = Number(current.balance) > Number(previous.balance);
  const previousUsed = Number(previous.used);
  const currentUsed = Number(current.used);
  return balanceIncreased && (
    !Number.isFinite(previousUsed)
    || !Number.isFinite(currentUsed)
    || currentUsed < previousUsed
  );
}

function reconcileChatUsageResetTimes(currentStatus = {}, nextStatus = {}) {
  const currentReferenceUsage = currentStatus.meta?.referenceUsage || {};
  const nextReferenceUsage = nextStatus.meta?.referenceUsage;
  if (!nextReferenceUsage || typeof nextReferenceUsage !== "object") return nextStatus;

  const checkedAt = nextStatus.meta?.accountCheck?.checkedAt || new Date().toISOString();
  const checkedTime = Date.parse(checkedAt);
  const now = Number.isFinite(checkedTime) ? checkedTime : Date.now();
  const referenceUsage = Object.fromEntries(Object.entries(nextReferenceUsage).map(([key, usageValue]) => {
    const usage = usageValue && typeof usageValue === "object" ? usageValue : {};
    const previous = currentReferenceUsage[key] || {};
    const periodMs = chatUsagePeriodMs(usage.period || previous.period);
    const hasPositiveBalance = knownChatUsageBalance(usage.balance) && Number(usage.balance) > 0;
    const recovered = periodMs && chatUsageRecovered(previous, usage);
    const upstreamResetAt = usage.quotaResetAt || "";
    const upstreamResetTime = Date.parse(upstreamResetAt);

    if (recovered) {
      return [key, {
        ...usage,
        quotaResetAt: new Date(now + periodMs).toISOString(),
        quotaResetSource: "estimated",
        quotaResetObservedAt: new Date(now).toISOString()
      }];
    }
    if (periodMs && hasPositiveBalance && Number.isFinite(upstreamResetTime) && upstreamResetTime <= now) {
      return [key, {
        ...usage,
        quotaResetAt: nextPeriodicResetAt(upstreamResetAt, periodMs, now),
        quotaResetSource: "estimated"
      }];
    }
    if (periodMs && !upstreamResetAt && previous.quotaResetObservedAt && previous.quotaResetAt) {
      return [key, {
        ...usage,
        quotaResetAt: nextPeriodicResetAt(previous.quotaResetAt, periodMs, now),
        quotaResetSource: "estimated",
        quotaResetObservedAt: previous.quotaResetObservedAt
      }];
    }
    return [key, {
      ...usage,
      quotaResetSource: Number.isFinite(upstreamResetTime) ? "upstream" : ""
    }];
  }));

  return {
    ...nextStatus,
    meta: {
      ...(currentStatus.meta || {}),
      ...(nextStatus.meta || {}),
      referenceUsage
    }
  };
}

function successfulChatAccountCheckStatus(currentStatus = {}, status = {}) {
  const nextStatus = reconcileChatUsageResetTimes(currentStatus, successfulAccountCheckStatus(status));
  const meta = { ...(nextStatus.meta || {}) };
  delete meta.proxyRestricted;
  delete meta.proxyUnavailable;
  delete meta.upstreamMessage;
  const restriction = status.meta?.proCarRestriction;
  if (!restriction || typeof restriction !== "object") return { ...nextStatus, meta };

  delete meta.proCarRestriction;
  if (restriction.active === true && Date.parse(restriction.until || "") > Date.now()) {
    meta.proCarsUnavailable = true;
    meta.proCarsUnavailableReason = "plan_mismatch";
    meta.proCarsUnavailableUntil = restriction.until;
  } else {
    delete meta.proCarsUnavailable;
    delete meta.proCarsUnavailableReason;
    delete meta.proCarsUnavailableUntil;
  }
  return { ...nextStatus, meta };
}

function accountCheckTimeoutStatus(currentStatus = {}, error) {
  const previousCheck = currentStatus.meta?.accountCheck || {};
  const consecutiveTimeouts = Number(previousCheck.consecutiveTimeouts || 0) + 1;
  const step = String(error?.accountCheckStep || "账号检测");
  const preservePreviousStatus = consecutiveTimeouts < 2
    && ["ok", "quota_empty", "cooldown"].includes(String(currentStatus.status || "").toLowerCase());
  const message = preservePreviousStatus
    ? `${step}超时，暂时沿用上次状态。`
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
  const client = getWorkClient(config, abilityChannel, account);
  const currentStatus = ability === "chatplus"
    ? account.meta?.abilities?.chatplus || {}
    : account.meta?.abilities?.drawing || {};
  try {
    const checked = await runChatplusAccountWork(abilityChannel, account, () => client.check());
    const checkedStatus = ability === "chatplus"
      ? preserveConfirmedChatQuota(currentStatus, successfulChatAccountCheckStatus(currentStatus, checked))
      : checked;
    const data = applyCheckedQuotaProtection(abilityChannel, account, checkedStatus, currentStatus);
    return { ok: true, data };
  } catch (error) {
    if (ability === "chatplus" && isAccountCheckTimeoutError(error)) {
      return {
        ok: false,
        data: accountCheckTimeoutStatus(currentStatus, error)
      };
    }
    const proxyRestricted = ability === "chatplus" && isProxyRestrictedLoginError(error, account);
    const errorStatus = proxyRestricted
      ? proxyRestrictedStatus(error)
      : ability === "chatplus"
        ? accountStatusFromError(error, { explicitChatQuotaOnly: true })
        : accountStatusFromError(error);
    const markedStatus = !proxyRestricted && isProxyUnavailableError(error, account)
      ? withProxyUnavailableMark(errorStatus)
      : errorStatus;
    const data = ability === "chatplus"
      ? preserveConfirmedChatQuota(currentStatus, {
          ...markedStatus,
          message: proxyRestricted ? "IP 被限制" : readableCheckErrorMessage(error),
          expireAt: ""
        })
      : {
          ...markedStatus,
          quota: markedStatus.quota ?? null,
          balance: markedStatus.balance ?? null,
          quotaResetAt: markedStatus.quotaResetAt || "",
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
  if (isChatSubscriptionMissingError(error)) {
    const model = chatSubscriptionModel(error);
    return `${model.name} 未订阅套餐，暂不参与任务分配。`;
  }
  if (isChatSubscriptionExpiredError(error)) {
    const model = chatSubscriptionModel(error);
    return `${model.name === "当前模型" ? "GPT" : model.name} 套餐已过期，请续费后重新检测。`;
  }
  if (isCarPoolUnavailableError(error)) {
    return carPoolUnavailableMessage();
  }
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

function isProxyRestrictedLoginError(error, account) {
  if (!String(accountProxyValue(account) || "").trim()) return false;
  if (error?.portalAccountRejected !== true) return false;
  return /用户不存在或密码错误|账号或密码错误|账号密码错误/.test(String(error?.message || ""));
}

function proxyRestrictedStatus(error) {
  return {
    status: "proxy_restricted",
    quota: null,
    balance: null,
    used: null,
    quotaResetAt: "",
    expireAt: "",
    cooldownUntil: null,
    quotaReason: "proxy_restricted",
    quotaConfirmedByUpstream: false,
    message: "IP 被限制",
    meta: {
      proxyRestricted: true,
      upstreamMessage: String(error?.message || "")
    }
  };
}

function isProxyUnavailableError(error, account) {
  if (!String(accountProxyValue(account) || "").trim()) return false;
  const code = Number(error?.curlCode || 0);
  if (code === 96 || code === 97) return true;
  if (String(error?.code || "") === "CURL_PROXY_ERROR") return true;
  return /User was rejected by the SOCKS\d server|rejected by the SOCKS\d server|SOCKS\d server \(\d|remote proxy host refused/i
    .test(String(error?.message || ""));
}

function withProxyUnavailableMark(status) {
  return {
    ...status,
    meta: {
      ...(status.meta && typeof status.meta === "object" ? status.meta : {}),
      proxyUnavailable: true
    }
  };
}

function combinedShareAIStatus(results) {
  const drawing = results.drawing.data;
  const chatplus = results.chatplus.data;
  const subscriptionExpired = [drawing.status, chatplus.status].includes("subscription_expired");
  const subscriptionMissing = [drawing.status, chatplus.status].includes("subscription_missing");
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return {
    status: subscriptionExpired ? "subscription_expired" : subscriptionMissing ? "subscription_missing" : disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : "error",
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
  const subscriptionExpired = statuses.includes("subscription_expired");
  const subscriptionMissing = statuses.includes("subscription_missing");
  const disconnected = statuses.includes("disconnected");
  const ok = statuses.includes("ok");
  const failed = statuses.some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = statuses.includes("quota_empty");
  const messages = [
    results.drawing ? `绘图站：${drawing.message || (results.drawing.ok ? "可用" : "不可用")}` : "",
    results.chatplus ? `聊天：${chatplus.message || (results.chatplus.ok ? "可用" : "不可用")}` : ""
  ].filter(Boolean);

  return {
    status: subscriptionExpired ? "subscription_expired" : subscriptionMissing ? "subscription_missing" : disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : "error",
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

function preserveAccountMetadata(account, status) {
  const savedMeta = { ...(account.meta || {}) };
  delete savedMeta.abilities;
  const checkedMeta = status.meta || {};
  return {
    ...status,
    meta: {
      ...savedMeta,
      ...checkedMeta
    }
  };
}

async function preserveLatestAccountMetadata(account, status) {
  const config = await loadConfig();
  const latest = config.accounts.find((item) => item.id === account.id) || account;
  return preserveAccountMetadata(latest, status);
}

async function performAccountCheck(accountId) {
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
  if (String(account.status || "").toLowerCase() === "activation_required") {
    return {
      status: "activation_required",
      quota: account.quota ?? null,
      balance: account.balance ?? null,
      quotaResetAt: account.quotaResetAt || "",
      expireAt: account.expireAt || "",
      message: account.message || "账号尚未激活，请先填写激活码。",
      activationRequired: true,
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
  await validateAccountProxy(account);
  if (channel.type === "shareai") {
    const abilities = ["drawing", "chatplus"].filter((ability) => channelAbilityEnabled(channel, ability));
    const checked = await Promise.all(abilities.map(async (ability) => [
      ability,
      await checkShareAIAbility(config, channel, account, ability)
    ]));
    const results = Object.fromEntries(checked);
    const status = await preserveLatestAccountMetadata(account, preserveDrawingCooldown(
      account,
      combinedEnabledShareAIStatus(results)
    ));
    await updateAccountStatus(account.id, status);
    if (!["ok", "subscription_missing"].includes(status.status)) throw new Error(status.message || "检测失败");
    return status;
  }
  const client = getWorkClient(config, channel, account);
  try {
    const rawStatus = await runChatplusAccountWork(channel, account, () => client.check());
    const checked = channel.type === "chatplus"
      ? successfulChatAccountCheckStatus(account, rawStatus)
      : successfulAccountCheckStatus(rawStatus);
    const checkedStatus = channel.type === "chatplus"
      ? preserveConfirmedChatQuota(account, checked)
      : checked;
    const status = applyCheckedQuotaProtection(channel, account, checkedStatus, account);
    const nextStatus = await preserveLatestAccountMetadata(account, {
      ...status,
      cooldownUntil: status.status === "ok" ? null : status.cooldownUntil
    });
    await updateAccountStatus(account.id, nextStatus);
    return nextStatus;
  } catch (error) {
    if (channel.type === "chatplus" && isAccountCheckTimeoutError(error)) {
      const status = await preserveLatestAccountMetadata(account, accountCheckTimeoutStatus(account, error));
      await updateAccountStatus(account.id, status);
      if (status.status === "error") throw new Error(status.message);
      return status;
    }
    const proxyRestricted = channel.type === "chatplus" && isProxyRestrictedLoginError(error, account);
    const message = proxyRestricted ? "IP 被限制" : readableCheckErrorMessage(error);
    const errorStatus = proxyRestricted
      ? proxyRestrictedStatus(error)
      : accountStatusFromError(error, {
          explicitChatQuotaOnly: channel.type === "chatplus"
        });
    const markedStatus = !proxyRestricted && isProxyUnavailableError(error, account)
      ? withProxyUnavailableMark(errorStatus)
      : errorStatus;
    const checkedStatus = {
      ...markedStatus,
      quota: channel.type === "chatplus" ? null : markedStatus.quota ?? null,
      balance: channel.type === "chatplus" ? null : markedStatus.balance ?? null,
      quotaResetAt: markedStatus.quotaResetAt || "",
      expireAt: "",
      message
    };
    const status = await preserveLatestAccountMetadata(account,
      channel.type === "chatplus"
        ? preserveConfirmedChatQuota(account, checkedStatus)
        : checkedStatus
    );
    await updateAccountStatus(account.id, status);
    if (status.status === "subscription_missing") return status;
    throw new Error(message);
  }
}

export function checkAccount(accountId) {
  const key = String(accountId || "").trim();
  const active = activeAccountChecks.get(key);
  if (active) return active;
  const check = performAccountCheck(key).finally(() => {
    if (activeAccountChecks.get(key) === check) activeAccountChecks.delete(key);
  });
  activeAccountChecks.set(key, check);
  return check;
}

export async function checkAllAccounts() {
  const config = await loadRuntimeConfig();
  const results = new Array(config.accounts.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < config.accounts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const account = config.accounts[index];
      if (account.enabled === false) {
        results[index] = { accountId: account.id, ok: false, skipped: true, message: "账号已停用，已跳过检测。" };
        continue;
      }
      try {
        results[index] = {
          accountId: account.id,
          ok: true,
          data: await checkAccount(account.id)
        };
      } catch (error) {
        results[index] = { accountId: account.id, ok: false, message: error.message };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(ACCOUNT_CHECK_CONCURRENCY, config.accounts.length) },
    () => worker()
  ));
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

export async function createChatCompletion(input = {}, requestMeta = {}, taskOptions = {}) {
  if (input.stream === true) input = { ...input, stream: false };
  assertChatInput(input);

  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const strictAccountId = strictAccountIdForInput(input);
  const targets = await selectReadyTargets(config, requestedChannel, "chat", { accountId: strictAccountId, input });
  if (!targets.length) {
    throw noUsableTargetError("chat", {
      config,
      requestedChannel,
      accountId: strictAccountId,
      input
    });
  }

  const reserved = await tryReserveFirstAvailableTarget(targets, "chat", { input });
  const ordered = reserved?.orderedTargets?.length
    ? reserved.orderedTargets
    : await orderTargetsByRoutingUsage(targets, "chat", input);
  const target = reserved?.target || ordered[0] || targets[0];
  const waitingForSlot = !reserved;
  const task = queuedTask({
    input,
    target,
    taskType: "chat",
    prompt: cleanChatPrompt(input),
    imageCount: chatImageCount(input),
    inputImageUrls: taskInputPreviewUrls(input, taskOptions.inputImageUrls),
    raw: { endpoint: "/v1/chat/completions", waitingForSlot },
    requestMeta,
    status: waitingForSlot ? "queued" : "processing"
  });
  try {
    await upsertTask(task);
  } catch (error) {
    reserved?.release();
    throw error;
  }
  scheduledChatTasks.add(task.id);
  try {
    const result = await runChatCompletionTask(task, input, reserved, { waitForSlot: waitingForSlot });
    return chatCompletionResponse(result);
  } finally {
    scheduledChatTasks.delete(task.id);
    reserved?.release();
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
  const targets = await selectReadyTargets(config, requestedChannel, "text2img", { input });
  if (!targets.length) throw noUsableTargetError("text2img", { config, requestedChannel, input });

  const reserved = await reserveFirstAvailableTarget(targets, "text2img", { input });
  const attempts = [...reserved.attempts];
  let reservedRelease = reserved.release;
  try {
    for (const target of orderedTargets(targets, reserved)) {
      const { channel, account } = target;
      let submitted = false;
      let release = null;
      if (reservedRelease && sameTarget(target, reserved.target)) {
        release = reservedRelease;
        reservedRelease = null;
      } else {
        release = await tryReserveTaskSlot(targetTaskSlot(target, "text2img"), target, input);
        if (!release) {
          attempts.push(await targetBusyAttempt(target, "text2img", input));
          continue;
        }
      }
      try {
        const finishedTask = await runChatplusAccountWork(channel, account, async () => {
          if (!(await ensureTargetReady(config, target, "text2img", attempts, { input }))) return null;
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
          taskType: "text2img",
          parallel: wait && channel.type === "chatplus",
          noQueue: wait && channel.type !== "chatplus",
          slot: targetTaskSlot(target, "text2img"),
          modelKey: targetChatModelKey(target, input),
          quotaProbe: targetConfirmedQuotaBlocksTask(target, "text2img", input)
            && targetConfirmedQuotaRetryDue(target, input),
          blockingSlots: ["chatImage"]
        });
        if (finishedTask) return finishedTask;
      } catch (error) {
        if (await skipAccountAfterConfirmedUsageLimit(target, error, attempts)) continue;
        if (submitted) {
          error.imageSubmissionAttempted = true;
          error.imageSubmissionConfirmed = true;
          throw imageSubmissionFailure(error);
        }
        if (error.imageSubmissionAttempted === true) throw imageSubmissionFailure(error);
        if (isTerminalTaskFailureError(error)) {
          pushAttempt(attempts, target, error.message || "调用失败", attemptMetadataForError(error));
          continue;
        }
        pushAttempt(attempts, target, error.message || "调用失败", {
          ...attemptMetadataForError(error),
          busy: Boolean(error.busy),
          quotaEmpty: channel.type === "chatplus"
            ? isExplicitChatQuotaError(error)
            : Boolean(error.quotaEmpty || isQuotaEmptyError(error))
        });
        if (!error.busy && !error.imageCarQuotaExhausted) {
          await updateTargetStatusAfterError(account, channel, error);
        }
      } finally {
        release?.();
      }
    }
  } finally {
    reservedRelease?.();
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
  assertImageFileCount(files);
  if (!wait) return queueImageTask({ input, files, requestMeta, admission });
  const inputImageHashes = await imageFileHashes(files);

  const config = await loadRuntimeConfig();
  const requestedChannel = requestedChannelForInput(config, input);
  const requestedAccountId = String(input.accountId || input.account_id || "").trim();
  const selection = await selectImageExecutionTargets(
    config,
    requestedChannel,
    requestedAccountId,
    input,
    admission,
    { skipRecovery: Boolean(admission) }
  );
  const targets = selection.targets;
  if (!targets.length) {
    throw noUsableTargetError("img2img", {
      config,
      requestedChannel,
      accountId: requestedAccountId,
      input
    });
  }
  const reserved = selection.reserved;
  const executionTargets = reserved
    ? orderedTargets(targets, reserved)
    : await orderTargetsByRoutingUsage(targets, "img2img", input);

  const task = queuedTask({
    input: { ...input, files },
    target: reserved?.target || executionTargets[0],
    taskType: "img2img",
    requestMeta,
    raw: inputImageHashes.length ? { inputImageHashes } : {}
  });
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
      waitForChatplusImages: true,
      orderedTargets: executionTargets
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
