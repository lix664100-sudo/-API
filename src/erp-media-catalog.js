import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function publicId() {
  return randomBytes(24).toString("base64url");
}

function rowToMedia(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    installId: row.install_id,
    uploadKey: row.upload_key,
    workspaceId: row.workspace_id,
    shopId: row.shop_id,
    productId: row.product_id,
    batchId: row.batch_id,
    mediaKind: row.media_kind,
    contentVersion: row.content_version,
    status: row.status,
    contentType: row.content_type,
    filename: row.filename,
    relativePath: row.relative_path,
    size: Number(row.size || 0),
    digest: row.digest,
    errorCode: row.error_code,
    ownerToken: row.owner_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

export function createErpMediaCatalog(options = {}) {
  const databaseFile = path.resolve(requiredText(options.databaseFile, "databaseFile"));
  mkdirSync(path.dirname(databaseFile), { recursive: true });
  const database = new Database(databaseFile);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS erp_media (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      install_id TEXT NOT NULL,
      upload_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      batch_id TEXT NOT NULL DEFAULT '',
      media_kind TEXT NOT NULL,
      content_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      digest TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      owner_token TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(install_id, upload_key)
    );
    CREATE INDEX IF NOT EXISTS erp_media_status_updated_idx
      ON erp_media(status, updated_at);
    CREATE INDEX IF NOT EXISTS erp_media_expires_idx
      ON erp_media(status, expires_at);
    CREATE INDEX IF NOT EXISTS erp_media_kind_idx
      ON erp_media(status, media_kind);
  `);

  const selectByKey = database.prepare(
    "SELECT * FROM erp_media WHERE install_id = ? AND upload_key = ?",
  );
  const selectByPublicId = database.prepare(
    "SELECT * FROM erp_media WHERE public_id = ?",
  );
  const insertPending = database.prepare(`
    INSERT OR IGNORE INTO erp_media (
      id, public_id, install_id, upload_key, workspace_id, shop_id, product_id,
      batch_id, media_kind, content_version, status, owner_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);
  const takeOver = database.prepare(`
    UPDATE erp_media
    SET owner_token = ?, updated_at = ?, error_code = ''
    WHERE id = ? AND status = 'pending' AND updated_at <= ?
  `);
  const retryFailed = database.prepare(`
    UPDATE erp_media
    SET status = 'pending', owner_token = ?, updated_at = ?, error_code = ''
    WHERE id = ? AND status = 'failed'
  `);

  const reserveTransaction = database.transaction((input, now, takeoverBefore) => {
    const ownerToken = randomUUID();
    const id = randomUUID();
    const created = nowIso(now);
    const result = insertPending.run(
      id,
      publicId(),
      input.installId,
      input.uploadKey,
      input.workspaceId,
      input.shopId,
      input.productId,
      input.batchId,
      input.mediaKind,
      input.contentVersion,
      ownerToken,
      created,
      created,
    );
    let row = selectByKey.get(input.installId, input.uploadKey);
    if (result.changes === 1) {
      return { state: "reserved", ownerToken, media: rowToMedia(row) };
    }
    if (row?.status === "complete") {
      return { state: "complete", ownerToken: "", media: rowToMedia(row) };
    }
    if (row?.status === "pending") {
      const changed = takeOver.run(ownerToken, created, row.id, nowIso(takeoverBefore));
      if (changed.changes === 1) {
        row = selectByKey.get(input.installId, input.uploadKey);
        return { state: "reserved", ownerToken, media: rowToMedia(row), takeover: true };
      }
      return { state: "pending", ownerToken: "", media: rowToMedia(row) };
    }
    if (row?.status === "failed") {
      const changed = retryFailed.run(ownerToken, created, row.id);
      if (changed.changes === 1) {
        row = selectByKey.get(input.installId, input.uploadKey);
        return { state: "reserved", ownerToken, media: rowToMedia(row), retry: true };
      }
    }
    return { state: row?.status || "unavailable", ownerToken: "", media: rowToMedia(row) };
  });

  function reserve(input = {}, settings = {}) {
    const normalized = {
      installId: requiredText(input.installId, "installId"),
      uploadKey: requiredText(input.uploadKey, "uploadKey"),
      workspaceId: String(input.workspaceId || "").trim(),
      shopId: String(input.shopId || "").trim(),
      productId: String(input.productId || "").trim(),
      batchId: String(input.batchId || "").trim(),
      mediaKind: requiredText(input.mediaKind, "mediaKind"),
      contentVersion: String(input.contentVersion || "").trim(),
    };
    const now = Number(settings.now || Date.now());
    const takeoverMs = Math.max(1, Number(settings.pendingTakeoverMs || 120_000));
    return reserveTransaction.immediate(normalized, now, now - takeoverMs);
  }

  function complete(id, ownerToken, value = {}) {
    const result = database.prepare(`
      UPDATE erp_media
      SET status = 'complete', content_type = ?, filename = ?, relative_path = ?,
          size = ?, digest = ?, error_code = '', expires_at = ?, updated_at = ?
      WHERE id = ? AND owner_token = ? AND status = 'pending'
    `).run(
      requiredText(value.contentType, "contentType"),
      requiredText(value.filename, "filename"),
      requiredText(value.relativePath, "relativePath"),
      Math.max(0, Number(value.size || 0)),
      requiredText(value.digest, "digest"),
      value.expiresAt ? nowIso(Date.parse(value.expiresAt)) : null,
      nowIso(value.now || Date.now()),
      requiredText(id, "id"),
      requiredText(ownerToken, "ownerToken"),
    );
    if (result.changes !== 1) {
      const error = new Error("Media reservation is no longer owned by this upload.");
      error.code = "MEDIA_RESERVATION_LOST";
      throw error;
    }
    return rowToMedia(database.prepare("SELECT * FROM erp_media WHERE id = ?").get(id));
  }

  function fail(id, ownerToken, errorCode = "UPLOAD_FAILED", now = Date.now()) {
    database.prepare(`
      UPDATE erp_media
      SET status = 'failed', error_code = ?, owner_token = '', updated_at = ?
      WHERE id = ? AND owner_token = ? AND status = 'pending'
    `).run(String(errorCode || "UPLOAD_FAILED"), nowIso(now), id, ownerToken);
  }

  function markDeleted(id, now = Date.now()) {
    database.prepare(`
      UPDATE erp_media
      SET status = 'deleted', relative_path = '', owner_token = '', updated_at = ?
      WHERE id = ? AND status = 'complete'
    `).run(nowIso(now), id);
  }

  function listExpired(cutoff, limit = 200) {
    return database.prepare(`
      SELECT * FROM erp_media
      WHERE status = 'complete'
        AND (expires_at IS NOT NULL AND expires_at <= ? OR updated_at <= ?)
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(nowIso(cutoff), nowIso(cutoff), Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map(rowToMedia);
  }

  function stats() {
    const rows = database.prepare(`
      SELECT media_kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM erp_media
      WHERE status = 'complete'
      GROUP BY media_kind
    `).all();
    return rows.map((row) => ({
      mediaKind: row.media_kind,
      count: Number(row.count || 0),
      bytes: Number(row.bytes || 0),
    }));
  }

  return {
    databaseFile,
    reserve,
    complete,
    fail,
    markDeleted,
    listExpired,
    stats,
    getByKey: (installId, uploadKey) => rowToMedia(selectByKey.get(installId, uploadKey)),
    getByPublicId: (value) => rowToMedia(selectByPublicId.get(String(value || ""))),
    close() {
      if (!database.open) return;
      database.pragma("wal_checkpoint(TRUNCATE)");
      database.close();
    },
  };
}
