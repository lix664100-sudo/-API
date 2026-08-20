import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const allowedMedia = Object.freeze({
  image: new Map([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
  ]),
  cover: new Map([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["video/mp4", ".mp4"],
    ["video/webm", ".webm"],
  ]),
  video: new Map([
    ["video/mp4", ".mp4"],
    ["video/webm", ".webm"],
    ["video/quicktime", ".mov"],
  ]),
});

export class MediaStoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "MediaStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SharedBandwidthLimiter {
  constructor(bytesPerSecond) {
    this.bytesPerSecond = Math.max(1, Number(bytesPerSecond || 1));
    this.nextAvailableAt = 0;
  }

  async consume(bytes) {
    const now = Date.now();
    const startAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = startAt + Math.ceil((Math.max(0, bytes) / this.bytesPerSecond) * 1000);
    const waitMs = startAt - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function normalizedContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function maxBytesFor(kind, config) {
  if (kind === "video") return config.videoMaxBytes;
  if (kind === "cover") return config.coverMaxBytes;
  return config.imageMaxBytes;
}

function matchesFileSignature(kind, contentType, bytes) {
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/gif") return bytes.subarray(0, 4).toString("ascii") === "GIF8";
  if (contentType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (contentType === "video/mp4" || contentType === "video/quicktime") return bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (contentType === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return kind === "video" ? bytes.length >= 12 : false;
}

async function safeUnlink(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createErpMediaStore({ config, catalog }) {
  if (!config || !catalog) throw new TypeError("config and catalog are required");
  const activeReads = new Map();
  const readLimiter = new SharedBandwidthLimiter(config.readBytesPerSecond);
  const writeLimiter = new SharedBandwidthLimiter(config.writeBytesPerSecond);

  async function ensureDirectories() {
    await Promise.all([
      mkdir(config.mediaDir, { recursive: true }),
      mkdir(config.tempDir, { recursive: true }),
    ]);
  }

  async function disk() {
    await ensureDirectories();
    const value = await statfs(config.mediaDir);
    const totalBytes = Number(value.blocks) * Number(value.bsize);
    const freeBytes = Number(value.bavail) * Number(value.bsize);
    return {
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0,
    };
  }

  async function ensureWritable() {
    const current = await disk();
    if (current.freeBytes < config.minimumFreeBytes || current.freePercent < config.minimumFreePercent) {
      throw new MediaStoreError("MEDIA_STORAGE_FULL", "Media storage has insufficient free space.", 507);
    }
    return current;
  }

  async function save({ stream, reservation, mediaKind, contentType, expiresAt }) {
    if (!stream || typeof stream.pipe !== "function") {
      throw new MediaStoreError("MEDIA_FILE_REQUIRED", "A media file is required.");
    }
    const kind = String(mediaKind || "").trim().toLowerCase();
    const accepted = allowedMedia[kind];
    const normalizedType = normalizedContentType(contentType);
    const extension = accepted?.get(normalizedType);
    if (!extension) {
      throw new MediaStoreError("MEDIA_TYPE_UNSUPPORTED", "This media type is not supported.", 415);
    }
    await ensureWritable();
    const maximumBytes = maxBytesFor(kind, config);
    const temporaryPath = path.join(config.tempDir, `${reservation.media.publicId}.part`);
    const date = new Date();
    const relativeDir = path.join(
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    const filename = `${reservation.media.publicId}${extension}`;
    const relativePath = path.join(relativeDir, filename);
    const finalPath = path.join(config.mediaDir, relativePath);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const digest = createHash("sha256");
    let size = 0;
    let header = Buffer.alloc(0);
    const verifier = new Transform({
      async transform(chunk, _encoding, callback) {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maximumBytes) {
            throw new MediaStoreError("MEDIA_TOO_LARGE", "The media file exceeds the allowed size.", 413);
          }
          if (header.length < 32) header = Buffer.concat([header, bytes]).subarray(0, 32);
          digest.update(bytes);
          await writeLimiter.consume(bytes.length);
          callback(null, bytes);
        } catch (error) {
          callback(error);
        }
      },
    });

    try {
      await pipeline(stream, verifier, createWriteStream(temporaryPath, { flags: "wx" }));
      if (!size) throw new MediaStoreError("MEDIA_EMPTY", "The media file is empty.");
      if (!matchesFileSignature(kind, normalizedType, header)) {
        throw new MediaStoreError("MEDIA_CONTENT_INVALID", "The file contents do not match its media type.", 415);
      }
      await rename(temporaryPath, finalPath);
      try {
        return catalog.complete(reservation.media.id, reservation.ownerToken, {
          contentType: normalizedType,
          filename,
          relativePath,
          size,
          digest: digest.digest("hex"),
          expiresAt,
        });
      } catch (error) {
        await safeUnlink(finalPath);
        throw error;
      }
    } catch (error) {
      await safeUnlink(temporaryPath).catch(() => {});
      catalog.fail(reservation.media.id, reservation.ownerToken, error?.code || "UPLOAD_FAILED");
      throw error;
    }
  }

  async function openForRead(media) {
    if (!media || media.status !== "complete" || !media.relativePath) {
      throw new MediaStoreError("MEDIA_NOT_FOUND", "Media was not found.", 404);
    }
    const fullPath = path.resolve(config.mediaDir, media.relativePath);
    const root = `${path.resolve(config.mediaDir)}${path.sep}`;
    if (!fullPath.startsWith(root)) {
      throw new MediaStoreError("MEDIA_NOT_FOUND", "Media was not found.", 404);
    }
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new MediaStoreError("MEDIA_NOT_FOUND", "Media was not found.", 404);
      throw error;
    }
    activeReads.set(media.id, (activeReads.get(media.id) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = (activeReads.get(media.id) || 1) - 1;
      if (next > 0) activeReads.set(media.id, next);
      else activeReads.delete(media.id);
    };
    return { fullPath, stat: fileStat, release };
  }

  function createThrottledReadStream(filePath, options = {}) {
    const source = createReadStream(filePath, options);
    const throttle = new Transform({
      async transform(chunk, _encoding, callback) {
        try {
          await readLimiter.consume(chunk.length);
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    source.on("error", (error) => throttle.destroy(error));
    return source.pipe(throttle);
  }

  async function cleanupExpired({ cutoff, limit = 200 } = {}) {
    const targetCutoff = Number(cutoff || Date.now());
    let deletedCount = 0;
    let deletedBytes = 0;
    let activeSkipped = 0;
    for (const media of catalog.listExpired(targetCutoff, limit)) {
      if (activeReads.has(media.id)) {
        activeSkipped += 1;
        continue;
      }
      const fullPath = path.resolve(config.mediaDir, media.relativePath);
      try {
        await safeUnlink(fullPath);
        catalog.markDeleted(media.id);
        deletedCount += 1;
        deletedBytes += media.size;
      } catch {
        // A later cleanup pass can retry a file that is temporarily locked.
      }
    }
    return { deletedCount, deletedBytes, activeSkipped };
  }

  async function cleanupTemporary(now = Date.now()) {
    await ensureDirectories();
    let deletedCount = 0;
    for (const entry of await readdir(config.tempDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      const filePath = path.join(config.tempDir, entry.name);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs > now - config.tempRetentionMs) continue;
        await safeUnlink(filePath);
        deletedCount += 1;
      } catch {
        // The file may already be gone.
      }
    }
    return { deletedCount };
  }

  async function storageStats() {
    const groups = Object.fromEntries(catalog.stats().map((item) => [item.mediaKind, item]));
    const currentDisk = await disk();
    const image = groups.image || { count: 0, bytes: 0 };
    const cover = groups.cover || { count: 0, bytes: 0 };
    const video = groups.video || { count: 0, bytes: 0 };
    return {
      images: { count: image.count + cover.count, bytes: image.bytes + cover.bytes },
      videos: { count: video.count, bytes: video.bytes },
      total: {
        count: image.count + cover.count + video.count,
        bytes: image.bytes + cover.bytes + video.bytes,
      },
      disk: currentDisk,
    };
  }

  return {
    ensureDirectories,
    ensureWritable,
    save,
    openForRead,
    createThrottledReadStream,
    cleanupExpired,
    cleanupTemporary,
    storageStats,
    isActive: (id) => activeReads.has(id),
  };
}
