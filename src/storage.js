import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "data");
const configFile = path.join(dataDir, "config.json");
const tasksFile = path.join(dataDir, "tasks.json");
const statsFile = path.join(dataDir, "stats.json");
const runtimeStatsFile = path.join(dataDir, "runtime-stats.json");
const databaseFile = path.join(dataDir, "storage.sqlite");
const taskHistoryDays = 2;
const taskHistoryLimit = 50000;
const statRecordDays = 31;
const dailyStatDays = 30;
const imageTaskTypes = new Set(["text2img", "img2img"]);
const statRecordLimit = 50000;
const intradayIntervalMinutes = 30;
let statsWriteQueue = Promise.resolve();
let runtimeStatsWriteQueue = Promise.resolve();
let tasksWriteQueue = Promise.resolve();
let configWriteQueue = Promise.resolve();
let statsRevision = 0;
let statsSnapshot = null;
const intradayStatsCache = new Map();
let tasksLoadPromise = null;
let storageDatabase = null;
let storageDatabasePromise = null;
let tasksSnapshot = {
  ready: false,
  tasks: [],
  queryCache: new Map(),
  searchTextCache: new WeakMap()
};

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
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "balanced", carTier: "auto", enabled: true, default: true },
  { key: "grok", name: "Grok", carType: "grok", model: "", strategy: "balanced", carTier: "auto", enabled: true, default: false },
  { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", carTier: "auto", enabled: true, default: false }
];

const defaultShareAISettings = {
  mainBaseUrl: "https://ikun.aishare.icu",
  drawingBaseUrl: "https://drawing.aishare.icu",
  chatBaseUrl: "https://www.chatplus.cc",
  enabledAbilities: { drawing: true, chatplus: true },
  defaultModelId: 1,
  geminiDrawingModelId: 2,
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
  imageSourcePriority: "chatplus",
  waitTimeoutSec: 300,
  waitTimeoutVersion: 2,
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

function storageTaskId(task = {}) {
  return String(task.id || taskSourceTaskId(task) || randomUUID()).trim();
}

function writeTaskRow(database, task) {
  const stored = {
    ...task,
    id: storageTaskId(task)
  };
  database.prepare(`
    INSERT INTO tasks (
      id, source_task_id, created_at, created_time, status, payload
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_task_id = excluded.source_task_id,
      created_at = excluded.created_at,
      created_time = excluded.created_time,
      status = excluded.status,
      payload = excluded.payload
  `).run(
    stored.id,
    taskSourceTaskId(stored),
    String(stored.createdAt || stored.updatedAt || new Date().toISOString()),
    taskHistoryTime(stored) ?? Date.now(),
    taskStatus(stored),
    JSON.stringify(stored)
  );
  return stored;
}

function writeTaskStatRow(database, record) {
  database.prepare(`
    INSERT INTO task_stats (task_id, time, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      time = excluded.time,
      payload = excluded.payload
  `).run(record.taskId, Number(record.time || Date.now()), JSON.stringify(record));
}

function setStorageMeta(database, key, value) {
  database.prepare(`
    INSERT INTO storage_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ""));
}

function getStorageMeta(database, key) {
  return database.prepare("SELECT value FROM storage_meta WHERE key = ?").pluck().get(key) || "";
}

function removeTaskRows(database, tasks = []) {
  if (!tasks.length) return;
  const remove = database.prepare("DELETE FROM tasks WHERE id = ?");
  database.transaction((items) => {
    for (const task of items) remove.run(String(task.id || ""));
  })(tasks);
}

function pruneTaskStatRows(database, now = Date.now()) {
  const cutoff = now - statRecordDays * 24 * 60 * 60 * 1000;
  database.prepare("DELETE FROM task_stats WHERE time < ?").run(cutoff);
  database.prepare(`
    DELETE FROM task_stats
    WHERE task_id NOT IN (
      SELECT task_id
      FROM task_stats
      ORDER BY time DESC
      LIMIT ?
    )
  `).run(statRecordLimit);
}

async function migrateLegacyStorage(database) {
  const taskCount = database.prepare("SELECT COUNT(*) FROM tasks").pluck().get();
  if (taskCount === 0) {
    const legacyTasks = limitTasks(await readJson(tasksFile, []));
    const insertTasks = database.transaction((tasks) => {
      for (const task of tasks) writeTaskRow(database, task);
    });
    insertTasks(legacyTasks);
    setStorageMeta(database, "tasks_migrated_at", new Date().toISOString());
  }

  const statCount = database.prepare("SELECT COUNT(*) FROM task_stats").pluck().get();
  if (statCount === 0) {
    const legacyStats = normalizeStats(await readJson(statsFile, { version: 1, records: {} }));
    const insertStats = database.transaction((records) => {
      for (const record of records) writeTaskStatRow(database, record);
    });
    insertStats(Object.values(legacyStats.records || {}));
    pruneTaskStatRows(database);
    setStorageMeta(
      database,
      "stats_updated_at",
      legacyStats.updatedAt || new Date().toISOString()
    );
    setStorageMeta(database, "stats_migrated_at", new Date().toISOString());
  }
}

async function openStorageDatabase() {
  await ensureDir();
  const database = new Database(databaseFile);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_source_task_id_idx
        ON tasks(source_task_id);
      CREATE INDEX IF NOT EXISTS tasks_created_time_idx
        ON tasks(created_time DESC);
      CREATE INDEX IF NOT EXISTS tasks_status_idx
        ON tasks(status);

      CREATE TABLE IF NOT EXISTS task_stats (
        task_id TEXT PRIMARY KEY,
        time INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_stats_time_idx
        ON task_stats(time DESC);

      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await migrateLegacyStorage(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function getStorageDatabase() {
  if (storageDatabase) return storageDatabase;
  if (!storageDatabasePromise) {
    storageDatabasePromise = openStorageDatabase()
      .then((database) => {
        storageDatabase = database;
        return database;
      })
      .finally(() => {
        storageDatabasePromise = null;
      });
  }
  return storageDatabasePromise;
}

export async function closeStorage() {
  await Promise.all([
    configWriteQueue.catch(() => {}),
    tasksWriteQueue.catch(() => {}),
    statsWriteQueue.catch(() => {}),
    runtimeStatsWriteQueue.catch(() => {})
  ]);

  const database = storageDatabase || await storageDatabasePromise?.catch(() => null);
  if (database?.open) {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
  }
  storageDatabase = null;
  storageDatabasePromise = null;
  tasksLoadPromise = null;
  statsSnapshot = null;
  intradayStatsCache.clear();
  tasksSnapshot = {
    ready: false,
    tasks: [],
    queryCache: new Map(),
    searchTextCache: new WeakMap()
  };
}

function normalizeChatModelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCarTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return ["auto", "pro", "ultra", "any"].includes(tier) ? tier : "auto";
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

function normalizeImageSourcePriority(value) {
  return value === "drawing" ? "drawing" : "chatplus";
}

function normalizeGeminiDrawingModelId(value) {
  const modelId = Number(value);
  return [2, 3].includes(modelId) ? modelId : 2;
}

function normalizeAccountConcurrency(value = {}, fallback = defaultConcurrency) {
  return normalizeConcurrency({
    chat: value.chat ?? fallback.chat,
    drawingImage: value.drawingImage ?? fallback.drawingImage,
    chatImage: value.chatImage ?? fallback.chatImage
  });
}

function normalizeWaitTimeout(stored = {}) {
  const value = Number(stored.waitTimeoutSec);
  const migrateLegacyDefault = stored.waitTimeoutVersion !== 2 && (!Number.isFinite(value) || value === 180);
  const seconds = migrateLegacyDefault || !Number.isFinite(value) || value <= 0 ? defaultConfig.waitTimeoutSec : value;
  return Math.min(3600, Math.max(30, Number.isFinite(seconds) ? seconds : defaultConfig.waitTimeoutSec));
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
      carTier: normalizeCarTier(item?.carTier || base.carTier),
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
  settings.geminiDrawingModelId = normalizeGeminiDrawingModelId(settings.geminiDrawingModelId);
  settings.autoCarSelection = true;
  settings.autoCarSelectionMigrated = true;
  settings.legacyChannelIds = {
    drawing: drawing?.id || "drawing",
    chatplus: chatplus?.id || "chatplus"
  };
  delete settings.baseUrl;
  delete settings.carId;
  delete settings.carType;
  delete settings.imageSourcePriority;

  return [{
    id: String(shareai?.id || "shareai"),
    name: shareai?.name || "ShareAI账号",
    type: "shareai",
    enabled: (shareai || drawing || chatplus)?.enabled !== false,
    priority: Number(shareai?.priority || Math.min(Number(drawing?.priority || 1), Number(chatplus?.priority || 1)) || 1),
    settings
  }];
}

function normalizeShareAISettings(channel = {}, legacy = {}) {
  const settings = {
    ...defaultShareAISettings,
    ...(channel?.settings || {})
  };
  const drawing = legacy.drawing || null;
  const chatplus = legacy.chatplus || null;

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
  settings.geminiDrawingModelId = normalizeGeminiDrawingModelId(settings.geminiDrawingModelId);
  settings.autoCarSelection = true;
  settings.autoCarSelectionMigrated = true;
  settings.enabledAbilities = {
    drawing: settings.enabledAbilities?.drawing !== false,
    chatplus: settings.enabledAbilities?.chatplus !== false
  };
  if (!settings.enabledAbilities.drawing && !settings.enabledAbilities.chatplus) {
    settings.enabledAbilities.chatplus = true;
  }
  settings.legacyChannelIds = {
    ...(settings.legacyChannelIds || {}),
    drawing: drawing?.id || settings.legacyChannelIds?.drawing || "drawing",
    chatplus: chatplus?.id || settings.legacyChannelIds?.chatplus || "chatplus"
  };
  delete settings.baseUrl;
  delete settings.carId;
  delete settings.carType;
  delete settings.imageSourcePriority;
  return settings;
}

function normalizeShareAIChannelEntry(channel = {}, index = 0, legacy = {}) {
  const drawing = legacy.drawing || null;
  const chatplus = legacy.chatplus || null;
  const legacyPriority = Math.min(Number(drawing?.priority || 99), Number(chatplus?.priority || 99));
  return {
    id: String(channel?.id || (index === 0 ? "shareai" : `shareai-${randomUUID()}`)),
    name: channel?.name || "ShareAI账号",
    type: "shareai",
    enabled: channel?.enabled !== false && drawing?.enabled !== false && chatplus?.enabled !== false,
    priority: Number(channel?.priority || (Number.isFinite(legacyPriority) ? legacyPriority : index + 1) || index + 1),
    settings: normalizeShareAISettings(channel, legacy)
  };
}

function normalizeChannels(channels = []) {
  const source = Array.isArray(channels) ? channels : [];
  const drawing = legacyChannelByType(source, "drawing");
  const chatplus = legacyChannelByType(source, "chatplus");
  const shareAIChannels = source.filter((channel) => channel?.type === "shareai");

  if (!shareAIChannels.length) {
    return [normalizeShareAIChannelEntry({ id: "shareai", name: "ShareAI账号" }, 0, { drawing, chatplus })];
  }

  return shareAIChannels.map((channel, index) =>
    normalizeShareAIChannelEntry(channel, index, index === 0 ? { drawing, chatplus } : {})
  );
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

function legacyChannelMap(stored, channels = []) {
  const map = new Map();
  const shareAIChannels = channels.filter((channel) => channel.type === "shareai");
  const primaryShareAI = shareAIChannels[0] || { id: "shareai" };

  for (const channel of shareAIChannels) {
    map.set(String(channel.id), { type: "shareai", channelId: channel.id });
  }
  for (const channel of Array.isArray(stored.channels) ? stored.channels : []) {
    if (!channel?.id || channel.type === "shareai") continue;
    if (channel.type === "drawing" || channel.type === "chatplus") {
      map.set(String(channel.id), { type: channel.type, channelId: primaryShareAI.id });
    }
  }
  map.set("shareai", { type: "shareai", channelId: primaryShareAI.id });
  map.set("drawing", { type: "drawing", channelId: primaryShareAI.id });
  map.set("chatplus", { type: "chatplus", channelId: primaryShareAI.id });
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
    String(account.channelId || "shareai"),
    String(account.username || "").trim().toLowerCase(),
    String(account.password || ""),
    String(account.proxyUrl || account.proxy || "").trim()
  ].join("::");
}

function mergeAccountIntoGroup(group, account, type) {
  const next = group || {
    id: account.id || `account-${randomUUID()}`,
    channelId: account.channelId || "shareai",
    name: "",
    username: account.username || "",
    password: account.password || "",
    proxyUrl: account.proxyUrl || account.proxy || "",
    enabled: account.enabled !== false,
    priority: Number(account.priority || 1),
    routingWeight: normalizeRoutingWeight(account.routingWeight),
    concurrency: normalizeAccountConcurrency(account.concurrency),
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
  if (type === "drawing") {
    next.concurrency.drawingImage = account.concurrency.drawingImage;
  } else if (type === "chatplus") {
    next.concurrency.chat = account.concurrency.chat;
    next.concurrency.chatImage = account.concurrency.chatImage;
  } else {
    next.concurrency = normalizeAccountConcurrency(account.concurrency, next.concurrency);
  }
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
    channelId: account.channelId || "shareai",
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
  const fallbackConcurrency = normalizeConcurrency(stored.concurrency);
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
      concurrency: normalizeAccountConcurrency(account.concurrency, fallbackConcurrency),
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

function normalizeAccountsForChannels(stored, channels = []) {
  const source = Array.isArray(stored.accounts) && stored.accounts.length ? stored.accounts : makeDefaultAccounts(stored);
  const channelMap = legacyChannelMap(stored, channels);
  const fallbackChannelId = channels.find((channel) => channel.type === "shareai")?.id || "shareai";
  const fallbackConcurrency = normalizeConcurrency(stored.concurrency);
  const groups = new Map();

  for (const account of source) {
    const mapped = channelMap.get(String(account.channelId || "shareai")) || { type: "shareai", channelId: fallbackChannelId };
    const normalized = {
      id: account.id || `account-${randomUUID()}`,
      channelId: mapped.channelId,
      name: account.name || "未命名账号",
      username: account.username || "",
      password: account.password || "",
      proxyUrl: account.proxyUrl || account.proxy || "",
      enabled: account.enabled !== false,
      priority: Number(account.priority || 1),
      routingWeight: normalizeRoutingWeight(account.routingWeight),
      concurrency: normalizeAccountConcurrency(account.concurrency, fallbackConcurrency),
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
    const key = accountGroupKey(normalized) || normalized.id;
    groups.set(key, mergeAccountIntoGroup(groups.get(key), normalized, mapped.type));
  }

  return [...groups.values()].map(finalizeShareAIAccount);
}

function normalizeConfig(stored = {}) {
  const channels = normalizeChannels(stored.channels);
  const defaultChannel = channels.some((channel) => channel.id === stored.defaultChannel) ? stored.defaultChannel : "auto";
  const config = {
    ...defaultConfig,
    ...stored,
    defaultChannel,
    imageSourcePriority: normalizeImageSourcePriority(stored.imageSourcePriority),
    imageStorage: normalizeImageStorage(stored.imageStorage),
    concurrency: normalizeConcurrency(stored.concurrency),
    waitTimeoutSec: normalizeWaitTimeout(stored),
    waitTimeoutVersion: 2,
    channels,
    accounts: normalizeAccountsForChannels(stored, channels)
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

export async function loadConfig({ waitForWrites = true } = {}) {
  if (waitForWrites) await configWriteQueue.catch(() => {});
  const stored = await readJson(configFile, {});
  const config = normalizeConfig(stored);
  if (
    !stored.apiKey
    || !Array.isArray(stored.channels)
    || !Array.isArray(stored.accounts)
    || stored.imageSourcePriority !== config.imageSourcePriority
    || stored.channels.some((channel) => Object.prototype.hasOwnProperty.call(channel?.settings || {}, "imageSourcePriority"))
    || stored.waitTimeoutVersion !== 2
    || Number(stored.waitTimeoutSec) !== config.waitTimeoutSec
  ) {
    await writeJson(configFile, config);
  }
  return config;
}

export async function saveConfig(nextConfig) {
  const write = configWriteQueue.catch(() => {}).then(async () => {
    const current = await loadConfig({ waitForWrites: false });
    const merged = normalizeConfig({
      ...current,
      ...nextConfig,
      updatedAt: new Date().toISOString()
    });
    await writeJson(configFile, merged);
    return merged;
  });
  configWriteQueue = write.catch(() => {});
  return write;
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
    imageSourcePriority: config.imageSourcePriority,
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
    routingWeight: normalizeRoutingWeight(accountInput.routingWeight ?? current.routingWeight),
    concurrency: normalizeAccountConcurrency(
      accountInput.concurrency,
      current.concurrency || config.concurrency
    )
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

function taskHistoryTime(task = {}) {
  const time = Date.parse(task.createdAt || task.updatedAt || task.completedAt || "");
  return Number.isFinite(time) ? time : null;
}

function taskStillActive(task = {}) {
  return ["processing", "queued", "pending", "unknown", "waiting_upstream"].includes(task.status);
}

function limitTasks(tasks) {
  const cutoff = Date.now() - taskHistoryDays * 24 * 60 * 60 * 1000;
  return sortTasks(tasks)
    .filter((task) => {
      const time = taskHistoryTime(task);
      return time === null || time >= cutoff || taskStillActive(task);
    })
    .slice(0, taskHistoryLimit);
}

function setTasksSnapshot(tasks) {
  tasksSnapshot = {
    ready: true,
    tasks,
    queryCache: new Map(),
    searchTextCache: new WeakMap()
  };
  return tasks;
}

async function loadTasksFromDatabase() {
  const database = await getStorageDatabase();
  const tasks = database.prepare(`
    SELECT payload
    FROM tasks
    ORDER BY created_time DESC
  `).all().map((row) => JSON.parse(row.payload));
  const limited = limitTasks(tasks);
  if (limited.length !== tasks.length) {
    const retainedIds = new Set(limited.map((task) => String(task.id || "")));
    removeTaskRows(
      database,
      tasks.filter((task) => !retainedIds.has(String(task.id || "")))
    );
  }
  return setTasksSnapshot(limited);
}

async function loadTasks({ waitForWrites = true } = {}) {
  if (waitForWrites) await tasksWriteQueue.catch(() => {});
  if (tasksSnapshot.ready) return tasksSnapshot.tasks;
  if (!tasksLoadPromise) {
    tasksLoadPromise = loadTasksFromDatabase().finally(() => {
      tasksLoadPromise = null;
    });
  }
  return tasksLoadPromise;
}

export async function listTasks() {
  return loadTasks();
}

const durableFinalTaskStatuses = new Set(["success", "failed"]);
const staleTaskStatuses = new Set(["processing", "queued", "pending", "unknown", "waiting_upstream", "interrupted"]);

function taskSourceTaskId(value = {}) {
  return String(
    value?.sourceTaskId
      || value?.requestMeta?.sourceTaskId
      || value?.requestJson?.sourceTaskId
      || value?.requestJson?.client_task_id
      || value?.responseJson?.sourceTaskId
      || ""
  ).trim();
}

function taskStatus(value) {
  return String(value?.status || "").trim().toLowerCase();
}

function normalizeTaskSearchKeyword(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, " ")
    .replace(/\s+/g, " ");
}

function taskSearchHaystack(task = {}, searchTextCache = null) {
  if (searchTextCache?.has(task)) return searchTextCache.get(task);
  const request = task.requestJson || {};
  const response = task.responseJson || {};
  const haystack = [
    task.id,
    task.externalId,
    taskSourceTaskId(task),
    task.prompt,
    task.accountName,
    task.channelName,
    task.errorMessage,
    response.message,
    JSON.stringify(request)
  ].filter(Boolean).join(" ").toLowerCase();
  if (searchTextCache) searchTextCache.set(task, haystack);
  return haystack;
}

function taskMatchesSearch(task, value, searchTextCache = null) {
  const keyword = normalizeTaskSearchKeyword(value);
  if (!keyword) return true;
  const haystack = taskSearchHaystack(task, searchTextCache);
  if (haystack.includes(keyword)) return true;
  const parts = keyword
    .split(/(?:\.{2,}|…|⋯|[\s,，;；:：]+)+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && (part.length >= 8 || /[_-]|\d/.test(part)));
  return parts.length > 0 && parts.every((part) => haystack.includes(part));
}

export async function listTaskPage({ page = 1, pageSize = 100, keyword = "", accountId = "", channel = "", status = "" } = {}) {
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  const normalizedPageSize = Math.min(500, Math.max(1, Math.floor(Number(pageSize) || 100)));
  const normalizedKeyword = normalizeTaskSearchKeyword(keyword);
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedStatus = String(status || "").trim().toLowerCase();

  const tasks = await loadTasks({ waitForWrites: false });
  const cacheKey = [
    normalizedKeyword,
    normalizedAccountId,
    normalizedChannel,
    normalizedStatus
  ].join("\u0000");
  let filtered = tasksSnapshot.queryCache.get(cacheKey);
  if (!filtered) {
    filtered = tasks.filter((task) => {
      if (normalizedAccountId && normalizedAccountId !== "all" && String(task.accountId || "") !== normalizedAccountId) return false;
      if (normalizedChannel && normalizedChannel !== "all" && taskStatChannelGroup(task) !== normalizedChannel) return false;
      if (normalizedStatus && normalizedStatus !== "all" && taskStatus(task) !== normalizedStatus) return false;
      return taskMatchesSearch(task, normalizedKeyword, tasksSnapshot.searchTextCache);
    });
    tasksSnapshot.queryCache.set(cacheKey, filtered);
  }
  const total = filtered.length;
  const pageCount = Math.ceil(total / normalizedPageSize);
  const normalizedPage = Math.min(requestedPage, Math.max(1, pageCount));
  const start = (normalizedPage - 1) * normalizedPageSize;

  return {
    items: filtered.slice(start, start + normalizedPageSize),
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    pageCount,
    hasMore: start + normalizedPageSize < total
  };
}

function shouldKeepStoredTask(current, incoming) {
  const currentStatus = taskStatus(current);
  const incomingStatus = taskStatus(incoming);
  if (currentStatus === "success" && incomingStatus !== "success") return true;
  if (currentStatus === "failed" && staleTaskStatuses.has(incomingStatus)) return true;
  if (!durableFinalTaskStatuses.has(currentStatus)) return false;
  if (incomingStatus === currentStatus) return false;
  return false;
}

function taskIdentityIndex(tasks, task) {
  const id = String(task?.id || "").trim();
  if (id) {
    const idIndex = tasks.findIndex((item) => String(item.id) === id);
    if (idIndex >= 0) return idIndex;
  }
  const sourceTaskId = taskSourceTaskId(task);
  return sourceTaskId
    ? tasks.findIndex((item) => taskSourceTaskId(item) === sourceTaskId)
    : -1;
}

export async function upsertTask(task) {
  const write = tasksWriteQueue.catch(() => {}).then(async () => {
    const tasks = [...await loadTasks({ waitForWrites: false })];
    const index = taskIdentityIndex(tasks, task);
    const next = {
      ...task,
      updatedAt: new Date().toISOString()
    };
    if (index >= 0 && shouldKeepStoredTask(tasks[index], next)) return tasks[index];
    const storedCandidate = index >= 0
      ? { ...tasks[index], ...next, id: tasks[index].id || next.id }
      : { ...next, createdAt: task.createdAt || new Date().toISOString() };
    const stored = {
      ...storedCandidate,
      id: storageTaskId(storedCandidate)
    };
    if (index >= 0) tasks[index] = stored;
    else tasks.push(stored);
    const limited = limitTasks(tasks);
    const database = await getStorageDatabase();
    writeTaskRow(database, stored);
    if (limited.length !== tasks.length) {
      const retainedIds = new Set(limited.map((item) => String(item.id || "")));
      removeTaskRows(
        database,
        tasks.filter((item) => !retainedIds.has(String(item.id || "")))
      );
    }
    setTasksSnapshot(limited);
    return stored;
  });
  tasksWriteQueue = write.catch(() => {});
  return write;
}

export async function getTask(id) {
  const tasks = await loadTasks();
  return tasks.find((task) => String(task.id) === String(id)) || null;
}

export async function getTaskBySourceTaskId(sourceTaskId) {
  const normalized = String(sourceTaskId || "").trim();
  if (!normalized) return null;
  const tasks = await loadTasks();
  return tasks.find((task) => taskSourceTaskId(task) === normalized) || null;
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

function taskStatDuration(task, status) {
  if (status !== "success") return null;
  const start = Date.parse(task?.createdAt || "");
  const end = Date.parse(task?.completedAt || task?.updatedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
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
    failedTasks: status === "failed" ? 1 : 0,
    durationMs: taskStatDuration(task, status)
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

export function summarizeDailyTaskStats(records = [], days = dailyStatDays, now = Date.now()) {
  const rangeDays = Math.min(statRecordDays, Math.max(1, Math.floor(Number(days) || dailyStatDays)));
  const dayKeys = Array.from({ length: rangeDays }, (_, index) => (
    dateKeyInShanghai(now - (rangeDays - index - 1) * 24 * 60 * 60 * 1000)
  ));
  const visibleDays = new Set(dayKeys);
  const grouped = new Map();

  for (const record of records) {
    if (!imageTaskTypes.has(record?.taskType)) continue;
    const day = record?.day || dateKeyInShanghai(record?.time);
    if (!visibleDays.has(day)) continue;
    const accountId = String(record?.accountId || "");
    const channelGroup = String(record?.channelGroup || "other");
    const key = `${day}\u0000${accountId}\u0000${channelGroup}`;
    const current = grouped.get(key) || {
      day,
      accountId,
      accountName: record?.accountName || "",
      channelGroup,
      tasks: 0,
      successTasks: 0,
      failedTasks: 0,
      successImages: 0,
      durationMsTotal: 0,
      durationSamples: 0
    };
    const taskCount = Math.max(0, Number(record?.tasks || 1) || 0);
    current.tasks += taskCount;
    if (record?.status === "success") {
      current.successTasks += taskCount;
      current.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
      const durationMs = Number(record?.durationMs);
      if (Number.isFinite(durationMs) && durationMs >= 0 && record?.durationMs !== null) {
        current.durationMsTotal += durationMs;
        current.durationSamples += 1;
      }
    } else if (record?.status === "failed") {
      current.failedTasks += Math.max(0, Number(record?.failedTasks || taskCount) || 0);
    }
    grouped.set(key, current);
  }

  return {
    days: dayKeys,
    records: [...grouped.values()]
      .map((record) => ({
        ...record,
        averageDurationMs: record.durationSamples
          ? Math.round(record.durationMsTotal / record.durationSamples)
          : null
      }))
      .sort((a, b) => (
        a.day.localeCompare(b.day)
        || a.accountId.localeCompare(b.accountId)
        || a.channelGroup.localeCompare(b.channelGroup)
      ))
  };
}

export function summarizeRecentTaskStats(records = [], days = 7, now = Date.now()) {
  const rangeDays = Math.min(statRecordDays, Math.max(1, Math.floor(Number(days) || 7)));
  const visibleDays = new Set(Array.from({ length: rangeDays }, (_, index) => (
    dateKeyInShanghai(now - index * 24 * 60 * 60 * 1000)
  )));
  const grouped = new Map();

  for (const record of records) {
    const status = finalStatStatus(record?.status);
    const day = record?.day || dateKeyInShanghai(record?.time);
    if (!status || !visibleDays.has(day)) continue;
    const accountId = String(record?.accountId || "");
    const channelGroup = String(record?.channelGroup || "other");
    const taskType = String(record?.taskType || "");
    const key = `${day}\u0000${accountId}\u0000${channelGroup}\u0000${taskType}\u0000${status}`;
    const current = grouped.get(key) || {
      day,
      status,
      taskType,
      accountId,
      accountName: record?.accountName || "",
      channelId: record?.channelId || "",
      channelName: record?.channelName || "",
      channelType: record?.channelType || "",
      channelGroup,
      tasks: 0,
      successImages: 0,
      failedTasks: 0
    };
    const taskCount = Math.max(0, Number(record?.tasks || 1) || 0);
    current.tasks += taskCount;
    current.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
    current.failedTasks += Math.max(0, Number(record?.failedTasks || (status === "failed" ? taskCount : 0)) || 0);
    grouped.set(key, current);
  }

  return [...grouped.values()].sort((a, b) => (
    b.day.localeCompare(a.day)
    || a.accountId.localeCompare(b.accountId)
    || a.channelGroup.localeCompare(b.channelGroup)
    || a.taskType.localeCompare(b.taskType)
    || a.status.localeCompare(b.status)
  ));
}

function intradayTargetDay(value, now = Date.now()) {
  const day = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dateKeyInShanghai(now);
}

function minutesInShanghai(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function intradayTimeLabel(totalMinutes) {
  const minutes = Math.max(0, Math.min(24 * 60, totalMinutes));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function summarizeIntradayTaskStats(records = [], day, now = Date.now()) {
  const targetDay = intradayTargetDay(day, now);
  const bucketCount = 24 * 60 / intradayIntervalMinutes;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const startMinute = index * intradayIntervalMinutes;
    return {
      index,
      startMinute,
      start: intradayTimeLabel(startMinute),
      end: intradayTimeLabel(startMinute + intradayIntervalMinutes),
      tasks: 0,
      successTasks: 0,
      failedTasks: 0,
      successImages: 0,
      accountIds: new Set()
    };
  });

  for (const record of records) {
    if (!imageTaskTypes.has(record?.taskType)) continue;
    const recordDay = record?.day || dateKeyInShanghai(record?.time);
    if (recordDay !== targetDay) continue;
    const minute = minutesInShanghai(record?.time);
    if (minute === null) continue;
    const bucket = buckets[Math.min(bucketCount - 1, Math.floor(minute / intradayIntervalMinutes))];
    const taskCount = Math.max(0, Number(record?.tasks || 1) || 0);
    bucket.tasks += taskCount;
    if (record?.status === "success") {
      bucket.successTasks += taskCount;
      bucket.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
    } else if (record?.status === "failed") {
      bucket.failedTasks += Math.max(0, Number(record?.failedTasks || taskCount) || 0);
    }
    const accountId = String(record?.accountId || record?.accountName || "").trim();
    if (taskCount > 0 && accountId) bucket.accountIds.add(accountId);
  }

  const normalizedBuckets = buckets.map((bucket) => ({
    index: bucket.index,
    startMinute: bucket.startMinute,
    start: bucket.start,
    end: bucket.end,
    tasks: bucket.tasks,
    successTasks: bucket.successTasks,
    failedTasks: bucket.failedTasks,
    successImages: bucket.successImages,
    accountCount: bucket.accountIds.size,
    successRate: bucket.tasks ? Number((bucket.successTasks / bucket.tasks * 100).toFixed(1)) : null
  }));
  const peak = normalizedBuckets.reduce((best, bucket) => (
    bucket.successImages > best.successImages ? bucket : best
  ), normalizedBuckets[0]);

  return {
    day: targetDay,
    intervalMinutes: intradayIntervalMinutes,
    totalImages: normalizedBuckets.reduce((sum, bucket) => sum + bucket.successImages, 0),
    totalTasks: normalizedBuckets.reduce((sum, bucket) => sum + bucket.tasks, 0),
    failedTasks: normalizedBuckets.reduce((sum, bucket) => sum + bucket.failedTasks, 0),
    peak: peak?.successImages > 0 ? {
      start: peak.start,
      end: peak.end,
      successImages: peak.successImages
    } : null,
    buckets: normalizedBuckets
  };
}

function normalizeRuntimeStats(stats = {}) {
  return {
    version: 1,
    updatedAt: stats.updatedAt || null,
    days: stats.days && typeof stats.days === "object" ? stats.days : {}
  };
}

function runtimeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function mergeRuntimeStatSample(stats = {}, sample = {}) {
  const next = normalizeRuntimeStats(stats);
  const time = Number.isFinite(Number(sample.time)) ? Number(sample.time) : Date.now();
  const day = dateKeyInShanghai(time);
  const running = runtimeNumber(sample.running);
  const configured = runtimeNumber(sample.configured);
  const available = runtimeNumber(sample.available);
  const current = next.days[day] || {
    day,
    samples: 0,
    runningTotal: 0,
    peakRunning: 0,
    configuredTotal: 0,
    availableTotal: 0,
    firstSampleAt: time,
    lastSampleAt: time
  };
  current.samples += 1;
  current.runningTotal += running;
  current.peakRunning = Math.max(runtimeNumber(current.peakRunning), running);
  current.configuredTotal += configured;
  current.availableTotal += available;
  current.firstSampleAt = Math.min(Number(current.firstSampleAt || time), time);
  current.lastSampleAt = Math.max(Number(current.lastSampleAt || time), time);
  next.days[day] = current;
  next.updatedAt = new Date(time).toISOString();
  return next;
}

function pruneRuntimeStats(stats, now = Date.now()) {
  const visibleDays = new Set(Array.from({ length: statRecordDays }, (_, index) => (
    dateKeyInShanghai(now - index * 24 * 60 * 60 * 1000)
  )));
  return {
    version: 1,
    updatedAt: stats.updatedAt || new Date(now).toISOString(),
    days: Object.fromEntries(Object.entries(stats.days || {}).filter(([day]) => visibleDays.has(day)))
  };
}

export function summarizeDailyRuntimeStats(stats = {}, days = dailyStatDays, now = Date.now()) {
  const rangeDays = Math.min(statRecordDays, Math.max(1, Math.floor(Number(days) || dailyStatDays)));
  const dayKeys = Array.from({ length: rangeDays }, (_, index) => (
    dateKeyInShanghai(now - (rangeDays - index - 1) * 24 * 60 * 60 * 1000)
  ));
  const source = normalizeRuntimeStats(stats).days;
  return {
    updatedAt: stats.updatedAt || null,
    days: dayKeys.map((day) => {
      const record = source[day];
      const samples = Math.max(0, Number(record?.samples || 0) || 0);
      if (!samples) return { day, samples: 0 };
      return {
        day,
        samples,
        averageRunning: Number((runtimeNumber(record.runningTotal) / samples).toFixed(2)),
        peakRunning: runtimeNumber(record.peakRunning),
        averageConfigured: Number((runtimeNumber(record.configuredTotal) / samples).toFixed(2)),
        averageAvailable: Number((runtimeNumber(record.availableTotal) / samples).toFixed(2)),
        firstSampleAt: Number(record.firstSampleAt || 0) || null,
        lastSampleAt: Number(record.lastSampleAt || 0) || null
      };
    })
  };
}

async function loadRuntimeStats() {
  return normalizeRuntimeStats(await readJson(runtimeStatsFile, { version: 1, days: {} }));
}

export async function recordRuntimeStat(sample) {
  const work = async () => {
    const next = pruneRuntimeStats(mergeRuntimeStatSample(await loadRuntimeStats(), sample));
    await writeJson(runtimeStatsFile, next);
    return next.days[dateKeyInShanghai(sample?.time)];
  };
  const run = runtimeStatsWriteQueue.then(work, work);
  runtimeStatsWriteQueue = run.catch(() => {});
  return run;
}

async function withStatsLock(work) {
  const run = statsWriteQueue.then(work, work);
  statsWriteQueue = run.catch(() => {});
  return run;
}

async function loadStats() {
  if (statsSnapshot) return statsSnapshot;
  const database = await getStorageDatabase();
  const records = database.prepare(`
    SELECT payload
    FROM task_stats
    ORDER BY time DESC
  `).all().map((row) => JSON.parse(row.payload));
  statsSnapshot = normalizeStats({
    updatedAt: getStorageMeta(database, "stats_updated_at") || null,
    records: Object.fromEntries(records.map((record) => [record.taskId, record]))
  });
  return statsSnapshot;
}

async function seedStatsFromTasks(stats) {
  if (Object.keys(stats.records || {}).length) return stats;
  const tasks = await loadTasks();
  const records = [];
  for (const task of tasks) {
    const record = taskStatRecord(task);
    if (record) records.push(record);
  }
  const database = await getStorageDatabase();
  database.transaction((items) => {
    for (const record of items) writeTaskStatRow(database, record);
    pruneTaskStatRows(database);
    setStorageMeta(database, "stats_updated_at", new Date().toISOString());
  })(records);
  statsSnapshot = null;
  return loadStats();
}

async function loadTaskStatsSnapshot() {
  const stats = await loadStats();
  if (Object.keys(stats.records || {}).length) return stats;
  return withStatsLock(async () => seedStatsFromTasks(await loadStats()));
}

export async function recordTaskStat(task) {
  const record = taskStatRecord(task);
  if (!record) return null;
  return withStatsLock(async () => {
    const database = await getStorageDatabase();
    database.transaction(() => {
      writeTaskStatRow(database, record);
      pruneTaskStatRows(database);
      setStorageMeta(database, "stats_updated_at", new Date().toISOString());
    })();
    statsSnapshot = null;
    statsRevision += 1;
    intradayStatsCache.clear();
    return record;
  });
}

export async function listIntradayTaskStats(day) {
  const targetDay = intradayTargetDay(day);
  const cached = intradayStatsCache.get(targetDay);
  if (cached) return { ...cached, generatedAt: new Date().toISOString() };
  const revision = statsRevision;
  const stats = await loadTaskStatsSnapshot();
  const records = Object.values(stats.records || {});
  const intraday = summarizeIntradayTaskStats(records, targetDay);
  const targetTimestamp = Date.parse(`${targetDay}T12:00:00+08:00`);
  const daily = summarizeDailyTaskStats(records, 1, targetTimestamp);
  const result = {
    ...intraday,
    updatedAt: stats.updatedAt || null,
    dailyRecords: daily.records
  };
  if (revision === statsRevision) intradayStatsCache.set(targetDay, result);
  return { ...result, generatedAt: new Date().toISOString() };
}

export async function listTaskStats() {
  const [stats, runtimeStats] = await Promise.all([loadTaskStatsSnapshot(), loadRuntimeStats()]);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const records = Object.values(stats.records || {});
  return {
    updatedAt: stats.updatedAt || null,
    records: records
      .filter((record) => Number(record.time || 0) >= cutoff)
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0)),
    daily: summarizeDailyTaskStats(records),
    concurrency: summarizeDailyRuntimeStats(runtimeStats)
  };
}

export async function listTaskStatsSummary() {
  const [stats, runtimeStats] = await Promise.all([loadTaskStatsSnapshot(), loadRuntimeStats()]);
  const records = Object.values(stats.records || {});
  return {
    updatedAt: stats.updatedAt || null,
    records: summarizeRecentTaskStats(records),
    daily: summarizeDailyTaskStats(records),
    concurrency: summarizeDailyRuntimeStats(runtimeStats)
  };
}
