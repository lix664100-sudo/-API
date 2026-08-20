import path from "node:path";
import { timingSafeEqual } from "node:crypto";

import { MediaStoreError } from "./erp-media-store.js";

const MEDIA_KINDS = new Set(["image", "video", "cover"]);

class MediaBusyError extends Error {
  constructor() {
    super("The media service is busy. Please retry shortly.");
    this.code = "MEDIA_BUSY";
    this.statusCode = 503;
  }
}

export function createBoundedGate(concurrency, queueLimit) {
  const maximum = Math.max(1, Number(concurrency || 1));
  const waitingLimit = Math.max(0, Number(queueLimit || 0));
  let running = 0;
  const waiting = [];

  function release() {
    running = Math.max(0, running - 1);
    const next = waiting.shift();
    if (next) {
      running += 1;
      next(release);
    }
  }

  function acquire() {
    if (running < maximum) {
      running += 1;
      return Promise.resolve(release);
    }
    if (waiting.length >= waitingLimit) return Promise.reject(new MediaBusyError());
    return new Promise((resolve) => waiting.push(resolve));
  }

  return {
    acquire,
    stats: () => ({ running, waiting: waiting.length, concurrency: maximum, queueLimit: waitingLimit }),
  };
}

function cleanText(value, maximum = 200) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : "";
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createErpMediaApiKeyGuard(expectedApiKey) {
  const expected = cleanText(expectedApiKey, 500);
  return async function requireErpMediaApiKey(request, reply) {
    const authorization = cleanText(request.headers.authorization, 600);
    const bearer = authorization.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : "";
    const supplied = cleanText(request.headers["x-api-key"] || bearer, 500);
    if (!expected || !supplied || !safeTextEqual(supplied, expected)) {
      return reply.code(401).send({ ok: false, message: "媒体服务密钥不正确。" });
    }
  };
}

function fieldValue(part) {
  return part?.type === "field" ? cleanText(part.value, 500) : "";
}

function uploadMetadata(request, fields) {
  const headers = request.headers || {};
  return {
    installId: cleanText(fields.installId || fields.install_id || headers["x-erp-install-id"]),
    workspaceId: cleanText(fields.workspaceId || fields.workspace_id || headers["x-erp-workspace-id"]),
    shopId: cleanText(fields.shopId || fields.shop_id || headers["x-erp-shop-id"]),
    productId: cleanText(fields.productId || fields.product_id || headers["x-erp-product-id"]),
    batchId: cleanText(fields.batchId || fields.batch_id || headers["x-erp-batch-id"]),
    mediaKind: cleanText(fields.mediaKind || fields.media_kind || headers["x-media-kind"], 20).toLowerCase(),
    contentVersion: cleanText(fields.contentVersion || fields.content_version || headers["x-content-version"]),
    uploadKey: cleanText(headers["idempotency-key"] || fields.uploadKey || fields.upload_key, 300),
  };
}

function validateMetadata(metadata) {
  if (!metadata.installId) return "ERP installation identifier is required.";
  if (!metadata.uploadKey) return "Idempotency-Key is required.";
  if (!MEDIA_KINDS.has(metadata.mediaKind)) return "The media kind is not supported.";
  return "";
}

function publicUrl(config, request, media) {
  const forwardedProtocol = cleanText(request.headers["x-forwarded-proto"], 20).split(",")[0];
  const protocol = forwardedProtocol || request.protocol || "https";
  const host = cleanText(request.headers["x-forwarded-host"] || request.headers.host, 300);
  const base = config.publicBaseUrl || (host ? `${protocol}://${host}` : "");
  const pathname = `/erp-media/${encodeURIComponent(media.publicId)}/${encodeURIComponent(media.filename)}`;
  return base ? `${base}${pathname}` : pathname;
}

function sendRouteError(reply, error) {
  const statusCode = Number(error?.statusCode || 500);
  const code = cleanText(error?.code || "MEDIA_INTERNAL_ERROR", 80) || "MEDIA_INTERNAL_ERROR";
  const safeMessages = {
    MEDIA_BUSY: "媒体服务繁忙，请稍后重试。",
    MEDIA_STORAGE_FULL: "媒体存储空间不足，暂时无法接收新文件。",
    MEDIA_FILE_REQUIRED: "请选择需要上传的文件。",
    MEDIA_TYPE_UNSUPPORTED: "该文件类型暂不支持。",
    MEDIA_TOO_LARGE: "文件超过允许的大小。",
    MEDIA_EMPTY: "文件内容为空。",
    MEDIA_CONTENT_INVALID: "文件内容与类型不一致。",
    MEDIA_NOT_FOUND: "文件不存在或已清理。",
    MEDIA_RESERVATION_LOST: "本次上传已由另一个请求完成，请重新查询。",
  };
  return reply.code(statusCode).send({
    ok: false,
    code,
    retryable: ["MEDIA_BUSY", "MEDIA_RESERVATION_LOST"].includes(code),
    message: safeMessages[code] || "媒体处理失败，请稍后重试。",
  });
}

function parseRange(value, size) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^bytes=\d*-\d*$/.test(text) || text.includes(",")) return { invalid: true };
  const [startText, endText] = text.slice(6).split("-");
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
}

function setReadHeaders(reply, media, fileSize) {
  reply.header("Content-Type", media.contentType);
  reply.header("Content-Length", String(fileSize));
  reply.header("ETag", `"${media.digest}"`);
  reply.header("Cache-Control", "public, max-age=3600, immutable");
  reply.header("X-Content-Type-Options", "nosniff");
  if (media.mediaKind === "video") reply.header("Accept-Ranges", "bytes");
}

export async function registerErpMediaRoutes(app, options = {}) {
  const { config, catalog, store, requireMediaApiKey } = options;
  if (!config || !catalog || !store || typeof requireMediaApiKey !== "function") {
    throw new TypeError("ERP media route dependencies are required");
  }
  const uploadGate = createBoundedGate(config.uploadConcurrency, config.uploadQueueLimit);
  const readGate = createBoundedGate(config.readConcurrency, config.readQueueLimit);

  app.get("/v1/erp-media/capabilities", { preHandler: requireMediaApiKey }, async () => ({
    ok: true,
    data: {
      version: 1,
      media: { image: true, video: true, cover: true },
      maxBytes: {
        image: config.imageMaxBytes,
        video: config.videoMaxBytes,
        cover: config.coverMaxBytes,
      },
    },
  }));

  app.post("/v1/erp-media", { preHandler: requireMediaApiKey }, async (request, reply) => {
    let releaseUpload;
    try {
      releaseUpload = await uploadGate.acquire();
      const fields = {};
      let filePart = null;
      let stored = null;
      for await (const part of request.parts({ limits: { files: 1, fileSize: config.videoMaxBytes + 1 } })) {
        if (part.type === "field") {
          fields[part.fieldname] = fieldValue(part);
          continue;
        }
        if (filePart) {
          part.file.resume();
          throw new MediaStoreError("MEDIA_FILE_REQUIRED", "Only one file is allowed.");
        }
        filePart = part;
        const metadata = uploadMetadata(request, fields);
        const metadataError = validateMetadata(metadata);
        if (metadataError) {
          part.file.resume();
          return reply.code(400).send({ ok: false, code: "MEDIA_METADATA_INVALID", message: metadataError });
        }
        const reservation = catalog.reserve(metadata, { pendingTakeoverMs: config.pendingTakeoverMs });
        if (reservation.state === "complete") {
          part.file.resume();
          stored = reservation.media;
          continue;
        }
        if (reservation.state === "pending") {
          part.file.resume();
          return reply.code(202).send({
            ok: false,
            code: "MEDIA_UPLOAD_PENDING",
            retryable: true,
            message: "相同文件正在上传，请稍后查询。",
          });
        }
        if (reservation.state !== "reserved") {
          part.file.resume();
          return reply.code(409).send({
            ok: false,
            code: "MEDIA_UPLOAD_UNAVAILABLE",
            retryable: false,
            message: "该上传记录当前不可用。",
          });
        }
        stored = await store.save({
          stream: part.file,
          reservation,
          mediaKind: metadata.mediaKind,
          contentType: part.mimetype,
        });
      }
      if (!filePart || !stored) {
        return reply.code(400).send({ ok: false, code: "MEDIA_FILE_REQUIRED", message: "请选择需要上传的文件。" });
      }
      return {
        ok: true,
        data: {
          id: stored.publicId,
          url: publicUrl(config, request, stored),
          mediaKind: stored.mediaKind,
          contentType: stored.contentType,
          size: stored.size,
          status: "complete",
        },
      };
    } catch (error) {
      return sendRouteError(reply, error);
    } finally {
      releaseUpload?.();
    }
  });

  async function serveMedia(request, reply) {
    let releaseGate;
    let opened;
    try {
      releaseGate = await readGate.acquire();
      const publicId = cleanText(request.params.publicId, 100);
      const filename = cleanText(request.params.filename, 160);
      const media = catalog.getByPublicId(publicId);
      if (!media || media.status !== "complete" || media.filename !== filename || path.basename(filename) !== filename) {
        throw new MediaStoreError("MEDIA_NOT_FOUND", "Media was not found.", 404);
      }
      opened = await store.openForRead(media);
      const range = media.mediaKind === "video" ? parseRange(request.headers.range, opened.stat.size) : null;
      if (range?.invalid) {
        reply.header("Content-Range", `bytes */${opened.stat.size}`);
        opened.release();
        opened = null;
        releaseGate();
        releaseGate = null;
        return reply.code(416).send();
      }
      if (range) {
        const length = range.end - range.start + 1;
        reply.code(206);
        setReadHeaders(reply, media, length);
        reply.header("Content-Range", `bytes ${range.start}-${range.end}/${opened.stat.size}`);
      } else {
        setReadHeaders(reply, media, opened.stat.size);
      }
      if (request.method === "HEAD") {
        opened.release();
        opened = null;
        releaseGate();
        releaseGate = null;
        return reply.send();
      }
      const stream = store.createThrottledReadStream(opened.fullPath, range ? { start: range.start, end: range.end } : {});
      const release = () => {
        opened?.release();
        opened = null;
        releaseGate?.();
        releaseGate = null;
      };
      stream.once("end", release);
      stream.once("close", release);
      stream.once("error", release);
      request.raw.once("close", release);
      return reply.send(stream);
    } catch (error) {
      opened?.release();
      releaseGate?.();
      return sendRouteError(reply, error);
    }
  }

  app.get("/erp-media/:publicId/:filename", serveMedia);

  return { uploadGate, readGate };
}
