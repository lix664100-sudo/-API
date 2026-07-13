import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-recovery-"));
process.env.DATA_DIR = dataDir;

const { getTask, listTaskStats, upsertTask } = await import("../src/storage.js");
const { refreshProcessingTasks } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("重启后没有上游编号的生图任务会变成结果待确认，且不计失败", async () => {
  const id = "task-restart-without-upstream-id";
  await upsertTask({
    id,
    status: "processing",
    taskType: "img2img",
    prompt: "测试重启恢复",
    channelId: "shareai:drawing",
    channelName: "ShareAI账号/绘图站",
    channelType: "drawing",
    accountId: "account-1",
    accountName: "测试账号",
    raw: { queued: true },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    completedAt: null
  });

  const results = await refreshProcessingTasks();
  const stored = await getTask(id);
  const stats = await listTaskStats();

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(stored.status, "interrupted");
  assert.equal(stored.errorMessage, "");
  assert.equal(stored.raw.queued, false);
  assert.equal(stored.raw.interrupted, true);
  assert.match(stored.responseJson.message, /不计失败/);
  assert.ok(stored.completedAt);
  assert.equal(Object.keys(stats.records).length, 0);
});

test("聊天生图拿到上游编号后会先通知保存，再继续等待图片", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-1", username: "test@example.com" },
    sessionLock: async (work) => work()
  });
  let submitted = null;
  client.withImageQuotaFallback = async (_prompt, _input, work) => work({
    events: [],
    conversationId: "conversation-123",
    messageId: "message-123",
    model: "gpt",
    upstreamModel: "gpt-image",
    route: { key: "gpt" },
    selected: { carId: "car-1", carType: "chatgpt", strategy: "image" }
  });
  client.waitForConversationImages = async () => {
    assert.equal(submitted?.externalId, "conversation-123");
    return [];
  };

  const result = await client.createImageTask({
    prompt: "测试图片",
    files: [{ filename: "source.png" }],
    ratio: "1:1",
    onSubmitted: async (value) => {
      submitted = value;
    }
  });

  assert.equal(submitted.status, "processing");
  assert.equal(submitted.taskType, "img2img");
  assert.equal(submitted.raw.selectedCarId, "car-1");
  assert.equal(result.status, "waiting_upstream");
});
