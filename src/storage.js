import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { normalizeProxyUrl, safeProxyEndpoint } from "./proxy.js";
import { normalizeQuotaProtectionSettings } from "./quota-protection.js";

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
const accountImportLimit = 500;
const proxyBatchLimit = 500;
let statsWriteQueue = Promise.resolve();
let runtimeStatsWriteQueue = Promise.resolve();
let tasksWriteQueue = Promise.resolve();
let configWriteQueue = Promise.resolve();
let statsRevision = 0;
let statsSnapshot = null;
const intradayStatsCache = new Map();
let todayAccountRoutingUsageCache = null;
let tasksLoadPromise = null;
let storageDatabase = null;
let storageDatabasePromise = null;
let tasksSnapshot = {
  ready: false,
  tasks: []
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
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "", strategy: "balanced", carTier: "auto", enabled: true, default: true },
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
  quotaProtection: normalizeQuotaProtectionSettings(),
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, file);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code) || attempt >= 4) throw error;
      await delay(20 * (2 ** attempt));
    }
  }
}

function storageTaskId(task = {}) {
  return String(task.id || taskSourceTaskId(task) || randomUUID()).trim();
}

function writeTaskRow(database, task) {
  const stored = {
    ...task,
    id: storageTaskId(task)
  };
  const listColumns = taskListColumnValues(stored);
  database.prepare(`
    INSERT INTO tasks (
      id, source_task_id, created_at, created_time, status,
      account_id, channel_id, channel_group, record_kind, list_status, search_text,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_task_id = excluded.source_task_id,
      created_at = excluded.created_at,
      created_time = excluded.created_time,
      status = excluded.status,
      account_id = excluded.account_id,
      channel_id = excluded.channel_id,
      channel_group = excluded.channel_group,
      record_kind = excluded.record_kind,
      list_status = excluded.list_status,
      search_text = excluded.search_text,
      payload = excluded.payload
  `).run(
    stored.id,
    taskSourceTaskId(stored),
    String(stored.createdAt || stored.updatedAt || new Date().toISOString()),
    taskHistoryTime(stored) ?? Date.now(),
    taskStatus(stored),
    listColumns.accountId,
    listColumns.channelId,
    listColumns.channelGroup,
    listColumns.recordKind,
    listColumns.listStatus,
    listColumns.searchText,
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

function ensureTaskListColumns(database) {
  const existing = new Set(database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
  const columns = [
    ["account_id", "TEXT NOT NULL DEFAULT ''"],
    ["channel_id", "TEXT NOT NULL DEFAULT ''"],
    ["channel_group", "TEXT NOT NULL DEFAULT ''"],
    ["record_kind", "TEXT NOT NULL DEFAULT ''"],
    ["list_status", "TEXT NOT NULL DEFAULT ''"],
    ["search_text", "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [name, definition] of columns) {
    if (!existing.has(name)) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }

  const pending = database.prepare(`
    SELECT id, payload
    FROM tasks
    WHERE record_kind = '' OR list_status = '' OR search_text = ''
  `).all();
  if (!pending.length) return;
  const update = database.prepare(`
    UPDATE tasks
    SET account_id = ?, channel_id = ?, channel_group = ?, record_kind = ?, list_status = ?, search_text = ?
    WHERE id = ?
  `);
  database.transaction((rows) => {
    for (const row of rows) {
      let task;
      try {
        task = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const values = taskListColumnValues(task);
      update.run(
        values.accountId,
        values.channelId,
        values.channelGroup,
        values.recordKind,
        values.listStatus,
        values.searchText,
        row.id
      );
    }
  })(pending);
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
        account_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
        channel_group TEXT NOT NULL DEFAULT '',
        record_kind TEXT NOT NULL DEFAULT '',
        list_status TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
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
    ensureTaskListColumns(database);
    database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_record_kind_time_idx
        ON tasks(record_kind, created_time DESC);
      CREATE INDEX IF NOT EXISTS tasks_account_time_idx
        ON tasks(account_id, created_time DESC);
      CREATE INDEX IF NOT EXISTS tasks_channel_time_idx
        ON tasks(channel_id, created_time DESC);
      CREATE INDEX IF NOT EXISTS tasks_channel_group_time_idx
        ON tasks(channel_group, created_time DESC);
      CREATE INDEX IF NOT EXISTS tasks_list_status_time_idx
        ON tasks(list_status, created_time DESC);
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
  todayAccountRoutingUsageCache = null;
  tasksSnapshot = {
    ready: false,
    tasks: []
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
    const configuredModel = String(item?.model || (key === "gpt" ? legacy.model : base.model || "")).trim();
    return {
      key,
      name: String(item?.name || base.name || key).trim(),
      carType: String(item?.carType || (key === "gpt" ? legacy.carType : base.carType || "")).trim(),
      model: key === "gpt" && normalizeChatModelKey(configuredModel) === "gpt-5-5-instant" ? "" : configuredModel,
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
  settings.quotaProtection = normalizeQuotaProtectionSettings(settings.quotaProtection);
  settings.autoCarSelection = true;
  settings.autoCarSelectionMigrated = true;
  settings.legacyChannelIds = {
    drawing: drawing?.id || "drawing",
    chatplus: chatplus?.id || "chatplus"
  };
  delete settings.baseUrl;
  delete settings.carId;
  delete settings.carType;
  delete settings.model;
  delete settings.defaultModel;
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
  settings.quotaProtection = normalizeQuotaProtectionSettings(settings.quotaProtection);
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
  delete settings.model;
  delete settings.defaultModel;
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
  const subscriptionExpired = [drawing.status, chatplus.status].includes("subscription_expired");
  const activationRequired = [drawing.status, chatplus.status].includes("activation_required")
    || account.meta?.registration?.status === "activation_required";
  const disconnected = [drawing.status, chatplus.status].includes("disconnected");
  const ok = [drawing.status, chatplus.status].includes("ok");
  const failed = [drawing.status, chatplus.status].some((status) => ["error", "failed"].includes(status));
  const quotaEmpty = [drawing.status, chatplus.status].includes("quota_empty");
  return {
    ...account,
    channelId: account.channelId || "shareai",
    name: account.name || account.username || "ShareAI账号",
    status: subscriptionExpired ? "subscription_expired" : activationRequired ? "activation_required" : disconnected ? "disconnected" : failed ? "error" : ok ? "ok" : quotaEmpty ? "quota_empty" : account.status || "unknown",
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

function updateConfig(buildPatch) {
  const write = configWriteQueue.catch(() => {}).then(async () => {
    const current = await loadConfig({ waitForWrites: false });
    const patch = await buildPatch(current);
    const merged = normalizeConfig({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    });
    await writeJson(configFile, merged);
    return merged;
  });
  configWriteQueue = write.catch(() => {});
  return write;
}

export async function saveConfig(nextConfig) {
  return updateConfig(() => nextConfig);
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
  return updateConfig((config) => {
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
    return { channels };
  });
}

export async function removeChannel(channelId) {
  return updateConfig((config) => ({
    channels: config.channels.filter((channel) => channel.id !== channelId),
    accounts: config.accounts.filter((account) => account.channelId !== channelId),
    defaultChannel: config.defaultChannel === channelId ? "auto" : config.defaultChannel
  }));
}

export async function saveAccount(accountInput) {
  return updateConfig((config) => {
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
    return { accounts };
  });
}

export async function removeAccount(accountId) {
  return updateConfig((config) => ({
    accounts: config.accounts.filter((account) => account.id !== accountId)
  }));
}

function importedAccountText(value, field, rowNumber, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) {
    const error = new Error(`第 ${rowNumber} 行缺少${field}。`);
    error.status = 400;
    throw error;
  }
  if (text.length > maxLength) {
    const error = new Error(`第 ${rowNumber} 行的${field}过长。`);
    error.status = 400;
    throw error;
  }
  return text;
}

function normalizeImportedAccount(row, index, channelId, config) {
  const rowNumber = index + 2;
  const username = importedAccountText(row?.username, "登录账号", rowNumber, 320);
  const nameInput = String(row?.name ?? "").trim();
  if (nameInput.length > 320) {
    const error = new Error(`第 ${rowNumber} 行的账号名称过长。`);
    error.status = 400;
    throw error;
  }
  const name = nameInput || username;
  const password = String(row?.password ?? "");
  const proxyUrl = String(row?.proxyUrl ?? row?.proxy ?? "").trim();
  if (!password) {
    const error = new Error(`第 ${rowNumber} 行缺少登录密码。`);
    error.status = 400;
    throw error;
  }
  if (password.length > 1024) {
    const error = new Error(`第 ${rowNumber} 行的登录密码过长。`);
    error.status = 400;
    throw error;
  }
  if (proxyUrl.length > 2048 || (proxyUrl && !safeProxyEndpoint(proxyUrl).proxyHost)) {
    const error = new Error(`第 ${rowNumber} 行的代理 IP 格式不正确。`);
    error.status = 400;
    throw error;
  }
  return {
    id: `account-${randomUUID()}`,
    channelId,
    name,
    username,
    password,
    proxyUrl,
    enabled: true,
    priority: 1,
    routingWeight: 1,
    concurrency: normalizeAccountConcurrency({}, config.concurrency),
    status: "unknown"
  };
}

export async function importAccounts(input = {}) {
  const channelId = String(input.channelId || "").trim();
  const source = Array.isArray(input.accounts) ? input.accounts : [];
  if (!channelId) {
    const error = new Error("请选择导入账号所属的渠道。");
    error.status = 400;
    throw error;
  }
  if (!source.length) {
    const error = new Error("没有可导入的账号。");
    error.status = 400;
    throw error;
  }
  if (source.length > accountImportLimit) {
    const error = new Error(`每次最多导入 ${accountImportLimit} 个账号，请拆分后重试。`);
    error.status = 400;
    throw error;
  }

  let result = null;
  const config = await updateConfig((current) => {
    if (!current.channels.some((channel) => channel.id === channelId)) {
      const error = new Error("导入账号所属的渠道不存在。");
      error.status = 400;
      throw error;
    }

    const existingUsernames = new Set(
      current.accounts
        .filter((account) => account.channelId === channelId)
        .map((account) => String(account.username || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const imported = [];
    let skipped = 0;
    source.forEach((row, index) => {
      const account = normalizeImportedAccount(row, index, channelId, current);
      const duplicateKey = account.username.toLowerCase();
      if (existingUsernames.has(duplicateKey)) {
        skipped += 1;
        return;
      }
      existingUsernames.add(duplicateKey);
      imported.push(account);
    });
    result = {
      total: source.length,
      imported: imported.length,
      skipped
    };
    return { accounts: [...current.accounts, ...imported] };
  });

  return { config, result };
}

function proxyBatchError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function proxyBatchKey(value) {
  try {
    return new URL(normalizeProxyUrl(value)).href;
  } catch {
    return "";
  }
}

function proxyBatchExpiryTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T23:59:59+08:00`
    : text;
  const time = Date.parse(dateText);
  return Number.isFinite(time) ? time : Number.NaN;
}

const proxyAssignmentTargetTypes = new Set(["usable", "expired", "empty"]);

function normalizeProxyAssignmentTargetType(value) {
  const targetType = String(value || "").trim();
  if (!proxyAssignmentTargetTypes.has(targetType)) {
    throw proxyBatchError("请选择分配对象。");
  }
  return targetType;
}

function accountProxyExpired(account) {
  const proxyUrl = String(account?.proxyUrl || "").trim();
  if (!proxyUrl) return false;
  const expiryTime = proxyBatchExpiryTime(safeProxyEndpoint(proxyUrl).expiresAt);
  return Number.isFinite(expiryTime) && expiryTime < Date.now();
}

function proxyAssignmentTargetMatches(account, targetType) {
  if (account.enabled === false) return false;
  const hasProxy = Boolean(String(account.proxyUrl || "").trim());
  if (targetType === "empty") return !hasProxy;
  if (!hasProxy) return false;
  return targetType === "expired" ? accountProxyExpired(account) : !accountProxyExpired(account);
}

function normalizeProxyBatch(source) {
  if (!Array.isArray(source) || !source.length) {
    throw proxyBatchError("请先导入代理 IP。");
  }
  if (source.length > proxyBatchLimit) {
    throw proxyBatchError(`每次最多导入 ${proxyBatchLimit} 个代理 IP，请拆分后重试。`);
  }

  const entries = [];
  const byKey = new Map();
  let duplicateCount = 0;
  source.forEach((value, index) => {
    const proxyUrl = String(value ?? "").trim();
    if (!proxyUrl) return;
    const endpoint = safeProxyEndpoint(proxyUrl);
    const key = proxyBatchKey(proxyUrl);
    if (proxyUrl.length > 2048 || !endpoint.proxyHost || !key) {
      throw proxyBatchError(`第 ${index + 1} 行的代理 IP 格式不正确。`);
    }
    const expiryTime = proxyBatchExpiryTime(endpoint.expiresAt);
    if (Number.isNaN(expiryTime)) {
      throw proxyBatchError(`第 ${index + 1} 行的代理 IP 格式不正确。`);
    }
    if (expiryTime !== null && expiryTime < Date.now()) {
      throw proxyBatchError(`第 ${index + 1} 行的代理 IP 已到期。`);
    }
    if (byKey.has(key)) {
      duplicateCount += 1;
      return;
    }
    const entry = { key, proxyUrl };
    entries.push(entry);
    byKey.set(key, entry);
  });

  if (!entries.length) throw proxyBatchError("请先导入代理 IP。");
  return { entries, byKey, duplicateCount };
}

function normalizeProxyBatchChannelIds(source) {
  const channelIds = [...new Set(
    (Array.isArray(source) ? source : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!channelIds.length) throw proxyBatchError("请选择应用渠道。");
  return channelIds;
}

function resolveProxyBatchChannels(config, channelIds) {
  const channelMap = new Map(config.channels.map((channel) => [channel.id, channel]));
  return channelIds.map((channelId) => {
    const channel = channelMap.get(channelId);
    if (!channel) throw proxyBatchError("所选渠道不存在，请刷新后重试。", 409);
    return channel;
  });
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function automaticProxyAssignments(accounts, proxyBatch, allowReuse, targetType) {
  const targetAccounts = accounts.filter((account) => proxyAssignmentTargetMatches(account, targetType));
  const targetAccountIds = new Set(targetAccounts.map((account) => account.id));
  const assignments = new Map(targetAccounts.map((account) => [account.id, String(account.proxyUrl || "").trim()]));
  const usage = new Map(proxyBatch.entries.map((entry) => [entry.key, 0]));
  const assignedAccountIds = new Set();
  const reservedKeys = new Set();

  for (const account of accounts) {
    if (targetAccountIds.has(account.id)) continue;
    const key = proxyBatchKey(account.proxyUrl);
    if (!proxyBatch.byKey.has(key)) continue;
    usage.set(key, usage.get(key) + 1);
    if (!allowReuse) reservedKeys.add(key);
  }

  for (const account of targetAccounts) {
    const key = proxyBatchKey(account.proxyUrl);
    const imported = proxyBatch.byKey.get(key);
    if (!imported || (!allowReuse && usage.get(key) > 0)) continue;
    assignments.set(account.id, imported.proxyUrl);
    assignedAccountIds.add(account.id);
    usage.set(key, usage.get(key) + 1);
  }

  const remainingAccounts = shuffled(targetAccounts.filter((account) => !assignedAccountIds.has(account.id)));

  if (!allowReuse) {
    const available = shuffled(proxyBatch.entries.filter((entry) => usage.get(entry.key) === 0));
    remainingAccounts.slice(0, available.length).forEach((account, index) => {
      assignments.set(account.id, available[index].proxyUrl);
      usage.set(available[index].key, 1);
    });
    return { assignments, reservedKeys, targetAccounts, usage };
  }

  for (const account of remainingAccounts) {
    const minimumUsage = Math.min(...proxyBatch.entries.map((entry) => usage.get(entry.key)));
    const candidates = proxyBatch.entries.filter((entry) => usage.get(entry.key) === minimumUsage);
    const selected = candidates[randomInt(candidates.length)];
    assignments.set(account.id, selected.proxyUrl);
    usage.set(selected.key, usage.get(selected.key) + 1);
  }
  return { assignments, reservedKeys, targetAccounts, usage };
}

function proxyAssignmentSummary(rows, unusedByChannel) {
  return {
    channels: new Set(rows.map((row) => row.channelId)).size,
    accounts: rows.length,
    assigned: rows.filter((row) => row.proxyUrl).length,
    cleared: rows.filter((row) => row.previousProxyUrl && !row.proxyUrl).length,
    changed: rows.filter((row) => row.previousProxyUrl !== row.proxyUrl).length,
    unchanged: rows.filter((row) => row.previousProxyUrl === row.proxyUrl).length,
    unused: unusedByChannel.reduce((total, channel) => total + channel.proxies.length, 0)
  };
}

export async function previewAccountProxyAssignments(input = {}) {
  const channelIds = normalizeProxyBatchChannelIds(input.channelIds);
  const proxyBatch = normalizeProxyBatch(input.proxies);
  const allowReuse = input.allowReuse === true;
  const targetType = normalizeProxyAssignmentTargetType(input.targetType);
  const config = await loadConfig();
  const channels = resolveProxyBatchChannels(config, channelIds);
  const rows = [];
  const unusedByChannel = [];
  const unavailableByChannel = [];

  for (const channel of channels) {
    const accounts = config.accounts.filter((account) => account.channelId === channel.id);
    const { assignments, reservedKeys, targetAccounts, usage } = automaticProxyAssignments(accounts, proxyBatch, allowReuse, targetType);
    targetAccounts.forEach((account) => {
      rows.push({
        key: `${channel.id}:${account.id}`,
        channelId: channel.id,
        channelName: channel.name,
        accountId: account.id,
        accountName: account.name || account.username || "未命名账号",
        username: account.username || "",
        enabled: account.enabled !== false,
        previousProxyUrl: String(account.proxyUrl || "").trim(),
        proxyUrl: assignments.get(account.id) || ""
      });
    });
    unusedByChannel.push({
      channelId: channel.id,
      channelName: channel.name,
      proxies: proxyBatch.entries
        .filter((entry) => usage.get(entry.key) === 0)
        .map((entry) => entry.proxyUrl)
    });
    unavailableByChannel.push({
      channelId: channel.id,
      channelName: channel.name,
      proxies: proxyBatch.entries
        .filter((entry) => reservedKeys.has(entry.key))
        .map((entry) => entry.proxyUrl)
    });
  }

  if (!rows.length) throw proxyBatchError("所选渠道没有符合条件的启用账号。");

  const selectedChannels = new Set(channelIds);
  const snapshotAccounts = config.accounts.filter((account) => selectedChannels.has(account.channelId));

  return {
    channelIds,
    allowReuse,
    targetType,
    proxies: proxyBatch.entries.map((entry) => entry.proxyUrl),
    duplicateCount: proxyBatch.duplicateCount,
    rows,
    snapshot: snapshotAccounts.map((account) => ({
      accountId: account.id,
      channelId: account.channelId,
      proxyUrl: String(account.proxyUrl || "").trim(),
      enabled: account.enabled !== false
    })),
    unusedByChannel,
    unavailableByChannel,
    summary: proxyAssignmentSummary(rows, unusedByChannel)
  };
}

function assertProxyAssignmentSnapshot(accounts, snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length !== accounts.length) {
    throw proxyBatchError("账号或代理状态已经变化，请重新预览后再保存。", 409);
  }
  const currentById = new Map(accounts.map((account) => [account.id, account]));
  const seen = new Set();
  for (const item of snapshot) {
    const accountId = String(item?.accountId || "");
    const current = currentById.get(accountId);
    if (
      !current
      || seen.has(accountId)
      || current.channelId !== String(item?.channelId || "")
      || String(current.proxyUrl || "").trim() !== String(item?.proxyUrl || "").trim()
      || (current.enabled !== false) !== (item?.enabled !== false)
    ) {
      throw proxyBatchError("账号或代理状态已经变化，请重新预览后再保存。", 409);
    }
    seen.add(accountId);
  }
}

function normalizeProxyAssignments(accounts, targetAccounts, source, proxyBatch, allowReuse) {
  if (!Array.isArray(source) || source.length !== targetAccounts.length) {
    throw proxyBatchError("预览内容不完整，请重新预览后再保存。");
  }
  const accountById = new Map(targetAccounts.map((account) => [account.id, account]));
  const targetAccountIds = new Set(accountById.keys());
  const assignments = new Map();
  const usedByChannel = new Map();

  if (!allowReuse) {
    for (const account of accounts) {
      if (targetAccountIds.has(account.id)) continue;
      const key = proxyBatchKey(account.proxyUrl);
      if (!proxyBatch.byKey.has(key)) continue;
      const used = usedByChannel.get(account.channelId) || new Set();
      used.add(key);
      usedByChannel.set(account.channelId, used);
    }
  }

  for (const item of source) {
    const accountId = String(item?.accountId || "");
    const account = accountById.get(accountId);
    if (!account || assignments.has(accountId)) {
      throw proxyBatchError("预览内容不完整，请重新预览后再保存。");
    }
    const requestedProxy = String(item?.proxyUrl || "").trim();
    if (!requestedProxy) {
      assignments.set(accountId, "");
      continue;
    }
    const key = proxyBatchKey(requestedProxy);
    const imported = proxyBatch.byKey.get(key);
    if (!imported && requestedProxy === String(account.proxyUrl || "").trim()) {
      assignments.set(accountId, requestedProxy);
      continue;
    }
    if (!imported) throw proxyBatchError("分配结果中包含未导入的代理 IP，请重新预览。");
    if (!allowReuse) {
      const used = usedByChannel.get(account.channelId) || new Set();
      if (used.has(key)) throw proxyBatchError("同一渠道不能重复使用同一个代理。");
      used.add(key);
      usedByChannel.set(account.channelId, used);
    }
    assignments.set(accountId, imported.proxyUrl);
  }
  return assignments;
}

export async function applyAccountProxyAssignments(input = {}) {
  const channelIds = normalizeProxyBatchChannelIds(input.channelIds);
  const proxyBatch = normalizeProxyBatch(input.proxies);
  const allowReuse = input.allowReuse === true;
  const targetType = normalizeProxyAssignmentTargetType(input.targetType);
  let result = null;

  const config = await updateConfig((current) => {
    resolveProxyBatchChannels(current, channelIds);
    const selectedChannels = new Set(channelIds);
    const accounts = current.accounts.filter((account) => selectedChannels.has(account.channelId));
    assertProxyAssignmentSnapshot(accounts, input.snapshot);
    const targetAccounts = accounts.filter((account) => proxyAssignmentTargetMatches(account, targetType));
    const assignments = normalizeProxyAssignments(accounts, targetAccounts, input.assignments, proxyBatch, allowReuse);
    const nextAccounts = current.accounts.map((account) => {
      if (!assignments.has(account.id)) return account;
      const proxyUrl = assignments.get(account.id);
      if (String(account.proxyUrl || "").trim() === proxyUrl) return account;
      const meta = { ...(account.meta || {}) };
      delete meta.proxyCheck;
      return { ...account, proxyUrl, meta };
    });
    const rows = targetAccounts.map((account) => ({
      channelId: account.channelId,
      previousProxyUrl: String(account.proxyUrl || "").trim(),
      proxyUrl: assignments.get(account.id) || ""
    }));
    result = {
      channels: channelIds.length,
      accounts: targetAccounts.length,
      assigned: rows.filter((row) => row.proxyUrl).length,
      cleared: rows.filter((row) => row.previousProxyUrl && !row.proxyUrl).length,
      changed: rows.filter((row) => row.previousProxyUrl !== row.proxyUrl).length,
      unchanged: rows.filter((row) => row.previousProxyUrl === row.proxyUrl).length
    };
    return { accounts: nextAccounts };
  });

  return { config, result };
}

export async function clearAccountProxies(input = {}) {
  const channelIds = normalizeProxyBatchChannelIds(input.channelIds);
  let result = null;

  const config = await updateConfig((current) => {
    resolveProxyBatchChannels(current, channelIds);
    const selectedChannels = new Set(channelIds);
    const accounts = current.accounts.filter((account) => selectedChannels.has(account.channelId));
    assertProxyAssignmentSnapshot(accounts, input.snapshot);
    const accountIds = new Set(accounts.filter((account) => String(account.proxyUrl || "").trim()).map((account) => account.id));
    const nextAccounts = current.accounts.map((account) => {
      if (!accountIds.has(account.id)) return account;
      const meta = { ...(account.meta || {}) };
      delete meta.proxyCheck;
      return { ...account, proxyUrl: "", meta };
    });
    result = {
      channels: channelIds.length,
      accounts: accounts.length,
      cleared: accountIds.size
    };
    return { accounts: nextAccounts };
  });

  return { config, result };
}

export async function updateAccountStatus(accountId, statusPatch) {
  await updateConfig((config) => ({
    accounts: config.accounts.map((account) =>
      account.id === accountId
        ? { ...account, ...statusPatch, lastCheckAt: new Date().toISOString() }
        : account
    )
  }));
}

export async function updateAccountMeta(accountId, buildMeta) {
  if (typeof buildMeta !== "function") throw new TypeError("buildMeta must be a function");
  return updateConfig((config) => ({
    accounts: config.accounts.map((account) => {
      if (account.id !== accountId) return account;
      const meta = buildMeta({ ...(account.meta || {}) });
      return { ...account, meta: meta && typeof meta === "object" ? meta : account.meta || {} };
    })
  }));
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
    tasks
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

export async function listActiveTasks() {
  await tasksWriteQueue.catch(() => {});
  const database = await getStorageDatabase();
  const statuses = ["processing", "queued", "pending", "unknown", "waiting_upstream"];
  return database.prepare(`
    SELECT payload
    FROM tasks
    WHERE status IN (${statuses.map(() => "?").join(", ")})
    ORDER BY created_time DESC
  `).all(...statuses).flatMap((row) => {
    try {
      return [JSON.parse(row.payload)];
    } catch {
      return [];
    }
  });
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

function taskListStatus(task) {
  const status = taskStatus(task);
  if (status !== "failed") return status;
  const code = String(task?.responseJson?.code || task?.code || "").trim().toUpperCase();
  const message = String(task?.errorMessage || task?.responseJson?.message || "").trim();
  const rejectedBeforeSubmission = task?.raw?.submitted !== true;
  if (!rejectedBeforeSubmission) return status;
  if (code === "QUOTA_PROTECTION") return "quota_protected";
  return code === "CONCURRENCY_LIMIT" || /^并发上限/.test(message)
    ? "concurrency_limited"
    : status;
}

function taskRecordKind(task = {}) {
  const taskType = String(task?.taskType || "").trim().toLowerCase();
  if (taskType === "chat") return "chat";
  if (["text2img", "img2img"].includes(taskType)) return "image";
  const endpoint = String(task?.raw?.endpoint || "").trim().toLowerCase();
  return endpoint.includes("/chat/completions") ? "chat" : "image";
}

function normalizeTaskSearchKeyword(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, " ")
    .replace(/\s+/g, " ");
}

function taskSearchParts(value) {
  return normalizeTaskSearchKeyword(value)
    .split(/(?:\.{2,}|…|⋯|[\s,，;；:：]+)+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && (part.length >= 8 || /[_-]|\d/.test(part)));
}

function stripTaskImageData(value) {
  return String(value || "").replace(
    /data:image\/[a-z0-9.+-]+;base64,(?:[a-z0-9+/=]+|\[omitted[^\]]*\])/gi,
    "[图片]"
  );
}

function taskRequestSearchText(request = {}) {
  const values = [request.prompt, request.content, request.input, request.question];
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (typeof message?.content === "string") values.push(message.content);
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || /image/i.test(String(part.type || ""))) continue;
      values.push(part.text, part.content);
    }
  }
  return values.filter(Boolean).map(stripTaskImageData).join(" ");
}

function taskListSearchText(task = {}) {
  const request = task.requestJson || {};
  const response = task.responseJson || {};
  return normalizeTaskSearchKeyword([
    task.id,
    task.externalId,
    taskSourceTaskId(task),
    stripTaskImageData(task.prompt),
    stripTaskImageData(task.responseText),
    task.accountName,
    task.channelName,
    ...(task.submissionChannels || []).flatMap((item) => [item?.channelName, item?.accountName]),
    ...(task.generationChannels || []).flatMap((item) => [item?.channelName, item?.accountName]),
    task.errorMessage,
    task.upstreamText,
    response.message,
    taskRequestSearchText(request)
  ].filter(Boolean).join(" ").slice(0, 24000));
}

function taskListColumnValues(task = {}) {
  return {
    accountId: String(task.accountId || "").trim(),
    channelId: String(task.channelId || "").trim(),
    channelGroup: taskStatChannelGroup(task),
    recordKind: taskRecordKind(task),
    listStatus: taskListStatus(task),
    searchText: taskListSearchText(task)
  };
}

function taskListPreviewText(value, limit = 1200) {
  const text = stripTaskImageData(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function safeTaskListImageUrls(value) {
  const urls = Array.isArray(value) ? value : [];
  return [...new Set(urls
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item && !/^data:/i.test(item) && item.length <= 4096))]
    .slice(0, 4);
}

function taskInputImageCount(task = {}) {
  const request = task.requestJson || {};
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const messageImages = messages.reduce((total, message) => total + (
    Array.isArray(message?.content)
      ? message.content.filter((part) => part?.image_url || /image/i.test(String(part?.type || ""))).length
      : 0
  ), 0);
  return Math.max(
    Number(request.received_image_count) || 0,
    Array.isArray(request.files) ? request.files.length : 0,
    Array.isArray(task.inputImageUrls) ? task.inputImageUrls.length : 0,
    messageImages
  );
}

function taskListAttempts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    channelId: String(item?.channelId || ""),
    channelName: String(item?.channelName || ""),
    accountId: String(item?.accountId || ""),
    accountName: String(item?.accountName || ""),
    message: taskListPreviewText(item?.message, 600),
    busy: item?.busy === true,
    carPoolUnavailable: item?.carPoolUnavailable === true,
    blockingTaskId: String(item?.blockingTaskId || ""),
    blockingTaskStatus: String(item?.blockingTaskStatus || ""),
    blockingTaskCreatedAt: String(item?.blockingTaskCreatedAt || "")
  }));
}

function taskListRequestSummary(request = {}) {
  const keys = ["model", "chat_model", "chatModel", "model_id", "modelId"];
  return Object.fromEntries(keys
    .filter((key) => request?.[key] !== undefined)
    .map((key) => [key, request[key]]));
}

function taskListResponseSummary(response = {}) {
  const summary = {
    code: response?.code,
    message: taskListPreviewText(response?.message, 1200),
    failureType: response?.failureType,
    conversationId: response?.conversationId || response?.conversation_id,
    externalId: response?.externalId,
    selectedCarId: response?.selectedCarId,
    title: response?.title,
    upstreamModel: response?.upstreamModel,
    sourceTaskId: response?.sourceTaskId,
    usage: response?.usage,
    raw: {
      chatModel: response?.raw?.chatModel,
      upstreamModel: response?.raw?.upstreamModel,
      stageTimings: Array.isArray(response?.raw?.stageTimings) ? response.raw.stageTimings.slice(-30) : undefined
    }
  };
  return JSON.parse(JSON.stringify(summary));
}

function taskListRawSummary(raw = {}) {
  const summary = {
    endpoint: raw?.endpoint,
    submitted: raw?.submitted,
    queued: raw?.queued,
    requestedModel: raw?.requestedModel,
    upstreamModel: raw?.upstreamModel,
    chatModel: raw?.chatModel,
    modelFamily: raw?.modelFamily,
    conversationId: raw?.conversationId || raw?.conversation_id,
    selectedCarId: raw?.selectedCarId,
    title: raw?.title,
    created_at: raw?.created_at,
    failureType: raw?.failureType,
    stageTimings: Array.isArray(raw?.stageTimings) ? raw.stageTimings.slice(-30) : undefined,
    imageMirrorPending: raw?.imageMirrorPending,
    resultSaveError: raw?.resultSaveError,
    refreshErrorMessage: taskListPreviewText(raw?.refreshErrorMessage, 800),
    manualRefreshAvailable: raw?.manualRefreshAvailable,
    upstreamWaitExpired: raw?.upstreamWaitExpired
  };
  return JSON.parse(JSON.stringify(summary));
}

function taskListSummary(task = {}) {
  const prompt = String(task.prompt || "");
  const responseText = String(task.responseText || "");
  const inputImageCount = taskInputImageCount(task);
  return {
    id: task.id,
    sourceTaskId: taskSourceTaskId(task),
    externalId: task.externalId,
    taskNo: task.taskNo,
    status: task.status,
    code: task.code,
    taskType: task.taskType,
    modelId: task.modelId,
    ratio: task.ratio,
    imageCount: task.imageCount,
    imageUrls: safeTaskListImageUrls(task.imageUrls),
    inputImageUrls: safeTaskListImageUrls(task.inputImageUrls),
    inputImageCount,
    prompt: taskListPreviewText(prompt),
    responseText: taskListPreviewText(responseText),
    upstreamText: taskListPreviewText(task.upstreamText, 1200),
    errorMessage: taskListPreviewText(task.errorMessage, 1200),
    channelId: task.channelId,
    channelName: task.channelName,
    channelType: task.channelType,
    accountId: task.accountId,
    accountName: task.accountName,
    submissionChannels: Array.isArray(task.submissionChannels) ? task.submissionChannels.slice(0, 20) : [],
    generationChannels: Array.isArray(task.generationChannels) ? task.generationChannels.slice(0, 20) : [],
    requestMeta: task.requestMeta,
    network: task.network,
    attempts: taskListAttempts(task.attempts || task.responseJson?.attempts),
    requestJson: taskListRequestSummary(task.requestJson),
    responseJson: taskListResponseSummary(task.responseJson),
    raw: taskListRawSummary(task.raw),
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    detail: {
      promptLength: stripTaskImageData(prompt).length,
      responseTextLength: stripTaskImageData(responseText).length,
      inputImageCount,
      hasRequest: Boolean(task.requestJson),
      hasResponse: Boolean(task.responseJson || task.responseText || task.errorMessage)
    }
  };
}

export function taskListItem(task = {}) {
  return taskListSummary(task);
}

function taskPageWhere({ keyword, accountId, sourceChannelId, channel, status, kind }, includeKind = true) {
  const clauses = [];
  const params = [];
  if (accountId && accountId !== "all") {
    clauses.push("account_id = ?");
    params.push(accountId);
  }
  if (sourceChannelId && sourceChannelId !== "all") {
    clauses.push("(channel_id = ? OR substr(channel_id, 1, length(?) + 1) = ? || ':')");
    params.push(sourceChannelId, sourceChannelId, sourceChannelId);
  }
  if (channel && channel !== "all") {
    clauses.push("channel_group = ?");
    params.push(channel);
  }
  if (status && status !== "all") {
    clauses.push("list_status = ?");
    params.push(status);
  }
  if (keyword) {
    const parts = taskSearchParts(keyword);
    const partSql = parts.length
      ? ` OR (${parts.map(() => "instr(search_text, ?) > 0").join(" AND ")})`
      : "";
    clauses.push(`(instr(search_text, ?) > 0${partSql})`);
    params.push(keyword, ...parts);
  }
  if (includeKind && kind) {
    clauses.push("record_kind = ?");
    params.push(kind);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

export async function listTaskPage({
  page = 1,
  pageSize = 30,
  keyword = "",
  accountId = "",
  sourceChannelId = "",
  channel = "",
  status = "",
  kind = ""
} = {}) {
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 30)));
  const normalizedKeyword = normalizeTaskSearchKeyword(keyword);
  const filters = {
    keyword: normalizedKeyword,
    accountId: String(accountId || "").trim(),
    sourceChannelId: String(sourceChannelId || "").trim(),
    channel: String(channel || "").trim().toLowerCase(),
    status: String(status || "").trim().toLowerCase(),
    kind: ""
  };
  const normalizedKind = ["image", "chat"].includes(String(kind || "").trim().toLowerCase())
    ? String(kind).trim().toLowerCase()
    : "";
  filters.kind = normalizedKind;

  const database = await getStorageDatabase();
  const cutoff = Date.now() - taskHistoryDays * 24 * 60 * 60 * 1000;
  const activeStatuses = ["processing", "queued", "pending", "unknown", "waiting_upstream"];
  const eligibleSql = `
    SELECT id, account_id, channel_id, channel_group, record_kind, list_status, search_text, created_time, payload
    FROM tasks
    WHERE created_time >= ? OR status IN (${activeStatuses.map(() => "?").join(", ")})
    ORDER BY created_time DESC
    LIMIT ?
  `;
  const eligibleParams = [cutoff, ...activeStatuses, taskHistoryLimit];
  const baseWhere = taskPageWhere(filters, false);
  const pageWhere = taskPageWhere(filters, true);
  const withEligible = (sql) => `WITH eligible AS (${eligibleSql}) ${sql}`;
  const allTotal = Number(database.prepare(withEligible("SELECT COUNT(*) FROM eligible")).pluck().get(...eligibleParams) || 0);
  const kindTotals = database.prepare(withEligible(`
    SELECT record_kind AS kind, COUNT(*) AS total
    FROM eligible
    ${baseWhere.sql}
    GROUP BY record_kind
  `)).all(...eligibleParams, ...baseWhere.params).reduce((totals, row) => {
    if (row.kind === "image" || row.kind === "chat") totals[row.kind] = Number(row.total || 0);
    return totals;
  }, { image: 0, chat: 0 });
  const total = Number(database.prepare(withEligible(`
    SELECT COUNT(*)
    FROM eligible
    ${pageWhere.sql}
  `)).pluck().get(...eligibleParams, ...pageWhere.params) || 0);
  const pageCount = Math.ceil(total / normalizedPageSize);
  const normalizedPage = Math.min(requestedPage, Math.max(1, pageCount));
  const start = (normalizedPage - 1) * normalizedPageSize;
  const rows = database.prepare(withEligible(`
    SELECT payload
    FROM eligible
    ${pageWhere.sql}
    ORDER BY created_time DESC
    LIMIT ? OFFSET ?
  `)).all(...eligibleParams, ...pageWhere.params, normalizedPageSize, start);
  const items = rows.flatMap((row) => {
    try {
      return [taskListSummary(JSON.parse(row.payload))];
    } catch {
      return [];
    }
  });

  return {
    items,
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    pageCount,
    hasMore: start + normalizedPageSize < total,
    allTotal,
    kindTotals
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
  return id ? tasks.findIndex((item) => String(item.id) === id) : -1;
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
  await tasksWriteQueue.catch(() => {});
  const database = await getStorageDatabase();
  const payload = database.prepare("SELECT payload FROM tasks WHERE id = ?").pluck().get(String(id || ""));
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function getTaskBySourceTaskId(sourceTaskId) {
  const normalized = String(sourceTaskId || "").trim();
  if (!normalized) return null;
  await tasksWriteQueue.catch(() => {});
  const database = await getStorageDatabase();
  const payload = database.prepare("SELECT payload FROM tasks WHERE source_task_id = ? ORDER BY created_time DESC LIMIT 1")
    .pluck().get(normalized);
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
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

function taskWasSystemRejected(task, status) {
  if (status !== "failed" || task?.raw?.returnedError !== true || task?.raw?.submitted === true) return false;
  const code = String(task?.responseJson?.code || task?.code || "").trim().toUpperCase();
  return ["CONCURRENCY_LIMIT", "QUOTA_PROTECTION"].includes(code);
}

function taskStatCount(record) {
  const value = record?.tasks;
  return Math.max(0, Number(value === undefined || value === null ? 1 : value) || 0);
}

function taskStatValue(record, field, fallback = 0) {
  const value = record?.[field];
  return Math.max(0, Number(value === undefined || value === null ? fallback : value) || 0);
}

function taskStatRecord(task) {
  const status = finalStatStatus(task?.status);
  if (!status || !task?.id) return null;
  const time = taskStatTime(task);
  const systemRejected = taskWasSystemRejected(task, status);
  return {
    taskId: String(task.id),
    day: dateKeyInShanghai(time),
    time,
    status,
    taskType: task.taskType || "",
    accountId: systemRejected ? "" : task.accountId || "",
    accountName: systemRejected ? "" : task.accountName || "",
    channelId: task.channelId || "",
    channelName: task.channelName || "",
    channelType: task.channelType || "",
    channelGroup: taskStatChannelGroup(task),
    tasks: systemRejected ? 0 : 1,
    successImages: status === "success" ? taskGeneratedImageCount(task) : 0,
    failedTasks: status === "failed" && !systemRejected ? 1 : 0,
    systemRejectedTasks: systemRejected ? 1 : 0,
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
      systemRejectedTasks: 0,
      successImages: 0,
      durationMsTotal: 0,
      durationSamples: 0
    };
    const taskCount = taskStatCount(record);
    current.tasks += taskCount;
    current.systemRejectedTasks += taskStatValue(record, "systemRejectedTasks");
    if (record?.status === "success") {
      current.successTasks += taskCount;
      current.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
      const durationMs = Number(record?.durationMs);
      if (Number.isFinite(durationMs) && durationMs >= 0 && record?.durationMs !== null) {
        current.durationMsTotal += durationMs;
        current.durationSamples += 1;
      }
    } else if (record?.status === "failed") {
      current.failedTasks += taskStatValue(record, "failedTasks", taskCount);
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
      failedTasks: 0,
      systemRejectedTasks: 0
    };
    const taskCount = taskStatCount(record);
    current.tasks += taskCount;
    current.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
    current.failedTasks += taskStatValue(record, "failedTasks", status === "failed" ? taskCount : 0);
    current.systemRejectedTasks += taskStatValue(record, "systemRejectedTasks");
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
      systemRejectedTasks: 0,
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
    const taskCount = taskStatCount(record);
    bucket.tasks += taskCount;
    bucket.systemRejectedTasks += taskStatValue(record, "systemRejectedTasks");
    if (record?.status === "success") {
      bucket.successTasks += taskCount;
      bucket.successImages += Math.max(0, Number(record?.successImages || 0) || 0);
    } else if (record?.status === "failed") {
      bucket.failedTasks += taskStatValue(record, "failedTasks", taskCount);
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
    systemRejectedTasks: bucket.systemRejectedTasks,
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
    systemRejectedTasks: normalizedBuckets.reduce((sum, bucket) => sum + bucket.systemRejectedTasks, 0),
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
    todayAccountRoutingUsageCache = null;
    return record;
  });
}

export async function listTodayAccountRoutingUsage(now = Date.now()) {
  await statsWriteQueue.catch(() => {});
  const day = dateKeyInShanghai(now);
  if (
    todayAccountRoutingUsageCache?.day === day
    && todayAccountRoutingUsageCache.revision === statsRevision
  ) {
    return todayAccountRoutingUsageCache.value;
  }

  const start = Date.parse(`${day}T00:00:00+08:00`);
  const end = start + 24 * 60 * 60 * 1000;
  const database = await getStorageDatabase();
  const records = database.prepare(`
    SELECT payload
    FROM task_stats
    WHERE time >= ? AND time < ?
  `).all(start, end).map((row) => JSON.parse(row.payload));
  const accounts = {};

  for (const record of records) {
    const accountId = String(record?.accountId || "").trim();
    if (!accountId) continue;
    const current = accounts[accountId] || {
      drawingImages: 0,
      chatImages: 0,
      chats: 0
    };
    if (record?.taskType === "chat") {
      current.chats += taskStatCount(record);
    } else if (imageTaskTypes.has(record?.taskType)) {
      const images = taskStatValue(record, "successImages");
      const channelGroup = String(record?.channelGroup || "").toLowerCase();
      if (channelGroup === "chatplus") current.chatImages += images;
      else if (channelGroup === "drawing") current.drawingImages += images;
    }
    accounts[accountId] = current;
  }

  const value = { day, accounts };
  todayAccountRoutingUsageCache = { day, revision: statsRevision, value };
  return value;
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
