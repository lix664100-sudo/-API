import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupMediaStorage,
  getMediaStorageStats,
  runAutoCleanupMediaStorage,
} from "../src/erp-media-admin.js";

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    config: { imageStorage: { autoCleanup: true, retentionDays: 2 } },
    store: {
      storageStats: async () => ({
        images: { count: 3, bytes: 30 },
        videos: { count: 2, bytes: 200 },
        total: { count: 5, bytes: 230 },
        disk: { freeBytes: 1000 },
      }),
      cleanupExpired: async (options) => {
        calls.push(["erp", options]);
        return { deletedCount: 2, deletedBytes: 120, activeSkipped: 1 };
      },
      cleanupTemporary: async () => ({ deletedCount: 1 }),
    },
    getGeneratedStats: async () => ({ count: 4, totalBytes: 40, disk: { freeBytes: 900 } }),
    cleanupGenerated: async (_config, options) => {
      calls.push(["generated", options]);
      return { deletedCount: 1, deletedBytes: 10 };
    },
    ...overrides,
  };
}

test("A media stats separate generated, ERP image and ERP video storage", async () => {
  const value = await getMediaStorageStats(dependencies());
  assert.deepEqual(value.generatedImages, { count: 4, bytes: 40 });
  assert.deepEqual(value.erpImages, { count: 3, bytes: 30 });
  assert.deepEqual(value.erpVideos, { count: 2, bytes: 200 });
  assert.deepEqual(value.total, { count: 9, bytes: 270 });
});

test("A cleanup uses only A imageStorage retention settings", async () => {
  const context = dependencies();
  const result = await cleanupMediaStorage(context);
  assert.equal(result.retentionDays, 2);
  assert.equal(result.deletedCount, 3);
  assert.equal(result.activeSkipped, 1);
  assert.equal(context.calls[0][1].retentionDays, 2);
  assert.equal(context.calls[1][1].cutoff <= Date.now() - 2 * 24 * 60 * 60 * 1000 + 100, true);
});

test("disabled A automatic cleanup does not invoke any provider", async () => {
  const context = dependencies({ config: { imageStorage: { autoCleanup: false, retentionDays: 2 } } });
  const result = await runAutoCleanupMediaStorage(context);
  assert.equal(result.skipped, true);
  assert.deepEqual(context.calls, []);
});
