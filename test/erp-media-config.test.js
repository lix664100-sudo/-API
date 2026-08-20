import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DEFAULT_ERP_MEDIA_API_KEY, loadErpMediaConfig } from "../src/erp-media-config.js";

test("ERP media config uses safe independent defaults", () => {
  const root = path.resolve("example-root");
  const config = loadErpMediaConfig({}, root);
  assert.equal(config.databaseFile, path.resolve(root, "data/erp-media.sqlite"));
  assert.equal(config.apiKey, DEFAULT_ERP_MEDIA_API_KEY);
  assert.equal(config.uploadConcurrency, 3);
  assert.equal(config.readConcurrency, 16);
  assert.equal(config.imageMaxBytes, 25 * 1024 * 1024);
  assert.equal(config.videoMaxBytes, 300 * 1024 * 1024);
  assert.equal(config.readBytesPerSecond, 80 * 1024 * 1024);
  assert.equal(config.writeBytesPerSecond, 80 * 1024 * 1024);
});

test("ERP media uses its dedicated key override independently", () => {
  const config = loadErpMediaConfig({
    ERP_MEDIA_API_KEY: "media-only-key",
  }, path.resolve("example-root"));
  assert.equal(config.apiKey, "media-only-key");
});

test("ERP media bandwidth cannot be configured above the A server safety ceiling", () => {
  const config = loadErpMediaConfig({
    ERP_MEDIA_READ_LIMIT_MBPS: "200",
    ERP_MEDIA_WRITE_LIMIT_MBPS: "300",
  }, path.resolve("example-root"));
  assert.equal(config.readBytesPerSecond, 80 * 1024 * 1024);
  assert.equal(config.writeBytesPerSecond, 80 * 1024 * 1024);
});
