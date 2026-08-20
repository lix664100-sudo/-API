import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createErpMediaCatalog } from "../src/erp-media-catalog.js";

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-media-catalog-"));
  return { dir, file: path.join(dir, "catalog.sqlite") };
}

function reservationInput() {
  return {
    installId: "erp-install",
    uploadKey: "product-1:image-1:v1",
    mediaKind: "image",
    workspaceId: "workspace",
    shopId: "shop",
    productId: "product",
    batchId: "batch",
    contentVersion: "v1",
  };
}

test("catalog deduplicates an upload and reuses the completed result after reopen", () => {
  const target = tempDatabase();
  let catalog = createErpMediaCatalog({ databaseFile: target.file });
  try {
    const first = catalog.reserve(reservationInput(), { now: 1_000 });
    assert.equal(first.state, "reserved");
    const waiting = catalog.reserve(reservationInput(), { now: 1_001 });
    assert.equal(waiting.state, "pending");
    const completed = catalog.complete(first.media.id, first.ownerToken, {
      contentType: "image/png",
      filename: `${first.media.publicId}.png`,
      relativePath: `2026/08/20/${first.media.publicId}.png`,
      size: 12,
      digest: "abc",
      now: 1_002,
    });
    assert.equal(completed.status, "complete");
    catalog.close();
    catalog = createErpMediaCatalog({ databaseFile: target.file });
    const reused = catalog.reserve(reservationInput(), { now: 2_000 });
    assert.equal(reused.state, "complete");
    assert.equal(reused.media.publicId, first.media.publicId);
  } finally {
    catalog.close();
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test("only one stale pending reservation can be taken over", () => {
  const target = tempDatabase();
  const catalog = createErpMediaCatalog({ databaseFile: target.file });
  try {
    const first = catalog.reserve(reservationInput(), { now: 1_000, pendingTakeoverMs: 100 });
    const attempts = Array.from({ length: 12 }, (_, index) => (
      catalog.reserve(reservationInput(), { now: 2_000 + index, pendingTakeoverMs: 100 })
    ));
    assert.equal(attempts.filter((item) => item.state === "reserved").length, 1);
    assert.equal(attempts.filter((item) => item.state === "pending").length, 11);
    assert.notEqual(attempts.find((item) => item.state === "reserved").ownerToken, first.ownerToken);
  } finally {
    catalog.close();
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});
