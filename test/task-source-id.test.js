import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-source-id-"));
process.env.DATA_DIR = dataDir;

const { getTaskBySourceTaskId, listTasks, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { createImageTask, getRuntimeStatus, refreshTask } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
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

test("相同洗图王任务 ID 的失败结果会更新原任务记录", async () => {
  const sourceTaskId = "task_xituwang_source_api_1234abcd";
  const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 60 * 60 * 1000 + 5000).toISOString();

  await upsertTask({
    id: "local-source-task-original",
    sourceTaskId,
    status: "processing",
    taskType: "img2img",
    requestJson: { client_task_id: sourceTaskId },
    createdAt
  });

  await upsertTask({
    id: "local-source-task-fallback",
    sourceTaskId,
    status: "failed",
    taskType: "img2img",
    errorMessage: "并发上限",
    responseJson: { ok: false, code: "CONCURRENCY_LIMIT", sourceTaskId },
    completedAt
  });

  const tasks = await listTasks();
  const matched = tasks.filter((task) => task.sourceTaskId === sourceTaskId);

  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, "local-source-task-original");
  assert.equal(matched[0].status, "failed");
  assert.equal(matched[0].responseJson.code, "CONCURRENCY_LIMIT");
  assert.equal((await getTaskBySourceTaskId(sourceTaskId)).id, "local-source-task-original");
});

test("额度检测不会占用生图并发", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: { drawingBaseUrl: "https://drawing.example.test", defaultModelId: 1 }
    }],
    accounts: [{
      id: "drawing-account-1",
      name: "Drawing Account",
      channelId: "shareai",
      username: "drawing@example.test",
      password: "password",
      enabled: true,
      status: "ok",
      token: "test-token",
      meta: { abilities: { drawing: { status: "ok" } } }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalCreateImageTask = DrawingClient.prototype.createImageTask;
  let releaseCheck;
  const checkStarted = new Promise((resolve) => {
    DrawingClient.prototype.check = async () => {
      resolve();
      await new Promise((release) => {
        releaseCheck = release;
      });
      return { status: "quota_empty", message: "绘图积分不足" };
    };
  });
  let submitted = false;
  DrawingClient.prototype.createImageTask = async () => {
    submitted = true;
    throw new Error("should not submit when quota is empty");
  };

  const sourceTaskId = "task_quota_check_no_slot_api_abcd1234";
  const taskPromise = createImageTask({
    input: {
      channel: "drawing",
      prompt: "quota check no slot",
      client_task_id: sourceTaskId
    },
    files: [{ filename: "source.png", mimetype: "image/png", buffer: Buffer.from("x") }],
    wait: true
  });

  try {
    await checkStarted;
    const runtime = await getRuntimeStatus();
    assert.equal(runtime.running.drawingImage, 0);
    assert.equal(runtime.running.total, 0);

    releaseCheck();
    await assert.rejects(taskPromise, /绘图积分不足|No available compatible accounts|并发上限|调用失败/);

    const stored = await getTaskBySourceTaskId(sourceTaskId);
    assert.equal(stored.status, "failed");
    assert.equal(submitted, false);
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("绘图站刷新返回异常网页时任务直接失败", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: { drawingBaseUrl: "https://drawing.example.test", defaultModelId: 1 }
    }],
    accounts: [{
      id: "drawing-refresh-account",
      name: "Drawing Refresh Account",
      channelId: "shareai",
      username: "drawing-refresh@example.test",
      password: "password",
      enabled: true,
      status: "ok",
      meta: { abilities: { drawing: { status: "ok" } } }
    }]
  });

  const taskId = "waiting-drawing-html";
  await upsertTask({
    id: taskId,
    sourceTaskId: "task_waiting_drawing_html_api_12345678",
    status: "waiting_upstream",
    taskType: "img2img",
    prompt: "refresh invalid upstream",
    channelId: "shareai:drawing",
    channelType: "drawing",
    accountId: "drawing-refresh-account",
    accountName: "Drawing Refresh Account",
    externalId: "upstream-html-response",
    raw: { submittedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });

  const originalGetTask = DrawingClient.prototype.getTask;
  DrawingClient.prototype.getTask = async () => {
    const error = new Error("绘图站返回了网页页面，不是任务结果，请检查绘图站登录状态或接口地址。");
    error.status = 502;
    error.code = "INVALID_UPSTREAM_RESPONSE";
    error.payload = { bodyPreview: "<!doctype html><html></html>" };
    throw error;
  };

  try {
    const refreshed = await refreshTask(taskId);
    assert.equal(refreshed.status, "failed");
    assert.match(refreshed.errorMessage, /网页页面/);
    assert.equal(refreshed.raw.refreshCode, "INVALID_UPSTREAM_RESPONSE");
  } finally {
    DrawingClient.prototype.getTask = originalGetTask;
  }
});

test("chatplus text-only image result is returned as failure message", async () => {
  const message = "I wasn't able to generate the image due to an error on my side.";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-text-account", username: "chat@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  const originalLoginPortal = ChatplusClient.prototype.loginPortal;
  const originalJson = ChatplusClient.prototype.json;
  ChatplusClient.prototype.loginPortal = async function loginPortal() {
    this.portalLoggedIn = true;
  };
  ChatplusClient.prototype.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: [message] }
        }
      }
    }
  });

  try {
    const task = await client.getTask("conversation-text-only");
    assert.equal(task.status, "failed");
    assert.equal(task.errorMessage, message);
    assert.equal(task.imageUrls.length, 0);
  } finally {
    ChatplusClient.prototype.loginPortal = originalLoginPortal;
    ChatplusClient.prototype.json = originalJson;
  }
});

test("chatplus text-only image wait returns upstream text immediately", async () => {
  const message = "I wasn't able to generate the image due to an error on my side.";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-text-account", username: "chat@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  await assert.rejects(
    () => client.waitForConversationImages([{
      message: {
        author: { role: "assistant" },
        content: { parts: [message] }
      }
    }], "conversation-text-only", 30, { generatedOnly: true }),
    (error) => {
      assert.equal(error.message, message);
      assert.equal(error.status, 400);
      assert.equal(error.code, "upstream_text_response");
      assert.equal(error.upstreamExplicitFailure, true);
      return true;
    }
  );
});
