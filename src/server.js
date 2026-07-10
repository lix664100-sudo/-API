import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAccount,
  checkAllAccounts,
  createChatCompletion,
  createImageTask,
  queueChatCompletion,
  queueImageTask,
  refreshProcessingTasks,
  refreshTask
} from "./channel-manager.js";
import { DrawingClient } from "./channels/drawing.js";
import {
  getTask,
  listTasks,
  loadConfig,
  publicConfig,
  removeAccount,
  removeChannel,
  saveAccount,
  saveChannel,
  saveConfig
} from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const adminDir = path.join(rootDir, "admin");
const previewDir = path.join(rootDir, "outputs", "previews");

const app = Fastify({ logger: true, bodyLimit: 60 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

function sendError(reply, error) {
  const status = Number(error.status || error.statusCode || 500);
  reply.code(status >= 400 && status < 600 ? status : 500).send({
    ok: false,
    message: error.message || "请求失败"
  });
}

async function requireApiKey(request, reply) {
  const config = await loadConfig();
  const authHeader = String(request.headers.authorization || "");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const apiKey = String(request.headers["x-api-key"] || bearer || "").trim();
  if (!apiKey || apiKey !== config.apiKey) {
    reply.code(401).send({ ok: false, message: "API 密钥不正确。" });
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

async function savePreviewImage(buffer, part) {
  if (!String(part.mimetype || "").startsWith("image/")) return "";
  await mkdir(previewDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}${imageExtension(part.mimetype, part.filename)}`;
  await writeFile(path.join(previewDir, filename), buffer);
  return `/uploads/previews/${filename}`;
}

async function readMultipartInput(request, { maxFiles, savePreview = false }) {
  const input = {};
  const files = [];
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (!["image", "images", "file", "files"].includes(part.fieldname)) continue;
      if (!part.filename) continue;
      if (files.length >= maxFiles) throw badRequest(`最多只能上传 ${maxFiles} 张图片。`);
      const buffer = await part.toBuffer();
      const previewUrl = savePreview ? await savePreviewImage(buffer, part) : "";
      files.push({
        filename: part.filename,
        mimetype: part.mimetype,
        previewUrl,
        toBuffer: async () => buffer
      });
      continue;
    }
    input[part.fieldname] = part.value ?? "";
  }
  return { input: normalizeFields(input), files };
}

function isMultipartRequest(request) {
  return typeof request.isMultipart === "function"
    ? request.isMultipart()
    : String(request.headers["content-type"] || "").toLowerCase().includes("multipart/form-data");
}

app.get("/uploads/previews/:filename", async (request, reply) => {
  const filename = path.basename(String(request.params.filename || ""));
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw badRequest("图片地址不正确。");
  const file = await readFile(path.join(previewDir, filename));
  reply.type(previewContentType(filename)).send(file);
});

app.get("/", async (_request, reply) => {
  reply.redirect("/admin/");
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

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

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
    waitTimeoutSec: Number(body.waitTimeoutSec || current.waitTimeoutSec || 180)
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
  const chatAccounts = config.accounts.filter((account) => account.channelId === "chatplus");
  const drawingAccounts = config.accounts.filter((account) => account.channelId === "drawing");
  return {
    ok: true,
    data: {
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

app.get("/api/models", async () => {
  const config = await loadConfig();
  const channel = config.channels.find((item) => item.type === "drawing" && item.enabled !== false)
    || config.channels.find((item) => item.type === "drawing");
  const account = channel
    ? config.accounts.find((item) => item.channelId === channel.id && item.enabled !== false)
    : null;
  if (channel && account) {
    try {
      const client = new DrawingClient({ config, channel, account });
      const models = await client.getModels();
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

app.post("/api/tasks/refresh-processing", async () => {
  return { ok: true, data: await refreshProcessingTasks() };
});

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
  try {
    const { input, files } = await readMultipartInput(request, { maxFiles: 3 });
    if (!files.length) throw badRequest("请上传 1 到 3 张源图，字段名用 image。");
    let task;
    if (request.query?.wait === "1") {
      task = await createImageTask({ input, files, wait: true });
    } else {
      task = await queueImageTask({ input, files });
    }
    return { ok: true, data: task };
  } catch (error) {
    return sendError(reply, error);
  }
});

app.post("/v1/chat/completions", { preHandler: requireApiKey }, async (request, reply) => {
  try {
    if (isMultipartRequest(request)) {
      const { input, files } = await readMultipartInput(request, { maxFiles: 5, savePreview: true });
      if (request.query?.wait === "0") {
        const task = await queueChatCompletion({ ...input, files });
        return { created: Math.floor(Date.now() / 1000), task };
      }
      return await createChatCompletion({ ...input, files });
    }
    const input = normalizeFields(request.body || {});
    if (request.query?.wait === "0") {
      const task = await queueChatCompletion(input);
      return { created: Math.floor(Date.now() / 1000), task };
    }
    return await createChatCompletion(input);
  } catch (error) {
    return sendError(reply, error);
  }
});

app.post("/v1/images/edits", { preHandler: requireApiKey }, async (request, reply) => {
  try {
    const { input, files } = await readMultipartInput(request, { maxFiles: 3 });
    if (!files.length) throw badRequest("请上传 1 到 3 张源图，字段名用 image。");
    const task = await createImageTask({ input, files, wait: request.query?.wait !== "0" });
    return { created: Math.floor(Date.now() / 1000), task };
  } catch (error) {
    return sendError(reply, error);
  }
});

const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";

try {
  await app.listen({ port, host });
  app.log.info(`管理后台：http://${host}:${port}/admin/`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
