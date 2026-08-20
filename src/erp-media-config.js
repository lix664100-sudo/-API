import path from "node:path";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  return Math.floor(positiveNumber(value, fallback, minimum));
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

export function loadErpMediaConfig(env = process.env, rootDir = process.cwd()) {
  const dataDir = path.resolve(rootDir, env.ERP_MEDIA_DATA_DIR || "data");
  const mediaDir = path.resolve(rootDir, env.ERP_MEDIA_DIR || "outputs/erp-media");
  const tempDir = path.resolve(rootDir, env.ERP_MEDIA_TEMP_DIR || "outputs/erp-media-temp");

  return Object.freeze({
    dataDir,
    mediaDir,
    tempDir,
    databaseFile: path.resolve(dataDir, env.ERP_MEDIA_DATABASE_FILE || "erp-media.sqlite"),
    publicBaseUrl: cleanBaseUrl(env.PUBLIC_BASE_URL),
    uploadConcurrency: positiveInteger(env.ERP_MEDIA_UPLOAD_CONCURRENCY, 3),
    uploadQueueLimit: positiveInteger(env.ERP_MEDIA_UPLOAD_QUEUE_LIMIT, 30),
    readConcurrency: positiveInteger(env.ERP_MEDIA_READ_CONCURRENCY, 16),
    readQueueLimit: positiveInteger(env.ERP_MEDIA_READ_QUEUE_LIMIT, 100),
    imageMaxBytes: positiveInteger(env.ERP_MEDIA_IMAGE_MAX_MB, 25) * MB,
    videoMaxBytes: positiveInteger(env.ERP_MEDIA_VIDEO_MAX_MB, 300) * MB,
    coverMaxBytes: positiveInteger(env.ERP_MEDIA_COVER_MAX_MB, 25) * MB,
    readBytesPerSecond: Math.min(
      80 * MB,
      positiveInteger(env.ERP_MEDIA_READ_LIMIT_MBPS, 80) * MB,
    ),
    writeBytesPerSecond: Math.min(
      80 * MB,
      positiveInteger(env.ERP_MEDIA_WRITE_LIMIT_MBPS, 80) * MB,
    ),
    minimumFreeBytes: positiveNumber(env.ERP_MEDIA_MIN_FREE_GB, 5) * GB,
    minimumFreePercent: Math.min(50, positiveNumber(env.ERP_MEDIA_MIN_FREE_PERCENT, 5)),
    pendingTakeoverMs: positiveInteger(env.ERP_MEDIA_PENDING_TAKEOVER_SEC, 120) * 1000,
    tempRetentionMs: positiveInteger(env.ERP_MEDIA_TEMP_RETENTION_MIN, 60) * 60 * 1000,
  });
}

export const erpMediaConfig = loadErpMediaConfig();
