import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  chatplusConversationUpdates,
  chatplusConversationUpdateVersion,
  getChatplusConversationConnection,
  waitForChatplusConversationUpdate
} from "../chatplus-conversation-updates.js";
import { assertInputImageCount, MAX_INPUT_IMAGE_COUNT } from "../image-limits.js";
import { normalizeProxyUrl } from "../proxy.js";
import { isImagePolicyFailureMessage } from "../task-error-policy.js";

export { isImagePolicyFailureMessage } from "../task-error-policy.js";

const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";
const ACCOUNT_CHECK_TIMEOUT_SEC = 20;
const DEFAULT_CHAT_HTTP_TIMEOUT_SEC = 300;
const DEFAULT_CONNECT_TIMEOUT_SEC = 20;
const IMAGE_TASK_LIST_CACHE_MS = 2_000;
const IMAGE_TASK_LIST_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_IMAGE_TASK_LIST_CACHES = 100;
const CONVERSATION_READ_HEADERS = Object.freeze({
  "cache-control": "no-cache",
  pragma: "no-cache"
});
const MAX_CHAT_CAR_ATTEMPTS = 8;
const BAD_CAR_TTL_MS = 15 * 60 * 1000;
const PRO_CAR_RECHECK_MS = 6 * 60 * 60 * 1000;
const UNCONFIRMED_CAR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UNCONFIRMED_CAR_ATTEMPTS = 2;
const IMAGE_CAR_RECHECK_MS = 5 * 60 * 1000;
const RECENT_IMAGE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const GEMINI_REQUEST_PATH = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_PREFLIGHT_PATH = "/_/BardChatUi/data/batchexecute";
const GEMINI_UPLOAD_PREFLIGHT_RPC_ID = "ESY5D";
const GEMINI_CONVERSATION_RPC_ID = "hNvQHb";
const GEMINI_CONVERSATION_RELOAD_LIMIT = 3;
const GEMINI_UPLOAD_START_PATH = "/gemini/push/upload/";
const GEMINI_DEFAULT_BUILD_LABEL = "boq_assistant-bard-web-server_20260525.09_p0";
const GEMINI_DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz";
const GEMINI_FASTEST_MODEL = "gemini-3.5-flash-lite";
const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";
const GEMINI_IMAGE_MODEL = "gemini-3.1-pro";
const GEMINI_WEB_MODELS = Object.freeze({
  "gemini-3.5-flash-lite": Object.freeze({ hash: "8c46e95b1a07cecc", mode: 6 }),
  "gemini-3.7-flash": Object.freeze({ hash: "56fdd199312815e2", mode: 1 }),
  "gemini-3.1-pro": Object.freeze({ hash: "e6fa609c3fa255c0", mode: 3 })
});
const GEMINI_THINKING_LEVELS = Object.freeze({ standard: 1, extended: 2 });
const GEMINI_REASONING_EFFORTS = Object.freeze({
  none: "standard",
  minimal: "standard",
  low: "standard",
  medium: "standard",
  standard: "standard",
  high: "extended",
  xhigh: "extended",
  max: "extended",
  ultra: "extended",
  extended: "extended"
});
const GROK_DIRECT_UPLOAD_PATHS = [
  "/grok/http/upload-file-v2/direct",
  "/http/upload-file-v2/direct"
];
const GROK_LEGACY_UPLOAD_PATH = "/rest/app-chat/upload-file";
const GROK_IMAGE_EDIT_MODEL = "imagine-image-edit";
const GROK_IMAGE_UPLOAD_SOURCE = "IMAGINE_SELF_UPLOAD_FILE_SOURCE";
const GROK_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const GROK_STATSIG_EPOCH = 1682924400;
const GROK_STATSIG_SALT = "obfiowerehiring";
const GROK_STATSIG_MARK = 0x03;
const GROK_STATSIG_SEED = Buffer.from(
  "t2ODAFY4ozXd0K2Y8MdI2XfxTDiJoakZPuoaKfcQn8VuasZMcKliyhA1pJ+o1oMf",
  "base64"
);
const GROK_STATSIG_FINGERPRINT = "3bab9506b851eb851eb840e8f5c28f5c28f80e8f5c28f5c28f806b851eb851eb8400";
const badCarUntil = new Map();
const recentImageCarSuccessAt = new Map();
const imageTaskListCaches = new Map();

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

function isAccountCheckRequestTimeout(error) {
  const message = String(error?.message || "");
  return Number(error?.status || error?.statusCode || 0) === 504
    || error?.code === "ACCOUNT_CHECK_TIMEOUT"
    || /聊天站响应慢|请求超时|timeout|timed out|ETIMEDOUT|AbortError/i.test(message);
}

async function runAccountCheckStep(step, work) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isAccountCheckRequestTimeout(error)) throw error;
      lastError = error;
    }
  }

  const error = new Error(`${step}超时，聊天站连续两次没有及时响应。`);
  error.status = 504;
  error.code = "ACCOUNT_CHECK_TIMEOUT";
  error.accountCheckTimeout = true;
  error.accountCheckStep = step;
  error.cause = lastError;
  throw error;
}

function curlProcessError(code, stderr) {
  const message = stderr || `curl 退出码：${code}`;
  const error = new Error(code === 28 ? "聊天站响应慢，代理可能可用但请求超时。" : message);
  error.curlCode = code;
  if (code === 28) {
    error.status = 504;
    error.code = "CURL_TIMEOUT";
  } else if (code === 97) {
    error.code = "CURL_PROXY_ERROR";
  } else {
    error.code = `CURL_${code}`;
  }
  return error;
}

function isCurlTlsHandshakeError(error) {
  return Number(error?.curlCode) === 35
    || error?.code === "CURL_35"
    || /SSL_ERROR_SYSCALL|SSL connect error|secure TLS connection was established|TLS handshake/i
      .test(String(error?.message || ""));
}

export function curlTlsCompatibilityArgs(args = []) {
  return ["--http1.1", "--tlsv1.2", "--tls-max", "1.2", ...args];
}

export async function runCurlWithTlsCompatibilityRetry(attempt, args, input = "", options = {}) {
  try {
    return await attempt(args, input, options);
  } catch (error) {
    if (!isCurlTlsHandshakeError(error)) throw error;
  }

  try {
    return await attempt(curlTlsCompatibilityArgs(args), input, options);
  } catch (error) {
    const finalError = error instanceof Error ? error : new Error(String(error || "聊天站安全连接失败。"));
    finalError.tlsCompatibilityRetryAttempted = true;
    if (isCurlTlsHandshakeError(finalError)) {
      finalError.code = "CURL_TLS_CONNECT_ERROR";
      finalError.status = 502;
      finalError.message = "聊天站安全连接失败，系统已自动使用兼容方式重试，但仍未连接成功。";
    }
    throw finalError;
  }
}

function runCurlAttempt(args, input = "", options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL_COMMAND, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let abortError = null;
    let settled = false;
    const abortWhen = typeof options.abortWhen === "function" ? options.abortWhen : null;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (data) => {
      stdout += data;
      if (!abortWhen || abortError) return;
      try {
        const candidate = abortWhen(stdout.length > 32768 ? stdout.slice(-32768) : stdout);
        if (candidate instanceof Error) {
          abortError = candidate;
          child.kill();
        }
      } catch (error) {
        abortError = error;
        child.kill();
      }
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      if (abortError) return;
      finishReject(error);
    });
    child.on("close", (code) => {
      if (abortError) {
        abortError.body = stdout;
        finishReject(abortError);
        return;
      }
      if (!code) {
        finishResolve(stdout);
        return;
      }
      finishReject(curlProcessError(code, stderr));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runCurl(args, input = "", options = {}) {
  return runCurlWithTlsCompatibilityRetry(runCurlAttempt, args, input, options);
}

function runCurlBufferAttempt(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL_COMMAND, args, { windowsHide: true });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout.push(Buffer.from(data));
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(curlProcessError(code, stderr));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runCurlBuffer(args, input = "") {
  return runCurlWithTlsCompatibilityRetry(runCurlBufferAttempt, args, input);
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

const CURL_DOWNLOAD_MARKER = "\n__SHAREAI_DOWNLOAD_META__";

function splitCurlDownload(raw) {
  const marker = Buffer.from(CURL_DOWNLOAD_MARKER);
  const index = raw.lastIndexOf(marker);
  if (index < 0) {
    const error = new Error("图片下载结果不完整，请稍后重试。");
    error.code = "INVALID_IMAGE_DOWNLOAD";
    throw error;
  }
  const meta = raw.subarray(index + marker.length).toString("utf8");
  const [statusText = "0", contentType = ""] = meta.split(/\r?\n/, 2);
  return {
    status: Number(statusText) || 0,
    contentType: contentType.trim(),
    buffer: raw.subarray(0, index)
  };
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

function rememberBadCar(accountId, carType, carId, until = Date.now() + BAD_CAR_TTL_MS) {
  if (!carId) return;
  badCarUntil.set(badCarKey(accountId, carType, carId), until);
}

function rememberImageCarSuccess(accountId, carType, carId) {
  if (!carId) return false;
  const key = badCarKey(accountId, carType, carId);
  const hadCooldown = badCarUntil.has(key);
  badCarUntil.delete(key);
  recentImageCarSuccessAt.set(key, Date.now());
  return hadCooldown;
}

function recentImageCarSuccess(accountId, carType, carId) {
  const key = badCarKey(accountId, carType, carId);
  const succeededAt = recentImageCarSuccessAt.get(key) || 0;
  if (succeededAt > Date.now() - RECENT_IMAGE_SUCCESS_TTL_MS) return succeededAt;
  if (succeededAt) recentImageCarSuccessAt.delete(key);
  return 0;
}

function isAuthSessionError(error) {
  const text = `${error?.message || ""} ${error?.body || ""} ${error?.status || error?.statusCode || ""}`;
  return /\b(401|403)\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|登录.{0,8}(?:失效|过期)|会话.{0,8}(?:失效|过期)|其他设备登|unauthorized|forbidden|session expired/i.test(text);
}

function isExplicitAuthSessionError(error) {
  const text = `${error?.message || ""} ${error?.body || ""} ${error?.upstreamText || ""}`;
  return /\b401\b|身份验证失败|请重新登录|重新登陆|未登录|未登陆|登录.{0,8}(?:失效|过期)|会话.{0,8}(?:失效|过期)|其他设备登|聊天记录.{0,12}(?:删除|已删除)|换车继续聊|unauthorized|session expired/i.test(text);
}

function tagCarPoolUnavailable(error) {
  error.code ||= "CHAT_CAR_POOL_UNAVAILABLE";
  error.carPoolUnavailable = true;
  error.authScope = "car";
  return error;
}

function isRetryableImageSubmissionRejection(error) {
  if (error?.imageSubmissionAttempted !== true || error?.upstreamExplicitFailure !== true) return false;
  const status = Number(error?.status || error?.statusCode || 0);
  return status === 401 || (status === 403 && isExplicitAuthSessionError(error));
}

function shouldQuarantineImageSubmissionCar(error) {
  if (error?.imageSubmissionAttempted !== true) return false;
  const status = Number(error?.status || error?.statusCode || 0);
  return status >= 500 || error?.code === "INVALID_UPSTREAM_RESPONSE";
}

function isInvalidCarError(error) {
  const text = `${error?.message || ""} ${error?.body || ""} ${error?.upstreamText || ""}`;
  return error?.conversationNotCreated === true
    || error?.code === "UPSTREAM_CONVERSATION_NOT_CREATED"
    || /车队失效|车位失效|请重新选择|BardErrorInfo/.test(text);
}

function isProCarPlanMismatchError(error) {
  const text = `${error?.message || ""} ${error?.body || ""}`.replace(/\s+/g, " ");
  return /不是\s*Pro\s*用户|not.{0,12}(?:a\s+)?pro\s+user/i.test(text);
}

function isCarPlanMismatchError(error) {
  const text = `${error?.message || ""} ${error?.body || ""}`.replace(/\s+/g, " ");
  return isProCarPlanMismatchError(error)
    || /\u4e0d\u662f\s*Ultra\s*\u7528\u6237|\u5347\u7ea7\u540e\u4f7f\u7528\u8be5\u8f66|not.{0,24}ultra|ultra.{0,24}user|(?:upgrade|\u5347\u7ea7).{0,24}(?:car|\u8be5\u8f66|\u8f66\u4f4d|Ultra)/i.test(text);
}

function isChatSubscriptionExpiredText(value) {
  return /用户没有有效的\s*chatgpt\s*订阅|没有可用的\s*chatgpt\s*套餐|(?:chatgpt|gpt).{0,18}(?:订阅|套餐).{0,12}(?:过期|无效)|no valid.{0,20}(?:subscription|plan)|(?:subscription|plan).{0,20}(?:expired|invalid|not valid)/i.test(String(value || ""));
}

function chatSubscriptionExpiredError(expireAt = "") {
  const error = new Error("GPT 套餐已过期，请续费后重新检测。");
  error.code = "CHAT_SUBSCRIPTION_EXPIRED";
  error.status = 403;
  error.subscriptionExpired = true;
  error.expireAt = expireAt;
  return error;
}

function chatUsageExpired(usage = {}) {
  const expiresAt = Date.parse(usage.expireAt || "");
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
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

function imageTaskConversationId(task = {}) {
  return String(task.original_conversation_id || task.conversation_id || task.conversationId || "").trim();
}

function imageTaskMatchesConversation(task, conversationId) {
  const expected = String(conversationId || "").trim();
  const actual = imageTaskConversationId(task);
  return Boolean(expected && actual && expected === actual);
}

function imageTaskIdFrom(value, conversationId = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const taskId = imageTaskIdFrom(item, conversationId, seen);
      if (taskId) return taskId;
    }
    return "";
  }

  const taskId = String(value.task_id || value.taskId || "").trim();
  const valueConversationId = imageTaskConversationId(value);
  if (taskId && (!conversationId || !valueConversationId || valueConversationId === conversationId)) return taskId;
  for (const item of Object.values(value)) {
    const nestedTaskId = imageTaskIdFrom(item, conversationId, seen);
    if (nestedTaskId) return nestedTaskId;
  }
  return "";
}

function hasAsyncImageTaskMarker(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasAsyncImageTaskMarker(item, seen));
  if (
    value.async_status !== null && value.async_status !== undefined
    || value.image_gen_async === true
    || value.metadata?.image_gen_async === true
    || Boolean(value.async_source || value.metadata?.async_source)
    || Boolean(value.ghostrider || value.metadata?.ghostrider)
  ) return true;
  return Object.values(value).some((item) => hasAsyncImageTaskMarker(item, seen));
}

function imageTaskFailure(task = {}) {
  const status = String(task.status || task.task_status || task.state || "").trim().toLowerCase();
  if (!["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return null;
  const message = String(
    task.error_message
      || task.errorMessage
      || task.failure_reason
      || task.failureReason
      || task.error?.message
      || ""
  ).trim();
  return {
    status: ["cancelled", "canceled"].includes(status) ? "cancelled" : "failed",
    message: message || (["cancelled", "canceled"].includes(status) ? "上游已取消任务。" : "上游明确返回任务失败。")
  };
}

function pruneImageTaskListCaches(now = Date.now()) {
  for (const [key, entry] of imageTaskListCaches) {
    if (!entry.promise && now - entry.updatedAt > IMAGE_TASK_LIST_CACHE_TTL_MS) imageTaskListCaches.delete(key);
  }
  if (imageTaskListCaches.size <= MAX_IMAGE_TASK_LIST_CACHES) return;
  const excess = [...imageTaskListCaches.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, imageTaskListCaches.size - MAX_IMAGE_TASK_LIST_CACHES);
  for (const [key] of excess) imageTaskListCaches.delete(key);
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

function requestedGrokImageCount(input = {}) {
  const value = Number(input.image_count ?? input.imageCount ?? input.n ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(1, Math.round(value)));
}

function grokAspectRatio(input = {}) {
  const value = String(input.ratio_label || input.ratio || input.aspect_ratio || input.aspectRatio || input.size || "")
    .trim()
    .toLowerCase();
  const mapped = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "720x1280": "9:16",
    "1280x720": "16:9",
    "1024x1792": "2:3",
    "1792x1024": "3:2"
  }[value] || value;
  return /^(?:1:1|2:3|3:2|3:4|4:3|9:16|16:9|1:2|2:1)$/.test(mapped) ? mapped : "";
}

function safeMultipartFilename(value, fallback = "image.png") {
  const filename = String(value || fallback).replace(/[\r\n"]/g, "_").trim();
  return filename || fallback;
}

function grokMultipartBody(file, buffer) {
  const boundary = `----ShareAIGrok${randomUUID().replaceAll("-", "")}`;
  const filename = safeMultipartFilename(file.filename);
  const mimetype = String(file.mimetype || "image/png").toLowerCase();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${mimetype}\r\n\r\n`
    ),
    buffer,
    Buffer.from(
      `\r\n--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file_source"\r\n\r\n`
      + `${GROK_IMAGE_UPLOAD_SOURCE}\r\n`
      + `--${boundary}--\r\n`
    )
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function grokUploadedFile(body) {
  let payload = null;
  try {
    payload = JSON.parse(String(body || ""));
  } catch {
    payload = null;
  }
  const metadata = payload?.fileMetadata || payload?.data?.fileMetadata || payload || {};
  const id = String(metadata.fileMetadataId || metadata.fileId || metadata.id || "").trim();
  const uri = String(metadata.fileUri || metadata.uri || metadata.url || "").trim();
  if (!id) {
    const error = new Error("Grok 图片上传成功，但没有返回图片编号。");
    error.status = 502;
    error.code = "INVALID_UPSTREAM_RESPONSE";
    throw error;
  }
  return { id, uri };
}

export function generateGrokStatsigId(method, path, options = {}) {
  const nowUnix = Math.floor(Number(options.nowUnix ?? Date.now() / 1000));
  const number = (nowUnix - GROK_STATSIG_EPOCH) >>> 0;
  const requestMethod = String(method || "GET").toUpperCase();
  const requestPath = String(path || "/");
  const digest = createHash("sha256")
    .update(`${requestMethod}!${requestPath}!${number}${GROK_STATSIG_SALT}${GROK_STATSIG_FINGERPRINT}`)
    .digest();
  const key = Number.isInteger(options.randomKey)
    ? options.randomKey & 0xff
    : randomBytes(1)[0];
  const output = Buffer.alloc(70);

  output[0] = key;
  for (let index = 0; index < GROK_STATSIG_SEED.length; index += 1) {
    output[index + 1] = GROK_STATSIG_SEED[index] ^ key;
  }
  output.writeUInt32LE(number, 49);
  for (let index = 49; index < 53; index += 1) output[index] ^= key;
  for (let index = 0; index < 16; index += 1) output[index + 53] = digest[index] ^ key;
  output[69] = GROK_STATSIG_MARK ^ key;

  return output.toString("base64").replace(/=+$/, "");
}

function absoluteGrokImageUrl(value, baseUrl) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/^https:\/\//i.test(source)) return source;
  if (/^\/?users\//i.test(source)) return `https://assets.grok.com/${source.replace(/^\/+/, "")}`;
  if (source.startsWith("/")) return `${trimSlash(baseUrl)}${source}`;
  return "";
}

function isFinalGrokImageUrl(value) {
  const source = String(value || "").trim();
  if (!source || /-part-/i.test(source)) return false;
  try {
    const url = new URL(source);
    return ["assets.grok.com", "imagine-public.x.ai", "imgen.x.ai"].includes(url.hostname.toLowerCase())
      || /\/generated\//i.test(url.pathname)
      || /\/image_generation_content\//i.test(url.pathname);
  } catch {
    return /^\/?users\/.+\/generated\//i.test(source);
  }
}

function collectGrokImageUrls(value, baseUrl, output = [], seen = new Set()) {
  if (!value) return output;
  if (typeof value === "string") {
    const text = value.trim();
    if ((text.startsWith("{") || text.startsWith("[")) && !seen.has(text)) {
      try {
        seen.add(text);
        collectGrokImageUrls(JSON.parse(text), baseUrl, output, seen);
      } catch {
        // Some Grok response fields contain ordinary text rather than encoded JSON.
      }
    }
    for (const match of text.matchAll(/!\[[^\]]*]\((https:\/\/[^)\s]+)\)/gi)) {
      const url = absoluteGrokImageUrl(match[1], baseUrl);
      if (isFinalGrokImageUrl(url) && !output.includes(url)) output.push(url);
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGrokImageUrls(item, baseUrl, output, seen));
    return output;
  }
  if (typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);

  const progress = Number(value.progress ?? value.percentage_complete ?? value.percentageComplete);
  const moderated = value.moderated === true;
  const final = value.isFinal === true
    || value.completed === true
    || String(value.current_status || value.status || "").toLowerCase() === "completed"
    || (Number.isFinite(progress) && progress >= 100);
  const directUrl = value.imageUrl || value.image_url || value.generatedImageUrl || "";
  if (!moderated && final && directUrl) {
    const url = absoluteGrokImageUrl(directUrl, baseUrl);
    if (isFinalGrokImageUrl(url) && !output.includes(url)) output.push(url);
  }

  const generatedUrls = value.generatedImageUrls || value.generated_image_urls;
  if (!moderated && Array.isArray(generatedUrls)) {
    for (const item of generatedUrls) {
      const url = absoluteGrokImageUrl(item, baseUrl);
      if (isFinalGrokImageUrl(url) && !output.includes(url)) output.push(url);
    }
  }

  Object.values(value).forEach((item) => collectGrokImageUrls(item, baseUrl, output, seen));
  return output;
}

function extractGrokImageUrls(events, baseUrl) {
  return collectGrokImageUrls(events, baseUrl);
}

function grokUpstreamError(events) {
  const values = [];
  const collect = (value, key = "") => {
    if (!value) return;
    if (typeof value === "string") {
      if (/(?:error|failed|failure|moderated|quota|limit|unavailable|not allowed|无法|失败|额度|上限|限制)/i.test(value)
        || /error|failure|rejection|streamError/i.test(key)) {
        values.push(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, key));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([nestedKey, item]) => collect(item, nestedKey));
    }
  };
  collect(events);
  return values.filter(Boolean).sort((left, right) => right.length - left.length)[0] || "";
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

function normalizeGeminiConversationId(value) {
  const id = String(value || "").trim();
  return /^c_[a-z0-9_-]{6,128}$/i.test(id) ? id : "";
}

function extractGeminiConversationId(events) {
  const ids = [];
  for (const value of nestedGeminiJson(events)) {
    for (const part of geminiResponseParts(value)) {
      const candidates = [part?.[0], Array.isArray(part?.[1]) ? part[1][0] : ""];
      for (const candidate of candidates) {
        const conversationId = normalizeGeminiConversationId(candidate);
        if (conversationId) ids.push(conversationId);
      }
    }
  }
  return ids[ids.length - 1] || "";
}

function normalizeGeminiImageUrl(value, baseUrl) {
  const text = String(value || "").trim().replace(/[),.;]+$/, "");
  if (!text) return "";
  let normalized = "";
  if (text.startsWith("//")) normalized = `https:${text}`;
  else if (text.startsWith("/")) normalized = `${baseUrl}${text}`;
  else if (/^https?:\/\//i.test(text)) normalized = text;
  return isPlaceholderGeminiImageUrl(normalized) ? "" : normalized;
}

function isPlaceholderGeminiImageUrl(value) {
  const source = String(value || "").trim();
  if (!source) return false;
  try {
    const url = new URL(source);
    return /^\/image_generation_content\/[^/]+$/i.test(url.pathname.replace(/\/+$/, ""));
  } catch {
    return /(?:^|\/)image_generation_content\/[^/?#]+(?:$|[?#])/i.test(source);
  }
}

function addGeminiImageUrl(output, value, baseUrl) {
  const normalized = normalizeGeminiImageUrl(value, baseUrl);
  if (normalized && !/\/gemini\/images\/gg\//i.test(normalized)) output.add(normalized);
}

function scanGeminiImageRefs(value, baseUrl, output = new Set()) {
  if (typeof value === "string") {
    const direct = value.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
    direct.forEach((url) => {
      if (/\/gemini\/images\/|googleusercontent\.com|image_generation/i.test(url)) {
        addGeminiImageUrl(output, url, baseUrl);
      }
    });
    const local = value.match(/\/gemini\/images\/gg-dl\/[A-Za-z0-9._~+/=-]+/g) || [];
    local.forEach((url) => addGeminiImageUrl(output, url, baseUrl));
    const protocolRelative = value.match(/\/\/[A-Za-z0-9.-]+\/(?:gemini\/images\/|image_generation\/)[^\s"'<>\\]+/gi) || [];
    protocolRelative.forEach((url) => addGeminiImageUrl(output, url, baseUrl));
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

function parseGeminiBatchPayloads(text, targetRpcId) {
  const source = String(text || "").replace(/^\)\]\}'\r?\n/, "");
  const lines = source.split(/\r?\n/).filter((line) => line.trim());
  const payloads = [];
  for (let index = 0; index < lines.length;) {
    const length = Number.parseInt(lines[index], 10);
    const line = Number.isFinite(length) ? lines[index + 1] : lines[index];
    index += Number.isFinite(length) ? 2 : 1;
    let entries = null;
    try {
      entries = JSON.parse(line || "");
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== targetRpcId) continue;
      if (typeof entry[2] !== "string") continue;
      try {
        payloads.push(JSON.parse(entry[2]));
      } catch {
        // Ignore an incomplete batch item and keep any complete payloads.
      }
    }
  }
  return payloads;
}

function addGeminiHistoryImageUrl(output, value, baseUrl) {
  const normalized = normalizeGeminiImageUrl(value, baseUrl);
  if (normalized) output.add(normalized);
}

function scanGeminiHistoryImageRefs(value, baseUrl, output) {
  if (typeof value === "string") {
    const direct = value.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
    direct.forEach((url) => addGeminiHistoryImageUrl(output, url, baseUrl));
    const local = value.match(/\/gemini\/images\/gg(?:-dl)?\/[A-Za-z0-9._~+/=-]+/g) || [];
    local.forEach((url) => addGeminiHistoryImageUrl(output, url, baseUrl));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => scanGeminiHistoryImageRefs(item, baseUrl, output));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => scanGeminiHistoryImageRefs(item, baseUrl, output));
  }
}

function extractGeminiHistoryImageUrls(payloads, baseUrl) {
  const output = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const richContent = value[12];
      if (Array.isArray(richContent) && Array.isArray(richContent[7])) {
        scanGeminiHistoryImageRefs(richContent[7], baseUrl, output);
      }
      value.forEach(visit);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(payloads);
  return [...output];
}

function extractGeminiHistoryText(payloads) {
  const output = [];
  const visit = (value) => {
    if (!Array.isArray(value)) {
      if (value && typeof value === "object") Object.values(value).forEach(visit);
      return;
    }
    if (
      typeof value[0] === "string"
      && value[0].startsWith("rc_")
      && Array.isArray(value[1])
      && typeof value[1][0] === "string"
      && value[1][0].trim()
    ) {
      output.push(value[1][0].trim());
    }
    value.forEach(visit);
  };
  visit(payloads);
  return output[output.length - 1] || "";
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
  assertInputImageCount(
    files.length,
    `对话最多只能上传 ${MAX_INPUT_IMAGE_COUNT} 张图片。`
  );
  return files;
}

function geminiRouteMetadata(route = {}) {
  if (route.key !== "gemini") return {};
  return {
    requestedModel: route.geminiRequestedModel || "gemini",
    thinkingLevel: route.thinkingLevel || "standard",
    parameterFallback: route.geminiParameterFallback === true,
    ...(route.geminiFallbackReason ? { parameterFallbackReason: route.geminiFallbackReason } : {})
  };
}

function resultChannelMetadata(conversation = {}, route = {}) {
  if (route.key !== "gpt") return {};
  return {
    resultChannelReady: conversation.resultChannelReady === true,
    ...(conversation.resultChannelError ? { resultChannelError: conversation.resultChannelError } : {}),
    ...(conversation.upstreamTaskId ? { upstreamTaskId: conversation.upstreamTaskId } : {})
  };
}

function submittedImageTask(conversation, input, prompt, taskType, sourceImageCount = 0) {
  const { events = [], conversationId, model, upstreamModel, route, selected } = conversation;
  const imageUrls = Array.isArray(conversation.imageUrls) ? conversation.imageUrls.filter(Boolean) : [];
  const upstreamText = String(conversation.directContent || "").trim();
  return {
    externalId: conversationId,
    status: "processing",
    prompt,
    taskType,
    modelId: model,
    ratio: input.ratio_label || input.ratio || "",
    imageCount: imageUrls.length,
    imageUrls,
    upstreamText,
    raw: {
      conversationId,
      eventCount: events.length,
      sourceImageCount,
      upstreamModel,
      chatModel: route?.key,
      selectedCarId: selected?.carId,
      selectedCarType: selected?.carType,
      strategy: selected?.strategy,
      ...resultChannelMetadata(conversation, route),
      ...geminiRouteMetadata(route),
      stageTimings: Array.isArray(conversation.stageTimings) ? conversation.stageTimings : [],
      ...(imageUrls.length ? {
        upstreamCompleted: true,
        upstreamStatus: "success",
        originalImageUrls: imageUrls
      } : {}),
      ...(upstreamText ? { upstreamText } : {})
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
  return /(?:(?:you(?:'|’)ve|you have) hit )?(?:the )?(?:[a-z][\w-]* ){0,3}plan limit for image generations?(?: requests?)?/i.test(text)
    || /image generation (?:request )?(?:limit|quota).*(?:reset|exhausted|reached)/i.test(text)
    || /(?:图片|图像).{0,12}(?:生成).{0,24}(?:额度|配额|上限|限制).{0,16}(?:用完|耗尽|达到|已满)/.test(text);
}

function relativeImageCarQuotaDelay(text) {
  const anchored = String(text || "").match(
    /(?:reset(?:s|ting)?|refresh(?:es|ing)?|available|try again|恢复|重置|刷新|再试).{0,160}/i
  )?.[0] || String(text || "").match(
    /(?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|秒钟?|分钟|小时|天)\s*(?:and|和)?\s*){1,4}.{0,40}?(?:后|later)/i
  )?.[0] || "";
  if (!anchored) return 0;

  let totalMs = 0;
  const durations = anchored.matchAll(
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|秒钟?|分钟|小时|天)/gi
  );
  for (const duration of durations) {
    const amount = Number(duration[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(duration[2] || "").toLowerCase();
    const unitMs = /天|day/.test(unit)
      ? 24 * 60 * 60 * 1000
      : /小时|hour|hr/.test(unit)
        ? 60 * 60 * 1000
        : /分钟|minute|min/.test(unit)
          ? 60 * 1000
          : 1000;
    totalMs += amount * unitMs;
  }
  return totalMs;
}

function imageCarQuotaRetryAt(content, now = Date.now()) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  const absolute = text.match(/\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|\s*[+-]\d{2}:?\d{2})?)?)/)?.[1];
  if (absolute) {
    const parsed = Date.parse(absolute.replace(/\//g, "-"));
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }

  const delayMs = relativeImageCarQuotaDelay(text);
  return delayMs > 0 ? now + delayMs : 0;
}

function imageCarQuotaError(content = "") {
  const retryAt = imageCarQuotaRetryAt(content);
  const error = new Error(retryAt
    ? `当前车位的图片生成次数已用完，将在 ${new Date(retryAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 恢复，正在切换其他车位。`
    : "当前车位的图片生成次数已用完，正在切换其他车位，稍后会自动重新检测。");
  error.imageCarQuotaExhausted = true;
  error.upstreamText = String(content || "").replace(/\s+/g, " ").trim();
  error.quotaResetAt = retryAt ? new Date(retryAt).toISOString() : "";
  error.status = 429;
  return error;
}

function imageQuotaError(message = "图片生成额度已用完。") {
  const error = new Error(message);
  error.imageQuotaExhausted = true;
  error.quotaEmpty = true;
  error.quotaReason = "image_quota";
  error.quotaConfirmedByUpstream = true;
  error.status = 429;
  return error;
}

function isImageRateLimitMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /(?:rate limit|too many requests|request frequency)/i.test(text)
    || /(?:生成频率|请求频率|访问频率).{0,20}(?:达到限制|过高|受限)/.test(text)
    || /(?:速率限制|请求过于频繁)/.test(text);
}

function isTerminalImageFailureMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return isImagePolicyFailureMessage(text)
    || isImageRateLimitMessage(text)
    || /(?:can't|cannot|unable to|won't)\s+(?:create|generate|help with).{0,120}(?:image|content|request)/i.test(text)
    || /(?:无法生成|不能生成)/.test(text);
}

function throwIfTerminalImageFailure(content, options = {}) {
  const message = String(content || "").trim();
  const policyFailure = isImagePolicyFailureMessage(message);
  const rateLimited = isImageRateLimitMessage(message);
  const failed = options.policyOnly
    ? policyFailure
    : (policyFailure || rateLimited || isTerminalImageFailureMessage(message));
  if (!failed) return;
  const error = new Error(message);
  error.upstreamExplicitFailure = true;
  error.upstreamStatus = "failed";
  error.upstreamText = message;
  error.status = rateLimited ? 429 : 400;
  error.code = policyFailure
    ? "content_policy"
    : (rateLimited ? "rate_limit" : "upstream_text_response");
  throw error;
}

function isImagePromptEnvelope(content) {
  const message = String(content || "").trim();
  if (!message.startsWith("{") || !message.endsWith("}")) return false;
  try {
    const payload = JSON.parse(message);
    if (payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && Object.keys(payload).length === 1
      && typeof payload.prompt === "string"
      && Boolean(payload.prompt.trim())) return true;
    return isImageGenerationParametersEnvelope(payload);
  } catch {
    return false;
  }
}

function isSearchToolAction(content) {
  let text = String(content || "").trim();
  if (!text) return false;
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") text = parsed.trim();
    } catch {
      // Keep the original text when the upstream only returned part of a JSON string.
    }
  }
  return /^(?:search|search_query|web(?:\.search|\.run)?)\s*\(/i.test(text);
}

export function isChatImageIntermediateResponse(content) {
  return isImagePromptEnvelope(content)
    || isSkippedMainlineContent(content)
    || isSearchToolAction(content);
}

function isImageGenerationParametersEnvelope(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Object.prototype.hasOwnProperty.call(payload, "prompt")
    && Object.prototype.hasOwnProperty.call(payload, "size")
    && Object.prototype.hasOwnProperty.call(payload, "n")
    && Object.prototype.hasOwnProperty.call(payload, "referenced_image_ids")
    && Array.isArray(payload.referenced_image_ids);
}

function throwIfTextImageResponse(content, options = {}) {
  const message = String(content || "").trim();
  const usableMessage = message && !isSkippedMainlineContent(message) ? message : "";
  if (!usableMessage && options.retryableCar !== true && options.requireResult !== true) return;
  const error = new Error(usableMessage || "Gemini 上游没有返回生成图。");
  error.upstreamText = usableMessage;
  error.upstreamExplicitFailure = true;
  error.upstreamStatus = "failed";
  error.status = 400;
  error.code = "upstream_text_response";
  if (options.retryableCar === true) error.retryableImageCar = true;
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

function nextShanghaiMidnight(now = Date.now()) {
  const shanghaiNow = new Date(now + 8 * 60 * 60 * 1000);
  const nextDay = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate() + 1
  ));
  return `${nextDay.toISOString().slice(0, 10)}T00:00:00+08:00`;
}

function firstPayloadField(data = {}, names = []) {
  for (const name of names) {
    const value = data?.[name];
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return "";
}

const chatUsagePayloadFields = {
  gpt: {
    quota: ["limit"],
    used: ["userUsed"],
    resetAt: ["resetTimeChatgpt"],
    period: ["per"],
    expireAt: ["expireTimeChatgpt", "chatgptExpireTime", "chatgptExpireAt", "expireAtChatgpt", "expireTime", "expireAt"]
  },
  grok: {
    quota: ["grokLimit"],
    used: ["grokUsed"],
    resetAt: ["resetTimeGrok"],
    period: ["grokPer"],
    expireAt: ["grokExpireTime", "expireTimeGrok", "grokExpireAt", "expireAtGrok", "expireTime", "expireAt"]
  },
  gemini: {
    quota: ["geminiLimit"],
    used: ["geminiUsed"],
    resetAt: ["resetTimeGemini"],
    period: ["geminiPer"],
    expireAt: [
      "geminiExpireTime",
      "expireTimeGemini",
      "geminiExpireAt",
      "expireAtGemini",
      "expireTimeChatgpt",
      "chatgptExpireTime",
      "chatgptExpireAt",
      "expireAtChatgpt",
      "expireTime",
      "expireAt"
    ]
  }
};

function chatUsageFromPayload(payload = {}, modelKey = "gpt") {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const key = chatModelKey(modelKey);
  const fields = chatUsagePayloadFields[key] || chatUsagePayloadFields.gpt;
  const quota = numberOrNull(firstPayloadField(data, fields.quota));
  const used = numberOrNull(firstPayloadField(data, fields.used));
  const balance = quota === null || used === null ? null : Math.max(0, quota - used);
  const upstreamResetAt = shanghaiDateTime(firstPayloadField(data, fields.resetAt));
  return {
    quota,
    used,
    balance,
    quotaResetAt: upstreamResetAt || (key === "gemini" && quota !== null ? nextShanghaiMidnight() : ""),
    expireAt: shanghaiDateTime(firstPayloadField(data, fields.expireAt)),
    period: String(firstPayloadField(data, fields.period) || "").trim()
  };
}

function chatUsageLimitFromText(value) {
  const text = String(value || "").trim();
  if (!/使用次数已达上限|usage count has reached the limit/i.test(text)) return null;
  const occupiedMatch = text.match(/(?:合计占用|total occupied)\s*:?\s*(\d+)\s*\/\s*(\d+)/i);
  const usedMatch = text.match(/(?:已使用|\bused)\s*:?\s*(\d+)/i);
  const remainingMatch = text.match(/(?:剩余|\bremaining)\s*:?\s*(\d+)/i);
  const resetMatch = text.match(/(?:请\s*|try again after\s*)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s*后重试)?/i);
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

function isChatUsageLimitMessage(value) {
  return /使用次数已达上限|聊天(?:使用次数|额度).{0,24}(?:已用完|用完|耗尽|达到上限)|usage count has reached the limit|chat usage.{0,24}(?:exhausted|limit reached|used up)/i.test(String(value || ""));
}

function chatUsageLimitError(message, usage = {}) {
  const error = new Error(message || "当前账号的使用次数已用完。");
  error.status = 429;
  error.code = "CHAT_USAGE_LIMIT";
  error.noRetry = true;
  error.quotaEmpty = true;
  error.quotaReason = "chat_usage_limit";
  error.quotaConfirmedByUpstream = true;
  if (usage.quota !== null && usage.quota !== undefined) error.quota = usage.quota;
  if (usage.used !== null && usage.used !== undefined) error.used = usage.used;
  if (usage.balance !== null && usage.balance !== undefined) error.balance = usage.balance;
  error.quotaResetAt = usage.quotaResetAt || "";
  error.cooldownUntil = usage.quotaResetAt || null;
  error.period = usage.period || "";
  return error;
}

function conversationSubmitError(response) {
  let payload = null;
  try {
    payload = response.body ? JSON.parse(response.body) : null;
  } catch {
    payload = null;
  }
  const payloadDetail = typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message;
  const payloadError = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
  const detail = String(payloadDetail || payload?.message || payloadError || "").trim();
  const upstreamText = detail || String(response.body || "").trim();
  const usage = chatUsageLimitFromText(detail || response.body);
  const error = usage
    ? chatUsageLimitError(
      `聊天使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`,
      usage
    )
    : new Error(detail || `聊天站提交失败：${response.status}`);
  error.status = response.status;
  error.body = response.body;
  error.upstreamText = upstreamText;
  if (response.status >= 400 && response.status < 500) {
    error.code ||= `UPSTREAM_HTTP_${response.status}`;
    error.upstreamExplicitFailure = true;
    error.upstreamStatus = "failed";
  }
  return error;
}

function isConfirmedChatUsageLimitError(error) {
  return error?.quotaConfirmedByUpstream === true
    && (error?.quotaReason === "chat_usage_limit" || error?.code === "CHAT_USAGE_LIMIT");
}

function conversationNotCreatedError(selected, detail = "", upstreamText = "") {
  const carId = String(selected?.carId || "").trim();
  const reason = String(detail || "").replace(/\s+/g, " ").trim();
  const error = new Error(
    `车位${carId ? ` ${carId}` : ""}失效：上游没有创建对话${reason ? `。上游回复：${reason}` : "。"}`
  );
  error.status = 502;
  error.code = "UPSTREAM_CONVERSATION_NOT_CREATED";
  error.conversationNotCreated = true;
  error.upstreamExplicitFailure = true;
  error.upstreamStatus = "failed";
  error.upstreamText = String(upstreamText || detail || "").trim();
  error.selectedCarId = carId;
  error.selectedCarType = String(selected?.carType || "").trim();
  return error;
}

function imageGenerationLimitContent(content) {
  if (typeof content === "string") return isImageGenerationLimitMessage(content) ? content : "";
  if (!content || typeof content !== "object") return "";
  const patchText = collectPatchText(content).join("").trim();
  const candidates = [patchText, ...collectAssistantText(content)].filter(Boolean);
  return candidates.find((candidate) => isImageGenerationLimitMessage(candidate)) || "";
}

function throwIfImageGenerationLimit(content, options = {}) {
  const limitContent = imageGenerationLimitContent(content);
  if (!limitContent) return;
  const error = options.car ? imageCarQuotaError(limitContent) : imageQuotaError();
  throw error;
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

function finalAssistantMessageText(message = {}) {
  if (message?.author?.role !== "assistant") return "";
  const contentType = String(message?.content?.content_type || "").toLowerCase();
  if (["thoughts", "reasoning_recap", "tether_browsing_display"].includes(contentType)) return "";
  if (message?.metadata?.is_visually_hidden_from_conversation === true) return "";
  const status = String(message.status || "").toLowerCase();
  const finished = message.end_turn === true
    || (
      message.end_turn !== false
      && ["finished", "finished_successfully", "complete", "completed"].includes(status)
    );
  return finished ? textFromAssistantContent(message.content) : "";
}

function collectFinalAssistantText(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFinalAssistantText(item, output));
    return output;
  }
  if (typeof value !== "object") return output;

  const direct = finalAssistantMessageText(value);
  if (direct) output.push(direct);
  const nested = finalAssistantMessageText(value.message);
  if (nested) output.push(nested);
  Object.values(value).forEach((item) => collectFinalAssistantText(item, output));
  return output;
}

function currentConversationBranchMessages(value) {
  const mapping = value?.mapping;
  let nodeId = String(value?.current_node || "").trim();
  if (!nodeId || !mapping || typeof mapping !== "object") return [];
  const messages = [];
  const visited = new Set();
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!node || typeof node !== "object") break;
    const message = node.message;
    const hidden = node.metadata?.is_visually_hidden_from_conversation === true
      || message?.metadata?.is_visually_hidden_from_conversation === true;
    if (message && !hidden) messages.push(message);
    nodeId = String(node.parent || "").trim();
  }
  return messages;
}

function scanForVisibleGeneratedImageRefs(value, baseUrl) {
  const branchMessages = currentConversationBranchMessages(value);
  if (!branchMessages.length) return scanForGeneratedImageRefs(value, baseUrl);
  const output = { urls: new Set(), fileIds: new Set() };
  for (const message of branchMessages) {
    const role = messageRole(message);
    if (role === "assistant" || role === "tool") {
      scanForImageRefs(message.content || message.parts || message, baseUrl, output);
    }
  }
  return output;
}

function assistantMessageInProgress(message = {}) {
  if (message?.author?.role !== "assistant") return false;
  const status = String(message.status || "").toLowerCase();
  return message.end_turn === false
    || ["in_progress", "processing", "pending", "running"].includes(status);
}

function hasInProgressAssistantMessage(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasInProgressAssistantMessage(item, seen));
  if (assistantMessageInProgress(value) || assistantMessageInProgress(value.message)) return true;
  return Object.values(value).some((item) => hasInProgressAssistantMessage(item, seen));
}

function imageAssistantResponseState(value) {
  const currentNode = String(value?.current_node || "").trim();
  const currentText = currentNode
    ? finalAssistantMessageText(value?.mapping?.[currentNode]?.message)
    : "";
  const finalText = currentText
    || collectFinalAssistantText(value).filter(Boolean).sort((a, b) => b.length - a.length)[0]
    || "";
  return {
    content: finalText || extractAssistantText(value),
    inProgress: !finalText && hasInProgressAssistantMessage(value)
  };
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

function isGeminiModelRequest(value) {
  const key = chatModelKey(value);
  return key === "gemini" || key.startsWith("gemini-");
}

function configuredChatModel(value, modelKey = "") {
  const model = String(value || "").trim();
  if (chatModelKey(modelKey) === "gpt" && chatModelKey(model) === "gpt-5-5-instant") return "";
  return model;
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

const gptImageModelRequestKeys = new Set([
  "1",
  "gpt-image-2",
  "chatgpt-image-2"
]);

function requestedChatModel(input = {}) {
  const requested = input.model || input.chat_model || input.chatModel || "";
  const requestedKey = chatModelKey(requested);
  if (gptImageModelRequestKeys.has(requestedKey)) return "gpt";
  if (isGeminiModelRequest(requestedKey)) return "gemini";
  if (requested) return drawingModelRequestKeys.has(requestedKey) ? "" : requested;

  const imageModel = input.model_id ?? input.modelId ?? "";
  return gptImageModelRequestKeys.has(chatModelKey(imageModel)) ? "gpt" : "";
}

const chatModelRoutes = [
  { key: "gpt", name: "GPT", carType: "chatgpt", model: "", strategy: "balanced", carTier: "auto" },
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
    model: configuredChatModel(route.model || fallback.model, key || fallback.key),
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
      model: configuredChatModel(requestedModel || settings.defaultModel || fallback.model, fallback.key)
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
  const explicit = raw.isPro ?? raw.is_pro ?? raw.isSuperPro ?? raw.is_super_pro ?? raw.superPro;
  if (explicit !== null && explicit !== undefined && explicit !== "") return truthyFlag(explicit);
  const text = rawCarText(raw, desc, label);
  return /\bpro\b|\bteam\b|\u4e13\u4e1a/i.test(text);
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
  const rawImageRemaining = raw.usage?.image_gen?.remaining ?? raw.model_limits?.image_gen?.remaining;
  return {
    id: String(raw.carID || raw.carId || raw.car_id || raw.id || "").trim(),
    carType,
    status: numeric(raw.status ?? raw.state ?? 1, 1),
    count: numeric(raw.count ?? raw.queue_count ?? 0, 0),
    cooldown: cooldowns.length ? Math.min(...cooldowns) : 0,
    desc,
    label,
    imageRemaining: numeric(rawImageRemaining, 0),
    imageRemainingKnown: rawImageRemaining !== undefined && rawImageRemaining !== null && rawImageRemaining !== "",
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

function carScore(car, strategy = "balanced", context = {}) {
  let score = 1000;
  const text = `${car.desc} ${car.label}`;
  if (car.cooldown > 0) score -= Math.min(car.cooldown, 3600) / 4;
  score -= car.count * (strategy === "speed" || strategy === "idle" ? 30 : 12);
  if (/空闲|推荐|正常/i.test(text)) score += 80;
  if (strategy === "image") {
    const knownRemaining = car.imageRemainingKnown === true
      || (car.imageRemainingKnown === undefined && Object.hasOwn(car, "imageRemaining"));
    const candidateIds = car.isVirtual && car.realCarIDs.length ? car.realCarIDs : [car.id];
    const succeededAt = knownRemaining && car.imageRemaining <= 0
      ? 0
      : Math.max(0, ...candidateIds.map((carId) => (
          recentImageCarSuccess(context.accountId, car.carType || context.carType, carId)
        )));
    if (knownRemaining && car.imageRemaining <= 0) score -= 10000;
    else if (succeededAt) score += 12000 + Math.min(1000, (succeededAt - (Date.now() - RECENT_IMAGE_SUCCESS_TTL_MS)) / 1000);
    else if (knownRemaining) score += 8000 + Math.min(car.imageRemaining, 200) * 8;
    else score += 2000;
  }
  if (strategy === "thinking") score += (car.isIQ ? 140 : 0) + (car.isPro ? 80 : 0) + (car.isSuper ? 30 : 0);
  if (strategy === "balanced") score += Math.random() * 40;
  return score;
}

function rankedCars(cars, strategy, context = {}) {
  const usable = cars.filter((car) => !isClearlyUnavailable(car));
  const source = usable.length ? usable : cars.filter((car) => car.id);
  return source
    .map((car) => ({ car, score: carScore(car, strategy, context) + Math.random() }))
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

function concreteCarId(car, context = {}) {
  if (car.isVirtual && car.realCarIDs.length) {
    const candidates = car.realCarIDs.slice(0, 5);
    const usable = candidates.filter((carId) => !isBadCar(context.accountId, car.carType || context.carType, carId));
    const source = usable.length ? usable : candidates;
    return source
      .map((carId) => ({
        carId,
        succeededAt: recentImageCarSuccess(context.accountId, car.carType || context.carType, carId),
        random: Math.random()
      }))
      .sort((left, right) => right.succeededAt - left.succeededAt || right.random - left.random)[0]?.carId || car.id;
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
    uploadClientPctx:
      firstGeminiToken(text, "Ylro7b")
      || firstGeminiToken(text, "uploadClientPctx")
      || previous.uploadClientPctx
      || "",
    sourcePath: "/app"
  };
}

function configuredGeminiModel(value) {
  const key = chatModelKey(value);
  if (GEMINI_WEB_MODELS[key]) return key;
  if (key === "3" || key.includes("pro")) return "gemini-3.1-pro";
  if (["5", "6"].includes(key) || key.includes("lite")) return GEMINI_FASTEST_MODEL;
  if (key === "1" || key.includes("flash")) return GEMINI_DEFAULT_MODEL;
  return "";
}

function geminiThinkingSelection(input = {}, route = {}) {
  const hasNativeLevel = Object.prototype.hasOwnProperty.call(input, "thinking_level")
    || Object.prototype.hasOwnProperty.call(input, "thinkingLevel");
  if (hasNativeLevel) {
    return {
      level: chatModelKey(input.thinking_level ?? input.thinkingLevel),
      field: "thinking_level"
    };
  }

  const hasReasoningEffort = Object.prototype.hasOwnProperty.call(input, "reasoning_effort")
    || Object.prototype.hasOwnProperty.call(input, "reasoningEffort")
    || Object.prototype.hasOwnProperty.call(input.reasoning || {}, "effort");
  if (hasReasoningEffort) {
    const effort = chatModelKey(
      input.reasoning_effort
        ?? input.reasoningEffort
        ?? input.reasoning?.effort
    );
    return {
      level: GEMINI_REASONING_EFFORTS[effort] || "",
      field: "reasoning_effort"
    };
  }

  return {
    level: GEMINI_THINKING_LEVELS[chatModelKey(route.thinkingLevel)]
      ? chatModelKey(route.thinkingLevel)
      : chatModelKey(route.strategy) === "thinking"
        ? "extended"
        : "standard",
    field: "thinking_level"
  };
}

function geminiRequestSelection(input = {}, route = {}) {
  const explicitModelValue = input.model || input.chat_model || input.chatModel || "";
  const explicitModel = chatModelKey(explicitModelValue);
  const configuredModel = configuredGeminiModel(route.model);
  const requestedModel = explicitModel && explicitModel !== "gemini"
    ? explicitModel
    : configuredModel
      ? configuredModel
      : GEMINI_DEFAULT_MODEL;
  const thinking = geminiThinkingSelection(input, route);
  const requestedThinkingLevel = thinking.level;
  const invalidFields = [];
  if (!GEMINI_WEB_MODELS[requestedModel]) invalidFields.push("model");
  if (!GEMINI_THINKING_LEVELS[requestedThinkingLevel]) invalidFields.push(thinking.field);
  if (invalidFields.length) {
    return {
      model: GEMINI_FASTEST_MODEL,
      thinkingLevel: "standard",
      requestedModel: explicitModel || "gemini",
      parameterFallback: true,
      fallbackReason: invalidFields.join(",")
    };
  }
  return {
    model: requestedModel,
    thinkingLevel: requestedThinkingLevel,
    requestedModel: explicitModel || "gemini",
    parameterFallback: false,
    fallbackReason: ""
  };
}

function geminiThinkingModeForRoute(route = {}) {
  const thinkingLevel = GEMINI_THINKING_LEVELS[chatModelKey(route.thinkingLevel)]
    ? chatModelKey(route.thinkingLevel)
    : chatModelKey(route.strategy) === "thinking"
      ? "extended"
      : "standard";
  return thinkingLevel === "extended" ? 0 : 4;
}

function geminiModelForRoute(route = {}) {
  return configuredGeminiModel(route.model) || GEMINI_DEFAULT_MODEL;
}

function geminiModelHeaders(route = {}) {
  const model = GEMINI_WEB_MODELS[geminiModelForRoute(route)];
  const thinkingLevel = geminiThinkingModeForRoute(route) === 0
    ? GEMINI_THINKING_LEVELS.extended
    : GEMINI_THINKING_LEVELS.standard;
  const requestId = randomUUID();
  const selector = [];
  selector[0] = 1;
  selector[4] = model.hash;
  selector[7] = 0;
  selector[8] = [4, 5, 6, 8];
  selector[11] = model.mode;
  selector[14] = model.mode;
  selector[15] = thinkingLevel;
  selector[16] = requestId;
  return {
    "x-goog-ext-525001261-jspb": JSON.stringify(selector),
    "x-goog-ext-525005358-jspb": JSON.stringify([requestId, 1]),
    "x-goog-ext-73010989-jspb": JSON.stringify([0]),
    "x-goog-ext-73010990-jspb": JSON.stringify([0, 0, 0])
  };
}

function savedProCarRestriction(account = {}, channel = {}) {
  const ability = String(channel?.ability || "");
  const abilityMeta = ability ? account.meta?.abilities?.[ability]?.meta : null;
  return (
    abilityMeta?.proCarsUnavailable === true
    && abilityMeta?.proCarsUnavailableReason === "plan_mismatch"
  ) || (
    account.meta?.chatplusProCarsUnavailable === true
    && account.meta?.chatplusProCarsUnavailableReason === "plan_mismatch"
  );
}

function savedProCarRestrictionUntil(account = {}, channel = {}) {
  if (!savedProCarRestriction(account, channel)) return 0;
  const ability = String(channel?.ability || "");
  const abilityMeta = ability ? account.meta?.abilities?.[ability]?.meta : null;
  const until = Date.parse(
    abilityMeta?.proCarsUnavailableUntil
      || account.meta?.chatplusProCarsUnavailableUntil
      || ""
  );
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

function savedImageCarCooldowns(account = {}, channel = {}) {
  const ability = String(channel?.ability || "");
  const abilityCooldowns = ability
    ? account.meta?.abilities?.[ability]?.meta?.imageCarCooldowns
    : null;
  const stored = abilityCooldowns || account.meta?.chatplusImageCarCooldowns || {};
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function restoreSavedImageCarCooldowns(account = {}, channel = {}) {
  const accountId = account?.id;
  if (!accountId) return;
  for (const cooldown of Object.values(savedImageCarCooldowns(account, channel))) {
    const carId = String(cooldown?.carId || "").trim();
    const carType = String(cooldown?.carType || "chatgpt").trim();
    const until = Date.parse(cooldown?.cooldownUntil || "");
    if (!carId || !Number.isFinite(until) || until <= Date.now()) continue;
    rememberBadCar(accountId, carType, carId, until);
  }
}

function createTaskStageRecorder(input = {}) {
  if (input.taskStageRecorder?.entries && typeof input.taskStageRecorder.record === "function") {
    return input.taskStageRecorder;
  }
  const entries = [];
  const onStage = typeof input.onStage === "function" ? input.onStage : null;
  return {
    entries,
    async record(entry) {
      const saved = {
        id: entry.id || `stage-${randomUUID()}`,
        key: String(entry.key || "").trim(),
        label: String(entry.label || "").trim(),
        status: entry.status === "failed" ? "failed" : "success",
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        durationMs: Math.max(0, Math.round(Number(entry.durationMs || 0))),
        ...(entry.carId ? { carId: String(entry.carId) } : {}),
        ...(entry.carType ? { carType: String(entry.carType) } : {}),
        ...(entry.message ? { message: String(entry.message).replace(/\s+/g, " ").trim().slice(0, 300) } : {})
      };
      entries.push(saved);
      if (onStage) {
        try {
          await onStage(saved);
        } catch (error) {
          console.error("保存任务耗时失败：", error);
        }
      }
      return saved;
    }
  };
}

function taskStageSnapshot(recorder) {
  return Array.isArray(recorder?.entries) ? recorder.entries.map((entry) => ({ ...entry })) : [];
}

async function measureTaskStage(recorder, stage, work) {
  if (!recorder) return work();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await work();
    const completedStage = typeof stage === "function" ? stage(result) : stage;
    await recorder.record({
      ...completedStage,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: performance.now() - started
    });
    return result;
  } catch (error) {
    const failedStage = typeof stage === "function" ? stage(null) : stage;
    await recorder.record({
      ...failedStage,
      status: "failed",
      message: error?.message || "处理失败",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: performance.now() - started
    });
    throw error;
  }
}

export class ChatplusClient {
  constructor({ config, channel, account, sessionLock, onProCarsUnavailable, onProCarsAvailable, onImageCarCooldown }) {
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
      uploadClientPctx: "",
      sourcePath: "/app"
    };
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    this.onProCarsUnavailable = typeof onProCarsUnavailable === "function" ? onProCarsUnavailable : null;
    this.onProCarsAvailable = typeof onProCarsAvailable === "function" ? onProCarsAvailable : null;
    this.onImageCarCooldown = typeof onImageCarCooldown === "function" ? onImageCarCooldown : null;
    this.contextSignature = this.makeContextSignature({ channel, account });
    this.accountWorks = new Map();
    this.concurrentChatSessions = new Map();
    this.completedConversationSyncs = new Map();
    this.imageTaskIds = new Map();
    this.sessionRevision = 0;
    this.proCarRestrictionSaved = savedProCarRestriction(account, channel);
    this.proCarsUnavailableUntil = savedProCarRestrictionUntil(account, channel);
    restoreSavedImageCarCooldowns(account, channel);
  }

  makeContextSignature({ channel, account }) {
    return [
      trimSlash(channel?.settings?.baseUrl || "https://www.chatplus.cc"),
      String(account?.username || "").trim().toLowerCase(),
      String(account?.password || ""),
      proxyUrlFor(account)
    ].join("::");
  }

  updateContext({ config, channel, account, sessionLock, onProCarsUnavailable, onProCarsAvailable, onImageCarCooldown }) {
    const nextSignature = this.makeContextSignature({ channel, account });
    const changed = nextSignature !== this.contextSignature;
    this.config = config;
    this.channel = channel;
    this.account = account;
    this.baseUrl = trimSlash(channel?.settings?.baseUrl || "https://www.chatplus.cc");
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    this.onProCarsUnavailable = typeof onProCarsUnavailable === "function" ? onProCarsUnavailable : null;
    this.onProCarsAvailable = typeof onProCarsAvailable === "function" ? onProCarsAvailable : null;
    this.onImageCarCooldown = typeof onImageCarCooldown === "function" ? onImageCarCooldown : null;
    restoreSavedImageCarCooldowns(account, channel);
    if (changed) {
      this.contextSignature = nextSignature;
      this.proCarRestrictionSaved = savedProCarRestriction(account, channel);
      this.proCarsUnavailableUntil = savedProCarRestrictionUntil(account, channel);
      this.resetSession();
    } else {
      this.proCarRestrictionSaved = savedProCarRestriction(account, channel);
      this.proCarsUnavailableUntil = savedProCarRestrictionUntil(account, channel);
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
    if (typeof options.abortWhen === "function") args.push("--no-buffer");
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
    const result = splitHttp(await runCurl(args, input, {
      abortWhen: options.abortWhen
    }));
    setCookiesFromHeaders(this.cookies, result.headers);
    return result;
  }

  async downloadResultImage(url, context = {}) {
    const source = new URL(String(url || ""), this.baseUrl).toString();
    const sameSite = source.startsWith(`${this.baseUrl}/`);
    const timeoutSec = Math.max(
      5,
      Math.ceil(Number(context.timeoutMs || 0) / 1000)
        || Number(context.timeoutSec || 30)
    );

    const prepareSession = async (force = false) => {
      if (!sameSite) return;
      if (force) {
        await this.sessionLock(async () => this.resetSession());
      }
      await this.loginPortal({ timeoutSec });
      const carId = String(context.carId || "");
      const carType = String(context.carType || "gemini");
      if (carId && (force || this.carId !== carId || this.carType !== carType)) {
        this.carId = carId;
        this.carType = carType;
        await this.enterCar(carId, carType, { timeoutSec });
      }
    };

    const download = async () => {
      const headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...(sameSite ? { referer: `${this.baseUrl}/app` } : {})
      };
      if (sameSite && this.cookies.length) headers.cookie = this.cookieHeader();
      const args = [
        "-sS",
        "-L",
        "--connect-timeout",
        String(Math.min(DEFAULT_CONNECT_TIMEOUT_SEC, timeoutSec)),
        "--max-time",
        String(timeoutSec)
      ];
      const proxyUrl = proxyUrlFor(this.account);
      if (proxyUrl) args.push("--proxy", proxyUrl);
      for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
      }
      args.push(
        "--output",
        "-",
        "--write-out",
        `${CURL_DOWNLOAD_MARKER}%{http_code}\n%{content_type}`,
        source
      );
      return splitCurlDownload(await runCurlBuffer(args));
    };

    await prepareSession();
    let result = await download();
    if (sameSite && [401, 403].includes(result.status)) {
      await prepareSession(true);
      result = await download();
    }
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(`图片保存失败：上游图片地址返回 ${result.status}。`);
      error.status = result.status;
      error.code = "IMAGE_DOWNLOAD_FAILED";
      throw error;
    }
    if (
      !result.contentType.toLowerCase().startsWith("image/")
      && Number(context.fileDownloadDepth || 0) === 0
      && /^\/backend-api\/files\/[^/]+\/download\/?$/i.test(new URL(source).pathname)
    ) {
      let payload = null;
      try {
        payload = JSON.parse(result.buffer.toString("utf8"));
      } catch {
        payload = null;
      }
      const nextValue = String(payload?.download_url || payload?.downloadUrl || payload?.url || "").trim();
      if (nextValue) {
        const nextUrl = new URL(nextValue, this.baseUrl);
        if (["http:", "https:"].includes(nextUrl.protocol) && nextUrl.toString() !== source) {
          return this.downloadResultImage(nextUrl.toString(), {
            ...context,
            fileDownloadDepth: 1
          });
        }
      }
    }
    if (!result.contentType.toLowerCase().startsWith("image/")) {
      const error = new Error("图片保存失败：上游返回的不是图片。");
      error.code = "INVALID_IMAGE_DOWNLOAD";
      throw error;
    }
    if (!result.buffer.length) {
      const error = new Error("图片保存失败：上游返回了空文件。");
      error.code = "INVALID_IMAGE_DOWNLOAD";
      throw error;
    }
    return {
      buffer: result.buffer,
      contentType: result.contentType
    };
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

  async conversationDetail(conversationId, options = {}) {
    const { fresh = true, ...requestOptions } = options;
    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    return this.json(fresh ? `${path}?_=${Date.now()}` : path, {
      ...requestOptions,
      headers: {
        ...CONVERSATION_READ_HEADERS,
        ...(requestOptions.headers || {})
      }
    });
  }

  conversationUpdateConnectionKey() {
    return [
      this.baseUrl,
      this.account?.id || this.account?.username || "account",
      this.carType || "chatgpt",
      this.carId || ""
    ].join("::");
  }

  async ensureConversationUpdates(options = {}) {
    if (!this.carId || this.carType !== "chatgpt") return null;
    const timeoutSec = Math.min(30, Math.max(5, Number(options.timeoutSec || DEFAULT_CONNECT_TIMEOUT_SEC)));
    const getWebSocketUrl = async () => {
      const readSocketUrl = async () => {
        const payload = await this.json("/backend-api/celsius/ws/user", { timeoutSec });
        const socketUrl = String(payload?.websocket_url || "").trim();
        if (!socketUrl.startsWith("wss://")) {
          const error = new Error("上游没有返回可用的结果通道。");
          error.code = "CHATPLUS_RESULT_CHANNEL_UNAVAILABLE";
          throw error;
        }
        return socketUrl;
      };

      try {
        return await readSocketUrl();
      } catch (error) {
        if (!isAuthSessionError(error)) throw error;
        const carId = this.carId;
        const carType = this.carType;
        await this.performPortalLogin({ timeoutSec });
        this.carId = carId;
        this.carType = carType;
        await this.performEnterCar(carId, carType, { timeoutSec });
        return readSocketUrl();
      }
    };
    const connection = getChatplusConversationConnection({
      key: this.conversationUpdateConnectionKey(),
      getWebSocketUrl,
      cookieHeader: this.cookieHeader(),
      origin: this.baseUrl,
      proxyUrl: proxyUrlFor(this.account)
    });
    return connection.ensureReady(timeoutSec * 1000);
  }

  rememberImageTaskId(conversationId, taskId) {
    const normalizedConversationId = String(conversationId || "").trim();
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedConversationId || !normalizedTaskId) return "";
    this.imageTaskIds.set(normalizedConversationId, normalizedTaskId);
    while (this.imageTaskIds.size > 250) this.imageTaskIds.delete(this.imageTaskIds.keys().next().value);
    return normalizedTaskId;
  }

  async imageGenerationTasks(options = {}) {
    pruneImageTaskListCaches();
    const key = this.conversationUpdateConnectionKey();
    const now = Date.now();
    let cache = imageTaskListCaches.get(key);
    if (cache?.promise) return cache.promise;
    if (options.fresh !== true && cache?.expiresAt > now) return cache.tasks;

    cache = cache || { tasks: [], expiresAt: 0, updatedAt: now, promise: null };
    const request = (async () => {
      const tasks = [];
      const seenCursors = new Set();
      let cursor = "";
      for (let page = 0; page < 5; page += 1) {
        const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const payload = await this.json(`/backend-api/tasks${suffix}`, {
          timeoutSec: options.timeoutSec
        });
        const pageTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
        tasks.push(...pageTasks);
        const nextCursor = String(payload?.cursor || "").trim();
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return tasks;
    })();
    cache.promise = request;
    cache.updatedAt = now;
    imageTaskListCaches.set(key, cache);
    try {
      cache.tasks = await request;
      cache.expiresAt = Date.now() + IMAGE_TASK_LIST_CACHE_MS;
      return cache.tasks;
    } catch (error) {
      imageTaskListCaches.delete(key);
      throw error;
    } finally {
      cache.promise = null;
      cache.updatedAt = Date.now();
      pruneImageTaskListCaches();
    }
  }

  async imageGenerationTaskState(conversationId, options = {}) {
    const normalizedConversationId = String(conversationId || "").trim();
    if (!normalizedConversationId) return null;
    let taskId = this.rememberImageTaskId(
      normalizedConversationId,
      options.upstreamTaskId || this.imageTaskIds.get(normalizedConversationId)
    );
    let task = null;

    if (taskId) {
      try {
        const payload = await this.json(`/backend-api/task/${encodeURIComponent(taskId)}`, {
          timeoutSec: options.timeoutSec
        });
        const directTask = payload?.task && typeof payload.task === "object" ? payload.task : payload;
        if (
          directTask
          && typeof directTask === "object"
          && (!imageTaskConversationId(directTask) || imageTaskMatchesConversation(directTask, normalizedConversationId))
        ) {
          task = directTask;
        }
      } catch {
        // Older upstream versions may not expose individual background tasks.
      }
    }

    if (!task) {
      try {
        const tasks = await this.imageGenerationTasks(options);
        task = tasks.find((item) => imageTaskMatchesConversation(item, normalizedConversationId)) || null;
        if (task) taskId = this.rememberImageTaskId(normalizedConversationId, imageTaskIdFrom(task, normalizedConversationId));
      } catch {
        return taskId ? { taskId, task: null, imageUrls: [], failure: null } : null;
      }
    }
    if (!task) return taskId ? { taskId, task: null, imageUrls: [], failure: null } : null;

    taskId = this.rememberImageTaskId(normalizedConversationId, imageTaskIdFrom(task, normalizedConversationId) || taskId);
    const imageUrls = await this.imageUrlsFrom(
      task.image_gen_message || task.messages || task,
      { generatedOnly: true }
    );
    return {
      taskId,
      task,
      imageUrls,
      failure: imageTaskFailure(task)
    };
  }

  async discoverImageGenerationTask(conversationId, events = [], options = {}) {
    const eventTaskId = imageTaskIdFrom(events, conversationId);
    if (eventTaskId) {
      this.rememberImageTaskId(conversationId, eventTaskId);
      return { taskId: eventTaskId, task: null, imageUrls: [], failure: null };
    }
    const attempts = Math.min(4, Math.max(1, Number(options.attempts || 1)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      const state = await this.imageGenerationTaskState(conversationId, {
        ...options,
        fresh: true
      });
      if (state?.taskId) return state;
    }
    return null;
  }

  async captureImageTaskRegistration(conversation, input, prompt, taskType, sourceImageCount = 0) {
    if (
      conversation?.route?.key !== "gpt"
      || conversation?.upstreamTaskId
      || !conversation?.conversationId
      || typeof input?.onSubmitted !== "function"
    ) return null;
    const reader = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
    try {
      const state = await reader.discoverImageGenerationTask(conversation.conversationId, conversation.events, {
        attempts: 1,
        timeoutSec: 5
      });
      if (!state?.taskId) return null;
      conversation.upstreamTaskId = state.taskId;
      await notifyImageSubmitted(
        input,
        submittedImageTask(conversation, input, prompt, taskType, sourceImageCount)
      );
      return state;
    } catch {
      // Realtime updates and conversation polling remain available when task registration is delayed.
      return null;
    }
  }

  async conversationStreamStatus(conversationId, options = {}) {
    const { fresh = true, ...requestOptions } = options;
    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}/stream_status`;
    return this.json(fresh ? `${path}?_=${Date.now()}` : path, {
      ...requestOptions,
      headers: {
        ...CONVERSATION_READ_HEADERS,
        referer: `${this.baseUrl}/c/${encodeURIComponent(conversationId)}`,
        ...(requestOptions.headers || {})
      }
    });
  }

  async refreshCompletedConversation(conversationId, detail, options = {}) {
    if (!conversationId || detail?.async_status === null || detail?.async_status === undefined) return detail;

    let completed = this.completedConversationSyncs.get(conversationId);
    if (!completed) {
      completed = (async () => {
        const streamStatus = await this.conversationStreamStatus(conversationId, options);
        return String(streamStatus?.status || "").trim().toUpperCase() === "COMPLETE";
      })();
      this.completedConversationSyncs.set(conversationId, completed);
    }

    try {
      if (!(await completed)) return detail;
      return await this.conversationDetail(conversationId, options);
    } catch {
      return detail;
    } finally {
      if (this.completedConversationSyncs.get(conversationId) === completed) {
        this.completedConversationSyncs.delete(conversationId);
      }
    }
  }

  async geminiConversationDetail(conversationId, options = {}) {
    const normalizedId = normalizeGeminiConversationId(conversationId);
    if (!normalizedId) {
      const error = new Error("Gemini 上游对话编号无效。");
      error.code = "INVALID_UPSTREAM_CONVERSATION_ID";
      throw error;
    }

    const routeId = normalizedId.replace(/^c_/i, "");
    const sourcePath = `/app/${encodeURIComponent(routeId)}`;
    for (let attempt = 0; attempt < GEMINI_CONVERSATION_RELOAD_LIMIT; attempt += 1) {
      const page = await this.http(`${sourcePath}?_=${Date.now()}-${attempt}`, {
        followRedirect: true,
        timeoutSec: options.timeoutSec,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...CONVERSATION_READ_HEADERS
        }
      });
      if (page.status < 200 || page.status >= 300) {
        const error = new Error(`Gemini 会话页面读取失败：${page.status}`);
        error.status = page.status;
        throw error;
      }
      this.geminiSession = geminiSessionFromPage(page.body, this.geminiSession);

      const params = new URLSearchParams({
        rpcids: GEMINI_CONVERSATION_RPC_ID,
        "source-path": sourcePath,
        hl: "zh-CN",
        rt: "c"
      });
      const requestPayload = JSON.stringify([[[
        GEMINI_CONVERSATION_RPC_ID,
        JSON.stringify([normalizedId, 1000, null, 1, [1], [4], null, 1]),
        null,
        "generic"
      ]]]);
      const form = new URLSearchParams({ "f.req": requestPayload });
      if (this.geminiSession.at) form.set("at", this.geminiSession.at);
      const response = await this.http(`${GEMINI_UPLOAD_PREFLIGHT_PATH}?${params.toString()}`, {
        method: "POST",
        body: `${form.toString()}&`,
        rawBody: true,
        timeoutSec: options.timeoutSec,
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1",
          referer: `${this.baseUrl}${sourcePath}`,
          ...CONVERSATION_READ_HEADERS
        }
      });

      let directError = "";
      try {
        directError = JSON.parse(response.body || "")?.error || "";
      } catch {
        directError = "";
      }
      if (directError === "need_reload") continue;
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`Gemini 会话详情读取失败：${response.status}`);
        error.status = response.status;
        error.body = response.body;
        throw error;
      }
      const payloads = parseGeminiBatchPayloads(response.body, GEMINI_CONVERSATION_RPC_ID);
      if (!payloads.length) {
        const error = new Error("Gemini 上游暂时没有返回有效会话内容。");
        error.code = "UPSTREAM_TASK_STATE_UNAVAILABLE";
        throw error;
      }
      return {
        conversationId: normalizedId,
        sourcePath,
        payloads
      };
    }

    const error = new Error("Gemini 会话暂时位于其他上游节点，重新连接后仍未读到结果。");
    error.code = "UPSTREAM_TASK_STATE_UNAVAILABLE";
    throw error;
  }

  resetSession() {
    this.sessionRevision += 1;
    this.cookies = [];
    this.portalLoggedIn = false;
    this.carId = "";
    this.carType = "chatgpt";
    this.geminiSession = {
      at: "",
      sid: "",
      bl: GEMINI_DEFAULT_BUILD_LABEL,
      pushId: GEMINI_DEFAULT_PUSH_ID,
      uploadClientPctx: "",
      sourcePath: "/app"
    };
    this.concurrentChatSessions.clear();
    this.completedConversationSyncs.clear();
    this.imageTaskIds.clear();
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
      revision: Number.isInteger(session.revision) ? session.revision : this.sessionRevision,
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

  async runAccountWork(work, modelKey = "") {
    const key = modelKey || "__account__";
    const previous = this.accountWorks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.accountWorks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.accountWorks.get(key) === current) this.accountWorks.delete(key);
    }
  }

  async runTaskWork(input, work) {
    if (input?.concurrentSubmit === true) return work();
    return this.runAccountWork(work, this.chatRouteForInput(input).key);
  }

  chatRouteForInput(input = {}) {
    let resolvedRoute = resolveChatModelRoute(this.channel?.settings || {}, requestedChatModel(input));
    if (resolvedRoute.key === "gemini") {
      const selection = geminiRequestSelection(input, resolvedRoute);
      resolvedRoute = {
        ...resolvedRoute,
        model: input.imageGeneration === true ? GEMINI_IMAGE_MODEL : selection.model,
        thinkingLevel: selection.thinkingLevel,
        geminiRequestedModel: selection.requestedModel,
        geminiParameterFallback: selection.parameterFallback,
        geminiFallbackReason: selection.fallbackReason
      };
    }
    if (!input.preferImageCar) return resolvedRoute;
    if (resolvedRoute.key === "gpt") return { ...resolvedRoute, strategy: "image" };
    if (resolvedRoute.key === "gemini") return { ...resolvedRoute, selectionStrategy: "image" };
    return resolvedRoute;
  }

  chatSessionKey(route = {}) {
    return [
      route.key || "",
      route.carType || "",
      route.model || "",
      route.strategy || "",
      route.thinkingLevel || "",
      route.selectionStrategy || "",
      route.carTier || ""
    ].join("::");
  }

  async prepareReusableChatSession(input = {}, ignoredCarIds = new Set(), maxAttempts = 5) {
    const route = this.chatRouteForInput(input);
    const key = this.chatSessionKey(route);
    const cached = this.concurrentChatSessions.get(key);
    if (cached?.session && cached.session.revision === this.sessionRevision) {
      const cachedCarId = cached.session.selected?.carId;
      if (
        !ignoredCarIds.has(cachedCarId)
        && !isBadCar(this.account?.id, cached.session.selected?.carType, cachedCarId)
      ) {
        if (cachedCarId) ignoredCarIds.add(cachedCarId);
        return measureTaskStage(input.taskStageRecorder, {
          key: "session_reuse",
          label: "复用已登录车位",
          carId: cachedCarId,
          carType: cached.session.selected?.carType
        }, async () => this.cloneChatSession(cached.session));
      }
      this.concurrentChatSessions.delete(key);
    } else if (cached?.session) {
      this.concurrentChatSessions.delete(key);
    }
    if (cached?.promise && cached.revision === this.sessionRevision) {
      const session = await measureTaskStage(input.taskStageRecorder, (prepared) => ({
        key: "session_reuse",
        label: "等待可复用车位",
        carId: prepared?.selected?.carId,
        carType: prepared?.selected?.carType
      }), async () => cached.promise);
      const cachedCarId = session.selected?.carId;
      if (
        !ignoredCarIds.has(cachedCarId)
        && !isBadCar(this.account?.id, session.selected?.carType, cachedCarId)
      ) {
        if (cachedCarId) ignoredCarIds.add(cachedCarId);
        return this.cloneChatSession(session);
      }
      this.concurrentChatSessions.delete(key);
    } else if (cached?.promise) {
      this.concurrentChatSessions.delete(key);
    }

    const revision = this.sessionRevision;
    const promise = this.prepareChatSession(input, ignoredCarIds, maxAttempts)
      .then((session) => this.preparedChatSession(session));
    this.concurrentChatSessions.set(key, { promise, revision });
    try {
      const session = await promise;
      if (
        session.revision === this.sessionRevision
        && this.concurrentChatSessions.get(key)?.promise === promise
      ) {
        this.concurrentChatSessions.set(key, { session });
      }
      return this.cloneChatSession(session);
    } catch (error) {
      if (this.concurrentChatSessions.get(key)?.promise === promise) this.concurrentChatSessions.delete(key);
      throw error;
    }
  }

  rememberReusableChatSession(input = {}, session = {}, submitClient = this) {
    if (input.concurrentSubmit !== true || !session?.route || !session?.selected) return;
    if (session.revision !== this.sessionRevision) return;
    const refreshed = this.cloneChatSession({
      ...session,
      snapshot: submitClient.sessionSnapshot()
    });
    this.concurrentChatSessions.set(this.chatSessionKey(session.route), { session: refreshed });
  }

  async invalidatePreparedChatSession(session = {}) {
    const preparedSession = session || {};
    const revision = Number.isInteger(preparedSession.revision)
      ? preparedSession.revision
      : this.sessionRevision;
    let invalidated = false;
    await this.sessionLock(async () => {
      if (revision !== this.sessionRevision) return;
      this.resetSession();
      invalidated = true;
    });
    return invalidated;
  }

  async performPortalLogin(options = {}) {
    return measureTaskStage(options.taskStageRecorder, {
      key: "account_login",
      label: "登录账号"
    }, async () => {
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
    });
  }

  async loginPortal(options = {}) {
    if (this.portalLoggedIn) return;
    await this.sessionLock(async () => {
      if (!this.portalLoggedIn) await this.performPortalLogin(options);
    });
  }

  async loadAccountUsages(options = {}) {
    await this.loginPortal(options);
    const payload = await this.json("/frontend-api/getme", {
      timeoutSec: options.timeoutSec
    });
    if (payload?.code !== undefined && payload.code !== 1) {
      throw new Error(payload?.msg || "读取聊天额度失败。");
    }
    return Object.fromEntries(
      ["gpt", "grok", "gemini"].map((key) => [key, chatUsageFromPayload(payload, key)])
    );
  }

  async loadAccountUsage(options = {}, modelKey = "") {
    const usages = await this.loadAccountUsages(options);
    const route = resolveChatModelRoute(this.channel?.settings || {}, modelKey);
    return usages[route.key] || usages.gpt;
  }

  async performEnterCar(carId, carType, options = {}) {
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
  }

  async enterCar(carId, carType, options = {}) {
    await this.sessionLock(() => this.performEnterCar(carId, carType, options));
  }

  async login(options = {}) {
    const route = resolveChatModelRoute(this.channel?.settings || {}, "");
    const selected = await this.selectCar(route, new Set(), options);
    this.carId = selected.carId;
    this.carType = selected.carType;
    await this.enterCar(this.carId, this.carType, options);
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
    const payload = await measureTaskStage(options.taskStageRecorder, {
      key: "car_list",
      label: "读取车位"
    }, async () => this.json(endpoint, {
      method: "POST",
      timeoutSec: options.timeoutSec,
      body: { page: 1, pageSize: 100, limit: 100 }
    }));
    if (payload?.code !== undefined && payload.code !== 1) {
      throw new Error(payload?.msg || `读取 ${carType} 车队失败。`);
    }
    const list = payload?.data?.list || payload?.data?.items || payload?.data?.records || payload?.list || payload?.items || [];
    return Array.isArray(list) ? list.map((item) => normalizeCar(item, carType)).filter((item) => item.id) : [];
  }

  async selectCar(route, ignoredCarIds = new Set(), options = {}) {
    const cars = await this.fetchCars(route.carType, options);
    const tier = effectiveCarTier(route);
    const selectionStrategy = route.selectionStrategy || route.strategy;
    const selectionContext = {
      accountId: this.account?.id,
      carType: route.carType
    };
    const proCarsUnavailable = this.proCarsUnavailableUntil > Date.now();
    if (!proCarsUnavailable && this.proCarsUnavailableUntil) this.proCarsUnavailableUntil = 0;
    const recheckProCars = proCarsUnavailable && options.recheckProCars === true;
    const candidates = rankedCars(cars, selectionStrategy, selectionContext)
      .map((car) => ({ car, carId: concreteCarId(car, selectionContext) }))
      .filter((item) => !ignoredCarIds.has(item.carId))
      .filter((item) => (
        recheckProCars && (item.car.isPro || item.car.isUltra)
          ? true
          : !isBadCar(this.account?.id, route.carType, item.carId)
      ));
    if (!candidates.length) throw new Error(`${route.name} 暂时没有可用车辆。`);
    const tierCandidates = candidates.filter((item) => carMatchesTier(item.car, tier));
    if (!tierCandidates.length) throw new Error(`${route.name} 暂时没有可用的${carTierDisplayName(tier)}车位。`);
    const usableCars = recheckProCars
      ? [
          ...tierCandidates.filter((item) => item.car.isPro || item.car.isUltra),
          ...tierCandidates.filter((item) => !item.car.isPro && !item.car.isUltra)
        ]
      : proCarsUnavailable
        ? tierCandidates.filter((item) => !item.car.isPro && !item.car.isUltra)
        : tierCandidates;
    if (!usableCars.length) {
      throw new Error(`${route.name} 当前账号不能使用 PRO 车位，普通车位也暂时不可用。`);
    }
    const selected = usableCars[0];
    return {
      carId: selected.carId,
      carType: route.carType,
      car: selected.car,
      candidateCount: usableCars.length,
      strategy: selectionStrategy || "balanced",
      carTier: tier
    };
  }

  rememberAuthFailedCar(selected) {
    rememberBadCar(this.account?.id, selected?.carType, selected?.carId);
  }

  async rememberUnconfirmedCar(selected, error = null) {
    if (!String(selected?.carId || "").trim()) return 0;
    const retryAt = Date.now() + UNCONFIRMED_CAR_TTL_MS;
    rememberBadCar(this.account?.id, selected?.carType, selected?.carId, retryAt);
    if (this.onImageCarCooldown) {
      try {
        await this.onImageCarCooldown({
          carId: String(selected.carId),
          carType: String(selected.carType || "chatgpt"),
          cooldownUntil: new Date(retryAt).toISOString(),
          reason: "conversation_not_created",
          message: String(error?.message || "上游没有创建对话")
        });
      } catch (persistError) {
        console.error("保存失效车位失败：", persistError);
      }
    }
    return retryAt;
  }

  async rememberImageFailedCar(selected, error = null) {
    if (!String(selected?.carId || "").trim()) return 0;
    const parsedResetAt = Date.parse(error?.quotaResetAt || "");
    const cooldownMs = Math.max(0, Number(selected?.car?.cooldown || 0)) * 1000;
    const retryAt = Number.isFinite(parsedResetAt) && parsedResetAt > Date.now()
      ? parsedResetAt
      : Date.now() + (cooldownMs || IMAGE_CAR_RECHECK_MS);
    rememberBadCar(this.account?.id, selected?.carType, selected?.carId, retryAt);
    if (this.onImageCarCooldown) {
      try {
        await this.onImageCarCooldown({
          carId: String(selected?.carId || ""),
          carType: String(selected?.carType || "chatgpt"),
          cooldownUntil: new Date(retryAt).toISOString(),
          reason: error?.imageCarQuotaExhausted === true ? "image_quota" : "image_failure"
        });
      } catch (persistError) {
        console.error("保存车位暂停时间失败：", persistError);
      }
    }
    return retryAt;
  }

  async rememberImageSuccessfulCar(selected) {
    const cleared = rememberImageCarSuccess(this.account?.id, selected?.carType, selected?.carId);
    if (!cleared || !this.onImageCarCooldown) return;
    try {
      await this.onImageCarCooldown({
        carId: String(selected?.carId || ""),
        carType: String(selected?.carType || "chatgpt"),
        cooldownUntil: "",
        reason: "recovered"
      });
    } catch (persistError) {
      console.error("清除车位暂停时间失败：", persistError);
    }
  }

  async rememberProCarsUnavailable(error) {
    if (isProCarPlanMismatchError(error)) {
      this.proCarRestrictionSaved = true;
      this.proCarsUnavailableUntil = Date.now() + PRO_CAR_RECHECK_MS;
      try {
        await this.onProCarsUnavailable?.({
          until: new Date(this.proCarsUnavailableUntil).toISOString()
        });
      } catch (persistError) {
        console.error("保存账号车位等级失败：", persistError);
      }
    }
  }

  async rememberProCarsAvailable() {
    if (!this.proCarRestrictionSaved) return;
    this.proCarRestrictionSaved = false;
    this.proCarsUnavailableUntil = 0;
    try {
      await this.onProCarsAvailable?.();
    } catch (persistError) {
      console.error("清除账号车位等级失败：", persistError);
    }
  }

  async prepareChatSession(input = {}, ignoredCarIds = new Set(), maxAttempts = 5) {
    const route = this.chatRouteForInput(input);
    const timeoutSec = Number(input.checkTimeoutSec || 0);
    const requestOptions = {
      ...(timeoutSec > 0 ? { timeoutSec } : {}),
      ...(input.taskStageRecorder ? { taskStageRecorder: input.taskStageRecorder } : {})
    };
    const errors = [];
    let subscriptionExpiredAttempts = 0;
    let recheckProCars = input.recheckProCars === true;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = await this.selectCar(route, ignoredCarIds, {
        ...requestOptions,
        recheckProCars
      });
      const selectedProCar = selected.car?.isPro === true || selected.car?.isUltra === true;
      if (recheckProCars && selectedProCar) recheckProCars = false;
      ignoredCarIds.add(selected.carId);
      this.carId = selected.carId;
      this.carType = selected.carType;
      try {
        await measureTaskStage(input.taskStageRecorder, {
          key: "car_enter",
          label: "进入车位",
          carId: selected.carId,
          carType: selected.carType
        }, async () => this.enterCar(selected.carId, selected.carType, requestOptions));
        const init = route.key === "gpt"
          ? await measureTaskStage(input.taskStageRecorder, {
              key: "car_init",
              label: "初始化车位",
              carId: selected.carId,
              carType: selected.carType
            }, async () => this.loadInit(requestOptions))
          : {};
        if (this.proCarRestrictionSaved && selectedProCar) {
          await this.rememberProCarsAvailable();
        }
        return { route, selected, init, revision: this.sessionRevision };
      } catch (error) {
        if (route.key === "gpt" && isChatSubscriptionExpiredText(`${error?.message || ""} ${error?.body || ""}`)) {
          subscriptionExpiredAttempts += 1;
        }
        const retryableCarError = isAuthSessionError(error) || isCarPlanMismatchError(error);
        if (retryableCarError) {
          await this.rememberProCarsUnavailable(error);
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
    const error = new Error(`${route.name} 自动找车失败：${errors.join("；")}`);
    if (route.key === "gpt" && errors.length > 0 && subscriptionExpiredAttempts === errors.length) {
      error.code = "CHAT_SUBSCRIPTION_EXPIRED";
      error.status = 403;
      error.subscriptionExpired = true;
    } else if (errors.length) {
      tagCarPoolUnavailable(error);
    }
    throw error;
  }

  async check(options = {}) {
    return this.runAccountWork(async () => {
      const requestOptions = { timeoutSec: ACCOUNT_CHECK_TIMEOUT_SEC };
      const usageRoute = resolveChatModelRoute(this.channel?.settings || {}, options.model || "");
      const referenceUsage = await runAccountCheckStep(
        "读取账号额度",
        () => this.loadAccountUsages(requestOptions)
      );
      const usage = referenceUsage[usageRoute.key] || referenceUsage.gpt;
      if (usageRoute.key === "gpt" && chatUsageExpired(usage)) {
        throw chatSubscriptionExpiredError(usage.expireAt);
      }
      const hasKnownBalance = usage?.balance !== null
        && usage?.balance !== undefined
        && String(usage.balance).trim() !== ""
        && Number.isFinite(Number(usage.balance));
      if (hasKnownBalance && Number(usage.balance) <= 0) {
        const resetAt = usage.quotaResetAt || "";
        const resetTime = Date.parse(resetAt);
        return {
          status: "quota_empty",
          quota: usage.quota,
          balance: 0,
          used: usage.used,
          quotaResetAt: resetAt,
          imageQuotaResetAt: "",
          expireAt: usage.expireAt,
          cooldownUntil: Number.isFinite(resetTime) && resetTime > Date.now() ? resetAt : null,
          quotaReason: "chat_usage_limit",
          quotaModel: usageRoute.key,
          quotaConfirmedByUpstream: true,
          period: usage.period || "",
          message: resetAt
            ? `${usageRoute.name} 额度已用完，将在额度刷新后自动恢复。`
            : `${usageRoute.name} 额度已用完，系统稍后会自动复查。`,
          meta: {
            chatModel: usageRoute.key,
            recoveryUsage: usage,
            referenceUsage
          }
        };
      }
      if (options.quotaOnly === true) {
        return {
          status: "ok",
          quota: null,
          balance: null,
          used: null,
          quotaResetAt: "",
          imageQuotaResetAt: "",
          expireAt: usage.expireAt,
          cooldownUntil: null,
          quotaReason: "",
          quotaConfirmedByUpstream: false,
          message: "聊天额度已更新",
          meta: {
            chatModel: usageRoute.key,
            recoveryUsage: usage,
            referenceUsage
          }
        };
      }
      const { init, route, selected } = await runAccountCheckStep(
        `进入 ${usageRoute.name} 页面`,
        () => this.prepareChatSession({
          model: usageRoute.key,
          preferImageCar: true,
          recheckProCars: true,
          checkTimeoutSec: ACCOUNT_CHECK_TIMEOUT_SEC
        }, new Set(), 5)
      );
      return {
        status: "ok",
        quota: null,
        balance: null,
        used: null,
        quotaResetAt: "",
        imageQuotaResetAt: "",
        expireAt: usage.expireAt,
        cooldownUntil: null,
        quotaReason: "",
        quotaConfirmedByUpstream: false,
        message: "聊天账号可用",
        meta: {
          defaultModel: init.default_model_slug || this.defaultModel,
          chatModel: route.key,
          selectedCarId: selected.carId,
          strategy: selected.strategy,
          proCarRestriction: {
            active: this.proCarRestrictionSaved && this.proCarsUnavailableUntil > Date.now(),
            until: this.proCarsUnavailableUntil > Date.now()
              ? new Date(this.proCarsUnavailableUntil).toISOString()
              : ""
          },
          recoveryUsage: usage,
          referenceUsage
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
    if (options.geminiHistory) return extractGeminiHistoryImageUrls(value?.payloads || value, this.baseUrl);
    if (options.gemini) return extractGeminiImageUrls(value, this.baseUrl);
    const refs = options.generatedOnly
      ? scanForVisibleGeneratedImageRefs(value, this.baseUrl)
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
    request[79] = GEMINI_WEB_MODELS[geminiModelForRoute(route)].mode;
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
    const preflightPayload = JSON.stringify([[[
      GEMINI_UPLOAD_PREFLIGHT_RPC_ID,
      JSON.stringify([[[["bard_activity_enabled"]]]]),
      null,
      "generic"
    ]]]);
    const preflightParams = new URLSearchParams({
      rpcids: GEMINI_UPLOAD_PREFLIGHT_RPC_ID,
      "source-path": this.geminiSession.sourcePath || "/app",
      bl: this.geminiSession.bl || GEMINI_DEFAULT_BUILD_LABEL,
      hl: "zh-CN",
      _reqid: String(Math.floor(100000 + Math.random() * 900000)),
      rt: "c"
    });
    if (this.geminiSession.sid) preflightParams.set("f.sid", this.geminiSession.sid);
    const preflightForm = new URLSearchParams({ "f.req": preflightPayload });
    if (this.geminiSession.at) preflightForm.set("at", this.geminiSession.at);
    const preflight = await this.http(`${GEMINI_UPLOAD_PREFLIGHT_PATH}?${preflightParams.toString()}`, {
      method: "POST",
      body: preflightForm.toString(),
      rawBody: true,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        referer: `${this.baseUrl}/app`
      }
    });
    if (preflight.status < 200 || preflight.status >= 300) {
      const error = new Error(`Gemini 图片上传前检查失败：${preflight.status}`);
      error.status = preflight.status;
      error.body = preflight.body;
      error.upstreamText = String(preflight.body || "").trim();
      error.noRetry = true;
      throw error;
    }
    const commonHeaders = {
      accept: "*/*",
      origin: this.baseUrl,
      referer: `${this.baseUrl}/app`,
      "push-id": this.geminiSession.pushId || GEMINI_DEFAULT_PUSH_ID,
      ...(this.geminiSession.uploadClientPctx ? { "x-client-pctx": this.geminiSession.uploadClientPctx } : {}),
      "x-goog-upload-header-content-length": String(buffer.length),
      "x-goog-upload-protocol": "resumable",
      "x-tenant-id": "bard-storage"
    };

    const start = await this.http(GEMINI_UPLOAD_START_PATH, {
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
      error.noRetry = true;
      throw error;
    }
    const uploadUrl = start.headers["x-goog-upload-url"]?.[0]
      || start.headers["x-goog-upload-control-url"]?.[0]
      || "";
    if (!uploadUrl) {
      const error = new Error("Gemini 图片上传没有返回上传地址。");
      error.noRetry = true;
      throw error;
    }

    const uploaded = await this.http(uploadUrl, {
      method: "POST",
      body: buffer,
      rawBody: true,
      headers: {
        ...commonHeaders,
        "x-goog-upload-command": "upload, finalize",
        "x-goog-upload-offset": "0"
      }
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      const error = new Error(`Gemini 图片上传失败：${uploaded.status}`);
      error.status = uploaded.status;
      error.body = uploaded.body;
      error.upstreamText = String(uploaded.body || "").trim();
      error.noRetry = true;
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

  async uploadGeminiImages(files = [], recorder = null) {
    if (!files.length) return [];
    return measureTaskStage(recorder, {
      key: "source_upload",
      label: "上传原图"
    }, async () => Promise.all(files.map((file) => this.uploadGeminiImage(file))));
  }

  async sendGeminiConversation(prompt, input, route, selected) {
    if (!this.geminiSession.bl) {
      const error = new Error("Gemini 页面参数还没有准备好，请重新进入车位后再试。");
      error.noRetry = true;
      throw error;
    }
    const uploads = await this.uploadGeminiImages(input.files || [], input.taskStageRecorder);
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
    if (input.imageSubmissionState) input.imageSubmissionState.started = true;
    const response = await measureTaskStage(input.taskStageRecorder, {
      key: "upstream_generation",
      label: "等待上游处理",
      carId: selected?.carId,
      carType: selected?.carType
    }, async () => {
      const upstreamResponse = await this.http(`${GEMINI_REQUEST_PATH}?${params.toString()}`, {
        method: "POST",
        body: form.toString(),
        rawBody: true,
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1",
          referer: `${this.baseUrl}/app`,
          ...geminiModelHeaders(route)
        }
      });
      if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
        const error = conversationSubmitError(upstreamResponse);
        if ([401, 403].includes(upstreamResponse.status)) {
          error.message = "Gemini 上游拒绝了当前登录会话，请重新检测账号。";
        }
        error.upstreamExplicitFailure = true;
        error.upstreamStatus = "failed";
        throw error;
      }
      return upstreamResponse;
    });
    const events = parseGeminiJsonLines(response.body);
    const directContent = extractGeminiText(events);
    const imageUrls = extractGeminiImageUrls(events, this.baseUrl);
    const upstreamError = extractGeminiErrorText(events);
    const conversationId = extractGeminiConversationId(events);
    const usageLimitText = [upstreamError, directContent, response.body]
      .find((value) => isChatUsageLimitMessage(value));
    if (usageLimitText) {
      const usage = chatUsageLimitFromText(response.body) || chatUsageLimitFromText(usageLimitText) || {};
      const error = chatUsageLimitError(
        `当前 Gemini 账号的使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`,
        usage
      );
      error.imageQuotaExhausted = true;
      throw error;
    }
    if (!conversationId) {
      throw conversationNotCreatedError(
        selected,
        upstreamError || "谷歌没有返回对话编号",
        response.body
      );
    }
    if (input.imageSubmissionState) input.imageSubmissionState.confirmed = true;
    throwIfImageGenerationLimit(response.body);
    throwIfImageGenerationLimit(directContent);
    if (isImageGenerationLimitMessage(upstreamError)) {
      throw imageQuotaError("当前 Gemini 账号的图片生成额度已用完。");
    }
    if (!directContent && !imageUrls.length && upstreamError) {
      const error = new Error(upstreamError);
      error.status = 400;
      error.upstreamExplicitFailure = true;
      error.upstreamText = String(response.body || upstreamError).trim();
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
      conversationId,
      messageId,
      model: route.geminiRequestedModel && route.geminiRequestedModel !== "gemini"
        ? route.model
        : route.key,
      upstreamModel: route.model || "gemini",
      route,
      selected,
      submissionConfirmed: true,
      directContent,
      imageUrls
    };
  }

  async grokStatsigId(method, path) {
    return generateGrokStatsigId(method, path);
  }

  async uploadGrokImage(file) {
    const buffer = await file.toBuffer();
    const mimetype = String(file.mimetype || "image/png").toLowerCase();
    if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimetype)) {
      const error = new Error("Grok 参考图只支持 PNG、JPG 或 WebP。");
      error.status = 400;
      error.noRetry = true;
      throw error;
    }
    if (!buffer.length || buffer.length > GROK_MAX_IMAGE_BYTES) {
      const error = new Error("Grok 参考图不能为空，且单张不能超过 25 MB。");
      error.status = 400;
      error.noRetry = true;
      throw error;
    }

    const filename = fileNameFromMime(mimetype, file.filename || `grok-image-${randomUUID()}`);
    const uploadFile = { filename, mimetype };
    const multipart = grokMultipartBody(uploadFile, buffer);
    for (const path of GROK_DIRECT_UPLOAD_PATHS) {
      const response = await this.http(path, {
        method: "POST",
        body: multipart.body,
        rawBody: true,
        timeoutSec: 60,
        headers: {
          "content-type": multipart.contentType,
          accept: "application/json, text/plain, */*",
          referer: `${this.baseUrl}/imagine`
        }
      });
      if (response.status >= 200 && response.status < 300) return grokUploadedFile(response.body);
      if (![404, 405, 410, 501].includes(response.status)) {
        const error = new Error(`Grok 参考图上传失败：${response.status}`);
        error.status = response.status || 502;
        error.noRetry = response.status >= 400 && response.status < 500;
        throw error;
      }
    }

    const legacy = await this.http(GROK_LEGACY_UPLOAD_PATH, {
      method: "POST",
      timeoutSec: 60,
      body: {
        fileName: filename,
        fileMimeType: mimetype,
        content: buffer.toString("base64"),
        fileSource: GROK_IMAGE_UPLOAD_SOURCE
      },
      headers: {
        accept: "application/json, text/plain, */*",
        referer: `${this.baseUrl}/imagine`
      }
    });
    if (legacy.status < 200 || legacy.status >= 300) {
      const error = new Error(`Grok 参考图上传失败：${legacy.status}`);
      error.status = legacy.status || 502;
      error.noRetry = legacy.status >= 400 && legacy.status < 500;
      throw error;
    }
    return grokUploadedFile(legacy.body);
  }

  async uploadGrokImages(files = [], recorder = null) {
    if (!files.length) return [];
    return measureTaskStage(recorder, {
      key: "source_upload",
      label: "上传原图"
    }, async () => {
      const uploads = [];
      for (const file of files) uploads.push(await this.uploadGrokImage(file));
      return uploads;
    });
  }

  grokImageEditBody(prompt, input, uploads) {
    const imageToImage = {
      prompt,
      inputAssets: uploads.map((upload) => upload.id),
      numOfImages: requestedGrokImageCount(input)
    };
    const aspectRatio = grokAspectRatio(input);
    if (aspectRatio) imageToImage.aspectRatio = aspectRatio;
    return {
      temporary: true,
      modelName: GROK_IMAGE_EDIT_MODEL,
      message: prompt,
      mediaGenInput: { imageToImage },
      responseMetadata: {
        modelConfigOverride: {
          modelMap: {
            imageEditModel: "imagine"
          }
        }
      },
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: requestedGrokImageCount(input),
      forceConcise: false,
      enableSideBySide: false,
      sendFinalMetadata: true,
      isReasoning: false,
      disableTextFollowUps: true,
      disableMemory: true,
      forceSideBySide: false
    };
  }

  async sendGrokConversation(prompt, input, route, selected) {
    const files = input.files || [];
    const imageGeneration = input.imageGeneration === true;
    if (files.length && !imageGeneration) {
      const error = new Error("Grok 普通对话暂不支持上传图片。");
      error.status = 400;
      error.noRetry = true;
      throw error;
    }

    const messageId = randomUUID();
    const uploads = imageGeneration && files.length
      ? await this.uploadGrokImages(files, input.taskStageRecorder)
      : [];
    const upstreamModel = uploads.length ? GROK_IMAGE_EDIT_MODEL : route.model || "grok-4";
    const imageCount = requestedGrokImageCount(input);
    const body = uploads.length
      ? this.grokImageEditBody(prompt, input, uploads)
      : {
          message: imageGeneration ? `Drawing: ${prompt}` : prompt,
          modelName: upstreamModel,
          parentResponseId: null,
          temporary: imageGeneration,
          disableSearch: false,
          enableImageGeneration: imageGeneration,
          imageAttachments: [],
          fileAttachments: [],
          returnImageBytes: false,
          returnRawGrokInXaiRequest: false,
          enableImageStreaming: imageGeneration,
          imageGenerationCount: imageGeneration ? imageCount : 1,
          forceConcise: false,
          enableSideBySide: imageGeneration,
          sendFinalMetadata: true,
          isReasoning: imageGeneration ? false : route.strategy === "thinking",
          disableTextFollowUps: imageGeneration,
          disableMemory: true
    };
    const conversationPath = "/rest/app-chat/conversations/new";
    let statsigId = imageGeneration ? await this.grokStatsigId("POST", conversationPath) : "";
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (input.imageSubmissionState) input.imageSubmissionState.started = true;
      response = await measureTaskStage(input.taskStageRecorder, {
        key: "upstream_generation",
        label: "等待上游处理",
        carId: selected?.carId,
        carType: selected?.carType
      }, async () => this.http(conversationPath, {
        method: "POST",
        body,
        headers: {
          origin: this.baseUrl,
          referer: imageGeneration ? `${this.baseUrl}/imagine` : `${this.baseUrl}/`,
          accept: "application/json, text/plain, */*",
          "cache-control": "no-cache",
          pragma: "no-cache",
          priority: "u=1, i",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "x-xai-request-id": randomUUID(),
          ...(statsigId ? { "x-statsig-id": statsigId } : {})
        }
      }));
      if (response.status !== 403
        || !imageGeneration
        || isChatUsageLimitMessage(response.body)
        || isImageGenerationLimitMessage(response.body)
        || attempt > 0) {
        break;
      }
      statsigId = await this.grokStatsigId("POST", conversationPath, true);
    }

    if (imageGeneration && isImageGenerationLimitMessage(response.body)) {
      throw imageQuotaError("当前 Grok 账号的图片生成额度已用完。");
    }
    if (isChatUsageLimitMessage(response.body)) {
      const usage = chatUsageLimitFromText(response.body) || {};
      throw chatUsageLimitError(
        `当前 Grok 账号的使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`,
        usage
      );
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      const error = new Error("Grok 上游拦截了后台直连请求，需要真实浏览器会话才能提交；当前 API 请先使用 GPT 通道。");
      error.status = 502;
      error.noRetry = true;
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Grok 提交失败：${response.status}`);
      error.body = response.body;
      error.upstreamText = String(response.body || "").trim();
      error.noRetry = true;
      throw error;
    }

    const events = parseJsonLines(response.body);
    const directContent = extractGrokAssistantText(events);
    const imageUrls = imageGeneration
      ? extractGrokImageUrls(events, this.baseUrl).slice(0, imageCount)
      : [];
    const upstreamError = grokUpstreamError(events);
    const conversationId = extractGrokConversationId(events);
    if (!conversationId) {
      throw conversationNotCreatedError(
        selected,
        upstreamError || directContent || "Grok 没有返回对话编号",
        response.body
      );
    }
    if (input.imageSubmissionState) input.imageSubmissionState.confirmed = true;
    if (imageGeneration && isImageGenerationLimitMessage(upstreamError)) {
      throw imageQuotaError("当前 Grok 账号的图片生成额度已用完。");
    }
    if (isChatUsageLimitMessage(directContent)) {
      const usage = chatUsageLimitFromText(directContent) || {};
      throw chatUsageLimitError(
        `当前 Grok 账号的使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`,
        usage
      );
    }
    if (imageGeneration && !imageUrls.length) {
      const error = new Error(upstreamError || directContent || "Grok 没有返回可用的图片。");
      error.status = isTerminalImageFailureMessage(error.message) ? 400 : 502;
      error.code = "INVALID_UPSTREAM_RESPONSE";
      error.noRetry = error.status === 400;
      throw error;
    }
    return {
      events,
      conversationId,
      messageId,
      model: route.key,
      upstreamModel,
      route,
      selected,
      submissionConfirmed: true,
      directContent,
      imageUrls
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
    const imageCarQuotaErrors = [];
    const unconfirmedCars = [];
    let carPoolErrorCount = 0;
    let lastError = null;
    let lastUpstreamText = "";
    const runSubmitStep = input.concurrentSubmit === true
      ? async (work) => work()
      : async (work) => this.sessionLock(work);
    for (let attempt = 0; attempt < MAX_CHAT_CAR_ATTEMPTS; attempt += 1) {
      let selected = null;
      let activeRoute = null;
      let preparedSession = null;
      const imageSubmissionState = { started: false };
      const requestInput = { ...input, imageSubmissionState };
      try {
        const session = input.concurrentSubmit === true
          ? await this.prepareReusableChatSession(requestInput, ignoredCarIds, 1)
          : await this.prepareChatSession(requestInput, ignoredCarIds, 1);
        preparedSession = Number.isInteger(session.revision)
          ? session
          : { ...session, revision: this.sessionRevision };
        const { route, init } = session;
        activeRoute = route;
        const submitClient = input.concurrentSubmit === true ? this.createSubmitClient(session) : this;
        selected = session.selected;
        if (route.key === "grok") {
          const conversation = await runSubmitStep(() => submitClient.sendGrokConversation(prompt, requestInput, route, selected));
          this.rememberReusableChatSession(requestInput, session, submitClient);
          return {
            ...conversation,
            submitSessionSnapshot: submitClient.sessionSnapshot(),
            stageTimings: taskStageSnapshot(requestInput.taskStageRecorder)
          };
        }
        if (route.key === "gemini") {
          const conversation = await runSubmitStep(() => submitClient.sendGeminiConversation(prompt, requestInput, route, selected));
          this.rememberReusableChatSession(requestInput, session, submitClient);
          return {
            ...conversation,
            submitSessionSnapshot: submitClient.sessionSnapshot(),
            stageTimings: taskStageSnapshot(requestInput.taskStageRecorder)
          };
        }
        const model = route.model || init?.default_model_slug || submitClient.defaultModel || this.defaultModel;
        const sourceFiles = requestInput.files || [];
        const imageAssets = sourceFiles.length
          ? await measureTaskStage(requestInput.taskStageRecorder, {
              key: "source_upload",
              label: "上传原图"
            }, async () => runSubmitStep(() => submitClient.uploadChatImages(sourceFiles)))
          : [];
        const { body, messageId } = submitClient.buildConversationBody(prompt, model, imageAssets);
        let resultChannelReady = false;
        let resultChannelError = "";
        if (requestInput.imageGeneration === true) {
          void submitClient.ensureConversationUpdates({ timeoutSec: DEFAULT_CONNECT_TIMEOUT_SEC })
            .then(() => {
              resultChannelReady = true;
            })
            .catch((error) => {
              resultChannelError = String(error?.message || "结果通道连接失败。");
            });
        }

        if (requestInput.imageSubmissionState) requestInput.imageSubmissionState.started = true;
        const response = await measureTaskStage(requestInput.taskStageRecorder, {
          key: "upstream_generation",
          label: "等待上游处理",
          carId: selected?.carId,
          carType: selected?.carType
        }, async () => runSubmitStep(() => submitClient.http("/backend-api/conversation", {
          method: "POST",
          body,
          abortWhen: requestInput.imageGeneration === true
            ? (chunk) => isImageGenerationLimitMessage(chunk) ? imageCarQuotaError(chunk) : null
            : null,
          headers: {
            accept: "text/event-stream",
            referer: `${this.baseUrl}/`
          }
        })));
        if (response.status < 200 || response.status >= 300) {
          throw conversationSubmitError(response);
        }
        if (isChatUsageLimitMessage(response.body)) {
          const usage = chatUsageLimitFromText(response.body) || {};
          throw chatUsageLimitError(
            `当前 GPT 账号的使用次数已用完${usage.quotaResetAt ? `，请等待 ${usage.quotaResetAt.replace("T", " ").replace("+08:00", "")} 刷新` : ""}。`,
            usage
          );
        }

        const events = parseSse(response.body);
        throwIfImageGenerationLimit(events, { car: requestInput.imageGeneration === true });
        let conversationId = "";
        for (const event of events) {
          if (event.conversation_id) conversationId = event.conversation_id;
        }
        if (!conversationId) {
          throw conversationNotCreatedError(
            selected,
            "GPT 没有返回对话编号",
            response.body
          );
        }
        if (requestInput.imageSubmissionState) requestInput.imageSubmissionState.confirmed = true;
        const upstreamTaskId = requestInput.imageGeneration === true
          ? submitClient.rememberImageTaskId(conversationId, imageTaskIdFrom(events, conversationId))
          : "";
        this.rememberReusableChatSession(requestInput, session, submitClient);
        return {
          events,
          conversationId,
          messageId,
          model: route.key || model,
          upstreamModel: model,
          route,
          selected,
          submissionConfirmed: true,
          upstreamTaskId,
          resultChannelReady,
          resultChannelError,
          submitSessionSnapshot: submitClient.sessionSnapshot(),
          stageTimings: taskStageSnapshot(requestInput.taskStageRecorder)
        };
      } catch (error) {
        if (activeRoute?.model) error.upstreamModel ||= activeRoute.model;
        lastError = error;
        lastUpstreamText = String(error?.upstreamText || error?.body || lastUpstreamText).trim();
        const carScopedFailure = error?.carPoolUnavailable === true
          || error?.authScope === "car"
          || Boolean(selected);
        const recordCarError = (message) => {
          errors.push(message);
          if (carScopedFailure) carPoolErrorCount += 1;
        };
        if (imageSubmissionState.started) {
          error.imageSubmissionAttempted = true;
          if (imageSubmissionState.confirmed) error.imageSubmissionConfirmed = true;
          if (selected) {
            error.selectedCarId ||= selected.carId;
            error.selectedCarType ||= selected.carType;
          }
          if (selected && shouldQuarantineImageSubmissionCar(error)) {
            await this.rememberImageFailedCar(selected);
          }
        }
        if (isConfirmedChatUsageLimitError(error)) {
          error.quotaModel = activeRoute?.key || "";
          throw error;
        }
        if (
          selected
          && !imageSubmissionState.confirmed
          && (imageSubmissionState.started || isInvalidCarError(error))
        ) {
          const carId = String(selected.carId || "").trim();
          const reason = String(error?.message || "上游没有创建对话").replace(/\s+/g, " ").trim();
          const message = error?.conversationNotCreated === true
            ? reason
            : `车位 ${carId} 失效：上游没有创建对话。具体原因：${reason}`;
          const carAttempt = {
            carId,
            carType: String(selected.carType || "").trim(),
            message,
            upstreamText: String(error?.upstreamText || error?.body || "").trim()
          };
          unconfirmedCars.push(carAttempt);
          recordCarError(message);
          await this.rememberUnconfirmedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          if (unconfirmedCars.length >= MAX_UNCONFIRMED_CAR_ATTEMPTS) {
            const failedCars = unconfirmedCars.map((item) => item.carId).filter(Boolean).join("、");
            const finalError = new Error(
              `车位失效：连续两个车位都没有创建对话${failedCars ? `（${failedCars}）` : ""}，当前任务失败。最后原因：${reason}`
            );
            finalError.status = 502;
            finalError.code = "UPSTREAM_CONVERSATION_NOT_CREATED";
            finalError.conversationNotCreated = true;
            finalError.noRetry = true;
            finalError.upstreamExplicitFailure = true;
            finalError.upstreamStatus = "failed";
            finalError.upstreamText = carAttempt.upstreamText || lastUpstreamText;
            finalError.selectedCarId = carId;
            finalError.selectedCarType = String(selected.carType || "").trim();
            finalError.upstreamModel = error.upstreamModel || activeRoute?.model || "";
            finalError.carAttempts = unconfirmedCars;
            for (const key of [
              "quotaEmpty",
              "imageQuotaExhausted",
              "quotaReason",
              "quotaConfirmedByUpstream",
              "quota",
              "used",
              "balance",
              "quotaResetAt",
              "cooldownUntil",
              "period"
            ]) {
              if (error?.[key] !== undefined) finalError[key] = error[key];
            }
            if (input.imageGeneration === true) {
              finalError.imageSubmissionAttempted = true;
              finalError.imageSubmissionConfirmed = false;
            }
            throw finalError;
          }
          continue;
        }
        if (selected && error.imageCarQuotaExhausted === true) {
          await this.rememberImageFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          imageCarQuotaErrors.push(error.message || "当前车位不能继续生图");
          continue;
        }
        if (selected && isRetryableImageSubmissionRejection(error)) {
          this.rememberAuthFailedCar(selected);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "上游拒绝了当前聊天车位");
          continue;
        }
        if (error.noRetry || error.imageQuotaExhausted || error.imageSubmissionAttempted) {
          if (error.quotaConfirmedByUpstream === true) {
            error.quotaModel = activeRoute?.key || "";
          }
          throw error;
        }
        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          await this.rememberProCarsUnavailable(error);
          this.rememberAuthFailedCar(selected);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "调用失败");
          continue;
        }
        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAuthSessionError(error)) {
          this.rememberAuthFailedCar(selected);
          await this.invalidatePreparedChatSession(preparedSession);
        }
        recordCarError(error.message || "调用失败");
      }
    }
    const error = new Error(`自动换车失败：${[...imageCarQuotaErrors, ...errors].join("；")}`);
    if (imageCarQuotaErrors.length) error.imageCarQuotaExhausted = true;
    if (!imageCarQuotaErrors.length && errors.length && carPoolErrorCount === errors.length) {
      tagCarPoolUnavailable(error);
    }
    error.upstreamModel = lastError?.upstreamModel || "";
    error.upstreamText = lastUpstreamText || String(lastError?.upstreamText || lastError?.body || "").trim();
    throw error;
  }

  async withImageQuotaFallback(prompt, input, work) {
    if (input.imageGeneration === true) {
      const ignoredCarIds = new Set();
      const quotaErrors = [];
      let lastUpstreamModel = "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let conversation = null;
        try {
          conversation = await this.sendConversation(prompt, input, ignoredCarIds);
          lastUpstreamModel = conversation.upstreamModel || conversation.route?.model || lastUpstreamModel;
          return await work(conversation);
        } catch (error) {
          if (conversation) error.upstreamModel ||= conversation.upstreamModel || conversation.route?.model || "";
          if (conversation?.selected && error.imageCarQuotaExhausted === true) {
            ignoredCarIds.add(conversation.selected.carId);
            await this.rememberImageFailedCar(conversation.selected, error);
            quotaErrors.push(error.message || "当前车位图片生成额度已用完。");
            continue;
          }
          if (conversation) {
            error.imageSubmissionAttempted = true;
            error.imageSubmissionConfirmed = conversation.submissionConfirmed !== false;
          }
          throw error;
        }
      }
      const error = new Error(`已自动尝试 ${quotaErrors.length} 个生图车位，但图片生成额度都已用完。`);
      error.imageCarQuotaExhausted = true;
      error.imageSubmissionAttempted = true;
      error.status = 429;
      error.upstreamModel = lastUpstreamModel;
      throw error;
    }
    const ignoredCarIds = new Set();
    const quotaErrors = [];
    const textResponseErrors = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let conversation = null;
      try {
        conversation = await this.sendConversation(prompt, input, ignoredCarIds);
        return await work(conversation);
      } catch (error) {
        if (conversation) error.upstreamModel ||= conversation.upstreamModel || conversation.route?.model || "";
        if (isConfirmedChatUsageLimitError(error)) throw error;
        if (error.retryableImageCar === true) {
          textResponseErrors.push(error);
          continue;
        }
        if (error.imageQuotaExhausted) {
          quotaErrors.push(error);
          continue;
        }
        throw error;
      }
    }
    if (textResponseErrors.length) {
      const lastError = textResponseErrors[textResponseErrors.length - 1];
      const attempted = quotaErrors.length + textResponseErrors.length;
      const error = new Error(
        `已自动尝试 ${attempted} 个 Gemini 生图车位，但都没有返回图片。最后一次上游回复：${lastError.message}`
      );
      error.upstreamText = lastError.upstreamText || lastError.message || "";
      error.upstreamModel = lastError.upstreamModel || "";
      error.upstreamExplicitFailure = true;
      error.upstreamStatus = "failed";
      error.status = 400;
      error.code = "upstream_text_response";
      throw error;
    }
    const lastQuotaError = quotaErrors[quotaErrors.length - 1];
    if (lastQuotaError?.quotaReason === "chat_usage_limit") throw lastQuotaError;
    const error = imageQuotaError(`已自动尝试 ${quotaErrors.length} 个生图车位，但图片生成额度都已用完。`);
    error.upstreamModel = lastQuotaError?.upstreamModel || "";
    throw error;
  }

  async waitForGeminiConversationImages(conversation, timeoutSec) {
    let imageUrls = Array.isArray(conversation?.imageUrls) ? conversation.imageUrls.filter(Boolean) : [];
    const conversationId = normalizeGeminiConversationId(conversation?.conversationId);
    if (imageUrls.length || !conversationId) return imageUrls;

    const timeoutMs = Math.max(5, Number(timeoutSec || this.config.waitTimeoutSec || DEFAULT_CHAT_HTTP_TIMEOUT_SEC)) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const detail = await this.geminiConversationDetail(conversationId, {
          timeoutSec: Math.min(30, Math.max(5, Math.ceil((deadline - Date.now()) / 1000)))
        });
        imageUrls = await this.imageUrlsFrom(detail, { geminiHistory: true });
        if (imageUrls.length) return imageUrls;
        const content = extractGeminiHistoryText(detail.payloads);
        throwIfImageGenerationLimit(content, { car: true });
        throwIfTerminalImageFailure(content);
      } catch (error) {
        if (error.imageCarQuotaExhausted || error.imageQuotaExhausted || error.upstreamExplicitFailure) throw error;
        // Gemini can move a conversation between upstream nodes while the image is finishing.
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return [];
  }

  async waitForConversationImages(events, conversationId, timeoutSec, options = {}) {
    const initialResponse = imageAssistantResponseState(events);
    const initialContent = initialResponse.content;
    const initialIntermediateResponse = isChatImageIntermediateResponse(initialContent);
    if (!initialIntermediateResponse || imageGenerationLimitContent(events)) {
      throwIfImageGenerationLimit(events, { car: true });
    }
    let imageUrls = await this.imageUrlsFrom(events, { generatedOnly: options.generatedOnly });
    if (imageUrls.length || !conversationId) return imageUrls;
    const initialTaskId = options.upstreamTaskId || imageTaskIdFrom(events, conversationId);
    this.rememberImageTaskId(conversationId, initialTaskId);
    let shouldCheckImageTasks = Boolean(initialTaskId) || hasAsyncImageTaskMarker(events);
    if (!initialIntermediateResponse && !initialResponse.inProgress) {
      throwIfTerminalImageFailure(initialContent);
      throwIfTextImageResponse(initialContent);
    }

    const timeoutMs = Math.max(5, Number(timeoutSec || this.config.waitTimeoutSec || DEFAULT_CHAT_HTTP_TIMEOUT_SEC)) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const observedUpdateVersion = chatplusConversationUpdateVersion(conversationId);
      try {
        const pushedUpdates = chatplusConversationUpdates(conversationId);
        if (pushedUpdates.length) {
          this.rememberImageTaskId(conversationId, imageTaskIdFrom(pushedUpdates, conversationId));
          shouldCheckImageTasks ||= hasAsyncImageTaskMarker(pushedUpdates);
          imageUrls = await this.imageUrlsFrom(pushedUpdates, { generatedOnly: true });
          if (imageUrls.length) return imageUrls;
          throwIfImageGenerationLimit(pushedUpdates, { car: true });
          const pushedState = imageAssistantResponseState(pushedUpdates);
          if (!pushedState.inProgress) {
            throwIfTerminalImageFailure(pushedState.content);
            throwIfTextImageResponse(pushedState.content);
          }
          const pushedExplicitState = explicitConversationState(pushedUpdates);
          if (pushedExplicitState) {
            const error = new Error(pushedExplicitState.message);
            error.upstreamExplicitFailure = true;
            error.upstreamStatus = pushedExplicitState.status;
            throw error;
          }
        }
        let detail = await this.conversationDetail(conversationId);
        this.rememberImageTaskId(conversationId, imageTaskIdFrom(detail, conversationId));
        imageUrls = await this.imageUrlsFrom(detail, { generatedOnly: true });
        if (imageUrls.length) return imageUrls;
        shouldCheckImageTasks ||= hasAsyncImageTaskMarker(detail);
        if (shouldCheckImageTasks) {
          const imageTaskState = await this.imageGenerationTaskState(conversationId, {
            upstreamTaskId: options.upstreamTaskId || this.imageTaskIds.get(conversationId),
            timeoutSec: Math.min(30, Math.max(5, Math.ceil((deadline - Date.now()) / 1000)))
          });
          if (imageTaskState?.imageUrls.length) return imageTaskState.imageUrls;
          if (imageTaskState?.failure) {
            const error = new Error(imageTaskState.failure.message);
            error.upstreamExplicitFailure = true;
            error.upstreamStatus = imageTaskState.failure.status;
            throw error;
          }
        }
        detail = await this.refreshCompletedConversation(conversationId, detail);
        imageUrls = await this.imageUrlsFrom(detail, { generatedOnly: true });
        if (imageUrls.length) return imageUrls;
        const responseState = imageAssistantResponseState(detail);
        const content = responseState.content;
        const intermediateResponse = isChatImageIntermediateResponse(content);
        if (!intermediateResponse || imageGenerationLimitContent(detail)) {
          throwIfImageGenerationLimit(detail, { car: true });
        }
        if (!intermediateResponse && !responseState.inProgress) {
          throwIfTerminalImageFailure(content);
          throwIfTextImageResponse(content);
        }
        const explicitState = explicitConversationState(detail);
        if (explicitState) {
          const error = new Error(explicitState.message);
          error.upstreamExplicitFailure = true;
          error.upstreamStatus = explicitState.status;
          throw error;
        }
      } catch (error) {
        if (error.imageCarQuotaExhausted || error.imageQuotaExhausted || error.upstreamExplicitFailure) throw error;
        // Images can appear shortly after the streamed response finishes.
      }
      await waitForChatplusConversationUpdate(
        conversationId,
        observedUpdateVersion,
        Math.min(5000, Math.max(1, deadline - Date.now()))
      );
    }
    return [];
  }

  async getTask(externalId, context = {}) {
    if (!externalId) throw new Error("缺少上游任务编号。");
    const timeoutSec = Number(context.timeoutSec || 0);
    const requestOptions = timeoutSec > 0 ? { timeoutSec } : {};
    const taskCarId = String(context.carId || "").trim();
    const taskCarType = String(context.carType || "chatgpt").trim() || "chatgpt";
    const geminiTask = taskCarType === "gemini" || Boolean(normalizeGeminiConversationId(externalId));
    const readDetail = async (reader = this) => {
      const payload = geminiTask
        ? await reader.geminiConversationDetail(externalId, requestOptions)
        : await reader.conversationDetail(externalId, requestOptions);
      if (!payload || typeof payload !== "object") {
        const error = new Error("上游暂时没有返回有效任务状态。");
        error.code = "UPSTREAM_TASK_STATE_UNAVAILABLE";
        throw error;
      }
      const payloadMessage = [payload?.detail?.message, payload?.message, payload?.msg]
        .find((value) => typeof value === "string" && value.trim());
      if (payloadMessage) {
        const payloadError = new Error(payloadMessage.trim());
        payloadError.status = payload?.status || payload?.statusCode || "";
        if (isAuthSessionError(payloadError)) throw payloadError;
      }
      return payload;
    };
    const restoreConversationSession = async (reset = false) => {
      if (taskCarId) {
        return this.sessionLock(async () => {
          if (reset) this.resetSession();
          if (!this.portalLoggedIn) await this.performPortalLogin(requestOptions);
          this.carId = taskCarId;
          this.carType = taskCarType;
          await this.performEnterCar(taskCarId, taskCarType, requestOptions);
          return this.createSubmitClient({ snapshot: this.sessionSnapshot() });
        });
      }
      if (reset) await this.sessionLock(async () => this.resetSession());
      await this.loginPortal(requestOptions);
      if (!this.carId) await this.login(requestOptions);
      return this;
    };
    let detail = null;
    let taskReader = this;
    let resultChannelReady = false;
    let resultChannelError = "";
    let resultChannelAttempt = 0;
    const beginConversationUpdates = (reader) => {
      if (geminiTask || typeof reader?.ensureConversationUpdates !== "function") return;
      const attempt = ++resultChannelAttempt;
      try {
        void reader.ensureConversationUpdates(requestOptions)
          .then((connection) => {
            if (attempt !== resultChannelAttempt) return;
            resultChannelReady = Boolean(connection);
            resultChannelError = "";
          })
          .catch((error) => {
            if (attempt !== resultChannelAttempt) return;
            resultChannelError = String(error?.message || "结果通道连接失败。");
          });
      } catch (error) {
        resultChannelError = String(error?.message || "结果通道连接失败。");
      }
    };
    const readWith = async (reader) => {
      taskReader = reader;
      beginConversationUpdates(reader);
      return readDetail(reader);
    };
    if (taskCarId) {
      try {
        detail = await readWith(await restoreConversationSession(context.forceReconnect === true));
      } catch (directError) {
        if (!isAuthSessionError(directError)) throw directError;
        detail = await readWith(await restoreConversationSession(true));
      }
    } else {
      await this.loginPortal(requestOptions);
      try {
        detail = await readWith(this);
      } catch (directError) {
        const resetAfterDirectRead = isAuthSessionError(directError);
        detail = await readWith(await restoreConversationSession(resetAfterDirectRead));
      }
    }
    const persistedUpdates = Array.isArray(context.persistedUpdates)
      ? context.persistedUpdates.filter((item) => item && typeof item === "object")
      : [];
    const pushedUpdates = geminiTask
      ? []
      : [...persistedUpdates, ...chatplusConversationUpdates(externalId)].slice(-32);
    const observedTaskId = geminiTask || typeof taskReader.rememberImageTaskId !== "function"
      ? ""
      : taskReader.rememberImageTaskId(
          externalId,
          imageTaskIdFrom([detail, ...pushedUpdates], externalId)
        );
    const imageReader = typeof taskReader.imageUrlsFrom === "function" ? taskReader : this;
    let imageUrls = pushedUpdates.length
      ? await imageReader.imageUrlsFrom(pushedUpdates, { generatedOnly: true })
      : [];
    if (!imageUrls.length) {
      imageUrls = await imageReader.imageUrlsFrom(detail, geminiTask
        ? { geminiHistory: true }
        : { generatedOnly: true });
    }
    if (!geminiTask && !imageUrls.length) {
      const refreshReader = typeof taskReader.refreshCompletedConversation === "function" ? taskReader : this;
      detail = await refreshReader.refreshCompletedConversation(externalId, detail, requestOptions);
      imageUrls = await imageReader.imageUrlsFrom(detail, { generatedOnly: true });
    }
    let imageTaskState = null;
    const shouldCheckImageTasks = Boolean(context.upstreamTaskId || observedTaskId)
      || hasAsyncImageTaskMarker(detail)
      || hasAsyncImageTaskMarker(pushedUpdates);
    if (
      !geminiTask
      && !imageUrls.length
      && shouldCheckImageTasks
      && typeof taskReader.imageGenerationTaskState === "function"
    ) {
      imageTaskState = await taskReader.imageGenerationTaskState(externalId, {
        ...requestOptions,
        upstreamTaskId: context.upstreamTaskId || observedTaskId
      });
      if (imageTaskState?.imageUrls.length) imageUrls = imageTaskState.imageUrls;
    }
    const resultParts = [detail, ...pushedUpdates, imageTaskState?.task].filter(Boolean);
    const resultState = resultParts.length === 1 ? resultParts[0] : resultParts;
    const upstreamTaskId = imageTaskState?.taskId || context.upstreamTaskId || observedTaskId || "";
    const rawDetail = !geminiTask && (
      resultChannelReady
      || resultChannelError
      || pushedUpdates.length
      || upstreamTaskId
    )
      ? {
          ...detail,
          resultChannelReady,
          resultChannelUpdateCount: pushedUpdates.length,
          ...(resultChannelError ? { resultChannelError } : {}),
          ...(upstreamTaskId ? { upstreamTaskId } : {})
        }
      : detail;
    if (imageUrls.length) {
      await this.rememberImageSuccessfulCar({
        carId: context.carId || this.carId,
        carType: context.carType || this.carType
      });
      return {
        externalId,
        status: "success",
        imageCount: imageUrls.length,
        imageUrls,
        errorMessage: "",
        raw: rawDetail
      };
    }
    if (geminiTask) {
      const content = extractGeminiHistoryText(detail.payloads);
      if (isImageGenerationLimitMessage(content)) {
        return {
          externalId,
          status: "failed",
          imageCount: 0,
          imageUrls: [],
          errorMessage: content || "当前 Gemini 车位图片生成次数已用完。",
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
      return {
        externalId,
        status: "waiting_upstream",
        imageCount: 0,
        imageUrls: [],
        errorMessage: "",
        raw: {
          ...detail,
          ...(content ? { upstreamText: content } : {})
        }
      };
    }
    const responseState = imageAssistantResponseState(resultState);
    const content = responseState.content;
    const intermediateResponse = isChatImageIntermediateResponse(content);
    const quotaContent = imageGenerationLimitContent(resultState);
    if (quotaContent) {
      const quotaError = imageCarQuotaError(quotaContent);
      await this.rememberImageFailedCar({
        carId: context.carId || this.carId,
        carType: context.carType || this.carType
      }, quotaError);
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: "当前车位图片生成次数已用完，系统已暂停使用该车位。",
        raw: {
          ...rawDetail,
          imageCarQuotaExhausted: true,
          imageCarCooldownUntil: quotaError.quotaResetAt || ""
        }
      };
    }
    if (!intermediateResponse && !responseState.inProgress && isTerminalImageFailureMessage(content)) {
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: content,
        raw: rawDetail
      };
    }
    if (!intermediateResponse && content && !responseState.inProgress) {
      return {
        externalId,
        status: "failed",
        imageCount: 0,
        imageUrls: [],
        errorMessage: content,
        raw: rawDetail
      };
    }
    const explicitState = explicitConversationState(resultState);
    if (explicitState) {
      return {
        externalId,
        status: explicitState.status,
        imageCount: 0,
        imageUrls: [],
        errorMessage: explicitState.message,
        raw: rawDetail
      };
    }
    return {
      externalId,
      status: "waiting_upstream",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "",
      raw: rawDetail
    };
  }

  async createTextTask(input) {
    return this.runTaskWork(input, async () => {
      const taskStageRecorder = createTaskStageRecorder(input);
      const trackedInput = { ...input, taskStageRecorder };
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("请输入生图描述。");
      const result = await this.withImageQuotaFallback(prompt, {
        ...trackedInput,
        imageGeneration: true,
        preferImageCar: true,
        requireConversationId: true
      }, async (conversation) => {
        await notifyImageSubmitted(input, submittedImageTask(conversation, input, prompt, "text2img"));
        await this.captureImageTaskRegistration(conversation, input, prompt, "text2img");
        throwIfImageGenerationLimit(conversation.events, { car: true });
        if (conversation.route?.key === "gemini") {
          let imageUrls = conversation.imageUrls || [];
          if (!imageUrls.length) {
            try {
              throwIfTerminalImageFailure(conversation.directContent);
            } catch (error) {
              await this.rememberImageFailedCar(conversation.selected, error);
              throw error;
            }
            if (input.waitForImages !== false) {
              const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
              imageUrls = await measureTaskStage(taskStageRecorder, {
                key: "result_wait",
                label: "等待图片完成",
                carId: conversation.selected?.carId,
                carType: conversation.selected?.carType
              }, async () => waitClient.waitForGeminiConversationImages(conversation, input.waitTimeoutSec));
            }
          }
          return { ...conversation, imageUrls };
        }
        if (conversation.route?.key === "grok") {
          const imageUrls = conversation.imageUrls || [];
          if (!imageUrls.length) throwIfTextImageResponse(conversation.directContent, { requireResult: true });
          return { ...conversation, imageUrls };
        }
        if (input.waitForImages === false) return { ...conversation, imageUrls: [] };
        const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
        const imageUrls = await measureTaskStage(taskStageRecorder, {
          key: "result_wait",
          label: "等待图片完成",
          carId: conversation.selected?.carId,
          carType: conversation.selected?.carType
        }, async () => waitClient.waitForConversationImages(
          conversation.events,
          conversation.conversationId,
          input.waitTimeoutSec,
          { upstreamTaskId: conversation.upstreamTaskId }
        ));
        const upstreamTaskId = waitClient.imageTaskIds.get(conversation.conversationId) || conversation.upstreamTaskId || "";
        return { ...conversation, imageUrls, upstreamTaskId };
      });
      const { events, conversationId, model, upstreamModel, route, selected, imageUrls } = result;
      const downloadClient = result.submitSessionSnapshot ? this.createSubmitClient(result) : this;
      if (imageUrls.length) await this.rememberImageSuccessfulCar(selected);

      return {
        externalId: conversationId,
        status: imageUrls.length ? "success" : "waiting_upstream",
        prompt,
        taskType: "text2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        downloadImage: (url, options = {}) => downloadClient.downloadResultImage(url, {
          ...options,
          carId: selected?.carId,
          carType: selected?.carType
        }),
        raw: { conversationId, eventCount: events.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, selectedCarType: selected?.carType, strategy: selected?.strategy, ...resultChannelMetadata(result, route), ...geminiRouteMetadata(route), stageTimings: taskStageSnapshot(taskStageRecorder) }
      };
    });
  }

  async createImageTask(input = {}) {
    return this.runTaskWork(input, async () => {
      const taskStageRecorder = createTaskStageRecorder(input);
      const trackedInput = { ...input, taskStageRecorder };
      const files = normalizeChatFiles(input, []);
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("Please enter an image edit prompt.");
      if (!files.length) throw new Error("Please upload a source image.");

      const result = await this.withImageQuotaFallback(prompt, {
        ...trackedInput,
        files,
        imageGeneration: true,
        preferImageCar: true,
        requireConversationId: true
      }, async (conversation) => {
        await notifyImageSubmitted(input, submittedImageTask(conversation, input, prompt, "img2img", files.length));
        await this.captureImageTaskRegistration(conversation, input, prompt, "img2img", files.length);
        throwIfImageGenerationLimit(conversation.events, { car: true });
        if (conversation.route?.key === "gemini") {
          let imageUrls = conversation.imageUrls || [];
          if (!imageUrls.length) {
            try {
              throwIfTerminalImageFailure(conversation.directContent);
            } catch (error) {
              await this.rememberImageFailedCar(conversation.selected, error);
              throw error;
            }
            if (input.waitForImages !== false) {
              const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
              imageUrls = await measureTaskStage(taskStageRecorder, {
                key: "result_wait",
                label: "等待图片完成",
                carId: conversation.selected?.carId,
                carType: conversation.selected?.carType
              }, async () => waitClient.waitForGeminiConversationImages(conversation, input.waitTimeoutSec));
            }
          }
          return { ...conversation, imageUrls };
        }
        if (conversation.route?.key === "grok") {
          const imageUrls = conversation.imageUrls || [];
          if (!imageUrls.length) throwIfTextImageResponse(conversation.directContent, { requireResult: true });
          return { ...conversation, imageUrls };
        }
        if (input.waitForImages === false) return { ...conversation, imageUrls: [] };
        const waitClient = conversation.submitSessionSnapshot ? this.createSubmitClient(conversation) : this;
        const imageUrls = await measureTaskStage(taskStageRecorder, {
          key: "result_wait",
          label: "等待图片完成",
          carId: conversation.selected?.carId,
          carType: conversation.selected?.carType
        }, async () => waitClient.waitForConversationImages(
          conversation.events,
          conversation.conversationId,
          input.waitTimeoutSec,
          { generatedOnly: true, upstreamTaskId: conversation.upstreamTaskId }
        ));
        const upstreamTaskId = waitClient.imageTaskIds.get(conversation.conversationId) || conversation.upstreamTaskId || "";
        return { ...conversation, imageUrls, upstreamTaskId };
      });
      const { events, conversationId, model, upstreamModel, route, selected, imageUrls } = result;
      const downloadClient = result.submitSessionSnapshot ? this.createSubmitClient(result) : this;
      if (imageUrls.length) await this.rememberImageSuccessfulCar(selected);

      return {
        externalId: conversationId,
        status: imageUrls.length ? "success" : "waiting_upstream",
        prompt,
        taskType: "img2img",
        modelId: model,
        ratio: input.ratio_label || input.ratio || "",
        imageCount: imageUrls.length,
        imageUrls,
        downloadImage: (url, options = {}) => downloadClient.downloadResultImage(url, {
          ...options,
          carId: selected?.carId,
          carType: selected?.carType
        }),
        raw: { conversationId, eventCount: events.length, sourceImageCount: files.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, selectedCarType: selected?.carType, strategy: selected?.strategy, ...resultChannelMetadata(result, route), ...geminiRouteMetadata(route), stageTimings: taskStageSnapshot(taskStageRecorder) }
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

    const modelKey = this.chatRouteForInput({
      ...input,
      preferImageCar: files.length > 0
    }).key;
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
              const detail = await this.conversationDetail(conversationId);
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
        const { events, conversationId, model, upstreamModel, route, selected, content, detailContent, imageUrls } = result;
        return {
          externalId: conversationId,
          model,
          content,
          imageUrls,
          raw: { conversationId, eventCount: events.length, imageCount: files.length, outputImageCount: imageUrls.length, detailTextLength: detailContent.length, upstreamModel, chatModel: route?.key, selectedCarId: selected?.carId, strategy: selected?.strategy, ...geminiRouteMetadata(route) }
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
    }, modelKey);
  }
}
