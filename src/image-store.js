import { mkdir, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = process.cwd();
export const resultImageDir = path.resolve(rootDir, process.env.RESULT_IMAGE_DIR || "outputs/results");

const cleanupIntervalMs = Math.max(5, Number(process.env.RESULT_IMAGE_CLEANUP_INTERVAL_MIN || 60)) * 60 * 1000;
const defaultDownloadTimeoutMs = Math.max(1000, Number(process.env.RESULT_IMAGE_DOWNLOAD_TIMEOUT_MS || 30000));
const defaultDownloadAttempts = Math.max(1, Number(process.env.RESULT_IMAGE_DOWNLOAD_ATTEMPTS || 2));
const imageFilePattern = /\.(png|jpe?g|webp|gif)$/i;
let runtimePublicBaseUrl = "";
let lastAutoCleanupAt = 0;

const contentTypeExt = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

function extFromContentType(contentType = "") {
  return contentTypeExt[String(contentType).split(";")[0].trim().toLowerCase()] || ".png";
}

function publicBaseUrl(config = {}) {
  return String(process.env.PUBLIC_BASE_URL || config.publicBaseUrl || runtimePublicBaseUrl || "").replace(/\/+$/, "");
}

function localResultUrl(filename, config = {}) {
  const pathname = `/uploads/results/${filename}`;
  const base = publicBaseUrl(config);
  return base ? `${base}${pathname}` : pathname;
}

function imageStorageSettings(config = {}) {
  const settings = config.imageStorage || {};
  const mode = ["smart", "always", "never"].includes(settings.mode) ? settings.mode : "smart";
  const retentionDays = Math.min(3650, Math.max(1, Number(settings.retentionDays || 7)));
  return {
    mode,
    retentionDays,
    autoCleanup: settings.autoCleanup !== false
  };
}

function isLocalResultUrl(source, config = {}) {
  const value = String(source || "").trim();
  if (!value) return true;
  if (value.startsWith("/uploads/results/")) return true;
  const base = publicBaseUrl(config);
  if (base && value.startsWith(`${base}/uploads/results/`)) return true;
  try {
    return new URL(value).pathname.startsWith("/uploads/results/");
  } catch {
    return false;
  }
}

function looksTemporaryImageUrl(source) {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (host.includes("chatplus.cc") && pathname.startsWith("/backend-api/")) return true;
    if (pathname.startsWith("/gemini/images/")) return true;
    if (pathname.includes("/image_generation_content/")) return true;
    if (pathname.includes("/backend-api/estuary/content")) return true;
    return keys.some((key) => [
      "sig",
      "signature",
      "token",
      "expires",
      "expire",
      "x-amz-signature",
      "x-amz-expires",
      "policy",
      "key-pair-id"
    ].includes(key));
  } catch {
    return false;
  }
}

export function shouldMirrorImageUrl(url, config = {}) {
  const source = String(url || "").trim();
  if (!source || isLocalResultUrl(source, config)) return false;
  const { mode } = imageStorageSettings(config);
  if (mode === "always") return true;
  if (mode === "never") return false;
  return looksTemporaryImageUrl(source);
}

async function downloadImage(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || defaultDownloadTimeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": "ShareAI-API/1.0"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("图片保存超时，稍后会自动重试。");
      timeoutError.code = "IMAGE_DOWNLOAD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`图片保存失败：上游图片地址返回 ${response.status}。`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("图片保存失败：上游返回的不是图片。");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("图片保存失败：上游返回了空文件。");
  return { buffer, contentType };
}

async function downloadImageWithRetry(url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || defaultDownloadAttempts));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const downloader = typeof options.downloadImage === "function"
        ? options.downloadImage
        : downloadImage;
      return await downloader(url, { timeoutMs: options.timeoutMs || defaultDownloadTimeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  const error = lastError || new Error("图片保存失败。");
  error.code ||= "IMAGE_MIRROR_FAILED";
  throw error;
}

async function resultImageFiles() {
  await mkdir(resultImageDir, { recursive: true });
  const entries = await readdir(resultImageDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !imageFilePattern.test(entry.name)) continue;
    const fullPath = path.join(resultImageDir, entry.name);
    try {
      const fileStat = await stat(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        mtime: fileStat.mtime
      });
    } catch {
      // 文件可能刚好被清理掉，下一轮再统计。
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function diskStats() {
  try {
    const info = await statfs(resultImageDir);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
    };
  } catch {
    return null;
  }
}

export async function getResultImageStorageStats(config = {}) {
  const files = await resultImageFiles();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const settings = imageStorageSettings(config);
  return {
    directory: resultImageDir,
    count: files.length,
    totalBytes,
    oldestAt: files[0]?.mtime?.toISOString?.() || null,
    newestAt: files[files.length - 1]?.mtime?.toISOString?.() || null,
    disk: await diskStats(),
    settings
  };
}

export async function cleanupResultImages(config = {}, options = {}) {
  const settings = imageStorageSettings(config);
  const mode = options.mode === "all" ? "all" : "expired";
  const retentionDays = Math.min(3650, Math.max(1, Number(options.retentionDays || settings.retentionDays || 7)));
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const before = await getResultImageStorageStats(config);
  let deletedCount = 0;
  let deletedBytes = 0;

  for (const file of await resultImageFiles()) {
    if (mode !== "all" && file.mtimeMs >= cutoff) continue;
    try {
      await unlink(file.path);
      deletedCount += 1;
      deletedBytes += file.size;
    } catch {
      // 清理时文件被占用或已删除，不影响其它图片。
    }
  }

  return {
    mode,
    retentionDays,
    deletedCount,
    deletedBytes,
    before,
    after: await getResultImageStorageStats(config)
  };
}

export async function runAutoCleanupResultImages(config = {}, options = {}) {
  const settings = imageStorageSettings(config);
  if (!settings.autoCleanup) return { skipped: true, reason: "auto-cleanup-disabled" };
  if (!options.force && Date.now() - lastAutoCleanupAt < cleanupIntervalMs) {
    return { skipped: true, reason: "auto-cleanup-throttled" };
  }
  lastAutoCleanupAt = Date.now();
  return cleanupResultImages(config, { mode: "expired", retentionDays: settings.retentionDays });
}

export async function mirrorImageUrl(url, config = {}, options = {}) {
  const source = String(url || "").trim();
  if (!source || isLocalResultUrl(source, config)) return source;
  const { buffer, contentType } = await downloadImageWithRetry(source, options);
  await mkdir(resultImageDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}${extFromContentType(contentType)}`;
  await writeFile(path.join(resultImageDir, filename), buffer);
  await runAutoCleanupResultImages(config).catch(() => null);
  return localResultUrl(filename, config);
}

export async function mirrorImageUrls(urls = [], config = {}, options = {}) {
  const results = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    if (!shouldMirrorImageUrl(url, config)) {
      results.push(url);
      continue;
    }
    results.push(await mirrorImageUrl(url, config, options));
  }
  return results;
}

export function setRuntimePublicBaseUrl(value) {
  if (!value || process.env.PUBLIC_BASE_URL) return;
  runtimePublicBaseUrl = String(value).replace(/\/+$/, "");
}
