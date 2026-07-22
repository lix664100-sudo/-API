import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-list-page-"));
process.env.DATA_DIR = dataDir;

const { listTaskPage, upsertTask } = await import("../src/storage.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("task pages return the newest matching records without returning the full history", async () => {
  const now = Date.now();
  const tasks = [
    {
      id: "task-old-drawing",
      sourceTaskId: "batch_draw_old_001",
      status: "failed",
      channelType: "drawing",
      accountId: "account-a",
      errorMessage: "upstream concurrency limit",
      createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "task-middle-chat",
      sourceTaskId: "batch_draw_middle_002",
      status: "success",
      channelType: "chatplus",
      accountId: "account-b",
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "task-new-drawing",
      sourceTaskId: "batch_draw_new_003",
      status: "processing",
      channelType: "drawing",
      accountId: "account-a",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString()
    }
  ];
  for (const task of tasks) await upsertTask(task);

  const firstPage = await listTaskPage({ page: 1, pageSize: 2 });
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.pageCount, 2);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.items.map((task) => task.id), ["task-new-drawing", "task-middle-chat"]);

  const secondPage = await listTaskPage({ page: 2, pageSize: 2 });
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(secondPage.items.map((task) => task.id), ["task-old-drawing"]);

  const filtered = await listTaskPage({
    keyword: "batch_draw_old",
    accountId: "account-a",
    channel: "drawing",
    status: "failed"
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, "task-old-drawing");

  const errorSearch = await listTaskPage({ keyword: "concurrency limit" });
  assert.equal(errorSearch.total, 1);
  assert.equal(errorSearch.items[0].id, "task-old-drawing");
});
