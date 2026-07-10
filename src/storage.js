import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "data");
const configFile = path.join(dataDir, "config.json");
const tasksFile = path.join(dataDir, "tasks.json");
const taskHistoryLimit = 20;

const defaultChatModels = [
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "balanced", enabled: true, default: true },
  { key: "grok", name: "Grok", carType: "grok", model: "", strategy: "balanced", enabled: true, default: false },
  { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: false }
];

const defaultChannels = [
  {
    id: "chatplus",
    name: "A渠道-聊天生图",
    type: "chatplus",
    enabled: true,
    priority: 1,
    settings: {
      baseUrl: "https://www.chatplus.cc",
      defaultChatModel: "gpt",
      chatModels: defaultChatModels
    }
  },
  {
    id: "drawing",
    name: "B渠道-绘图站",
    type: "drawing",
    enabled: true,
    priority: 2,
    settings: {
      baseUrl: "https://drawing.aishare.icu",
      defaultModelId: 1
    }
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
  channels: defaultChannels,
  accounts: []
};

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
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

function normalizeChatModelKey(value) {
  return String(value || "").trim().toLowerCase();
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

function normalizeChannels(channels = []) {
  const source = Array.isArray(channels) ? channels : defaultChannels;
  const normalized = [];
  const seen = new Set();

  for (const channel of source) {
    if (!channel) continue;
    const type = channel.type === "chatplus" ? "chatplus" : "drawing";
    const base = defaultChannels.find((item) => item.type === type) || {};
    const id = String(channel.id || `channel-${randomUUID()}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const settings = { ...(base.settings || {}), ...(channel.settings || {}) };
    if (type === "chatplus") {
      const migrateAutoSelection = settings.autoCarSelectionMigrated !== true;
      settings.chatModels = normalizeChatModels(settings, migrateAutoSelection);
      settings.defaultChatModel = settings.chatModels.find((item) => item.default && item.enabled)?.key || settings.chatModels[0]?.key || "gpt";
      settings.autoCarSelection = true;
      settings.autoCarSelectionMigrated = true;
      delete settings.carId;
      delete settings.carType;
    }
    if (type === "drawing") {
      settings.defaultModelId = Number(settings.defaultModelId || 1);
    }
    normalized.push({
      id,
      name: channel.name || "未命名渠道",
      type,
      enabled: channel.enabled !== false,
      priority: Number(channel.priority || 1),
      settings
    });
  }

  return normalized.sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
}

function makeDefaultAccounts(stored) {
  if (!stored?.username || !stored?.password) return [];
  const username = stored.username;
  const password = stored.password;
  return [
    {
      id: "chatplus-default",
      channelId: "chatplus",
      name: "聊天账号1",
      username,
      password,
      enabled: true,
      priority: 1,
      status: "unknown"
    },
    {
      id: "drawing-default",
      channelId: "drawing",
      name: "绘图账号1",
      username,
      password,
      enabled: true,
      priority: 1,
      status: "unknown"
    }
  ];
}

function normalizeAccounts(stored) {
  const source = Array.isArray(stored.accounts) && stored.accounts.length ? stored.accounts : makeDefaultAccounts(stored);
  return source.map((account) => ({
    id: account.id || `account-${randomUUID()}`,
    channelId: account.channelId || "drawing",
    name: account.name || "未命名账号",
    username: account.username || "",
    password: account.password || "",
    enabled: account.enabled !== false,
    priority: Number(account.priority || 1),
    status: account.status || "unknown",
    lastCheckAt: account.lastCheckAt || null,
    cooldownUntil: account.cooldownUntil || null,
    quota: account.quota ?? null,
    balance: account.balance ?? null,
    expireAt: account.expireAt || null,
    message: account.message || "",
    meta: account.meta || {}
  }));
}

function normalizeConfig(stored = {}) {
  const config = {
    ...defaultConfig,
    ...stored,
    channels: normalizeChannels(stored.channels),
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
    priority: Number(accountInput.priority || current.priority || 1)
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
