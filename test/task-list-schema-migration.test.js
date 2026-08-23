import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-list-schema-"));
const databaseFile = path.join(dataDir, "storage.sqlite");
const database = new Database(databaseFile);
const createdAt = new Date().toISOString();
const task = {
  id: "legacy-sqlite-chat",
  status: "success",
  taskType: "chat",
  accountId: "account-legacy",
  channelId: "channel-google:chatplus",
  channelType: "chatplus",
  prompt: "旧数据库里的对话记录",
  createdAt
};

database.exec(`
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    source_task_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_time INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL
  );
`);
database.prepare(`
  INSERT INTO tasks (id, source_task_id, created_at, created_time, status, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(task.id, "", createdAt, Date.parse(createdAt), task.status, JSON.stringify(task));
database.close();

process.env.DATA_DIR = dataDir;
const { closeStorage, listTaskPage } = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("旧版 SQLite 自动补齐任务列表筛选字段", async () => {
  const page = await listTaskPage({
    accountId: "account-legacy",
    sourceChannelId: "channel-google",
    channel: "chatplus",
    kind: "chat",
    keyword: "旧数据库"
  });

  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, task.id);
});
