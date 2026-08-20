import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createErpMediaCatalog } from "../src/erp-media-catalog.js";
import { loadErpMediaConfig } from "../src/erp-media-config.js";
import { createErpMediaStore } from "../src/erp-media-store.js";

function pngBytes(extra = 0) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(extra, 1),
  ]);
}

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-media-store-"));
  const config = {
    ...loadErpMediaConfig({ ERP_MEDIA_MIN_FREE_GB: "0.000001" }, root),
    minimumFreeBytes: 1,
    minimumFreePercent: 0,
    ...overrides,
  };
  const catalog = createErpMediaCatalog({ databaseFile: config.databaseFile });
  const store = createErpMediaStore({ config, catalog });
  const reservation = catalog.reserve({
    installId: "install",
    uploadKey: `image-${Date.now()}-${Math.random()}`,
    mediaKind: "image",
  });
  return {
    root,
    config,
    catalog,
    store,
    reservation,
    close() {
      catalog.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("store streams a valid file into a dated private path", async () => {
  const context = setup();
  try {
    const media = await context.store.save({
      stream: Readable.from(pngBytes(16)),
      reservation: context.reservation,
      mediaKind: "image",
      contentType: "image/png",
    });
    assert.equal(media.status, "complete");
    assert.equal(media.size, 24);
    assert.equal(media.relativePath.includes(media.publicId), true);
    assert.equal(media.relativePath.includes("install"), false);
    assert.equal(fs.existsSync(path.join(context.config.mediaDir, media.relativePath)), true);
  } finally {
    context.close();
  }
});

test("store rejects empty, mismatched and oversized files without a public result", async () => {
  for (const scenario of [
    { bytes: Buffer.alloc(0), type: "image/png", code: "MEDIA_EMPTY" },
    { bytes: Buffer.from("not-png"), type: "image/png", code: "MEDIA_CONTENT_INVALID" },
    { bytes: pngBytes(64), type: "image/png", code: "MEDIA_TOO_LARGE", max: 16 },
  ]) {
    const context = setup(scenario.max ? { imageMaxBytes: scenario.max } : {});
    try {
      await assert.rejects(
        context.store.save({
          stream: Readable.from(scenario.bytes),
          reservation: context.reservation,
          mediaKind: "image",
          contentType: scenario.type,
        }),
        (error) => error.code === scenario.code,
      );
      assert.equal(context.catalog.getByPublicId(context.reservation.media.publicId)?.status, "failed");
    } finally {
      context.close();
    }
  }
});

test("cleanup skips an actively read file and removes it after release", async () => {
  const context = setup();
  try {
    const media = await context.store.save({
      stream: Readable.from(pngBytes(8)),
      reservation: context.reservation,
      mediaKind: "image",
      contentType: "image/png",
    });
    const opened = await context.store.openForRead(media);
    const first = await context.store.cleanupExpired({ cutoff: Date.now() + 1_000 });
    assert.equal(first.activeSkipped, 1);
    opened.release();
    const second = await context.store.cleanupExpired({ cutoff: Date.now() + 1_000 });
    assert.equal(second.deletedCount, 1);
  } finally {
    context.close();
  }
});

test("a failed stream leaves no public file and the same upload key can retry", async () => {
  const context = setup();
  try {
    const broken = new Readable({
      read() {
        this.push(pngBytes(8));
        this.destroy(Object.assign(new Error("disk stream interrupted"), { code: "STREAM_INTERRUPTED" }));
      },
    });
    await assert.rejects(context.store.save({
      stream: broken,
      reservation: context.reservation,
      mediaKind: "image",
      contentType: "image/png",
    }));
    assert.equal(fs.readdirSync(context.config.tempDir).length, 0);
    const publicFiles = fs.existsSync(context.config.mediaDir)
      ? fs.readdirSync(context.config.mediaDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.equal(publicFiles.length, 0);

    const retry = context.catalog.reserve({
      installId: "install",
      uploadKey: context.reservation.media.uploadKey,
      mediaKind: "image",
    });
    assert.equal(retry.state, "reserved");
    assert.equal(retry.retry, true);
  } finally {
    context.close();
  }
});

test("old orphan temporary files are removed without touching new ones", async () => {
  const context = setup({ tempRetentionMs: 1_000 });
  try {
    await context.store.ensureDirectories();
    const oldFile = path.join(context.config.tempDir, "old.part");
    const newFile = path.join(context.config.tempDir, "new.part");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(newFile, "new");
    fs.utimesSync(oldFile, new Date(0), new Date(0));
    const result = await context.store.cleanupTemporary(5_000);
    assert.equal(result.deletedCount, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  } finally {
    context.close();
  }
});

test("disk protection rejects only a new upload and leaves completed media readable", async () => {
  const context = setup();
  try {
    const completed = await context.store.save({
      stream: Readable.from(pngBytes(8)),
      reservation: context.reservation,
      mediaKind: "image",
      contentType: "image/png",
    });
    const second = context.catalog.reserve({
      installId: "install",
      uploadKey: "disk-protection-second",
      mediaKind: "image",
    });
    context.config.minimumFreeBytes = Number.MAX_SAFE_INTEGER;
    await assert.rejects(
      context.store.save({
        stream: Readable.from(pngBytes(8)),
        reservation: second,
        mediaKind: "image",
        contentType: "image/png",
      }),
      (error) => error.code === "MEDIA_STORAGE_FULL" && error.statusCode === 507,
    );
    const opened = await context.store.openForRead(completed);
    assert.equal(opened.stat.size, completed.size);
    opened.release();
  } finally {
    context.close();
  }
});
