import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "ikun-sqlite-storage-"));
const tasksFile = path.join(dataDir, "tasks.json");
const statsFile = path.join(dataDir, "stats.json");
const databaseFile = path.join(dataDir, "storage.sqlite");
const now = new Date().toISOString();
const legacyTasks = [
  {
    id: "legacy-task",
    status: "success",
    createdAt: now,
    updatedAt: now,
    prompt: "legacy"
  }
];
const legacyStats = {
  version: 1,
  updatedAt: now,
  records: {
    "legacy-task": {
      taskId: "legacy-task",
      time: Date.now(),
      status: "success",
      channel: "chatplus",
      generatedImages: 1
    }
  }
};

await writeFile(tasksFile, `${JSON.stringify(legacyTasks, null, 2)}\n`, "utf8");
await writeFile(statsFile, `${JSON.stringify(legacyStats, null, 2)}\n`, "utf8");
process.env.DATA_DIR = dataDir;

const {
  closeStorage,
  listTaskStats,
  listTasks,
  upsertTask
} = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("旧任务和统计自动迁移到 SQLite，后续写入不再重写旧 JSON", async () => {
  const originalTasksJson = await readFile(tasksFile, "utf8");
  const originalStatsJson = await readFile(statsFile, "utf8");

  assert.deepEqual((await listTasks()).map((task) => task.id), ["legacy-task"]);

  await upsertTask({
    id: "new-task",
    status: "processing",
    createdAt: new Date().toISOString(),
    prompt: "new"
  });

  assert.deepEqual(
    (await listTasks()).map((task) => task.id).sort(),
    ["legacy-task", "new-task"]
  );
  assert.equal(await readFile(tasksFile, "utf8"), originalTasksJson);
  assert.equal(await readFile(statsFile, "utf8"), originalStatsJson);
  assert.ok((await stat(databaseFile)).size > 0);

  const stats = await listTaskStats();
  assert.equal(stats.records.some((record) => record.taskId === "legacy-task"), true);
});
