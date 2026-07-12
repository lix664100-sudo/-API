import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "data");
const configFile = path.join(dataDir, "config.json");
const tasksFile = path.join(dataDir, "tasks.json");
const statsFile = path.join(dataDir, "stats.json");
const taskHistoryLimit = 20;
const statRecordDays = 31;
const statRecordLimit = 50000;
let statsWriteQueue = Promise.resolve();

const defaultImageStorage = {
  mode: "smart",
  autoCleanup: true,
  retentionDays: 7
};

const defaultConcurrency = {
  chat: 3,
  drawingImage: 2,
  chatImage: 2
};

const defaultChatModels = [
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "balanced", enabled: true, default: true },
  { key: "grok", name: "Grok", carType: "grok", model: "", strategy: "balanced", enabled: true, default: false },
  { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: false }
];

const defaultShareAISettings = {
  mainBaseUrl: "https://ikun.aishare.icu",
  drawingBaseUrl: "https://drawing.aishare.icu",
  chatBaseUrl: "https://www.chatplus.cc",
  defaultModelId: 1,
  defaultChatModel: "gpt",
  chatModels: defaultChatModels,
  autoCarSelection: true,
  autoCarSelectionMigrated: true
};

const defaultChannels = [
  {
    id: "shareai",
    name: "ShareAI账号",
    type: "shareai",
    enabled: true,
    priority: 1,
    settings: defaultShareAISettings
  }
];

const defaultConfig = {
  mainBaseUrl: "https://ikun.aishare.icu",
  drawingBaseUrl: "https://drawing.aishare.icu",
  apiKey: "",
  defaultChannel: "auto",
  defaultModelId: 1,
  defaultRatio: "1:1",
  defaultImageCount: 1,
  waitTimeoutSec: 180,
  imageStorage: defaultImageStorage,
  concurrency: defaultConcurrency,
  channels: defaultChannels,
  accounts: []
};

function normalizeRoutingWeight(value) {
  const weight = Math.round(Number(value || 1));
  return Math.min(100, Math.max(1, Number.isFinite(weight) ? weight : 1));
}

async function ensureDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await ensureDir();
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

function normalizeChatModelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeImageStorage(value = {}) {
  const mode = ["smart", "always", "never"].includes(value.mode) ? value.mode : defaultImageStorage.mode;
  return {
    mode,
    autoCleanup: value.autoCleanup !== false,
    retentionDays: Math.min(3650, Math.max(1, Number(value.retentionDays || defaultImageStorage.retentionDays)))
  };
}

function normalizeConcurrency(value = {}) {
  return {
    chat: Math.min(20, Math.max(1, Number(value.chat || defaultConcurrency.chat))),
    drawingImage: Math.min(20, Math.max(1, Number(value.drawingImage || defaultConcurrency.drawingImage))),
    chatImage: Math.min(20, Math.max(1, Number(value.chatImage || defaultConcurrency.chatImage)))
  };
}

function normalizeChatModels(settings = {}, migrateAutoSelection = false) {
  const legacy = {
    carType: settings.carType || defaultChatModels[0].carType,
    model: settings.model || settings.defaultModel || defaultChatModels[0].model
  };
  const source = Array.isArray(settings.chatModels) && settings.chatModels.length ? settings.chatModels : defaultChatModels;
  const byKey = new Map(defaultChatModels.map((item) => [item.key, item]));
  const merged = defaultChatModels.map((defaultItem, index) => {
    const item = source.find((entry) => normalizeChatModelKey(entry?.key || entry?.value || entry?.name) === defaultItem.key) || source[index] || defaultItem;
    const fallback = defaultChatModels[index] || {};
    const key = normalizeChatModelKey(item?.key || item?.value || fallback.key || `model-${index + 1}`);
    const base = byKey.get(key) || fallback;
    const migratedEnabled = migrateAutoSelection && item?.enabled === false && ["grok", "gemini"].includes(key)
      ? true
      : item?.enabled !== false;
    return {
      key,
      name: String(item?.name || base.name || key).trim(),
      carType: String(item?.carType || (key === "gpt" ? legacy.carType : base.carType || "")).trim(),
      model: String(item?.model || (key === "gpt" ? legacy.model : base.model || "")).trim(),
      strategy: String(item?.strategy || base.strategy || "balanced").trim(),
      enabled: migratedEnabled,
      default: Boolean(item?.default || item?.key === settings.defaultChatModel || item?.value === settings.defaultChatModel)
    };
  });
  if (!merged.some((item) => item.default && item.enabled)) {
    const firstEnabled = merged.find((item) => item.enabled) || merged[0];
    if (firstEnabled) firstEnabled.default = true;
  }
  return merged;
}

function legacyChannelByType(channels = [], type) {
  return (Array.isArray(channels) ? channels : []).find((channel) => channel?.type === type) || null;
}

function normalizeShareAIChannel(channels = []) {
  const source = Array.isArray(channels) ? channels : [];
  const shareai = source.find((channel) => channel?.type === "shareai") || null;
  const drawing = legacyChannelByType(source, "drawing");
  const chatplus = legacyChannelByType(source, "chatplus");
  const settings = {
    ...defaultShareAISettings,
    ...(shareai?.settings || {})
  };

  if (drawing?.settings?.baseUrl) settings.drawingBaseUrl = drawing.settings.baseUrl;
  if (drawing?.settings?.defaultModelId) settings.defaultModelId = Number(drawing.settings.defaultModelId || 1);
  if (chatplus?.settings?.baseUrl) settings.chatBaseUrl = chatplus.settings.baseUrl;
  if (chatplus?.settings) {
    settings.defaultChatModel = chatplus.settings.defaultChatModel || settings.defaultChatModel;
    settings.chatModels = chatplus.settings.chatModels || settings.chatModels;
  }

  const migrateAutoSelection = settings.autoCarSelectionMigrated !== true;
  settings.chatModels = normalizeChatModels(settings, migrateAutoSelection);
  settings.defaultChatModel = settings.chatModels.find((item) => item.default && item.enabled)?.key || settings.chatModels[0]?.key || "gpt";
  settings.defaultModelId = Number(settings.defaultModelId || 1);
  settings.autoCarSelection = true;
  settings.autoCarSelectionMigrated = true;
  settings.legacyChannelIds = {
    drawing: drawing?.id || "drawing",
    chatplus: chatplus?.id || "chatplus"
  };
  delete settings.baseUrl;
  delete settings.carId;
  delete settings.carType;

  return [{
    id: String(shareai?.id || "shareai"),
    name: shareai?.name || "ShareAI账号",
    type: "shareai",
    enabled: (shareai || drawing || chatplus)?.enabled !== false,
    priority: Number(shareai?.priority || Math.min(Number(drawing?.priority || 1), Number(chatplus?.priority || 1)) || 1),
    settings
  }];
}

function makeDefaultAccounts(stored) {
  if (!stored?.username || !stored?.password) return [];
  const username = stored.username;
  const password = stored.password;
  return [
    {
      id: "shareai-default",
      channelId: "shareai",
      name: "ShareAI账号1",
      username,
      password,
      enabled: true,
      priority: 1,
      routingWeight: 1,
      status: "unknown"
    }
  ];
}

function legacyChannelTypeMap(stored) {
  const map = new Map();
  for (const channel of Array.isArray(stored.channels) ? stored.channels : []) {
    if (channel?.id) map.set(String(channel.id), channel.type || "");
  }
  map.set("drawing", "drawing");
  map.set("chatplus", "chatplus");
  return map;
}

function accountAbilityStatus(account) {
  return {
    status: account.status || "unknown",
    lastCheckAt: account.lastCheckAt || null,
    cooldownUntil: account.cooldownUntil || null,
    quota: account.quota ?? null,
    balance: account.balance ?? null,
    quotaResetAt: account.quotaResetAt || null,
    expireAt: account.expireAt || null,
    message: account.message || "",
    meta: account.meta || {}
  };
}

function accountGroupKey(account) {
  return [
    String(account.username || "").trim().toLowerCase(),
    String(account.password || ""),
    String(account.proxyUrl || account.proxy || "").trim()
  ].join("::");
}

function mergeAccountIntoGroup(group, account, type) {
  const next = group || {
    id: account.id || `account-${randomUUID()}`,
    channelId: "shareai",
    name: "",
    username: account.username || "",
    password: account.password || "",
    proxyUrl: account.proxyUrl || account.proxy || "",
    enabled: account.enabled !== false,
    priority: Number(account.priority || 1),
    routingWeight: normalizeRoutingWeight(account.routingWeight),
    status: "unknown",
    lastCheckAt: null,
    cooldownUntil: null,
    quota: null,
    balance: null,
    quotaResetAt: null,
    expireAt: null,
    message: "",
    meta: {
      ...(account.meta || {}),
      abilities: { ...(account.meta?.abilities || {}) }
    }
  };
  if (!next.name || type === "chatplus") next.name = account.name || next.name || account.username || "ShareAI账号";
  if (!next.password && account.password) next.password = account.password;
  if (!next.proxyUrl && (account.proxyUrl || account.proxy)) next.proxyUrl = account.proxyUrl || account.proxy;
  next.enabled = next.enabled && account.enabled !== false;
  next.priority = Math.min(Number(next.priority || 99), Number(account.priority || 1));
  next.meta = {
    ...(next.meta || {}),
    ...(account.meta || {}),
    abilities: { ...(next.meta?.abilities || {}) }
  };
  if (type === "drawing" || type === "chatplus") {
    next.meta.abilities[type] = accountAbilityStatus(account);
  } else if (account.meta?.abilities) {
    next.meta.abilities = { ...next.meta.abilities, ...account.meta.abilities };
  }
  return next;
}

function finalizeShareAIAccount(account) {
  const abilities = account.meta?.abilities || {};
  const drawing = abilities.drawing || {};
  const chatplus = abilities.chatplus || {};
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return {
    ...account,
    channelId: "shareai",
    name: account.name || account.username || "ShareAI账号",
    status: disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : account.status || "unknown",
    lastCheckAt: account.lastCheckAt || drawing.lastCheckAt || chatplus.lastCheckAt || null,
    cooldownUntil: chatplus.cooldownUntil || null,
    quota: drawing.quota ?? account.quota ?? null,
    balance: drawing.balance ?? account.balance ?? null,
    quotaResetAt: drawing.quotaResetAt || chatplus.quotaResetAt || account.quotaResetAt || null,
    expireAt: drawing.expireAt || chatplus.expireAt || account.expireAt || null,
    message: account.message || [drawing.message && `绘图站：${drawing.message}`, chatplus.message && `聊天：${chatplus.message}`].filter(Boolean).join("；"),
    meta: {
      ...(account.meta || {}),
      abilities: {
        drawing,
        chatplus
      }
    }
  };
}

function normalizeAccounts(stored) {
  const source = Array.isArray(stored.accounts) && stored.accounts.length ? stored.accounts : makeDefaultAccounts(stored);
  const typeMap = legacyChannelTypeMap(stored);
  const groups = new Map();

  for (const account of source) {
    const normalized = {
      id: account.id || `account-${randomUUID()}`,
      channelId: account.channelId || "shareai",
      name: account.name || "未命名账号",
      username: account.username || "",
      password: account.password || "",
      proxyUrl: account.proxyUrl || account.proxy || "",
      enabled: account.enabled !== false,
      priority: Number(account.priority || 1),
      routingWeight: normalizeRoutingWeight(account.routingWeight),
      status: account.status || "unknown",
      lastCheckAt: account.lastCheckAt || null,
      cooldownUntil: account.cooldownUntil || null,
      quota: account.quota ?? null,
      balance: account.balance ?? null,
      quotaResetAt: account.quotaResetAt || null,
      expireAt: account.expireAt || null,
      message: account.message || "",
      meta: account.meta || {}
    };
    const type = normalized.channelId === "shareai" ? "shareai" : typeMap.get(String(normalized.channelId)) || "shareai";
    const key = accountGroupKey(normalized) || normalized.id;
    groups.set(key, mergeAccountIntoGroup(groups.get(key), normalized, type));
  }

  return [...groups.values()].map(finalizeShareAIAccount);
}

function normalizeConfig(stored = {}) {
  const channels = normalizeShareAIChannel(stored.channels);
  const defaultChannel = stored.defaultChannel === channels[0]?.id ? stored.defaultChannel : "auto";
  const config = {
    ...defaultConfig,
    ...stored,
    defaultChannel,
    imageStorage: normalizeImageStorage(stored.imageStorage),
    concurrency: normalizeConcurrency(stored.concurrency),
    channels,
    accounts: normalizeAccounts(stored)
  };
  if (!config.apiKey) config.apiKey = randomBytes(24).toString("hex");
  return config;
}

function redactAccount(account) {
  return {
    ...account,
    password: "",
    hasPassword: Boolean(account.password)
  };
}

export async function loadConfig() {
  const stored = await readJson(configFile, {});
  const config = normalizeConfig(stored);
  if (!stored.apiKey || !Array.isArray(stored.channels) || !Array.isArray(stored.accounts)) {
    await writeJson(configFile, config);
  }
  return config;
}

export async function saveConfig(nextConfig) {
  const current = await loadConfig();
  const merged = normalizeConfig({
    ...current,
    ...nextConfig,
    updatedAt: new Date().toISOString()
  });
  await writeJson(configFile, merged);
  return merged;
}

export function publicConfig(config) {
  return {
    mainBaseUrl: config.mainBaseUrl,
    drawingBaseUrl: config.drawingBaseUrl,
    apiKey: config.apiKey,
    defaultChannel: config.defaultChannel,
    defaultModelId: config.defaultModelId,
    defaultRatio: config.defaultRatio,
    defaultImageCount: config.defaultImageCount,
    waitTimeoutSec: config.waitTimeoutSec,
    imageStorage: config.imageStorage,
    concurrency: config.concurrency,
    channels: config.channels,
    accounts: config.accounts.map(redactAccount),
    updatedAt: config.updatedAt || null
  };
}

export async function saveChannel(channelId, patch) {
  const config = await loadConfig();
  const id = String(channelId || patch.id || `channel-${randomUUID()}`);
  const index = config.channels.findIndex((channel) => channel.id === id);
  const current = index >= 0 ? config.channels[index] : {};
  const next = {
    ...current,
    ...patch,
    id,
    enabled: patch.enabled !== false,
    priority: Number(patch.priority || current.priority || config.channels.length + 1),
    settings: { ...(current.settings || {}), ...(patch.settings || {}) }
  };
  const channels = [...config.channels];
  if (index >= 0) channels[index] = next;
  else channels.push(next);
  return saveConfig({ channels });
}

export async function removeChannel(channelId) {
  const config = await loadConfig();
  return saveConfig({
    channels: config.channels.filter((channel) => channel.id !== channelId),
    accounts: config.accounts.filter((account) => account.channelId !== channelId),
    defaultChannel: config.defaultChannel === channelId ? "auto" : config.defaultChannel
  });
}

export async function saveAccount(accountInput) {
  const config = await loadConfig();
  const accounts = [...config.accounts];
  const index = accounts.findIndex((account) => account.id === accountInput.id);
  const current = index >= 0 ? accounts[index] : {};
  const next = {
    ...current,
    ...accountInput,
    id: accountInput.id || `account-${randomUUID()}`,
    enabled: accountInput.enabled !== false,
    priority: Number(accountInput.priority || current.priority || 1),
    routingWeight: normalizeRoutingWeight(accountInput.routingWeight ?? current.routingWeight)
  };
  if (!accountInput.password && current.password) next.password = current.password;
  if (index >= 0) accounts[index] = next;
  else accounts.push(next);
  return saveConfig({ accounts });
}

export async function removeAccount(accountId) {
  const config = await loadConfig();
  return saveConfig({ accounts: config.accounts.filter((account) => account.id !== accountId) });
}

export async function updateAccountStatus(accountId, statusPatch) {
  const config = await loadConfig();
  const accounts = config.accounts.map((account) =>
    account.id === accountId
      ? { ...account, ...statusPatch, lastCheckAt: new Date().toISOString() }
      : account
  );
  await saveConfig({ accounts });
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function limitTasks(tasks) {
  return sortTasks(tasks).slice(0, taskHistoryLimit);
}

async function loadTasks() {
  const tasks = await readJson(tasksFile, []);
  const limited = limitTasks(tasks);
  if (limited.length !== tasks.length) await writeJson(tasksFile, limited);
  return limited;
}

export async function listTasks() {
  return loadTasks();
}

export async function upsertTask(task) {
  const tasks = await loadTasks();
  const index = tasks.findIndex((item) => String(item.id) === String(task.id));
  const next = {
    ...task,
    updatedAt: new Date().toISOString()
  };
  const stored = index >= 0
    ? { ...tasks[index], ...next }
    : { ...next, createdAt: task.createdAt || new Date().toISOString() };
  if (index >= 0) tasks[index] = stored;
  else tasks.push(stored);
  await writeJson(tasksFile, limitTasks(tasks));
  return stored;
}

export async function getTask(id) {
  const tasks = await loadTasks();
  return tasks.find((task) => String(task.id) === String(id)) || null;
}

function finalStatStatus(status) {
  if (status === "success" || status === "failed") return status;
  return "";
}

function dateKeyInShanghai(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function taskStatTime(task) {
  const time = Date.parse(task.completedAt || task.updatedAt || task.createdAt || "");
  return Number.isFinite(time) ? time : Date.now();
}

function taskStatChannelGroup(task) {
  if (task?.channelType === "drawing") return "drawing";
  if (task?.channelType === "chatplus") return "chatplus";
  const text = `${task?.channelName || ""} ${task?.channelId || ""}`;
  if (/绘图站|drawing/i.test(text)) return "drawing";
  if (/聊天|chatplus/i.test(text)) return "chatplus";
  return "other";
}

function taskGeneratedImageCount(task) {
  const urls = Array.isArray(task?.imageUrls) ? task.imageUrls.filter(Boolean).length : 0;
  if (urls) return urls;
  if (task?.status === "success" && task?.taskType !== "chat") return Number(task.imageCount || 0) || 0;
  return 0;
}

function taskStatRecord(task) {
  const status = finalStatStatus(task?.status);
  if (!status || !task?.id) return null;
  const time = taskStatTime(task);
  return {
    taskId: String(task.id),
    day: dateKeyInShanghai(time),
    time,
    status,
    taskType: task.taskType || "",
    accountId: task.accountId || "",
    accountName: task.accountName || "",
    channelId: task.channelId || "",
    channelName: task.channelName || "",
    channelType: task.channelType || "",
    channelGroup: taskStatChannelGroup(task),
    tasks: 1,
    successImages: status === "success" ? taskGeneratedImageCount(task) : 0,
    failedTasks: status === "failed" ? 1 : 0
  };
}

function normalizeStats(stats = {}) {
  return {
    version: 1,
    updatedAt: stats.updatedAt || null,
    records: stats.records && typeof stats.records === "object" ? stats.records : {}
  };
}

function pruneStats(stats) {
  const cutoff = Date.now() - statRecordDays * 24 * 60 * 60 * 1000;
  const records = Object.values(stats.records || {})
    .filter((record) => Number(record.time || 0) >= cutoff)
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, statRecordLimit);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: Object.fromEntries(records.map((record) => [record.taskId, record]))
  };
}

async function withStatsLock(work) {
  const run = statsWriteQueue.then(work, work);
  statsWriteQueue = run.catch(() => {});
  return run;
}

async function loadStats() {
  return normalizeStats(await readJson(statsFile, { version: 1, records: {} }));
}

async function seedStatsFromTasks(stats) {
  if (Object.keys(stats.records || {}).length) return stats;
  const tasks = await loadTasks();
  for (const task of tasks) {
    const record = taskStatRecord(task);
    if (record) stats.records[record.taskId] = record;
  }
  const next = pruneStats(stats);
  await writeJson(statsFile, next);
  return next;
}

export async function recordTaskStat(task) {
  const record = taskStatRecord(task);
  if (!record) return null;
  return withStatsLock(async () => {
    const stats = await loadStats();
    stats.records[record.taskId] = record;
    const next = pruneStats(stats);
    await writeJson(statsFile, next);
    return record;
  });
}

export async function listTaskStats() {
  return withStatsLock(async () => {
    const stats = await seedStatsFromTasks(await loadStats());
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
      updatedAt: stats.updatedAt || null,
      records: Object.values(stats.records || {})
        .filter((record) => Number(record.time || 0) >= cutoff)
        .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    };
  });
}
