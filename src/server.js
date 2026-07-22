import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  checkAccount,
  checkAllAccounts,
  createChatCompletion,
  createImageTask,
  getRuntimeStatus,
  queueChatCompletion,
  queueImageTask,
  recoverUnavailableChatAccounts,
  reserveImageTaskAdmission,
  refreshProcessingTasks,
  refreshTask
} from "./channel-manager.js";
import { DrawingClient } from "./channels/drawing.js";
import {
  cleanupResultImages,
  getResultImageStorageStats,
  mirrorImageUrl,
  resultImageDir,
  runAutoCleanupResultImages,
  setRuntimePublicBaseUrl
} from "./image-store.js";
import {
  getTask,
  getTaskBySourceTaskId,
  listIntradayTaskStats,
  listTaskPage,
  listTaskStats,
  listTaskStatsSummary,
  listTasks,
  loadConfig,
  publicConfig,
  recordTaskStat,
  recordRuntimeStat,
  removeAccount,
  removeChannel,
  saveAccount,
  saveChannel,
  saveConfig,
  upsertTask
} from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const adminDir = path.join(rootDir, "admin");
const adminVendorDir = path.join(adminDir, "vendor");
const previewDir = path.join(rootDir, "outputs", "previews");
const execAsync = promisify(exec);

const adminSessionCookie = "shareai_admin_session";
const adminUsername = String(process.env.ADMIN_USERNAME || "lixiang");
const adminPassword = String(process.env.ADMIN_PASSWORD || "999999");
const adminSessionSecret = String(process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || "shareai-local-admin-secret");
const adminSessionMs = Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 12)) * 60 * 60 * 1000;
const updateTimeoutMs = Math.max(10, Number(process.env.ADMIN_UPDATE_TIMEOUT_SEC || 120)) * 1000;
const updateOutputLimit = 8000;
const resultImageCleanupIntervalMs = Math.max(5, Number(process.env.RESULT_IMAGE_CLEANUP_INTERVAL_MIN || 60)) * 60 * 1000;
const publicAdminApiPaths = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout"
]);
const activeAdminSessions = new Map();
let updateRunning = false;

const app = Fastify({ logger: true, bodyLimit: 60 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

function taskFileJson(file) {
  return {
    filename: file?.filename || file?.name || "",
    mimetype: file?.mimetype || file?.type || "",
    previewUrl: file?.previewUrl || "",
    fieldname: file?.fieldname || ""
  };
}

function failedRequestJson(input = {}, files = [], sourceTaskId = "") {
  const { file: _file, files: _files, ...fields } = input || {};
  const requestJson = { ...fields };
  const fileItems = (Array.isArray(files) ? files : []).map(taskFileJson);
  if (fileItems.length) {
    requestJson.received_image_count = fileItems.length;
    requestJson.files = fileItems;
  }
  if (sourceTaskId) {
    requestJson.sourceTaskId = sourceTaskId;
    requestJson.client_task_id = requestJson.client_task_id || sourceTaskId;
  }
  return requestJson;
}

function errorSourceTaskId(error, responseJson = {}, context = {}) {
  return normalizeSourceTaskId(
    error.sourceTaskId
      || responseJson.sourceTaskId
      || error.task?.sourceTaskId
      || error.task?.requestMeta?.sourceTaskId
      || context.requestMeta?.sourceTaskId
      || sourceTaskIdFrom(context.input)
  );
}

async function persistReturnedErrorTask(error, context, payload, status) {
  const responseJson = error.responseJson || error.task?.responseJson || {};
  const sourceTaskId = errorSourceTaskId(error, responseJson, context);
  if (!sourceTaskId) return null;

  const attempts = error.attempts || responseJson.attempts || error.task?.attempts || [];
  const existing = error.task || await getTaskBySourceTaskId(sourceTaskId);
  const firstAttempt = Array.isArray(attempts) ? attempts[0] || {} : {};
  const now = new Date().toISOString();
  const responsePayload = {
    ok: false,
    message: payload.message,
    sourceTaskId,
    ...(status ? { status } : {}),
    ...(payload.code ? { code: payload.code } : {}),
    ...(Array.isArray(attempts) && attempts.length ? { attempts } : {})
  };
  const failedTask = {
    ...(existing || {}),
    id: existing?.id || `task-${randomUUID()}`,
    sourceTaskId,
    status: "failed",
    taskType: existing?.taskType || context.taskType || "",
    prompt: existing?.prompt || context.input?.prompt || context.input?.message || "",
    modelId: existing?.modelId || context.input?.model_id || context.input?.modelId || context.input?.model || "",
    ratio: existing?.ratio || context.input?.ratio_label || context.input?.ratio || "",
    imageCount: existing?.imageCount ?? Number(context.input?.image_count || context.input?.n || 1),
    imageUrls: Array.isArray(existing?.imageUrls) ? existing.imageUrls : [],
    inputImageUrls: Array.isArray(existing?.inputImageUrls) ? existing.inputImageUrls : [],
    errorMessage: payload.message,
    statusCode: status,
    channelId: existing?.channelId || firstAttempt.channelId || "",
    channelName: existing?.channelName || firstAttempt.channelName || "",
    channelType: existing?.channelType || "",
    accountId: existing?.accountId || firstAttempt.accountId || "",
    accountName: existing?.accountName || firstAttempt.accountName || "",
    requestMeta: existing?.requestMeta || context.requestMeta || {},
    attempts: Array.isArray(attempts) ? attempts : [],
    requestJson: existing?.requestJson || failedRequestJson(context.input, context.files, sourceTaskId),
    responseJson: responsePayload,
    raw: {
      ...(existing?.raw || {}),
      returnedError: true,
      returnedErrorAt: now
    },
    completedAt: now,
    createdAt: existing?.createdAt || context.requestMeta?.calledAt || now
  };
  const stored = await upsertTask(failedTask);
  await recordTaskStat(stored);
  error.task = stored;
  return stored;
}

async function sendError(reply, error, context = {}) {
  const status = Number(error.status || error.statusCode || 500);
  const responseJson = error.responseJson || error.task?.responseJson || {};
  const attempts = error.attempts || responseJson.attempts || error.task?.attempts || [];
  const sourceTaskId = errorSourceTaskId(error, responseJson, context);
  const payload = {
    ok: false,
    message: responseJson.message || error.message || "请求失败"
  };
  const code = error.code || responseJson.code;
  if (code) payload.code = code;
  if (sourceTaskId) payload.sourceTaskId = sourceTaskId;
  if (Array.isArray(attempts) && attempts.length) payload.attempts = attempts;
  try {
    await persistReturnedErrorTask(error, context, payload, status);
  } catch (persistError) {
    app.log.warn({ error: persistError }, "failed to persist returned task error");
  }
  reply.code(status >= 400 && status < 600 ? status : 500).send(payload);
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}

function normalizeIp(value) {
  const text = String(value || "").trim();
  return text.startsWith("::ffff:") ? text.slice(7) : text;
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

function sourceTaskIdFromHeaders(headers = {}) {
  return normalizeSourceTaskId(
    headers["x-source-task-id"]
      || headers["x-client-task-id"]
      || headers["x-task-id"]
      || headers["x-xtw-task-id"]
  );
}

function mergeInputSourceTaskId(requestMeta, input = {}) {
  const sourceTaskId = requestMeta.sourceTaskId || sourceTaskIdFrom(input);
  return sourceTaskId ? { ...requestMeta, sourceTaskId } : requestMeta;
}

function requestClientIp(request) {
  return normalizeIp(
    firstHeaderValue(request.headers["x-forwarded-for"])
      || firstHeaderValue(request.headers["x-real-ip"])
      || firstHeaderValue(request.headers["cf-connecting-ip"])
      || request.ip
      || request.socket?.remoteAddress
  );
}

function apiRequestMeta(request) {
  const sourceTaskId = sourceTaskIdFromHeaders(request.headers) || sourceTaskIdFrom(request.body);
  return {
    callerIp: requestClientIp(request),
    calledAt: new Date().toISOString(),
    forwardedFor: firstHeaderValue(request.headers["x-forwarded-for"]),
    ...(sourceTaskId ? { sourceTaskId } : {})
  };
}

function imageAdmissionInput(request, requestMeta = {}) {
  const queryInput = normalizeFields(request.query || {});
  const bodyInput = isMultipartRequest(request) ? {} : normalizeFields(request.body || {});
  return {
    ...queryInput,
    ...bodyInput,
    ...(requestMeta.sourceTaskId ? { sourceTaskId: requestMeta.sourceTaskId } : {})
  };
}

async function reserveImageRequestAdmission(request, requestMeta = {}) {
  return reserveImageTaskAdmission(imageAdmissionInput(request, requestMeta));
}

async function requireApiKey(request, reply) {
  const config = await loadConfig();
  const authHeader = String(request.headers.authorization || "");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const apiKey = String(request.headers["x-api-key"] || bearer || "").trim();
  if (!apiKey || apiKey !== config.apiKey) {
    return reply.code(401).send({ ok: false, message: "API 密钥不正确。" });
  }
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(request) {
  return String(request.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index <= 0) return cookies;
      try {
        const name = decodeURIComponent(item.slice(0, index).trim());
        const value = decodeURIComponent(item.slice(index + 1).trim());
        cookies[name] = value;
      } catch {
        return cookies;
      }
      return cookies;
    }, {});
}

function signAdminPayload(payload) {
  return createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
}

function createAdminToken(username) {
  const session = {
    username,
    sid: randomUUID(),
    exp: Date.now() + adminSessionMs
  };
  activeAdminSessions.set(session.sid, session.exp);
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${signAdminPayload(payload)}`;
}

function verifyAdminToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = signAdminPayload(payload);
  if (!safeTextEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (session.username !== adminUsername || !session.sid) return null;
    const activeExp = activeAdminSessions.get(session.sid);
    if (!activeExp || activeExp !== session.exp) return null;
    if (Date.now() > Number(session.exp || 0)) {
      activeAdminSessions.delete(session.sid);
      return null;
    }
    return { username: session.username, sid: session.sid, exp: session.exp };
  } catch {
    return null;
  }
}

function getAdminSession(request) {
  const cookies = parseCookies(request);
  return verifyAdminToken(cookies[adminSessionCookie]);
}

function setAdminCookie(reply, username) {
  const token = encodeURIComponent(createAdminToken(username));
  reply.header("set-cookie", `${adminSessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(adminSessionMs / 1000)}`);
}

function clearAdminCookie(reply) {
  reply.header("set-cookie", `${adminSessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function clearAdminSession(request, reply) {
  const session = getAdminSession(request);
  if (session?.sid) activeAdminSessions.delete(session.sid);
  clearAdminCookie(reply);
}

async function requireAdmin(request, reply) {
  const session = getAdminSession(request);
  if (!session) {
    return reply.code(401).send({ ok: false, message: "请先登录后台。" });
  }
  request.admin = session;
}

function shortenOutput(value) {
  const text = String(value || "");
  return text.length > updateOutputLimit ? text.slice(-updateOutputLimit) : text;
}

function updateCommandConfig() {
  return {
    command: String(process.env.ADMIN_UPDATE_COMMAND || "").trim(),
    cwd: path.resolve(String(process.env.ADMIN_UPDATE_CWD || rootDir))
  };
}

function shortCommit(value) {
  return String(value || "").trim().slice(0, 7);
}

async function currentGitUpdateState(cwd) {
  const execOptions = {
    cwd,
    timeout: updateTimeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 2
  };
  try {
    const inside = await execAsync("git rev-parse --is-inside-work-tree", execOptions);
    if (String(inside.stdout || "").trim() !== "true") {
      return { checked: false, message: "当前目录不是代码仓库，未执行更新。" };
    }

    const local = await execAsync("git rev-parse HEAD", execOptions);
    const upstream = await execAsync('git rev-parse --abbrev-ref --symbolic-full-name "@{u}"', execOptions);
    await execAsync("git fetch --quiet", execOptions);
    const remote = await execAsync('git rev-parse "@{u}"', execOptions);

    const localCommit = String(local.stdout || "").trim();
    const remoteCommit = String(remote.stdout || "").trim();
    return {
      checked: true,
      upToDate: localCommit && remoteCommit && localCommit === remoteCommit,
      localCommit,
      remoteCommit,
      upstream: String(upstream.stdout || "").trim()
    };
  } catch (error) {
    const stderr = shortenOutput(error.stderr || error.message);
    if (/not a git repository/i.test(stderr)) {
      return { checked: false, message: "当前目录不是代码仓库，未执行更新。", stderr };
    }
    return {
      checked: false,
      message: "无法确认当前是否为最新版，未执行更新。",
      stderr
    };
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseJsonField(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  const text = value.trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function normalizeFields(input = {}) {
  const next = { ...input };
  if (typeof next.messages === "string") next.messages = parseJsonField(next.messages, []);
  if (typeof next.stream === "string") next.stream = next.stream === "true";
  return next;
}

function imageExtension(mimetype, filename = "") {
  const typeExt = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  }[String(mimetype || "").toLowerCase()];
  if (typeExt) return typeExt;
  const ext = path.extname(String(filename || "")).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? ext : ".png";
}

function previewContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function imageContentType(filename) {
  return previewContentType(filename);
}

function adminVendorContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function isImageInputField(fieldname) {
  const name = String(fieldname || "").trim().toLowerCase();
  return /^(image|images|file|files)(\[\d*\]|_\d+|\d+)?$/.test(name);
}

function assignInputField(input, fieldname, value) {
  if (input[fieldname] === undefined) {
    input[fieldname] = value ?? "";
    return;
  }
  input[fieldname] = Array.isArray(input[fieldname])
    ? [...input[fieldname], value ?? ""]
    : [input[fieldname], value ?? ""];
}

async function savePreviewImage(buffer, part) {
  if (!String(part.mimetype || "").startsWith("image/")) return "";
  await mkdir(previewDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}${imageExtension(part.mimetype, part.filename)}`;
  await writeFile(path.join(previewDir, filename), buffer);
  return `/uploads/previews/${filename}`;
}

function imageMimeFromBuffer(buffer) {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50 && buffer?.[2] === 0x4e && buffer?.[3] === 0x47) return "image/png";
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return "image/jpeg";
  if (buffer?.slice(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer?.slice(0, 4).toString("ascii") === "RIFF" && buffer?.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function safeImageFilename(filename, mimetype, index) {
  const fallback = `image_${index}${imageExtension(mimetype)}`;
  const base = path.basename(String(filename || fallback)).replace(/[^\w.-]/g, "_") || fallback;
  return path.extname(base) ? base : `${base}${imageExtension(mimetype)}`;
}

function base64ImageToFile(value, fieldname, index) {
  const source = typeof value === "object" && value !== null
    ? value.data || value.base64 || value.image || value.content || value.url || ""
    : value;
  let text = String(source || "").trim();
  if (!text) return null;

  let mimetype = typeof value === "object" && value !== null ? String(value.mimetype || value.type || "") : "";
  const dataUrl = text.match(/^data:(image\/[\w.+-]+);base64,(.+)$/i);
  if (dataUrl) {
    mimetype = dataUrl[1];
    text = dataUrl[2];
  }
  const normalized = text.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length < 32 || !/^[a-z0-9+/]+=*$/i.test(normalized)) return null;

  const buffer = Buffer.from(normalized, "base64");
  const detectedType = imageMimeFromBuffer(buffer);
  if (!detectedType && !String(mimetype).startsWith("image/")) return null;
  const type = detectedType || mimetype || "image/png";
  const filename = safeImageFilename(typeof value === "object" && value !== null ? value.filename || value.name : "", type, index);
  return {
    filename,
    mimetype: type,
    previewUrl: "",
    fieldname,
    toBuffer: async () => buffer
  };
}

async function pushBufferedImage(files, buffer, part, { maxFiles, savePreview }) {
  if (files.length >= maxFiles) throw badRequest(`最多只能上传 ${maxFiles} 张图片。`);
  const mimetype = part.mimetype || imageMimeFromBuffer(buffer) || "image/png";
  const filename = safeImageFilename(part.filename, mimetype, files.length + 1);
  const previewUrl = savePreview ? await savePreviewImage(buffer, { ...part, filename, mimetype }) : "";
  files.push({
    filename,
    mimetype,
    previewUrl,
    fieldname: part.fieldname || "",
    toBuffer: async () => buffer
  });
}

async function pushBase64Image(files, value, fieldname, options) {
  if (files.length >= options.maxFiles) throw badRequest(`最多只能上传 ${options.maxFiles} 张图片。`);
  const file = base64ImageToFile(value, fieldname, files.length + 1);
  if (!file) return false;
  const buffer = await file.toBuffer();
  const previewUrl = options.savePreview ? await savePreviewImage(buffer, file) : "";
  files.push({ ...file, previewUrl });
  return true;
}

function imageFieldValues(value) {
  const parsed = typeof value === "string" ? parseJsonField(value, value) : value;
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function appendImageFields(input, files, options) {
  const nextInput = { ...input };
  for (const [fieldname, value] of Object.entries(input)) {
    if (!isImageInputField(fieldname)) continue;
    let used = false;
    for (const item of imageFieldValues(value)) {
      used = await pushBase64Image(files, item, fieldname, options) || used;
    }
    if (used) delete nextInput[fieldname];
  }
  return { input: nextInput, files };
}

async function readMultipartInput(request, { maxFiles, savePreview = false }) {
  const input = {};
  const files = [];
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (!isImageInputField(part.fieldname)) continue;
      if (!part.filename) continue;
      const buffer = await part.toBuffer();
      await pushBufferedImage(files, buffer, part, { maxFiles, savePreview });
      continue;
    }
    assignInputField(input, part.fieldname, part.value ?? "");
  }
  return appendImageFields(normalizeFields(input), files, { maxFiles, savePreview });
}

async function readImageInput(request, options) {
  if (isMultipartRequest(request)) return readMultipartInput(request, options);
  const input = normalizeFields(request.body || {});
  return appendImageFields(input, [], options);
}

function isMultipartRequest(request) {
  return typeof request.isMultipart === "function"
    ? request.isMultipart()
    : String(request.headers["content-type"] || "").toLowerCase().includes("multipart/form-data");
}

app.addHook("preHandler", async (request, reply) => {
  const protocol = request.headers["x-forwarded-proto"] || (request.protocol || "http");
  const hostHeader = request.headers["x-forwarded-host"] || request.headers.host;
  if (hostHeader) setRuntimePublicBaseUrl(`${protocol}://${hostHeader}`);

  const urlPath = String(request.url || "").split("?")[0];
  const needsAdmin = (urlPath.startsWith("/api/") && !publicAdminApiPaths.has(urlPath))
    || urlPath.startsWith("/uploads/previews/");
  if (needsAdmin) return requireAdmin(request, reply);
});

app.get("/uploads/previews/:filename", async (request, reply) => {
  const filename = path.basename(String(request.params.filename || ""));
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw badRequest("图片地址不正确。");
  const file = await readFile(path.join(previewDir, filename));
  reply.type(previewContentType(filename)).send(file);
});

app.get("/uploads/results/:filename", async (request, reply) => {
  const filename = path.basename(String(request.params.filename || ""));
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw badRequest("图片地址不正确。");
  const file = await readFile(path.join(resultImageDir, filename));
  reply.type(imageContentType(filename)).send(file);
});

app.get("/", async (_request, reply) => {
  reply.redirect("/admin/");
});

app.get("/favicon.ico", async (_request, reply) => {
  reply.code(204).send();
});

app.get("/admin", async (_request, reply) => {
  reply.redirect("/admin/");
});

app.get("/admin/", async (_request, reply) => {
  const html = await readFile(path.join(adminDir, "index.html"), "utf8");
  reply.type("text/html; charset=utf-8").send(html);
});

app.get("/admin/index.html", async (_request, reply) => {
  const html = await readFile(path.join(adminDir, "index.html"), "utf8");
  reply.type("text/html; charset=utf-8").send(html);
});

app.get("/admin/vendor/:filename", async (request, reply) => {
  const filename = path.basename(String(request.params.filename || ""));
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw badRequest("File path is invalid.");
  let file;
  try {
    file = await readFile(path.join(adminVendorDir, filename));
  } catch (error) {
    if (error.code === "ENOENT") return reply.code(404).send({ ok: false, message: "File not found." });
    throw error;
  }
  reply
    .header("cache-control", "public, max-age=31536000, immutable")
    .type(adminVendorContentType(filename))
    .send(file);
});

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

app.get("/api/auth/status", async (request) => {
  const session = getAdminSession(request);
  return {
    ok: true,
    data: session
      ? { authenticated: true, user: { username: session.username } }
      : { authenticated: false, user: null }
  };
});

app.post("/api/auth/login", async (request, reply) => {
  const body = request.body || {};
  const username = String(body.username || "");
  const password = String(body.password || "");
  if (!safeTextEqual(username, adminUsername) || !safeTextEqual(password, adminPassword)) {
    return reply.code(401).send({ ok: false, message: "账号或密码不正确。" });
  }
  setAdminCookie(reply, adminUsername);
  return { ok: true, data: { username: adminUsername } };
});

app.post("/api/auth/logout", async (request, reply) => {
  clearAdminSession(request, reply);
  return { ok: true, data: true };
});

app.post("/api/admin/update", async (_request, reply) => {
  const { command, cwd } = updateCommandConfig();
  if (!command) {
    return reply.code(400).send({ ok: false, message: "还没有配置更新命令。" });
  }
  if (updateRunning) {
    return reply.code(409).send({ ok: false, message: "更新正在执行，请稍后再试。" });
  }
  updateRunning = true;
  try {
    const gitState = await currentGitUpdateState(cwd);
    if (!gitState.checked) {
      return {
        ok: true,
        data: {
          success: false,
          skipped: true,
          message: gitState.message || "无法确认当前是否为最新版，未执行更新。",
          stdout: `检查目录：${cwd}`,
          stderr: gitState.stderr || ""
        }
      };
    }
    if (gitState.upToDate) {
      return {
        ok: true,
        data: {
          success: true,
          skipped: true,
          message: "已经是最新版，无需更新。",
          stdout: `当前版本：${shortCommit(gitState.localCommit)}\n线上来源：${gitState.upstream || "未识别"}`,
          stderr: ""
        }
      };
    }

    const result = await execAsync(command, {
      cwd,
      timeout: updateTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 5
    });
    return {
      ok: true,
      data: {
        success: true,
        stdout: shortenOutput(result.stdout),
        stderr: shortenOutput(result.stderr)
      }
    };
  } catch (error) {
    return {
      ok: true,
      data: {
        success: false,
        message: error.killed ? "更新命令超时。" : "更新命令执行失败。",
        stdout: shortenOutput(error.stdout),
        stderr: shortenOutput(error.stderr || error.message)
      }
    };
  } finally {
    updateRunning = false;
  }
});

app.post("/api/admin/mirror-image", async (request, reply) => {
  const url = String(request.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return reply.code(400).send({ ok: false, message: "图片链接不正确。" });
  }
  try {
    const config = await loadConfig();
    const mirroredUrl = await mirrorImageUrl(url, config);
    return {
      ok: true,
      data: {
        url: mirroredUrl,
        originalUrl: url
      }
    };
  } catch (error) {
    return sendError(reply, error);
  }
});

app.get("/api/admin/image-storage", async () => {
  const config = await loadConfig();
  return { ok: true, data: await getResultImageStorageStats(config) };
});

app.post("/api/admin/image-storage/cleanup", async (request) => {
  const config = await loadConfig();
  const mode = request.body?.mode === "all" ? "all" : "expired";
  return { ok: true, data: await cleanupResultImages(config, { mode }) };
});

app.get("/api/config", async () => {
  const config = await loadConfig();
  return { ok: true, data: publicConfig(config) };
});

app.post("/api/config", async (request) => {
  const current = await loadConfig();
  const body = request.body || {};
  const config = await saveConfig({
    mainBaseUrl: body.mainBaseUrl || current.mainBaseUrl,
    drawingBaseUrl: body.drawingBaseUrl || current.drawingBaseUrl,
    defaultChannel: body.defaultChannel || current.defaultChannel || "auto",
    defaultModelId: Number(body.defaultModelId || current.defaultModelId || 1),
    defaultRatio: body.defaultRatio || current.defaultRatio || "1:1",
    defaultImageCount: Number(body.defaultImageCount || current.defaultImageCount || 1),
    waitTimeoutSec: Number(body.waitTimeoutSec ?? current.waitTimeoutSec ?? 300),
    imageStorage: body.imageStorage || current.imageStorage,
    concurrency: body.concurrency || current.concurrency
  });
  return { ok: true, data: publicConfig(config) };
});

app.post("/api/channels/:id", async (request) => {
  const config = await saveChannel(request.params.id, request.body || {});
  return { ok: true, data: publicConfig(config) };
});

app.post("/api/channels", async (request) => {
  const config = await saveChannel(null, request.body || {});
  return { ok: true, data: publicConfig(config) };
});

app.delete("/api/channels/:id", async (request) => {
  const config = await removeChannel(request.params.id);
  return { ok: true, data: publicConfig(config) };
});

app.post("/api/accounts", async (request) => {
  const config = await saveAccount(request.body || {});
  return { ok: true, data: publicConfig(config) };
});

app.delete("/api/accounts/:id", async (request) => {
  const config = await removeAccount(request.params.id);
  return { ok: true, data: publicConfig(config) };
});

app.post("/api/accounts/:id/test", async (request, reply) => {
  try {
    return { ok: true, data: await checkAccount(request.params.id) };
  } catch (error) {
    return sendError(reply, error);
  }
});

app.post("/api/accounts/test-all", async () => {
  return { ok: true, data: await checkAllAccounts() };
});

app.post("/api/config/test", async () => {
  return { ok: true, data: await checkAllAccounts() };
});

app.get("/api/balance", async () => {
  const config = await loadConfig();
  const shareaiAccounts = config.accounts.filter((account) => account.channelId === "shareai");
  const chatAccounts = config.accounts.filter((account) => account.channelId === "chatplus");
  const drawingAccounts = config.accounts.filter((account) => account.channelId === "drawing");
  return {
    ok: true,
    data: {
      shareai: shareaiAccounts,
      chatplus: chatAccounts,
      drawing: drawingAccounts
    }
  };
});

function fallbackDrawingModels() {
  return [
    { id: 1, name: "ChatGPT-Image-2", code: "gpt-image-2" },
    { id: 2, name: "Nano-Banana-Pro", code: "nano-banana-pro" },
    { id: 3, name: "Nano-Banana", code: "nano-banana" }
  ];
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    })
  ]);
}

app.get("/api/models", async () => {
  const config = await loadConfig();
  const channel = config.channels.find((item) => item.type === "drawing" && item.enabled !== false)
    || config.channels.find((item) => item.type === "shareai" && item.enabled !== false)
    || config.channels.find((item) => item.type === "drawing");
  const account = channel
    ? config.accounts.find((item) => item.channelId === channel.id && item.enabled !== false)
    : null;
  if (channel && account) {
    try {
      const drawingChannel = channel.type === "shareai"
        ? {
            ...channel,
            type: "drawing",
            settings: {
              baseUrl: channel.settings?.drawingBaseUrl || config.drawingBaseUrl,
              defaultModelId: channel.settings?.defaultModelId || config.defaultModelId || 1
            }
          }
        : channel;
      const client = new DrawingClient({ config, channel: drawingChannel, account });
      const models = await withTimeout(client.getModels(), 5000);
      const items = Array.isArray(models?.items) ? models.items : Array.isArray(models) ? models : [];
      if (items.length) return { ok: true, data: { items } };
    } catch {
      // 管理后台不能因为上游模型列表临时失败而打不开。
    }
  }
  return {
    ok: true,
    data: {
      items: fallbackDrawingModels()
    }
  };
});

app.get("/api/tasks", async () => ({ ok: true, data: await listTasks() }));

app.get("/api/stats", async () => ({ ok: true, data: await listTaskStats() }));

app.get("/api/stats/summary", async () => ({ ok: true, data: await listTaskStatsSummary() }));

app.get("/api/stats/intraday", async (request) => ({
  ok: true,
  data: await listIntradayTaskStats(request.query?.day)
}));

app.get("/api/admin/runtime", async () => ({ ok: true, data: await getRuntimeStatus() }));

app.post("/api/tasks/refresh-processing", async () => {
  return { ok: true, data: await refreshProcessingTasks() };
});

app.get("/api/tasks/page", async (request) => ({
  ok: true,
  data: await listTaskPage({
    page: request.query?.page,
    pageSize: request.query?.pageSize,
    keyword: request.query?.keyword,
    accountId: request.query?.accountId,
    channel: request.query?.channel,
    status: request.query?.status
  })
}));

app.get("/api/tasks/:id", async (request) => {
  return { ok: true, data: await getTask(request.params.id) };
});

app.post("/api/tasks/:id/refresh", async (request, reply) => {
  try {
    return { ok: true, data: await refreshTask(request.params.id) };
  } catch (error) {
    return sendError(reply, error);
  }
});

app.post("/api/draw/edit", async (request, reply) => {
  let requestMeta = apiRequestMeta(request);
  let input = {};
  let files = [];
  let admission = null;
  let admissionTransferred = false;
  try {
    admission = await reserveImageRequestAdmission(request, requestMeta);
    const parsed = await readImageInput(request, { maxFiles: 3 });
    input = parsed.input;
    files = parsed.files;
    requestMeta = mergeInputSourceTaskId(requestMeta, input);
    if (!files.length) throw badRequest("请上传 1 到 3 张源图，字段名用 image。");
    let task;
    if (request.query?.wait === "1") {
      task = await createImageTask({ input, files, wait: true, requestMeta, admission });
    } else {
      task = await queueImageTask({ input, files, requestMeta, admission });
    }
    admissionTransferred = true;
    return { ok: true, data: task };
  } catch (error) {
    return sendError(reply, error, { requestMeta, input, files, taskType: "img2img" });
  } finally {
    if (!admissionTransferred) admission?.release?.();
  }
});

app.get("/v1/models", { preHandler: requireApiKey }, async () => {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: [
      { id: "auto", object: "model", created, owned_by: "shareai-api" },
      { id: "gpt", object: "model", created, owned_by: "shareai-api" },
      { id: "grok", object: "model", created, owned_by: "shareai-api" },
      { id: "gemini", object: "model", created, owned_by: "shareai-api" },
      { id: "gpt-image-2", object: "model", created, owned_by: "shareai-api" }
    ]
  };
});

function imageEditResponse(task) {
  const imageUrls = Array.isArray(task?.imageUrls) ? task.imageUrls : [];
  return {
    created: Math.floor(Date.now() / 1000),
    data: imageUrls.map((url) => ({ url })),
    task
  };
}

app.post("/v1/chat/completions", { preHandler: requireApiKey }, async (request, reply) => {
  try {
    let requestMeta = apiRequestMeta(request);
    if (isMultipartRequest(request)) {
      const { input, files } = await readMultipartInput(request, { maxFiles: 5, savePreview: true });
      requestMeta = mergeInputSourceTaskId(requestMeta, input);
      if (request.query?.wait === "0") {
        const task = await queueChatCompletion({ ...input, files }, requestMeta);
        return { created: Math.floor(Date.now() / 1000), task };
      }
      return await createChatCompletion({ ...input, files }, requestMeta);
    }
    const input = normalizeFields(request.body || {});
    requestMeta = mergeInputSourceTaskId(requestMeta, input);
    if (request.query?.wait === "0") {
      const task = await queueChatCompletion(input, requestMeta);
      return { created: Math.floor(Date.now() / 1000), task };
    }
    return await createChatCompletion(input, requestMeta);
  } catch (error) {
    return sendError(reply, error);
  }
});

app.post("/v1/images/edits", { preHandler: requireApiKey }, async (request, reply) => {
  let requestMeta = apiRequestMeta(request);
  let input = {};
  let files = [];
  let admission = null;
  let admissionTransferred = false;
  try {
    admission = await reserveImageRequestAdmission(request, requestMeta);
    const parsed = await readImageInput(request, { maxFiles: 3 });
    input = parsed.input;
    files = parsed.files;
    requestMeta = mergeInputSourceTaskId(requestMeta, input);
    if (!files.length) throw badRequest("请上传 1 到 3 张源图，字段名用 image。");
    const task = await createImageTask({ input, files, wait: request.query?.wait !== "0", requestMeta, admission });
    admissionTransferred = true;
    return imageEditResponse(task);
  } catch (error) {
    return sendError(reply, error, { requestMeta, input, files, taskType: "img2img" });
  } finally {
    if (!admissionTransferred) admission?.release?.();
  }
});

function scheduleResultImageCleanup() {
  const cleanup = async () => {
    try {
      const config = await loadConfig();
      await runAutoCleanupResultImages(config, { force: true });
    } catch (error) {
      app.log.warn({ error }, "result image cleanup failed");
    }
  };
  cleanup();
  const timer = setInterval(cleanup, resultImageCleanupIntervalMs);
  timer.unref?.();
}

function schedulePendingTaskRefresh() {
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshProcessingTasks();
    } catch (error) {
      app.log.warn({ error }, "pending task refresh failed");
    } finally {
      refreshing = false;
    }
  };
  refresh();
  const timer = setInterval(refresh, 30_000);
  timer.unref?.();
}

function scheduleAccountRecovery() {
  const recover = async () => {
    try {
      await recoverUnavailableChatAccounts();
    } catch (error) {
      app.log.warn({ error }, "account recovery failed");
    } finally {
      const timer = setTimeout(recover, 30_000);
      timer.unref?.();
    }
  };
  recover();
}

function scheduleRuntimeStats() {
  let recording = false;
  const record = async () => {
    if (recording) return;
    recording = true;
    try {
      const status = await getRuntimeStatus();
      await recordRuntimeStat({
        time: Date.now(),
        running: status.categories?.image?.running,
        configured: status.categories?.image?.configured,
        available: status.categories?.image?.available
      });
    } catch (error) {
      app.log.warn({ error }, "runtime stats recording failed");
    } finally {
      recording = false;
    }
  };
  record();
  const timer = setInterval(record, 30_000);
  timer.unref?.();
}

const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";

try {
  await app.listen({ port, host });
  scheduleResultImageCleanup();
  schedulePendingTaskRefresh();
  scheduleAccountRecovery();
  scheduleRuntimeStats();
  app.log.info(`管理后台：http://${host}:${port}/admin/`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
