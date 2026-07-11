import { mkdir, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = process.cwd();
export const resultImageDir = path.resolve(rootDir, process.env.RESULT_IMAGE_DIR || "outputs/results");

const cleanupIntervalMs = Math.max(5, Number(process.env.RESULT_IMAGE_CLEANUP_INTERVAL_MIN || 60)) * 60 * 1000;
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

async function downloadImage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "ShareAI-API/1.0"
    }
  });
  if (!response.ok) throw new Error(`图片转存失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("图片转存失败：上游返回的不是图片。");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
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

export async function mirrorImageUrl(url, config = {}) {
  const source = String(url || "").trim();
  if (!source || isLocalResultUrl(source, config)) return source;
  const { buffer, contentType } = await downloadImage(source);
  await mkdir(resultImageDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}${extFromContentType(contentType)}`;
  await writeFile(path.join(resultImageDir, filename), buffer);
  await runAutoCleanupResultImages(config).catch(() => null);
  return localResultUrl(filename, config);
}

export async function mirrorImageUrls(urls = [], config = {}) {
  const results = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    if (!shouldMirrorImageUrl(url, config)) {
      results.push(url);
      continue;
    }
    try {
      results.push(await mirrorImageUrl(url, config));
    } catch {
      results.push(url);
    }
  }
  return results;
}

export function setRuntimePublicBaseUrl(value) {
  if (!value || process.env.PUBLIC_BASE_URL) return;
  runtimePublicBaseUrl = String(value).replace(/\/+$/, "");
}
