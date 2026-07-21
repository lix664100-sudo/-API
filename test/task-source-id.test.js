import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-source-id-"));
process.env.DATA_DIR = dataDir;

const { listTasks, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { createImageTask } = await import("../src/channel-manager.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("生图记录保留最近 2 天，处理中的旧任务不清理", async () => {
  const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  await upsertTask({ id: "old-failed", status: "failed", createdAt: oldTime });
  await upsertTask({ id: "old-processing", status: "processing", createdAt: oldTime });
  await upsertTask({ id: "recent-failed", status: "failed", createdAt: recentTime });

  const ids = (await listTasks()).map((task) => task.id);
  assert.deepEqual(ids.sort(), ["old-processing", "recent-failed"].sort());
});

test("洗图王任务 ID 会保存到本地记录，失败返回也会带回去", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    waitTimeoutSec: 30,
    accounts: [{
      id: "account-source-id",
      channelId: "shareai",
      name: "来源任务测试账号",
      username: "source-id@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 10, message: "绘图账号可用" },
          chatplus: { status: "quota_empty", balance: 0, message: "聊天生图额度不足" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalUploadImage = DrawingClient.prototype.uploadImage;
  const originalCreateImageTask = DrawingClient.prototype.createImageTask;

  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 50,
    balance: 10,
    message: "绘图账号可用"
  });
  DrawingClient.prototype.uploadImage = async () => ({ uploadId: "upload-source-id" });
  DrawingClient.prototype.createImageTask = async (input) => ({
    externalId: "draw-source-id",
    status: "failed",
    taskType: "img2img",
    prompt: input.prompt,
    modelId: "gpt-image-2",
    ratio: "1:1",
    imageCount: 1,
    imageUrls: [],
    errorMessage: "上游返回失败",
    raw: { message: "上游返回失败" }
  });

  try {
    await assert.rejects(
      createImageTask({
        input: { channel: "drawing", prompt: "测试失败返回", client_task_id: "batch_draw_123" },
        files: [{ filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") }],
        wait: true,
        requestMeta: { sourceTaskId: "batch_draw_123", callerIp: "127.0.0.1" }
      }),
      (error) => {
        assert.equal(error?.task?.sourceTaskId, "batch_draw_123");
        assert.equal(error?.responseJson?.sourceTaskId, "batch_draw_123");
        return true;
      }
    );

    const stored = (await listTasks()).find((task) => task.sourceTaskId === "batch_draw_123");
    assert.equal(stored.requestMeta.sourceTaskId, "batch_draw_123");
    assert.equal(stored.requestJson.client_task_id, "batch_draw_123");
    assert.equal(stored.responseJson.sourceTaskId, "batch_draw_123");
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.uploadImage = originalUploadImage;
    DrawingClient.prototype.createImageTask = originalCreateImageTask;
  }
});
