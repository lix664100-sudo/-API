import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { normalizeProxyUrl } from "../proxy.js";

const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";
const ACCOUNT_CHECK_TIMEOUT_SEC = 8;
const DEFAULT_CHAT_HTTP_TIMEOUT_SEC = 180;
const DEFAULT_CONNECT_TIMEOUT_SEC = 20;
const MAX_CHAT_CAR_ATTEMPTS = 8;
const BAD_CAR_TTL_MS = 15 * 60 * 1000;
const badCarUntil = new Map();

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function proxyUrlFor(account) {
  return normalizeProxyUrl(account?.proxyUrl || account?.proxy || "");
}

function requestTimeoutSec(options = {}, config = {}) {
  const configured = Number(
    options.timeoutSec
      || config.upstreamTimeoutSec
      || config.waitTimeoutSec
      || DEFAULT_CHAT_HTTP_TIMEOUT_SEC
  );
  return Math.max(1, configured);
}

function runCurl(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL_COMMAND, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!code) {
        resolve(stdout);
        return;
      }
      const message = stderr || `curl 退出码：${code}`;
      const error = new Error(code === 28 ? "聊天站响应慢，代理可能可用但请求超时。" : message);
      if (code === 28) error.status = 504;
      reject(error);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function splitHttp(raw) {
  const sections = raw.split(/\r?\n\r?\n/);
  let headerIndex = -1;
  for (let index = sections.length - 2; index >= 0; index -= 1) {
    if (/^HTTP\//i.test(sections[index])) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) return { status: 0, headers: {}, body: raw };
  const headerText = sections[headerIndex];
  const body = sections.slice(headerIndex + 1).join("\n\n");
  const lines = headerText.split(/\r?\n/);
  const status = Number((lines[0].match(/\s(\d{3})\s/) || [])[1] || 0);
  const headers = {};
  for (const section of sections.slice(0, headerIndex + 1)) {
    if (!/^HTTP\//i.test(section)) continue;
    const headerLines = section.split(/\r?\n/).slice(1);
    for (const line of headerLines) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      headers[key] = headers[key] ? [...headers[key], value] : [value];
    }
  }
  return { status, headers, body };
}

function cookieName(cookie) {
  return String(cookie).split("=")[0].trim();
}

function setCookiesFromHeaders(jar, headers) {
  for (const value of headers["set-cookie"] || []) {
    const cookie = String(value).split(";")[0];
    const name = cookieName(cookie);
    const index = jar.findIndex((item) => cookieName(item) === name);
    if (index >= 0) jar[index] = cookie;
    else jar.push(cookie);
  }
}

function badCarKey(accountId, carType, carId) {
  return `${accountId || "account"}:${carType || "chatgpt"}:${carId || ""}`;
}

function isBadCar(accountId, carType, carId) {
  const key = badCarKey(accountId, carType, carId);
  const until = badCarUntil.get(key) || 0;
  if (until > Date.now()) return true;
  if (until) badCarUntil.delete(key);
  return false;
}

function rememberBadCar(accountId, carType, carId) {
  if (!carId) return;
  badCarUntil.set(badCarKey(accountId, carType, carId), Date.now() + BAD_CAR_TTL_MS);
}

function isAuthSessionError(error) {
  const text = `${error?.message || ""} ${error?.body || ""} ${error?.status || error?.statusCode || ""}`;
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|其他设备登|unauthorized|forbidden/i.test(text);
}

function fileNameFromMime(mimeType, fallback = "image.png") {
  const ext = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  }[String(mimeType || "").toLowerCase()];
  if (!ext) return fallback;
  return fallback.includes(".") ? fallback : `${fallback}${ext}`;
}

function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  return { width: 512, height: 512 };
}

function dataUrlToFile(dataUrl, index) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const mimetype = match[1] || "image/png";
  const buffer = Buffer.from(match[2], "base64");
  return {
    filename: fileNameFromMime(mimetype, `chat-image-${index}`),
    mimetype,
    toBuffer: async () => buffer
  };
}

function limitFromInit(initPayload) {
  const limits = initPayload?.limits_progress;
  if (Array.isArray(limits)) {
    return limits.find((item) => item.feature_name === "image_gen") || {};
  }
  return limits?.image_gen || {};
}

function scanForImageRefs(value, baseUrl, output = { urls: new Set(), fileIds: new Set() }) {
  if (!value) return output;
  if (typeof value === "string") {
    const text = value.trim();
    const directMatches = text.match(/https?:\/\/[^\s"'<>]+?\.(?:png|jpg|jpeg|webp)(?:\?[^\s"'<>]*)?/gi) || [];
    directMatches.forEach((url) => output.urls.add(url));
    const localMatches = text.match(/\/backend-api\/[^\s"'<>]+/gi) || [];
    localMatches.forEach((url) => output.urls.add(`${baseUrl}${url}`));
    const fileMatches = text.matchAll(/(?:file-service|sediment):\/\/(file[-_][A-Za-z0-9_-]+)/g);
    for (const match of fileMatches) output.fileIds.add(match[1]);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => scanForImageRefs(item, baseUrl, output));
    return output;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((item) => scanForImageRefs(item, baseUrl, output));
  }
  return output;
}

function messageRole(value) {
  return String(value?.role || value?.author?.role || value?.message?.role || value?.message?.author?.role || "").toLowerCase();
}

function scanForGeneratedImageRefs(value, baseUrl, output = { urls: new Set(), fileIds: new Set() }) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => scanForGeneratedImageRefs(item, baseUrl, output));
    return output;
  }
  if (typeof value !== "object") return output;

  const role = messageRole(value);
  if (role === "assistant" || role === "tool") {
    scanForImageRefs(value.content || value.message?.content || value.parts || value, baseUrl, output);
  }

  Object.values(value).forEach((item) => scanForGeneratedImageRefs(item, baseUrl, output));
  return output;
}

function isSkippedMainlineContent(content) {
  const text = String(content || "").trim();
  if (!text) return false;
  try {
    const payload = JSON.parse(text);
    return payload?.skipped_mainline === true && Object.keys(payload).length === 1;
  } catch {
    return false;
  }
}

function parseSse(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // ignore non-json data
    }
  }
  return events;
}

function parseJsonLines(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  try {
    return [JSON.parse(source)];
  } catch {
    // Some upstreams stream one JSON object per line.
  }
  const events = [];
  for (const line of source.split(/\r?\n/)) {
    const data = line.replace(/^data:\s*/i, "").trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // ignore non-json chunks
    }
  }
  return events;
}

function contentPartToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.type === "image_url" || part.image_url) return "";
  return String(part.text || part.content || "").trim();
}

function messageContentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(contentPartToText).filter(Boolean).join("\n").trim();
  }
  return contentPartToText(content);
}

function normalizeChatMessages(input = {}) {
  if (Array.isArray(input.messages) && input.messages.length) return input.messages;
  const message = input.message || input.prompt || input.content;
  return message ? [{ role: "user", content: message }] : [];
}

function collectMessageImageFiles(messages) {
  const files = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const imageUrl = part?.image_url?.url || part?.image_url || "";
      const file = dataUrlToFile(imageUrl, files.length + 1);
      if (file) files.push(file);
      else if (imageUrl) {
        const error = new Error("对话图片请用 multipart 上传，或传 data:image/...;base64 格式。");
        error.status = 400;
        throw error;
      }
    }
  }
  return files;
}

function normalizeChatFiles(input, messages) {
  const files = [
    ...(Array.isArray(input.files) ? input.files : input.file ? [input.file] : []),
    ...collectMessageImageFiles(messages)
  ].filter(Boolean);
  if (files.length > 5) {
    const error = new Error("对话最多只能上传 5 张图片。");
    error.status = 400;
    throw error;
  }
  return files;
}

function chatPromptFromMessages(messages) {
  const rows = [];
  for (const message of messages) {
    const text = messageContentToText(message?.content);
    if (!text) continue;
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
    rows.push(role === "user" ? text : `${role}: ${text}`);
  }
  return rows.join("\n\n").trim();
}

function textFromAssistantContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content?.parts)) {
    return content.parts
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .filter(Boolean)
      .join("")
      .trim();
  }
  if (typeof content?.text === "string") return content.text.trim();
  if (typeof content?.result === "string") return content.result.trim();
  return "";
}

function isImageGenerationLimitMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  return /(?:you(?:'|’)ve|you have) hit (?:the )?(?:plus )?plan limit for image generation(?:s| requests)?/i.test(text)
    || /image generation (?:request )?(?:limit|quota).*(?:reset|exhausted|reached)/i.test(text)
    || /(?:图片|图像).{0,12}(?:生成).{0,24}(?:额度|配额|上限|限制).{0,16}(?:用完|耗尽|达到|已满)/.test(text);
}

function throwIfImageGenerationLimit(content) {
  if (!isImageGenerationLimitMessage(content)) return;
  const error = new Error("当前账户的图片生成额度已用完，正在切换下一个账户。");
  error.imageQuotaExhausted = true;
  error.quotaEmpty = true;
  throw error;
}

function imageQuotaError(message = "图片生成额度已用完。") {
  const error = new Error(message);
  error.imageQuotaExhausted = true;
  error.quotaEmpty = true;
  error.status = 429;
  return error;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function imageQuotaResetAt(imageLimit = {}) {
  return imageLimit.reset_after
    || imageLimit.reset_at
    || imageLimit.resetAt
    || imageLimit.resets_at
    || imageLimit.next_reset_at
    || "";
}

function isAssistantContentPatch(value) {
  const path = String(value?.p || value?.path || "");
  const op = String(value?.o || value?.op || "").toLowerCase();
  return /\/message\/content\/parts\/\d+/.test(path) && (!op || op === "append" || op === "add" || op === "replace");
}

function collectPatchText(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPatchText(item, output));
    return output;
  }
  if (typeof value !== "object") return output;

  const path = String(value?.p || value?.path || "");
  if (isAssistantContentPatch(value)) {
    const text = typeof value.v === "string" ? value.v : typeof value.value === "string" ? value.value : "";
    if (text) output.push(text);
  }
  if (!path && typeof value.v === "string" && !value.type) {
    output.push(value.v);
  }

  Object.values(value).forEach((item) => collectPatchText(item, output));
  return output;
}

function collectAssistantText(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssistantText(item, output));
    return output;
  }
  if (typeof value !== "object") return output;

  if (value.author?.role === "assistant") {
    const text = textFromAssistantContent(value.content);
    if (text) output.push(text);
  }
  if (value.message?.author?.role === "assistant") {
    const text = textFromAssistantContent(value.message.content);
    if (text) output.push(text);
  }

  Object.values(value).forEach((item) => collectAssistantText(item, output));
  return output;
}

function extractAssistantText(events) {
  const candidates = [];
  const patchText = collectPatchText(events).join("").trim();
  if (patchText) candidates.push(patchText);
  candidates.push(...collectAssistantText(events).filter(Boolean));
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function grokTextFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(grokTextFromValue).filter(Boolean).join("").trim();
  if (typeof value !== "object") return "";
  if (Array.isArray(value.parts)) return value.parts.map(grokTextFromValue).filter(Boolean).join("").trim();
  if (Array.isArray(value.content)) return value.content.map(grokTextFromValue).filter(Boolean).join("").trim();
  return String(value.text || value.markdown || value.message || value.answer || value.result || "").trim();
}

function collectGrokAssistantText(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectGrokAssistantText(item, output));
    return output;
  }
  if (typeof value !== "object") return output;

  const role = String(value.role || value.sender || value.author?.role || value.message?.author?.role || "").toLowerCase();
  const type = String(value.type || value.kind || value.event || "").toLowerCase();
  const looksAssistant = role.includes("assistant") || role.includes("model") || type.includes("assistant") || type.includes("response");
  if (looksAssistant) {
    const text = grokTextFromValue(value.content || value.text || value.markdown || value.message || value.response || value.answer || value.result);
    if (text) output.push(text);
  }

  Object.values(value).forEach((item) => collectGrokAssistantText(item, output));
  return output;
}

function extractGrokAssistantText(events) {
  return collectGrokAssistantText(events).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
}

function extractGrokConversationId(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractGrokConversationId(item);
      if (id) return id;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const direct = value.conversationId || value.conversation_id || value.conversation?.id || value.conversation?.conversationId;
  if (direct) return String(direct);
  for (const item of Object.values(value)) {
    const id = extractGrokConversationId(item);
    if (id) return id;
  }
  return "";
}

function chatModelKey(value) {
  return String(value || "").trim().toLowerCase();
}

const chatModelRoutes = [
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "balanced" },
  { key: "grok", name: "Grok", carType: "grok", model: "", strategy: "balanced" },
  { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking" }
];

const carListEndpoints = {
  chatgpt: "/frontend-api/carpage",
  grok: "/frontend-api/grokCarpage",
  gemini: "/frontend-api/geminiCarpage"
};

function defaultRouteForKey(key) {
  return chatModelRoutes.find((item) => item.key === key) || chatModelRoutes[0];
}

function normalizeChatModelRoute(route = {}) {
  const key = chatModelKey(route.key || route.value || route.name || route.model);
  const fallback = defaultRouteForKey(key);
  return {
    key: key || fallback.key,
    name: String(route.name || fallback.name || key || "model").trim(),
    carType: String(route.carType || fallback.carType || "chatgpt").trim(),
    model: String(route.model || fallback.model || "").trim(),
    strategy: String(route.strategy || fallback.strategy || "balanced").trim(),
    enabled: route.enabled !== false,
    default: Boolean(route.default)
  };
}

function resolveChatModelRoute(settings = {}, requestedModel = "") {
  const requested = chatModelKey(requestedModel);
  const routes = (Array.isArray(settings.chatModels) ? settings.chatModels : [])
    .map(normalizeChatModelRoute)
    .filter((route) => route.enabled && route.key);

  if (!routes.length) {
    const fallback = defaultRouteForKey(requested || chatModelKey(settings.defaultChatModel) || "gpt");
    return {
      ...fallback,
      model: String(requestedModel || settings.defaultModel || fallback.model || "").trim()
    };
  }

  const route = requested
    ? routes.find((item) => [item.key, chatModelKey(item.name), chatModelKey(item.model)].includes(requested))
    : routes.find((item) => item.default || item.key === chatModelKey(settings.defaultChatModel)) || routes[0];

  if (!route) {
    const error = new Error(`这个聊天模型没有配置：${requestedModel}`);
    error.status = 400;
    throw error;
  }
  return route;
}

function numeric(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeCar(raw = {}, carType = "chatgpt") {
  const realCarIDs = Array.isArray(raw.realCarIDs)
    ? raw.realCarIDs
    : Array.isArray(raw.real_car_ids) ? raw.real_car_ids : [];
  const cooldowns = [
    raw.clears_in,
    raw.team_clears_in,
    raw.clears_in_pro,
    raw.clears_in_think
  ].map((value) => numeric(value, 0)).filter((value) => value > 0);
  return {
    id: String(raw.carID || raw.carId || raw.car_id || raw.id || "").trim(),
    carType,
    status: numeric(raw.status ?? raw.state ?? 1, 1),
    count: numeric(raw.count ?? raw.queue_count ?? 0, 0),
    cooldown: cooldowns.length ? Math.min(...cooldowns) : 0,
    desc: String(raw.desc || raw.statusText || raw.label || "").trim(),
    label: String(raw.label || "").trim(),
    imageRemaining: numeric(raw.usage?.image_gen?.remaining ?? raw.model_limits?.image_gen?.remaining ?? 0, 0),
    isIQ: Boolean(raw.isIQ || raw.is_iq),
    isPro: Boolean(raw.isPro || raw.isSuperPro || raw.isUltra),
    isSuper: Boolean(raw.isSuper || raw.isPlus || raw.isTeam),
    isVirtual: Boolean(raw.isVirtual || raw.is_virtual),
    realCarIDs: realCarIDs.map((item) => String(item || "").trim()).filter(Boolean),
    raw
  };
}

function isClearlyUnavailable(car) {
  const text = `${car.desc} ${car.label}`.toLowerCase();
  return !car.id || car.status === 0 || /停用|维护|失败|不可用|禁用|busy|offline/.test(text);
}

function carScore(car, strategy = "balanced") {
  let score = 1000;
  const text = `${car.desc} ${car.label}`;
  if (car.cooldown > 0) score -= Math.min(car.cooldown, 3600) / 4;
  score -= car.count * (strategy === "speed" || strategy === "idle" ? 30 : 12);
  if (/空闲|推荐|正常/i.test(text)) score += 80;
  if (strategy === "image") score += car.imageRemaining * 8 + (car.imageRemaining > 0 ? 120 : 0);
  if (strategy === "thinking") score += (car.isIQ ? 140 : 0) + (car.isPro ? 80 : 0) + (car.isSuper ? 30 : 0);
  if (strategy === "balanced") score += Math.random() * 40;
  return score;
}

function rankedCars(cars, strategy) {
  const usable = cars.filter((car) => !isClearlyUnavailable(car));
  const source = usable.length ? usable : cars.filter((car) => car.id);
  return source
    .map((car) => ({ car, score: carScore(car, strategy) + Math.random() }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.car);
}

function concreteCarId(car) {
  if (car.isVirtual && car.realCarIDs.length) {
    return car.realCarIDs[Math.floor(Math.random() * Math.min(car.realCarIDs.length, 5))];
  }
  return car.id;
}

export class ChatplusClient {
  constructor({ config, channel, account, sessionLock }) {
    this.config = config;
    this.channel = channel;
    this.account = account;
    this.baseUrl = trimSlash(channel?.settings?.baseUrl || "https://www.chatplus.cc");
    this.carId = "";
    this.carType = "chatgpt";
    this.cookies = [];
    this.portalLoggedIn = false;
    this.defaultModel = "gpt-5-5-thinking";
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    this.contextSignature = this.makeContextSignature({ channel, account });
    this.accountWork = Promise.resolve();
  }

  makeContextSignature({ channel, account }) {
    return [
      trimSlash(channel?.settings?.baseUrl || "https://www.chatplus.cc"),
      String(account?.username || "").trim().toLowerCase(),
      String(account?.password || ""),
      proxyUrlFor(account)
    ].join("::");
  }

  updateContext({ config, channel, account, sessionLock }) {
    const nextSignature = this.makeContextSignature({ channel, account });
    const changed = nextSignature !== this.contextSignature;
    this.config = config;
    this.channel = channel;
    this.account = account;
    this.baseUrl = trimSlash(channel?.settings?.baseUrl || "https://www.chatplus.cc");
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    if (changed) {
      this.contextSignature = nextSignature;
      this.resetSession();
    }
  }

  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个聊天账号还没有填写账号或密码。");
    }
  }

  cookieHeader() {
    return this.cookies.join("; ");
  }

  async http(path, options = {}) {
    const url = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const sameSite = url.startsWith(this.baseUrl);
    const hasBody = options.body !== undefined;
    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(sameSite ? { referer: `${this.baseUrl}/` } : {}),
      ...(sameSite && hasBody ? { origin: this.baseUrl } : {}),
      accept: "application/json, text/event-stream, */*",
      ...(options.headers || {})
    };
    if (this.cookies.length) headers.cookie = this.cookieHeader();
    const args = ["-sS", "-i"];
    if (options.followRedirect) args.push("-L");
    args.push("--connect-timeout", String(DEFAULT_CONNECT_TIMEOUT_SEC));
    args.push("--max-time", String(requestTimeoutSec(options, this.config)));
    const proxyUrl = proxyUrlFor(this.account);
    if (proxyUrl) args.push("--proxy", proxyUrl);
    args.push("-X", options.method || "GET", url);
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
    let input = "";
    if (hasBody) {
      input = options.rawBody || Buffer.isBuffer(options.body) || options.body instanceof Uint8Array
        ? options.body
        : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      args.push("--data-binary", "@-");
      if (!headers["content-type"] && !options.rawBody) args.push("-H", "content-type: application/json");
    }
    const result = splitHttp(await runCurl(args, input));
    setCookiesFromHeaders(this.cookies, result.headers);
    return result;
  }

  async json(path, options = {}) {
    const response = await this.http(path, options);
    let payload = null;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch {
      payload = null;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(payload?.detail?.message || payload?.message || `聊天站请求失败：${response.status}`);
      error.status = response.status;
      error.body = response.body;
      throw error;
    }
    return payload;
  }

  resetSession() {
    this.cookies = [];
    this.portalLoggedIn = false;
    this.carId = "";
    this.carType = "chatgpt";
  }

  async runAccountWork(work) {
    const current = this.accountWork.catch(() => {}).then(work);
    this.accountWork = current;
    try {
      return await current;
    } finally {
      if (this.accountWork === current) this.accountWork = Promise.resolve();
    }
  }

  async performPortalLogin(options = {}) {
    this.assertConfigured();
    const login = await this.json("/frontend-api/login", {
      method: "POST",
      timeoutSec: options.timeoutSec,
      body: {
        userToken: this.account.username,
        password: this.account.password,
        token: ""
      }
    });
    if (login?.code !== 1) throw new Error(login?.msg || "聊天站登录失败。");
    this.portalLoggedIn = true;
  }

  async loginPortal(options = {}) {
    if (this.portalLoggedIn) return;
    await this.sessionLock(async () => {
      if (!this.portalLoggedIn) await this.performPortalLogin(options);
    });
  }

  async enterCar(carId, carType, options = {}) {
    await this.sessionLock(async () => {
      if (!this.portalLoggedIn) await this.performPortalLogin(options);
      const session = await this.json(`/auth/loginSession?carid=${encodeURIComponent(carId)}&carType=${encodeURIComponent(carType)}`, {
        timeoutSec: options.timeoutSec
      });
      if (session?.code !== 1) throw new Error(session?.msg || "进入聊天车队失败。");
      const page = await this.http(carType === "gemini" ? "/app" : "/", {
        followRedirect: true,
        timeoutSec: options.timeoutSec,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "upgrade-insecure-requests": "1"
        }
      });
      if (page.status >= 400) {
        const error = new Error(`进入聊天页面失败：${page.status}`);
        error.status = page.status;
        error.body = page.body;
        throw error;
      }
    });
  }

  async login() {
    const route = resolveChatModelRoute(this.channel?.settings || {}, "");
    const selected = await this.selectCar(route);
    this.carId = selected.carId;
    this.carType = selected.carType;
    await this.enterCar(this.carId, this.carType);
  }

  async getInit() {
    await this.login();
    return this.loadInit();
  }

  async loadInit(options = {}) {
    const init = await this.json("/backend-api/conversation/init", {
      method: "POST",
      timeoutSec: options.timeoutSec,
      body: {}
    });
    if (init?.default_model_slug) this.defaultModel = init.default_model_slug;
    return init;
  }

  async fetchCars(carType, options = {}) {
    await this.loginPortal(options);
    const endpoint = carListEndpoints[carType] || carListEndpoints.chatgpt;
    const payload = await this.json(endpoint, {
      method: "POST",
      timeoutSec: options.timeoutSec,
      body: { page: 1, pageSize: 100, limit: 100 }
    });
    if (payload?.code !== undefined && payload.code !== 1) {
      throw new Error(payload?.msg || `读取 ${carType} 车队失败。`);
    }
    const list = payload?.data?.list || payload?.data?.items || payload?.data?.records || payload?.list || payload?.items || [];
    return Array.isArray(list) ? list.map((item) => normalizeCar(item, carType)).filter((item) => item.id) : [];
  }

  async selectCar(route, ignoredCarIds = new Set(), options = {}) {
    const cars = await this.fetchCars(route.carType, options);
    const candidates = rankedCars(cars, route.strategy)
      .map((car) => ({ car, carId: concreteCarId(car) }))
      .filter((item) => !ignoredCarIds.has(item.carId))
      .filter((item) => !isBadCar(this.account?.id, route.carType, item.carId));
    if (!candidates.length) throw new Error(`${route.name} 暂时没有可用车辆。`);
    const usableCars = route.strategy === "image"
      ? candidates.filter((item) => item.car.imageRemaining > 0 && !item.car.isPro)
      : candidates;
    if (!usableCars.length) throw imageQuotaError("暂时没有图片额度可用的 GPT 账号。");
    const selected = usableCars[0];
    return {
      carId: selected.carId,
      carType: route.carType,
      car: selected.car,
      candidateCount: usableCars.length,
      strategy: route.strategy || "balanced"
    };
  }

  rememberAuthFailedCar(selected) {
    rememberBadCar(this.account?.id, selected?.carType, selected?.carId);
  }

  async prepareChatSession(input = {}, ignoredCarIds = new Set(), maxAttempts = 5) {
    const resolvedRoute = resolveChatModelRoute(this.channel?.settings || {}, input.model || input.chat_model || input.chatModel || "");
    const route = input.preferImageCar && resolvedRoute.key === "gpt"
      ? { ...resolvedRoute, strategy: "image" }
      : resolvedRoute;
    const timeoutSec = Number(input.checkTimeoutSec || 0);
    const requestOptions = timeoutSec > 0 ? { timeoutSec } : {};
    const errors = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = await this.selectCar(route, ignoredCarIds, requestOptions);
      ignoredCarIds.add(selected.carId);
      this.carId = selected.carId;
      this.carType = selected.carType;
      try {
        await this.enterCar(selected.carId, selected.carType, requestOptions);
        const init = route.key === "gpt" ? await this.loadInit(requestOptions) : {};
        return { route, selected, init };
      } catch (error) {
        if (route.key === "gemini") {
          error.noRetry = true;
          throw error;
        }
        if (isAuthSessionError(error)) {
          this.rememberAuthFailedCar(selected);
          await this.sessionLock(async () => this.resetSession());
        }
        errors.push(`${selected.carId}：${error.message || "进入失败"}`);
      }
    }
    throw new Error(`${route.name} 自动找车失败：${errors.join("；")}`);
  }

  async check() {
    return this.runAccountWork(async () => {
      const { init, route, selected } = await this.prepareChatSession({
        model: this.channel?.settings?.defaultChatModel || "",
        preferImageCar: true,
        checkTimeoutSec: ACCOUNT_CHECK_TIMEOUT_SEC
      }, new Set(), 1);
      const imageLimit = limitFromInit(init);
      const remaining = imageLimit.remaining ?? null;
      const remainingNumber = numberOrNull(remaining);
      const quotaEmpty = remainingNumber !== null && remainingNumber <= 0;
      return {
        status: quotaEmpty ? "quota_empty" : "ok",
        quota: remaining,
        balance: remaining,
        quotaResetAt: imageQuotaResetAt(imageLimit),
        expireAt: "",
        message: quotaEmpty ? "聊天图片额度不足" : "聊天账号可用",
        meta: {
          defaultModel: init.default_model_slug || this.defaultModel,
          imageLimit,
          chatModel: route.key,
          selectedCarId: selected.carId,
          strategy: selected.strategy
        }
      };
    });
  }

  buildConversationBody(prompt, model, imageAssets = []) {
    const parentMessageId = randomUUID();
    const messageId = randomUUID();
    const hasImages = imageAssets.length > 0;
    return {
      messageId,
      body: {
        action: "next",
        messages: [
          {
            id: messageId,
            author: { role: "user" },
            content: {
              content_type: hasImages ? "multimodal_text" : "text",
              parts: hasImages ? [prompt, ...imageAssets.map((item) => item.part)] : [prompt]
            },
            metadata: hasImages ? { attachments: imageAssets.map((item) => item.attachment) } : {}
          }
        ],
        parent_message_id: parentMessageId,
        model,
        timezone_offset_min: -480,
        timezone: "Asia/Shanghai",
        suggestions: [],
        history_and_training_disabled: false,
        conversation_mode: { kind: "primary_assistant" },
        websocket_request_id: randomUUID()
      }
    };
  }

  async uploadChatImage(file) {
    const buffer = await file.toBuffer();
    const mimetype = file.mimetype || "image/png";
    if (!String(mimetype).startsWith("image/")) {
      const error = new Error("对话只能上传图片文件。");
      error.status = 400;
      throw error;
    }
    const filename = fileNameFromMime(mimetype, file.filename || `image-${randomUUID()}`);
    const { width, height } = imageDimensions(buffer);
    const upload = await this.json("/backend-api/files", {
      method: "POST",
      body: {
        file_name: filename,
        file_size: buffer.length,
        use_case: "multimodal"
      }
    });
    const fileId = upload?.file_id;
    const uploadUrl = upload?.upload_url;
    if (!fileId || !uploadUrl) throw new Error("聊天图片上传初始化失败。");

    const put = await this.http(uploadUrl, {
      method: "PUT",
      body: buffer,
      rawBody: true,
      headers: {
        "content-type": mimetype,
        "x-ms-blob-type": "BlockBlob"
      }
    });
    if (![200, 201].includes(put.status)) throw new Error(`聊天图片上传失败：${put.status}`);

    const done = await this.json(`/backend-api/files/${encodeURIComponent(fileId)}/uploaded`, {
      method: "POST",
      body: {}
    });
    if (done?.status && done.status !== "success") throw new Error("聊天图片上传未完成。");

    return {
      part: {
        content_type: "image_asset_pointer",
        asset_pointer: `file-service://${fileId}`,
        size_bytes: buffer.length,
        width,
        height
      },
      attachment: {
        id: fileId,
        name: filename,
        mimeType: mimetype,
        size: buffer.length,
        width,
        height
      }
    };
  }

  async uploadChatImages(files = []) {
    const assets = [];
    for (const file of files) assets.push(await this.uploadChatImage(file));
    return assets;
  }

  async imageDownloadUrl(fileId) {
    const fallback = `${this.baseUrl}/backend-api/files/${encodeURIComponent(fileId)}/download`;
    try {
      const info = await this.json(`/backend-api/files/${encodeURIComponent(fileId)}/download`);
      const url = info?.download_url || info?.url || info?.downloadUrl || "";
      if (/^https?:\/\//i.test(url)) return url;
      if (url) return `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
    } catch {
      // Generated files can still be fetched through the stable fallback endpoint.
    }
    return fallback;
  }

  async imageUrlsFrom(value, options = {}) {
    const refs = options.generatedOnly
      ? scanForGeneratedImageRefs(value, this.baseUrl)
      : scanForImageRefs(value, this.baseUrl);
    const urls = [...refs.urls];
    for (const fileId of refs.fileIds) urls.push(await this.imageDownloadUrl(fileId));
    return [...new Set(urls)];
  }

  async sendGrokConversation(prompt, input, route, selected) {
    if ((input.files || []).length) {
      const error = new Error("Grok 后台直连接口暂时不能稳定接收图片；带图对话请先使用 GPT 通道。");
      error.status = 400;
      error.noRetry = true;
      throw error;
    }

    const messageId = randomUUID();
    const upstreamModel = route.model || "grok-4";
    const response = await this.http("/rest/app-chat/conversations/new", {
      method: "POST",
      body: {
        message: prompt,
        modelName: upstreamModel,
        parentResponseId: null,
        disableSearch: false,
        enableImageGeneration: false,
        imageAttachments: [],
        fileAttachments: [],
        enableImageStreaming: true,
        imageGenerationCount: 1,
        forceConcise: false,
        enableSideBySide: true,
        sendFinalMetadata: true,
        isReasoning: route.strategy === "thinking",
        disableMemory: true
      },
      headers: {
        origin: this.baseUrl,
        referer: `${this.baseUrl}/`,
        accept: "application/json, text/plain, */*"
      }
    });

    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      const error = new Error("Grok 上游拦截了后台直连请求，需要真实浏览器会话才能提交；当前 API 请先使用 GPT 通道。");
      error.status = 502;
      error.noRetry = true;
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Grok 提交失败：${response.status}`);
      error.noRetry = true;
      throw error;
    }

    const events = parseJsonLines(response.body);
    return {
      events,
      conversationId: extractGrokConversationId(events),
      messageId,
      model: route.key,
      upstreamModel,
      route,
      selected,
      directContent: extractGrokAssistantText(events)
    };
  }

  async deleteConversation(conversationId, route) {
    if (!conversationId) return;
    const isGrok = route?.key === "grok";
    const response = await this.http(
      isGrok
        ? `/rest/app-chat/conversations/soft/${encodeURIComponent(conversationId)}`
        : `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      {
        method: isGrok ? "DELETE" : "PATCH",
        body: isGrok ? undefined : { is_visible: false },
        headers: { origin: this.baseUrl, referer: `${this.baseUrl}/` }
      }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`删除聊天记录失败：${response.status}`);
    }
  }

  async sendConversation(prompt, input = {}, ignoredCarIds = new Set()) {
    const errors = [];
    for (let attempt = 0; attempt < MAX_CHAT_CAR_ATTEMPTS; attempt += 1) {
      let selected = null;
      try {
        const session = await this.prepareChatSession(input, ignoredCarIds, 1);
        const { route, init } = session;
        selected = session.selected;
        if (route.key === "grok") return await this.sessionLock(() => this.sendGrokConversation(prompt, input, route, selected));
        if (route.key === "gemini") {
          const error = new Error("Gemini 上游当前账号没有有效订阅，暂时不能作为后端 API 转发。");
          error.noRetry = true;
          throw error;
        }
        const model = route.model || init?.default_model_slug || this.defaultModel;
        const imageAssets = await this.sessionLock(() => this.uploadChatImages(input.files || []));
        const { body, messageId } = this.buildConversationBody(prompt, model, imageAssets);

        const response = await this.sessionLock(() => this.http("/backend-api/conversation", {
          method: "POST",
          body,
          headers: {
            accept: "text/event-stream",
            referer: `${this.baseUrl}/`
          }
        }));
        if (response.status < 200 || response.status >= 300) {
          const error = new Error(`聊天站提交失败：${response.status}`);
          error.status = response.status;
          error.body = response.body;
          throw error;
        }

        const events = parseSse(response.body);
        throwIfImageGenerationLimit(extractAssistantText(events));
        let conversationId = "";
        for (const event of events) {
          if (event.conversation_id) conversationId = event.conversation_id;
        }
        return { events, conversationId, messageId, model: route.key || model, upstreamModel: model, route, selected };
      } catch (error) {
        if (error.noRetry || error.imageQuotaExhausted) throw error;
        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAuthSessionError(error)) {
          this.rememberAuthFailedCar(selected);
          await this.sessionLock(async () => this.resetSession());
        }
        errors.push(error.message || "调用失败");
      }
    }
    throw new Error(`自动换车失败：${errors.join("；")}`);
  }

  async withImageQuotaFallback(prompt, input, work) {
    const ignoredCarIds = new Set();
    const quotaErrors = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const conversation = await this.sendConversation(prompt, input, ignoredCarIds);
        return await work(conversation);
      } catch (error) {
        if (!error.imageQuotaExhausted) throw error;
        quotaErrors.push(error.message || "图片生成额度已用完。");
      }
    }
    throw imageQuotaError(`已自动尝试 ${quotaErrors.length} 个账户，但图片生成额度都已用完。`);
  }

  async waitForConversationImages(events, conversationId, timeoutSec, options = {}) {
    throwIfImageGenerationLimit(extractAssistantText(events));
    let imageUrls = await this.imageUrlsFrom(events, { generatedOnly: options.generatedOnly });
    if (imageUrls.length || !conversationId) return imageUrls;

    const timeoutMs = Math.max(5, Number(timeoutSec || this.config.waitTimeoutSec || 180)) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const detail = await this.json(`/backend-api/conversation/${encodeURIComponent(conversationId)}`);
        throwIfImageGenerationLimit(extractAssistantText(detail));
        imageUrls = await this.imageUrlsFrom(detail, { generatedOnly: true });
        if (imageUrls.length) return imageUrls;
      } catch (error) {
        if (error.imageQuotaExhausted) throw error;
        // Images can appear shortly after the streamed response finishes.
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return [];
  }

  async createTextTask(input) {
    return this.runAccountWork(async () => {
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("请输入生图描述。");
      const result = await this.withImageQuotaFallback(prompt, { ...input, preferImageCar: true }, async (conversation) => {
        const imageUrls = await this.waitForConversationImages(conversation.events, conversation.conversationId, input.waitTimeoutSec);
        if (!imageUrls.length) throw new Error("聊天通道没有返回图片，已尝试切换备用渠道。");
        return { ...conversation, imageUrls };
      });
      const { events, conversationId, messageId, model, upstreamModel, route, selected, imageUrls } = result;

      return {
        externalId: conversationId || messageId,
        status: "success",
        prompt,
        taskType: "text2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        raw: { conversationId, eventCount: events.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, strategy: selected?.strategy }
      };
    });
  }

  async createImageTask(input = {}) {
    return this.runAccountWork(async () => {
      const files = normalizeChatFiles(input, []);
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("Please enter an image edit prompt.");
      if (!files.length) throw new Error("Please upload a source image.");

      const result = await this.withImageQuotaFallback(prompt, { ...input, files, preferImageCar: true }, async (conversation) => {
        const imageUrls = await this.waitForConversationImages(conversation.events, conversation.conversationId, input.waitTimeoutSec, { generatedOnly: true });
        if (!imageUrls.length) throw new Error("Chat image channel did not return an edited image.");
        return { ...conversation, imageUrls };
      });
      const { events, conversationId, messageId, model, upstreamModel, route, selected, imageUrls } = result;

      return {
        externalId: conversationId || messageId,
        status: "success",
        prompt,
        taskType: "img2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        raw: { conversationId, eventCount: events.length, sourceImageCount: files.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, strategy: selected?.strategy }
      };
    });
  }

  async createChatCompletion(input = {}) {
    const messages = normalizeChatMessages(input);
    const files = normalizeChatFiles(input, messages);
    const prompt = chatPromptFromMessages(messages) || (files.length ? "请描述图片内容。" : "");
    if (!prompt) {
      const error = new Error("请输入对话内容，字段用 messages 或 message。");
      error.status = 400;
      throw error;
    }

    return this.runAccountWork(async () => {
      let conversationToDelete = null;
      try {
        const result = await this.withImageQuotaFallback(prompt, { ...input, files, preferImageCar: files.length > 0 }, async (conversation) => {
          conversationToDelete = conversation;
          const { events, conversationId, route, directContent } = conversation;
          const streamContent = extractAssistantText(events);
          let imageUrls = await this.imageUrlsFrom(events, { generatedOnly: files.length > 0 });
          let detailContent = "";
          if (conversationId && route?.key !== "grok") {
            try {
              const detail = await this.json(`/backend-api/conversation/${encodeURIComponent(conversationId)}`);
              detailContent = extractAssistantText(detail);
              imageUrls = [...new Set([...imageUrls, ...(await this.imageUrlsFrom(detail, { generatedOnly: true }))])];
            } catch {
              // The stream still has the answer if the detail endpoint is briefly unavailable.
            }
          }
          const rawContent = [directContent, streamContent, detailContent].filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
          throwIfImageGenerationLimit(rawContent);
          const content = isSkippedMainlineContent(rawContent) ? "" : rawContent;
          if (!content && imageUrls.length) return { ...conversation, content, detailContent, imageUrls };
          if (!content) throw new Error("聊天渠道没有返回文字内容，已尝试切换备用渠道。");
          return { ...conversation, content, detailContent, imageUrls };
        });
        const { events, conversationId, messageId, model, upstreamModel, route, selected, content, detailContent, imageUrls } = result;
        return {
          externalId: conversationId || messageId,
          model,
          content,
          imageUrls,
          raw: { conversationId, eventCount: events.length, imageCount: files.length, outputImageCount: imageUrls.length, detailTextLength: detailContent.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, strategy: selected?.strategy }
        };
      } finally {
        if (conversationToDelete?.conversationId) {
          try {
            await this.deleteConversation(conversationToDelete.conversationId, conversationToDelete.route);
          } catch (error) {
            console.error(error);
          }
        }
      }
    });
  }
}
