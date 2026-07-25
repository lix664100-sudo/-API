import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { normalizeProxyUrl } from "../proxy.js";

const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";
const ACCOUNT_CHECK_TIMEOUT_SEC = 8;
const DEFAULT_CHAT_HTTP_TIMEOUT_SEC = 300;
const DEFAULT_CONNECT_TIMEOUT_SEC = 20;
const MAX_CHAT_CAR_ATTEMPTS = 8;
const BAD_CAR_TTL_MS = 15 * 60 * 1000;
const GEMINI_REQUEST_PATH = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload/";
const GEMINI_UPLOAD_AUTHORIZATION = "Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=";
const GEMINI_DEFAULT_BUILD_LABEL = "boq_assistant-bard-web-server_20260525.09_p0";
const GEMINI_DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz";
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

function isCarPlanMismatchError(error) {
  const text = `${error?.message || ""} ${error?.body || ""}`.replace(/\s+/g, " ");
  return /\u4e0d\u662f\s*Ultra\s*\u7528\u6237|\u5347\u7ea7\u540e\u4f7f\u7528\u8be5\u8f66|not.{0,24}ultra|ultra.{0,24}user|(?:upgrade|\u5347\u7ea7).{0,24}(?:car|\u8be5\u8f66|\u8f66\u4f4d|Ultra)/i.test(text);
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

function parseGeminiJsonLines(text) {
  const events = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let data = line.trim().replace(/^data:\s*/i, "");
    if (!data || data === "[DONE]" || data === ")]}'") continue;
    if (data.startsWith(")]}'")) data = data.slice(4).trim();
    try {
      events.push(JSON.parse(data));
    } catch {
      // Gemini occasionally sends a non-json preamble before the response lines.
    }
  }
  return events;
}

function nestedGeminiJson(value, output = []) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("[") && !text.startsWith("{")) return output;
    try {
      const parsed = JSON.parse(text);
      output.push(parsed);
      nestedGeminiJson(parsed, output);
    } catch {
      // Ignore ordinary text fields.
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => nestedGeminiJson(item, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => nestedGeminiJson(item, output));
  }
  return output;
}

function geminiResponseParts(value, output = []) {
  if (Array.isArray(value)) {
    if (value.length >= 5 && Array.isArray(value[4])) output.push(value);
    value.forEach((item) => geminiResponseParts(item, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => geminiResponseParts(item, output));
  }
  return output;
}

function geminiTextFromResponsePart(part) {
  const rows = Array.isArray(part?.[4]) ? part[4] : [];
  const values = [];
  for (const row of rows) {
    const content = row?.[1];
    if (typeof content === "string") values.push(content);
    if (Array.isArray(content)) values.push(...content.filter((item) => typeof item === "string"));
  }
  return values.join("").trim();
}

function extractGeminiText(events) {
  const candidates = [];
  for (const value of nestedGeminiJson(events)) {
    for (const part of geminiResponseParts(value)) {
      const text = geminiTextFromResponsePart(part);
      if (text) candidates.push(text);
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function extractGeminiConversationId(events) {
  const ids = [];
  for (const value of nestedGeminiJson(events)) {
    for (const part of geminiResponseParts(value)) {
      const conversationId = Array.isArray(part?.[1]) ? part[1][0] : "";
      if (conversationId) ids.push(String(conversationId));
    }
  }
  return ids[ids.length - 1] || "";
}

function normalizeGeminiImageUrl(value, baseUrl) {
  const text = String(value || "").trim().replace(/[),.;]+$/, "");
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("/")) return `${baseUrl}${text}`;
  return /^https?:\/\//i.test(text) ? text : "";
}

function scanGeminiImageRefs(value, baseUrl, output = new Set()) {
  if (typeof value === "string") {
    const direct = value.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
    direct.forEach((url) => {
      if (/\/gemini\/images\/|googleusercontent\.com|image_generation/i.test(url)) {
        output.add(normalizeGeminiImageUrl(url, baseUrl));
      }
    });
    const local = value.match(/\/gemini\/images\/gg-dl\/[A-Za-z0-9._~+/=-]+/g) || [];
    local.forEach((url) => output.add(normalizeGeminiImageUrl(url, baseUrl)));
    const protocolRelative = value.match(/\/\/[A-Za-z0-9.-]+\/(?:gemini\/images\/|image_generation\/)[^\s"'<>\\]+/gi) || [];
    protocolRelative.forEach((url) => output.add(normalizeGeminiImageUrl(url, baseUrl)));
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => scanGeminiImageRefs(item, baseUrl, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => scanGeminiImageRefs(item, baseUrl, output));
  }
  return output;
}

function extractGeminiImageUrls(events, baseUrl) {
  const urls = new Set();
  for (const value of nestedGeminiJson(events)) {
    for (const part of geminiResponseParts(value)) {
      scanGeminiImageRefs(part?.[4], baseUrl, urls);
    }
  }
  return [...urls].filter(Boolean);
}

function extractGeminiErrorText(events) {
  const values = [];
  const collect = (value) => {
    if (typeof value === "string") {
      if (/(?:error|failed|failure|quota|limit|unavailable|not allowed|无法|失败|额度|上限)/i.test(value)) {
        values.push(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(events);
  return values.sort((a, b) => b.length - a.length)[0] || "";
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

function submittedImageTask(conversation, input, prompt, taskType, sourceImageCount = 0) {
  const { events = [], conversationId, model, upstreamModel, route, selected } = conversation;
  return {
    externalId: conversationId,
    status: "processing",
    prompt,
    taskType,
    modelId: model,
    ratio: input.ratio_label || input.ratio || "",
    imageCount: 0,
    imageUrls: [],
    raw: {
      conversationId,
      eventCount: events.length,
      sourceImageCount,
      upstreamModel,
      chatModel: route?.key,
      selectedCarId: selected?.carId,
      selectedCarType: selected?.carType,
      strategy: selected?.strategy
    }
  };
}

async function notifyImageSubmitted(input, result) {
  if (result.externalId && typeof input.onSubmitted === "function") {
    await input.onSubmitted(result);
  }
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

function isTerminalImageFailureMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /(?:violate|violates|violating).{0,160}(?:guardrails|policy|policies|content)/i.test(text)
    || /(?:guardrails|content policy|safety policy|safety system).{0,160}(?:image|content|request|third-party)/i.test(text)
    || /similarity to third-party content/i.test(text)
    || /(?:can't|cannot|unable to|won't)\s+(?:create|generate|help with).{0,120}(?:image|content|request)/i.test(text)
    || /(?:内容安全|安全拦截|上游渠道内容安全拦截|违规|无法生成|不能生成)/.test(text);
}

function throwIfTerminalImageFailure(content) {
  const message = String(content || "").trim();
  if (!isTerminalImageFailureMessage(message)) return;
  const error = new Error(message);
  error.upstreamExplicitFailure = true;
  error.upstreamStatus = "failed";
  error.status = 400;
  error.code = "content_policy";
  throw error;
}

function throwIfTextImageResponse(content) {
  const message = String(content || "").trim();
  if (!message) return;
  const error = new Error(message);
  error.upstreamExplicitFailure = true;
  error.upstreamStatus = "failed";
  error.status = 400;
  error.code = "upstream_text_response";
  throw error;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shanghaiDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(text)) {
    return `${text.replace(/\s+/, "T")}+08:00`;
  }
  return text;
}

function chatUsageFromPayload(payload = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const quota = numberOrNull(data?.limit);
  const used = numberOrNull(data?.userUsed);
  const balance = quota === null || used === null ? null : Math.max(0, quota - used);
  return {
    quota,
    used,
    balance,
    quotaResetAt: shanghaiDateTime(data?.resetTimeChatgpt),
    expireAt: shanghaiDateTime(data?.expireTime),
    period: String(data?.per || "").trim()
  };
}

function chatUsageLimitFromText(value) {
  const text = String(value || "").trim();
  if (!/使用次数已达上限|usage count has reached the limit/i.test(text)) return null;
  const occupiedMatch = text.match(/合计占用\s*(\d+)\s*\/\s*(\d+)/);
  const usedMatch = text.match(/已使用\s*(\d+)/);
  const remainingMatch = text.match(/剩余\s*(\d+)/);
  const resetMatch = text.match(/请\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*后重试/);
  const quota = numberOrNull(occupiedMatch?.[2]);
  const used = numberOrNull(usedMatch?.[1] ?? occupiedMatch?.[1]);
  const balance = numberOrNull(remainingMatch?.[1]) ?? (quota === null || used === null ? 0 : Math.max(0, quota - used));
  return {
    quota,
    used,
    balance,
    quotaResetAt: shanghaiDateTime(resetMatch?.[1]),
    period: ""
  };
}

function conversationSubmitError(response) {
  let payload = null;
  try {
    payload = response.body ? JSON.parse(response.body) : null;
  } catch {
    payload = null;
  }
  const detail = String(payload?.detail?.message || payload?.message || "").trim();
  const usage = chatUsageLimitFromText(detail);
  const error = new Error(usage
    ? `聊天使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`
    : detail || `聊天站提交失败：${response.status}`);
  error.status = response.status;
  error.body = response.body;
  if (usage) {
    error.code = "CHAT_USAGE_LIMIT";
    error.noRetry = true;
    error.quotaEmpty = true;
    error.quotaReason = "chat_usage_limit";
    error.quota = usage.quota;
    error.used = usage.used;
    error.balance = usage.balance;
    error.quotaResetAt = usage.quotaResetAt;
    error.cooldownUntil = usage.quotaResetAt;
    error.period = usage.period;
  }
  return error;
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

function explicitConversationState(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const state = explicitConversationState(item, seen);
      if (state) return state;
    }
    return null;
  }

  const status = String(value.status || value.state || value.task_status || value.taskStatus || "").toLowerCase();
  const message = String(
    value.error_message
      || value.errorMessage
      || value.failure_reason
      || value.failureReason
      || value.error?.message
      || value.detail?.message
      || value.message?.error
      || ""
  ).trim();
  if (["cancelled", "canceled"].includes(status)) {
    return { status: "cancelled", message: message || "上游已取消任务。" };
  }
  if (["failed", "failure", "error"].includes(status)) {
    return { status: "failed", message: message || "上游明确返回任务失败。" };
  }

  for (const item of Object.values(value)) {
    const state = explicitConversationState(item, seen);
    if (state) return state;
  }
  return null;
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

const drawingModelRequestKeys = new Set([
  "auto",
  "1",
  "2",
  "3",
  "gpt-image-2",
  "chatgpt-image-2",
  "nano-banana-pro",
  "nano-banana"
]);

function requestedChatModel(input = {}) {
  const requested = input.model || input.chat_model || input.chatModel || "";
  return drawingModelRequestKeys.has(chatModelKey(requested)) ? "" : requested;
}

const chatModelRoutes = [
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "balanced", carTier: "auto" },
  { key: "grok", name: "Grok", carType: "grok", model: "", strategy: "balanced", carTier: "auto" },
  { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", carTier: "auto" }
];

const carListEndpoints = {
  chatgpt: "/frontend-api/carpage",
  grok: "/frontend-api/grokCarpage",
  gemini: "/frontend-api/geminiCarpage"
};

function defaultRouteForKey(key) {
  return chatModelRoutes.find((item) => item.key === key) || chatModelRoutes[0];
}

function normalizeCarTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return ["auto", "pro", "ultra", "any"].includes(tier) ? tier : "auto";
}

function effectiveCarTier(route = {}) {
  const tier = normalizeCarTier(route.carTier);
  return tier === "auto" ? "pro" : tier;
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
    carTier: normalizeCarTier(route.carTier || fallback.carTier),
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

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

function carFieldText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(carFieldText).filter(Boolean).join(" ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

function rawCarText(raw = {}, desc = "", label = "") {
  return [
    desc,
    label,
    raw.name,
    raw.title,
    raw.plan,
    raw.planName,
    raw.tier,
    raw.level,
    raw.badge,
    raw.tags
  ].map(carFieldText).filter(Boolean).join(" ");
}

function carIsUltra(raw = {}, desc = "", label = "") {
  const text = rawCarText(raw, desc, label);
  return truthyFlag(raw.isUltra ?? raw.is_ultra ?? raw.ultra)
    || /\bultra\b|\u81f3\u5c0a|\u65d7\u8230/i.test(text);
}

function carIsPro(raw = {}, desc = "", label = "", isUltra = false) {
  if (isUltra) return false;
  const text = rawCarText(raw, desc, label);
  return truthyFlag(raw.isPro ?? raw.is_pro ?? raw.isSuperPro ?? raw.is_super_pro ?? raw.superPro)
    || /\bpro\b|\bplus\b|\bteam\b|\u4e13\u4e1a/i.test(text);
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
  const desc = String(raw.desc || raw.statusText || raw.label || "").trim();
  const label = String(raw.label || "").trim();
  const isUltra = carIsUltra(raw, desc, label);
  return {
    id: String(raw.carID || raw.carId || raw.car_id || raw.id || "").trim(),
    carType,
    status: numeric(raw.status ?? raw.state ?? 1, 1),
    count: numeric(raw.count ?? raw.queue_count ?? 0, 0),
    cooldown: cooldowns.length ? Math.min(...cooldowns) : 0,
    desc,
    label,
    imageRemaining: numeric(raw.usage?.image_gen?.remaining ?? raw.model_limits?.image_gen?.remaining ?? 0, 0),
    isIQ: Boolean(raw.isIQ || raw.is_iq),
    isPro: carIsPro(raw, desc, label, isUltra),
    isUltra,
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

function carMatchesTier(car, tier) {
  if (tier === "any") return true;
  if (tier === "ultra") return car.isUltra;
  return !car.isUltra;
}

function carTierDisplayName(tier) {
  if (tier === "ultra") return " Ultra";
  if (tier === "any") return "";
  return " PRO 及以下";
}

function concreteCarId(car) {
  if (car.isVirtual && car.realCarIDs.length) {
    return car.realCarIDs[Math.floor(Math.random() * Math.min(car.realCarIDs.length, 5))];
  }
  return car.id;
}

function firstGeminiToken(body, name) {
  const text = String(body || "");
  const escaped = new RegExp(`${name}.{0,80}?:(?:\\\\?"|")([^"\\\\]*)(?:\\\\?"|")`, "s").exec(text);
  if (escaped?.[1]) return escaped[1];
  const plain = new RegExp(`${name}.{0,80}?[:=]\\s*["']([^"']+)["']`, "s").exec(text);
  return plain?.[1] || "";
}

function geminiSessionFromPage(body, previous = {}) {
  const text = String(body || "");
  const buildLabel = text.match(/boq_assistant-bard-web-server_[A-Za-z0-9_.-]+/)?.[0] || "";
  return {
    at: firstGeminiToken(text, "SNlM0e") || previous.at || "",
    sid: firstGeminiToken(text, "FdrFJe") || previous.sid || "",
    bl: buildLabel || previous.bl || GEMINI_DEFAULT_BUILD_LABEL,
    pushId: firstGeminiToken(text, "qKIAYe") || previous.pushId || GEMINI_DEFAULT_PUSH_ID,
    sourcePath: "/app"
  };
}

function geminiModeForRoute(route = {}) {
  const requested = String(route.model || "").trim().toLowerCase();
  if (/^\d+$/.test(requested)) {
    const mode = Number(requested);
    if (mode >= 1 && mode <= 6) return mode;
  }
  if (requested.includes("pro")) return 3;
  if (requested.includes("lite")) return 5;
  return 1;
}

function geminiThinkingModeForRoute(route = {}) {
  return String(route.strategy || "").toLowerCase() === "thinking" ? 0 : 4;
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
    this.geminiSession = {
      at: "",
      sid: "",
      bl: GEMINI_DEFAULT_BUILD_LABEL,
      pushId: GEMINI_DEFAULT_PUSH_ID,
      sourcePath: "/app"
    };
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    this.contextSignature = this.makeContextSignature({ channel, account });
    this.accountWork = Promise.resolve();
    this.concurrentChatSessions = new Map();
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
    this.geminiSession = {
      at: "",
      sid: "",
      bl: GEMINI_DEFAULT_BUILD_LABEL,
      pushId: GEMINI_DEFAULT_PUSH_ID,
      sourcePath: "/app"
    };
    this.concurrentChatSessions.clear();
  }

  sessionSnapshot() {
    return {
      cookies: [...this.cookies],
      portalLoggedIn: this.portalLoggedIn,
      carId: this.carId,
      carType: this.carType,
      defaultModel: this.defaultModel,
      geminiSession: { ...this.geminiSession }
    };
  }

  restoreSession(snapshot = {}) {
    this.cookies = Array.isArray(snapshot.cookies) ? [...snapshot.cookies] : [];
    this.portalLoggedIn = Boolean(snapshot.portalLoggedIn);
    this.carId = String(snapshot.carId || "");
    this.carType = String(snapshot.carType || "chatgpt");
    if (snapshot.defaultModel) this.defaultModel = snapshot.defaultModel;
    this.geminiSession = {
      ...this.geminiSession,
      ...(snapshot.geminiSession || {})
    };
  }

  preparedChatSession(session = {}) {
    return {
      ...session,
      snapshot: this.sessionSnapshot()
    };
  }

  cloneChatSession(session = {}) {
    return {
      ...session,
      route: session.route ? { ...session.route } : session.route,
      selected: session.selected ? { ...session.selected } : session.selected,
      snapshot: session.snapshot
        ? {
            ...session.snapshot,
            cookies: [...(session.snapshot.cookies || [])],
            geminiSession: { ...(session.snapshot.geminiSession || {}) }
          }
        : this.sessionSnapshot()
    };
  }

  createSubmitClient(session = {}) {
    const snapshot = session.snapshot || session.submitSessionSnapshot;
    if (!snapshot) return this;
    const client = new ChatplusClient({
      config: this.config,
      channel: this.channel,
      account: this.account,
      sessionLock: async (work) => work()
    });
    client.restoreSession(snapshot);
    return client;
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

  async runTaskWork(input, work) {
    return input?.concurrentSubmit === true ? work() : this.runAccountWork(work);
  }

  chatRouteForInput(input = {}) {
    const resolvedRoute = resolveChatModelRoute(this.channel?.settings || {}, requestedChatModel(input));
    return input.preferImageCar && resolvedRoute.key === "gpt"
      ? { ...resolvedRoute, strategy: "image" }
      : resolvedRoute;
  }

  chatSessionKey(route = {}) {
    return [
      route.key || "",
      route.carType || "",
      route.model || "",
      route.strategy || "",
      route.carTier || ""
    ].join("::");
  }

  async prepareReusableChatSession(input = {}, ignoredCarIds = new Set(), maxAttempts = 5) {
    const route = this.chatRouteForInput(input);
    const key = this.chatSessionKey(route);
    const cached = this.concurrentChatSessions.get(key);
    if (cached?.session) {
      const cachedCarId = cached.session.selected?.carId;
      if (!ignoredCarIds.has(cachedCarId)) {
        if (cachedCarId) ignoredCarIds.add(cachedCarId);
        return this.cloneChatSession(cached.session);
      }
      this.concurrentChatSessions.delete(key);
    }
    if (cached?.promise) {
      const session = await cached.promise;
      const cachedCarId = session.selected?.carId;
      if (!ignoredCarIds.has(cachedCarId)) {
        if (cachedCarId) ignoredCarIds.add(cachedCarId);
        return this.cloneChatSession(session);
      }
      this.concurrentChatSessions.delete(key);
    }

    const promise = this.prepareChatSession(input, ignoredCarIds, maxAttempts)
      .then((session) => this.preparedChatSession(session));
    this.concurrentChatSessions.set(key, { promise });
    try {
      const session = await promise;
      this.concurrentChatSessions.set(key, { session });
      return this.cloneChatSession(session);
    } catch (error) {
      if (this.concurrentChatSessions.get(key)?.promise === promise) this.concurrentChatSessions.delete(key);
      throw error;
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

  async loadAccountUsage(options = {}) {
    await this.loginPortal(options);
    const payload = await this.json("/frontend-api/getme", {
      timeoutSec: options.timeoutSec
    });
    if (payload?.code !== undefined && payload.code !== 1) {
      throw new Error(payload?.msg || "读取聊天额度失败。");
    }
    return chatUsageFromPayload(payload);
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
      if (carType === "gemini") {
        this.geminiSession = geminiSessionFromPage(page.body, this.geminiSession);
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
    const tier = effectiveCarTier(route);
    const candidates = rankedCars(cars, route.strategy)
      .map((car) => ({ car, carId: concreteCarId(car) }))
      .filter((item) => !ignoredCarIds.has(item.carId))
      .filter((item) => !isBadCar(this.account?.id, route.carType, item.carId));
    if (!candidates.length) throw new Error(`${route.name} 暂时没有可用车辆。`);
    const tierCandidates = candidates.filter((item) => carMatchesTier(item.car, tier));
    if (!tierCandidates.length) throw new Error(`${route.name} 暂时没有可用的${carTierDisplayName(tier)}车位。`);
    const usableCars = route.strategy === "image"
      ? tierCandidates.filter((item) => item.car.imageRemaining > 0 && !item.car.isPro)
      : tierCandidates;
    if (!usableCars.length) throw imageQuotaError("暂时没有图片额度可用的 GPT 账号。");
    const selected = usableCars[0];
    return {
      carId: selected.carId,
      carType: route.carType,
      car: selected.car,
      candidateCount: usableCars.length,
      strategy: route.strategy || "balanced",
      carTier: tier
    };
  }

  rememberAuthFailedCar(selected) {
    rememberBadCar(this.account?.id, selected?.carType, selected?.carId);
  }

  async prepareChatSession(input = {}, ignoredCarIds = new Set(), maxAttempts = 5) {
    const route = this.chatRouteForInput(input);
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
        const retryableCarError = isAuthSessionError(error) || isCarPlanMismatchError(error);
        if (retryableCarError) {
          this.rememberAuthFailedCar(selected);
          await this.sessionLock(async () => this.resetSession());
        }
        if (route.key === "gemini" && !retryableCarError) {
          error.noRetry = true;
          throw error;
        }
        errors.push(`${selected.carId}：${error.message || "进入失败"}`);
      }
    }
    throw new Error(`${route.name} 自动找车失败：${errors.join("；")}`);
  }

  async check() {
    return this.runAccountWork(async () => {
      const requestOptions = { timeoutSec: ACCOUNT_CHECK_TIMEOUT_SEC };
      const usage = await this.loadAccountUsage(requestOptions);
      const usageQuotaEmpty = usage.balance !== null && usage.balance <= 0;
      if (usageQuotaEmpty) {
        return {
          status: "quota_empty",
          quota: usage.quota,
          balance: 0,
          used: usage.used,
          quotaResetAt: usage.quotaResetAt,
          expireAt: usage.expireAt,
          cooldownUntil: usage.quotaResetAt || null,
          quotaReason: "chat_usage_limit",
          message: usage.quotaResetAt
            ? `聊天使用次数已用完，等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新`
            : "聊天使用次数已用完，等待刷新",
          meta: {
            chatUsage: {
              quota: usage.quota,
              used: usage.used,
              balance: 0,
              period: usage.period
            }
          }
        };
      }
      const { init, route, selected } = await this.prepareChatSession({
        model: this.channel?.settings?.defaultChatModel || "",
        preferImageCar: true,
        checkTimeoutSec: ACCOUNT_CHECK_TIMEOUT_SEC
      }, new Set(), 5);
      const imageLimit = limitFromInit(init);
      const remaining = imageLimit.remaining ?? null;
      const remainingNumber = numberOrNull(remaining);
      const quotaEmpty = remainingNumber !== null && remainingNumber <= 0;
      const imageResetAt = imageQuotaResetAt(imageLimit);
      return {
        status: quotaEmpty ? "quota_empty" : "ok",
        quota: usage.quota ?? remaining,
        balance: usage.balance ?? remaining,
        used: usage.used,
        quotaResetAt: usage.quotaResetAt || imageResetAt,
        imageQuotaResetAt: imageResetAt,
        expireAt: usage.expireAt,
        cooldownUntil: null,
        quotaReason: quotaEmpty ? "image_quota" : "",
        message: quotaEmpty ? "聊天图片额度不足" : "聊天账号可用",
        meta: {
          defaultModel: init.default_model_slug || this.defaultModel,
          imageLimit,
          chatUsage: {
            quota: usage.quota,
            used: usage.used,
            balance: usage.balance,
            period: usage.period
          },
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
    if (options.gemini) return extractGeminiImageUrls(value, this.baseUrl);
    const refs = options.generatedOnly
      ? scanForGeneratedImageRefs(value, this.baseUrl)
      : scanForImageRefs(value, this.baseUrl);
    const urls = [...refs.urls];
    for (const fileId of refs.fileIds) urls.push(await this.imageDownloadUrl(fileId));
    return [...new Set(urls)];
  }

  buildGeminiRequest(prompt, route, uploads = []) {
    const request = Array(80).fill(null);
    request[0] = [
      prompt,
      0,
      null,
      uploads.map(([identifier, filename]) => [[identifier, 1], filename]),
      null,
      null,
      0
    ];
    request[1] = ["zh"];
    request[2] = ["", "", "", null, null, null, null, null, null, ""];
    request[6] = [0];
    request[7] = 1;
    request[9] = [];
    request[10] = 1;
    request[11] = 0;
    request[17] = [[geminiThinkingModeForRoute(route)]];
    request[18] = 0;
    request[27] = 1;
    request[30] = [4];
    request[41] = [2];
    request[53] = 0;
    request[59] = randomUUID().toUpperCase();
    request[61] = [];
    request[68] = 1;
    request[79] = geminiModeForRoute(route);
    return request;
  }

  async uploadGeminiImage(file) {
    const buffer = await file.toBuffer();
    const mimetype = String(file.mimetype || "image/png").toLowerCase();
    if (!mimetype.startsWith("image/")) {
      const error = new Error("对话只能上传图片文件。");
      error.status = 400;
      throw error;
    }
    const filename = fileNameFromMime(mimetype, file.filename || `gemini-image-${randomUUID()}`);
    const commonHeaders = {
      accept: "*/*",
      authorization: GEMINI_UPLOAD_AUTHORIZATION,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/app`,
      "push-id": this.geminiSession.pushId || GEMINI_DEFAULT_PUSH_ID,
      "x-goog-upload-header-content-length": String(buffer.length),
      "x-goog-upload-protocol": "resumable",
      "x-tenant-id": "bard-storage"
    };

    const start = await this.http(GEMINI_UPLOAD_URL, {
      method: "POST",
      body: `File name: ${filename}`,
      rawBody: true,
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-goog-upload-command": "start"
      }
    });
    if (start.status < 200 || start.status >= 300) {
      const error = new Error(`Gemini 图片上传初始化失败：${start.status}`);
      error.status = start.status;
      error.body = start.body;
      throw error;
    }
    const uploadUrl = start.headers["x-goog-upload-url"]?.[0] || "";
    if (!uploadUrl) throw new Error("Gemini 图片上传没有返回上传地址。");

    const uploaded = await this.http(uploadUrl, {
      method: "POST",
      body: buffer,
      rawBody: true,
      headers: {
        ...commonHeaders,
        "content-type": mimetype,
        "x-goog-upload-command": "upload, finalize",
        "x-goog-upload-offset": "0"
      }
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      const error = new Error(`Gemini 图片上传失败：${uploaded.status}`);
      error.status = uploaded.status;
      error.body = uploaded.body;
      throw error;
    }
    let identifier = String(uploaded.body || "").trim();
    try {
      const payload = JSON.parse(identifier);
      identifier = String(payload?.file_id || payload?.id || payload?.name || payload?.url || identifier).trim();
    } catch {
      // Gemini upload commonly returns the identifier as plain text.
    }
    if (!identifier) throw new Error("Gemini 图片上传没有返回图片编号。");
    return [identifier, filename];
  }

  async uploadGeminiImages(files = []) {
    return Promise.all(files.map((file) => this.uploadGeminiImage(file)));
  }

  async sendGeminiConversation(prompt, input, route, selected) {
    if (!this.geminiSession.bl) {
      const error = new Error("Gemini 页面参数还没有准备好，请重新进入车位后再试。");
      error.noRetry = true;
      throw error;
    }
    const uploads = await this.uploadGeminiImages(input.files || []);
    const request = this.buildGeminiRequest(prompt, route, uploads);
    const params = new URLSearchParams({
      bl: this.geminiSession.bl,
      hl: "zh",
      _reqid: String(Math.floor(100000 + Math.random() * 900000)),
      rt: "c"
    });
    if (this.geminiSession.sid) params.set("f.sid", this.geminiSession.sid);
    const form = new URLSearchParams({
      "f.req": JSON.stringify([null, JSON.stringify(request)])
    });
    if (this.geminiSession.at) form.set("at", this.geminiSession.at);
    const response = await this.http(`${GEMINI_REQUEST_PATH}?${params.toString()}`, {
      method: "POST",
      body: form.toString(),
      rawBody: true,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        referer: `${this.baseUrl}/app`
      }
    });
    if ([401, 403].includes(response.status)) {
      const error = new Error("Gemini 上游拒绝了当前登录会话，请重新检测账号。");
      error.status = response.status;
      error.body = response.body;
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Gemini 提交失败：${response.status}`);
      error.status = response.status;
      error.body = response.body;
      throw error;
    }

    const events = parseGeminiJsonLines(response.body);
    const directContent = extractGeminiText(events);
    const imageUrls = extractGeminiImageUrls(events, this.baseUrl);
    throwIfImageGenerationLimit(directContent);
    const upstreamError = extractGeminiErrorText(events);
    if (isImageGenerationLimitMessage(upstreamError) || /usage count has reached the limit|使用次数已达上限/i.test(upstreamError)) {
      const error = imageQuotaError("当前 Gemini 账号的使用次数已用完。");
      error.quotaReason = "chat_usage_limit";
      error.noRetry = true;
      throw error;
    }
    if (!directContent && !imageUrls.length && upstreamError) {
      const error = new Error(upstreamError);
      error.status = 400;
      error.upstreamExplicitFailure = true;
      throw error;
    }
    if (!directContent && !imageUrls.length) {
      const error = new Error("Gemini 上游没有返回文字或图片结果。");
      error.status = 502;
      error.code = "INVALID_UPSTREAM_RESPONSE";
      throw error;
    }
    const messageId = randomUUID();
    return {
      events,
      conversationId: extractGeminiConversationId(events),
      messageId,
      model: route.key,
      upstreamModel: route.model || "gemini",
      route,
      selected,
      directContent,
      imageUrls
    };
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
    if (!conversationId || route?.key === "gemini") return;
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
    const runSubmitStep = input.concurrentSubmit === true
      ? async (work) => work()
      : async (work) => this.sessionLock(work);
    for (let attempt = 0; attempt < MAX_CHAT_CAR_ATTEMPTS; attempt += 1) {
      let selected = null;
      try {
        const session = input.concurrentSubmit === true
          ? await this.prepareReusableChatSession(input, ignoredCarIds, 1)
          : await this.prepareChatSession(input, ignoredCarIds, 1);
        const { route, init } = session;
        const submitClient = input.concurrentSubmit === true ? this.createSubmitClient(session) : this;
        selected = session.selected;
        if (route.key === "grok") {
          const conversation = await runSubmitStep(() => submitClient.sendGrokConversation(prompt, input, route, selected));
          return { ...conversation, submitSessionSnapshot: submitClient.sessionSnapshot() };
        }
        if (route.key === "gemini") {
          const conversation = await runSubmitStep(() => submitClient.sendGeminiConversation(prompt, input, route, selected));
          return { ...conversation, submitSessionSnapshot: submitClient.sessionSnapshot() };
        }
        const model = route.model || init?.default_model_slug || submitClient.defaultModel || this.defaultModel;
        const imageAssets = await runSubmitStep(() => submitClient.uploadChatImages(input.files || []));
        const { body, messageId } = submitClient.buildConversationBody(prompt, model, imageAssets);

        const response = await runSubmitStep(() => submitClient.http("/backend-api/conversation", {
          method: "POST",
          body,
          headers: {
            accept: "text/event-stream",
            referer: `${this.baseUrl}/`
          }
        }));
        if (response.status < 200 || response.status >= 300) {
          throw conversationSubmitError(response);
        }

        const events = parseSse(response.body);
        throwIfImageGenerationLimit(extractAssistantText(events));
        let conversationId = "";
        for (const event of events) {
          if (event.conversation_id) conversationId = event.conversation_id;
        }
        if (input.requireConversationId && !conversationId) {
          const error = new Error("聊天站没有返回上游任务编号，不能算真正提交。");
          error.status = 502;
          error.code = "NO_UPSTREAM_TASK_ID";
          throw error;
        }
        return {
          events,
          conversationId,
          messageId,
          model: route.key || model,
          upstreamModel: model,
          route,
          selected,
          submitSessionSnapshot: submitClient.sessionSnapshot()
        };
      } catch (error) {
        if (error.noRetry || error.imageQuotaExhausted) throw error;
        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          this.rememberAuthFailedCar(selected);
          await this.sessionLock(async () => this.resetSession());
          errors.push(error.message || "调用失败");
          continue;
        }
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
    const initialContent = extractAssistantText(events);
    throwIfImageGenerationLimit(initialContent);
    let imageUrls = await this.imageUrlsFrom(events, { generatedOnly: options.generatedOnly });
    if (imageUrls.length || !conversationId) return imageUrls;
    throwIfTerminalImageFailure(initialContent);
    throwIfTextImageResponse(initialContent);

    const timeoutMs = Math.max(5, Number(timeoutSec || this.config.waitTimeoutSec || DEFAULT_CHAT_HTTP_TIMEOUT_SEC)) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const detail = await this.json(`/backend-api/conversation/${encodeURIComponent(conversationId)}`);
        const content = extractAssistantText(detail);
        throwIfImageGenerationLimit(content);
        imageUrls = await this.imageUrlsFrom(detail, { generatedOnly: true });
        if (imageUrls.length) return imageUrls;
        throwIfTerminalImageFailure(content);
        throwIfTextImageResponse(content);
        const explicitState = explicitConversationState(detail);
        if (explicitState) {
          const error = new Error(explicitState.message);
          error.upstreamExplicitFailure = true;
          error.upstreamStatus = explicitState.status;
          throw error;
        }
      } catch (error) {
        if (error.imageQuotaExhausted || error.upstreamExplicitFailure) throw error;
        // Images can appear shortly after the streamed response finishes.
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return [];
  }

  async getTask(externalId, context = {}) {
    if (!externalId) throw new Error("缺少上游任务编号。");
    await this.loginPortal();
    const readDetail = async () => {
      const payload = await this.json(`/backend-api/conversation/${encodeURIComponent(externalId)}`);
      if (!payload || typeof payload !== "object") throw new Error("上游暂时没有返回有效任务状态。");
      return payload;
    };
    let detail = null;
    try {
      detail = await readDetail();
    } catch (_directError) {
      if (context.carId) {
        this.carId = String(context.carId);
        this.carType = String(context.carType || "chatgpt");
        await this.enterCar(this.carId, this.carType);
      } else if (!this.carId) {
        await this.login();
      }
      detail = await readDetail();
    }
    const imageUrls = await this.imageUrlsFrom(detail, { generatedOnly: true });
    if (imageUrls.length) {
      return {
        externalId,
        status: "success",
        imageCount: imageUrls.length,
        imageUrls,
        errorMessage: "",
        raw: detail
      };
    }
    const content = extractAssistantText(detail);
    if (isImageGenerationLimitMessage(content)) {
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: "上游明确返回图片生成额度不足。",
        raw: detail
      };
    }
    if (isTerminalImageFailureMessage(content)) {
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: content,
        raw: detail
      };
    }
    if (content) {
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: content,
        raw: detail
      };
    }
    const explicitState = explicitConversationState(detail);
    if (explicitState) {
      return {
        externalId,
        status: explicitState.status,
        imageCount: 0,
        imageUrls: [],
        errorMessage: explicitState.message,
        raw: detail
      };
    }
    return {
      externalId,
      status: "waiting_upstream",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "",
      raw: detail
    };
  }

  async createTextTask(input) {
    return this.runTaskWork(input, async () => {
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("请输入生图描述。");
      const result = await this.withImageQuotaFallback(prompt, { ...input, preferImageCar: true, requireConversationId: true }, async (conversation) => {
        throwIfImageGenerationLimit(extractAssistantText(conversation.events));
        await notifyImageSubmitted(input, submittedImageTask(conversation, input, prompt, "text2img"));
        if (conversation.route?.key === "gemini") {
          return { ...conversation, imageUrls: conversation.imageUrls || [] };
        }
        if (input.waitForImages === false) return { ...conversation, imageUrls: [] };
        const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
        const imageUrls = await waitClient.waitForConversationImages(conversation.events, conversation.conversationId, input.waitTimeoutSec);
        return { ...conversation, imageUrls };
      });
      const { events, conversationId, messageId, model, upstreamModel, route, selected, imageUrls } = result;

      return {
        externalId: conversationId || messageId,
        status: imageUrls.length ? "success" : "waiting_upstream",
        prompt,
        taskType: "text2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        raw: { conversationId, eventCount: events.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, selectedCarType: selected?.carType, strategy: selected?.strategy }
      };
    });
  }

  async createImageTask(input = {}) {
    return this.runTaskWork(input, async () => {
      const files = normalizeChatFiles(input, []);
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("Please enter an image edit prompt.");
      if (!files.length) throw new Error("Please upload a source image.");

      const result = await this.withImageQuotaFallback(prompt, { ...input, files, preferImageCar: true, requireConversationId: true }, async (conversation) => {
        throwIfImageGenerationLimit(extractAssistantText(conversation.events));
        await notifyImageSubmitted(input, submittedImageTask(conversation, input, prompt, "img2img", files.length));
        if (conversation.route?.key === "gemini") {
          return { ...conversation, imageUrls: conversation.imageUrls || [] };
        }
        if (input.waitForImages === false) return { ...conversation, imageUrls: [] };
        const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
        const imageUrls = await waitClient.waitForConversationImages(conversation.events, conversation.conversationId, input.waitTimeoutSec, { generatedOnly: true });
        return { ...conversation, imageUrls };
      });
      const { events, conversationId, messageId, model, upstreamModel, route, selected, imageUrls } = result;

      return {
        externalId: conversationId || messageId,
        status: imageUrls.length ? "success" : "waiting_upstream",
        prompt,
        taskType: "img2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        raw: { conversationId, eventCount: events.length, sourceImageCount: files.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, selectedCarType: selected?.carType, strategy: selected?.strategy }
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
          let imageUrls = route?.key === "gemini"
            ? conversation.imageUrls || []
            : await this.imageUrlsFrom(events, { generatedOnly: files.length > 0 });
          let detailContent = "";
          if (conversationId && !["grok", "gemini"].includes(route?.key)) {
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
