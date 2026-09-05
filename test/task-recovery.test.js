import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-recovery-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, listTasks, listTaskStats, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { createImageTask, getRuntimeStatus, imageTaskClientView, inspectUpstreamTask, queueImageTask, queueTextTask, refreshProcessingTasks, refreshTask, reserveImageTaskAdmission } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("waiting image task response hides temporary image URLs", () => {
  const temporaryUrl = "https://cloudlian.cn/gemini/images/gg-dl/temporary-result";
  const view = imageTaskClientView({
    id: "task-waiting-client-view",
    sourceTaskId: "source-waiting-client-view",
    externalId: "conversation-waiting-client-view",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gemini",
    imageCount: 1,
    imageUrls: [temporaryUrl],
    requestJson: { sourceImage: "https://images.example.test/source.png" },
    raw: { originalImageUrls: [temporaryUrl] },
    createdAt: "2026-07-27T22:20:17.698Z",
    completedAt: null
  });

  assert.equal(view.status, "waiting_upstream");
  assert.equal(view.imageCount, 0);
  assert.deepEqual(view.imageUrls, []);
  assert.equal(view.raw, undefined);
  assert.equal(view.requestJson, undefined);
  assert.equal(JSON.stringify(view).includes("cloudlian.cn"), false);
  assert.equal(JSON.stringify(view).includes("images.example.test"), false);
});

test("drawing client accepts OpenAI image model aliases", () => {
  const client = new DrawingClient({
    config: { defaultModelId: 3 },
    channel: {
      id: "shareai:drawing",
      settings: { defaultModelId: 2, geminiDrawingModelId: 3 }
    },
    account: { id: "account-drawing-model" }
  });

  assert.equal(client.defaultModelId({ model: "gpt" }), 1);
  assert.equal(client.defaultModelId({ model: "gemini" }), 3);
  assert.equal(client.defaultModelId({ model: "gpt-image-2" }), 1);
  assert.equal(client.defaultModelId({ model: "nano-banana-pro" }), 2);
  assert.equal(client.defaultModelId({ model: "nano-banana" }), 3);
  assert.equal(client.defaultModelId({ model_id: 2, model: "gpt-image-2" }), 2);
  assert.equal(client.defaultModelId({ model: "unknown-image-model" }), 2);
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

test("服务重启后排队中的对话任务会停止，不会永久卡在排队中", async () => {
  const id = "task-restart-queued-chat";
  await upsertTask({
    id,
    status: "queued",
    taskType: "chat",
    prompt: "等待空闲名额的对话",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/对话",
    channelType: "chatplus",
    accountId: "account-queued-chat",
    accountName: "排队对话账号",
    raw: { queued: true, waitingForSlot: true },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    completedAt: null
  });

  const results = await refreshProcessingTasks();
  const stored = await getTask(id);

  assert.equal(results.some((result) => result.id === id && result.ok), true);
  assert.equal(stored.status, "failed");
  assert.equal(stored.raw.queued, false);
  assert.equal(stored.raw.waitingForSlot, false);
  assert.match(stored.errorMessage, /服务|后台执行进程|停止/);
});

test("已经明确失败的任务不会被旧的结果待确认覆盖", async () => {
  const id = "task-failed-before-stale-interrupt";
  const failedAt = new Date().toISOString();
  await upsertTask({
    id,
    status: "failed",
    taskType: "img2img",
    prompt: "failed task",
    errorMessage: "并发上限",
    responseJson: { ok: false, message: "并发上限", code: "CONCURRENCY_LIMIT" },
    raw: { queued: false },
    createdAt: failedAt,
    completedAt: failedAt
  });

  await upsertTask({
    id,
    status: "interrupted",
    taskType: "img2img",
    prompt: "failed task",
    errorMessage: "",
    responseJson: { ok: null, message: "结果待确认" },
    raw: { queued: false, interrupted: true },
    completedAt: new Date().toISOString()
  });

  const stored = await getTask(id);

  assert.equal(stored.status, "failed");
  assert.equal(stored.errorMessage, "并发上限");
  assert.equal(stored.responseJson.code, "CONCURRENCY_LIMIT");
});

test("later successful task result repairs an earlier failed refresh with the same task id", async () => {
  const id = "task-failed-before-success";
  const sourceTaskId = "source-failed-before-success";
  const failedAt = new Date().toISOString();
  await upsertTask({
    id,
    sourceTaskId,
    status: "failed",
    taskType: "img2img",
    prompt: "repair failed task",
    errorMessage: "stale refresh failed",
    responseJson: { status: "failed", sourceTaskId, errorMessage: "stale refresh failed" },
    imageCount: 0,
    imageUrls: [],
    createdAt: failedAt,
    completedAt: failedAt
  });

  await upsertTask({
    id,
    sourceTaskId,
    status: "success",
    taskType: "img2img",
    prompt: "repair failed task",
    errorMessage: "",
    responseJson: { status: "success", sourceTaskId },
    imageCount: 1,
    imageUrls: ["https://images.example.test/result.png"],
    completedAt: new Date().toISOString()
  });

  const stored = await getTask(id);

  assert.equal(stored.status, "success");
  assert.equal(stored.errorMessage, "");
  assert.equal(stored.imageUrls.length, 1);
});

test("正在执行的同步生图任务不会被刷新误判为结果待确认", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-active-image",
      channelId: "shareai",
      name: "正在生图的账号",
      username: "active@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图积分不足" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  let continueUpstream;
  let markUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    markUpstreamStarted = resolve;
  });
  ChatplusClient.prototype.createImageTask = async (input) => {
    markUpstreamStarted();
    await new Promise((resolve) => {
      continueUpstream = resolve;
    });
    return {
      externalId: "active-image-upstream-id",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      imageCount: 1,
      imageUrls: [],
      raw: {}
    };
  };

  try {
    const creation = createImageTask({
      input: { channel: "chatplus", prompt: "测试执行中刷新" },
      files: [{ filename: "source.png", mimetype: "image/png" }],
      wait: true
    });
    await upstreamStarted;

    await refreshProcessingTasks();
    const activeTask = (await listTasks()).find((task) => task.prompt === "测试执行中刷新");
    assert.equal(activeTask.status, "processing");
    assert.equal(activeTask.raw.queued, true);
    assert.notEqual(activeTask.raw.interrupted, true);

    continueUpstream();
    const completedTask = await creation;
    assert.equal(completedTask.status, "success");
  } finally {
    continueUpstream?.();
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("上游取消会保存为 cancelled 并保留下游任务编号", async () => {
  const config = await loadConfig();
  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  let submitCount = 0;
  await saveConfig({
    ...config,
    defaultChannel: "cancelled-chatplus",
    channels: [{
      id: "cancelled-chatplus",
      type: "chatplus",
      name: "取消测试聊天渠道",
      enabled: true,
      settings: {
        baseUrl: "https://chat.example.test",
        defaultChatModel: "gpt",
        chatModels: [{ key: "gpt", name: "GPT", enabled: true, default: true }]
      }
    }],
    accounts: [{
      id: "cancelled-chatplus-account",
      channelId: "cancelled-chatplus",
      name: "取消测试账号",
      username: "cancelled@example.test",
      password: "test",
      enabled: true,
      status: "ok"
    }]
  });
  ChatplusClient.prototype.createImageTask = async (input) => {
    submitCount += 1;
    await input.onSubmitted?.({
      externalId: "cancelled-upstream-task",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gpt",
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: "cancelled-upstream-task" }
    });
    const error = new Error("上游已取消任务。");
    error.upstreamExplicitFailure = true;
    error.upstreamStatus = "cancelled";
    error.imageSubmissionAttempted = true;
    error.imageSubmissionConfirmed = true;
    throw error;
  };

  try {
    const sourceTaskId = "cancelled-downstream-task";
    const result = await createImageTask({
      input: {
        channel: "cancelled-chatplus",
        prompt: "测试上游取消",
        client_task_id: sourceTaskId
      },
      files: [{
        filename: "source.png",
        mimetype: "image/png",
        buffer: Buffer.from("source image")
      }],
      wait: true
    });
    const stored = await getTask(result.id);

    assert.equal(submitCount, 1);
    assert.equal(result.status, "cancelled");
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.sourceTaskId, sourceTaskId);
    assert.equal(stored.responseJson.sourceTaskId, sourceTaskId);
    assert.equal(stored.responseJson.taskStatus, "cancelled");
    assert.equal(stored.raw.upstreamStatus, "cancelled");
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    await saveConfig(config);
  }
});

test("已取消任务不会被旧的处理中结果覆盖", async () => {
  const id = "task-cancelled-stale-refresh";
  const completedAt = new Date().toISOString();
  await upsertTask({
    id,
    status: "cancelled",
    taskType: "img2img",
    sourceTaskId: "cancelled-stale-source",
    errorMessage: "上游已取消任务。",
    responseJson: { taskStatus: "cancelled" },
    raw: { queued: false, upstreamStatus: "cancelled" },
    createdAt: completedAt,
    completedAt
  });
  await upsertTask({
    id,
    status: "processing",
    taskType: "img2img",
    sourceTaskId: "cancelled-stale-source",
    raw: { queued: true },
    createdAt: completedAt,
    completedAt: null
  });

  const stored = await getTask(id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.raw.upstreamStatus, "cancelled");
});

test("image fallback stores the real chat image channel before the final image is ready", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    waitTimeoutSec: 300,
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        defaultModelId: 1
      }
    }],
    accounts: [{
      id: "fallback-account",
      channelId: "shareai",
      name: "Fallback Account",
      username: "fallback@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 1, message: "drawing ok" },
          chatplus: { status: "ok", balance: 10, message: "chat ok" }
        }
      }
    }]
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalDrawingGetTask = DrawingClient.prototype.getTask;
  const originalChatCreateImageTask = ChatplusClient.prototype.createImageTask;
  const originalChatGetTask = ChatplusClient.prototype.getTask;
  let markSubmitted;
  let finishChatTask;
  const submitted = new Promise((resolve) => {
    markSubmitted = resolve;
  });
  const canFinish = new Promise((resolve) => {
    finishChatTask = resolve;
  });
  let drawingRefreshCount = 0;
  let chatRefreshCount = 0;

  DrawingClient.prototype.check = async () => ({
    status: "quota_empty",
    quota: 50,
    balance: 0,
    message: "drawing quota empty"
  });
  DrawingClient.prototype.getTask = async () => {
    drawingRefreshCount += 1;
    const error = new Error("wrong drawing refresh");
    error.code = "INVALID_UPSTREAM_RESPONSE";
    error.status = 502;
    throw error;
  };
  ChatplusClient.prototype.createImageTask = async (input) => {
    await input.onSubmitted?.({
      externalId: "chat-fallback-conversation",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gpt",
      ratio: input.ratio || "",
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: "chat-fallback-conversation" }
    });
    markSubmitted();
    await canFinish;
    return {
      externalId: "chat-fallback-conversation",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gpt",
      ratio: input.ratio || "",
      imageCount: 1,
      imageUrls: ["https://images.example.test/result.png"],
      raw: { conversationId: "chat-fallback-conversation" }
    };
  };
  ChatplusClient.prototype.getTask = async (externalId) => {
    chatRefreshCount += 1;
    return {
      externalId,
      status: "waiting_upstream",
      taskType: "img2img",
      prompt: "fallback stores chat channel",
      modelId: "gpt",
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: externalId }
    };
  };

  try {
    const sourceTaskId = "fallback-stores-chat-channel";
    const creation = createImageTask({
      input: {
        channel: "auto",
        prompt: "fallback stores chat channel",
        client_task_id: sourceTaskId
      },
      files: [{ filename: "source.png", mimetype: "image/png" }],
      wait: true
    });
    await submitted;

    let stored = (await listTasks()).find((task) => task.sourceTaskId === sourceTaskId);
    assert.equal(stored.channelType, "chatplus");
    assert.equal(stored.channelId, "shareai:chatplus");
    assert.deepEqual(
      stored.submissionChannels.map((item) => [item.channelId, item.accountId]),
      [["shareai:chatplus", "fallback-account"]]
    );
    assert.deepEqual(stored.generationChannels, []);

    const refreshResults = await refreshProcessingTasks();
    const refreshed = refreshResults.find((item) => item.id === stored.id);
    assert.equal(refreshed?.ok, true);
    assert.equal(drawingRefreshCount, 0);
    assert.equal(chatRefreshCount, 1);

    finishChatTask();
    const result = await creation;
    stored = await getTask(stored.id);

    assert.equal(result.status, "success");
    assert.equal(stored.status, "success");
    assert.equal(stored.channelType, "chatplus");
    assert.equal(stored.imageUrls.length, 1);
    assert.deepEqual(
      stored.submissionChannels.map((item) => [item.channelId, item.accountId]),
      [["shareai:chatplus", "fallback-account"]]
    );
    assert.deepEqual(
      stored.generationChannels.map((item) => [item.channelId, item.accountId]),
      [["shareai:chatplus", "fallback-account"]]
    );
  } finally {
    finishChatTask?.();
    DrawingClient.prototype.check = originalDrawingCheck;
    DrawingClient.prototype.getTask = originalDrawingGetTask;
    ChatplusClient.prototype.createImageTask = originalChatCreateImageTask;
    ChatplusClient.prototype.getTask = originalChatGetTask;
  }
});

test("preferred chat image failure falls back to drawing before an upstream task is accepted", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageSourcePriority: "chatplus",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: true, chatplus: true },
        defaultModelId: 1
      }
    }],
    accounts: [{
      id: "chat-to-drawing-fallback",
      channelId: "shareai",
      name: "Chat to Drawing Fallback",
      username: "chat-to-drawing@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 50 },
          chatplus: { status: "ok", balance: 10 }
        }
      }
    }]
  });

  const originalChatCreateImageTask = ChatplusClient.prototype.createImageTask;
  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalDrawingUploadImage = DrawingClient.prototype.uploadImage;
  const originalDrawingCreateImageTask = DrawingClient.prototype.createImageTask;
  let chatAttempts = 0;
  let drawingAttempts = 0;

  ChatplusClient.prototype.createImageTask = async () => {
    chatAttempts += 1;
    const error = new Error("chat image rejected before submission");
    error.upstreamExplicitFailure = true;
    throw error;
  };
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 50,
    balance: 49,
    message: "drawing ok"
  });
  DrawingClient.prototype.uploadImage = async () => ({
    uploadId: 1,
    upload: { id: 1 }
  });
  DrawingClient.prototype.createImageTask = async (input) => {
    drawingAttempts += 1;
    return {
      externalId: "drawing-fallback-task",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: 1,
      imageCount: 1,
      imageUrls: ["https://images.example.test/drawing-fallback.png"],
      raw: {}
    };
  };

  try {
    const result = await createImageTask({
      input: { model: "gpt", prompt: "fallback to drawing" },
      files: [{
        filename: "source.png",
        mimetype: "image/png",
        toBuffer: async () => Buffer.from("image")
      }],
      wait: true
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(chatAttempts, 1);
    assert.equal(drawingAttempts, 1);
    assert.equal(result.status, "success");
    assert.equal(result.channelType, "drawing");
    assert.equal(result.channelId, "shareai:drawing");
  } finally {
    ChatplusClient.prototype.createImageTask = originalChatCreateImageTask;
    DrawingClient.prototype.check = originalDrawingCheck;
    DrawingClient.prototype.uploadImage = originalDrawingUploadImage;
    DrawingClient.prototype.createImageTask = originalDrawingCreateImageTask;
  }
});

test("后台生图重试会跳过已知无额度的绘图账号", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    imageSourcePriority: "drawing",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "known-empty-retry",
      type: "shareai",
      name: "Known Empty Retry",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        enabledAbilities: { drawing: true, chatplus: false },
        defaultModelId: 1
      }
    }],
    accounts: [
      {
        id: "known-empty-retry-empty",
        channelId: "known-empty-retry",
        name: "Known Empty",
        username: "known-empty@example.test",
        password: "test",
        enabled: true,
        status: "quota_empty",
        meta: {
          abilities: {
            drawing: {
              status: "quota_empty",
              quota: 100,
              balance: 0,
              quotaResetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              message: "绘图积分不足"
            }
          }
        }
      },
      {
        id: "known-empty-retry-healthy",
        channelId: "known-empty-retry",
        name: "Healthy",
        username: "healthy@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "ok", quota: 100, balance: 10, message: "绘图账号可用" }
          }
        }
      }
    ]
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalDrawingUploadImage = DrawingClient.prototype.uploadImage;
  const originalDrawingCreateImageTask = DrawingClient.prototype.createImageTask;
  const checkedAccounts = [];
  const uploadedAccounts = [];
  const submittedAccounts = [];

  DrawingClient.prototype.check = async function checkDrawingAccount() {
    checkedAccounts.push(this.account.id);
    if (this.account.id === "known-empty-retry-empty") {
      throw new Error("已知无额度账号不应该再次检测");
    }
    return { status: "ok", quota: 100, balance: 10, message: "绘图账号可用" };
  };
  DrawingClient.prototype.uploadImage = async function uploadDrawingImage() {
    uploadedAccounts.push(this.account.id);
    return { uploadId: 1, upload: { id: 1 } };
  };
  DrawingClient.prototype.createImageTask = async function createDrawingImage(input) {
    submittedAccounts.push(this.account.id);
    return {
      externalId: "known-empty-retry-result",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: 1,
      imageCount: 0,
      imageUrls: [],
      raw: {}
    };
  };

  try {
    const queued = await queueImageTask({
      input: { channel: "drawing", prompt: "同一下游任务再次提交" },
      file: { filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") }
    });
    let stored = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = await getTask(queued.id);
      if (["success", "failed"].includes(stored?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(stored?.status, "success");
    assert.equal(checkedAccounts.includes("known-empty-retry-empty"), false);
    assert.deepEqual(new Set(uploadedAccounts), new Set(["known-empty-retry-healthy"]));
    assert.deepEqual(submittedAccounts, ["known-empty-retry-healthy"]);
  } finally {
    DrawingClient.prototype.check = originalDrawingCheck;
    DrawingClient.prototype.uploadImage = originalDrawingUploadImage;
    DrawingClient.prototype.createImageTask = originalDrawingCreateImageTask;
    await saveConfig(config);
  }
});

test("绘图站无额度不会阻止同一账号使用聊天站生图", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    imageSourcePriority: "drawing",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "ability-isolation-retry",
      type: "shareai",
      name: "Ability Isolation Retry",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: true, chatplus: true },
        defaultModelId: 1,
        defaultChatModel: "gemini",
        chatModels: [{ key: "gemini", name: "Gemini", enabled: true, default: true }]
      }
    }],
    accounts: [{
      id: "ability-isolation-account",
      channelId: "ability-isolation-retry",
      name: "Ability Isolation",
      username: "ability-isolation@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "quota_empty",
            quota: 100,
            balance: 0,
            quotaResetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            message: "绘图积分不足"
          },
          chatplus: { status: "ok", message: "聊天生图可用" }
        }
      }
    }]
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalChatCreateImageTask = ChatplusClient.prototype.createImageTask;
  let drawingCheckCount = 0;
  let chatSubmitCount = 0;

  DrawingClient.prototype.check = async () => {
    drawingCheckCount += 1;
    throw new Error("绘图站无额度时不应该再次检测");
  };
  ChatplusClient.prototype.createImageTask = async function createChatImage(input) {
    chatSubmitCount += 1;
    return {
      externalId: "ability-isolation-chat-result",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 0,
      imageUrls: [],
      raw: { upstreamModel: "gemini-3.1-pro" }
    };
  };

  try {
    const queued = await queueImageTask({
      input: { model: "gemini", prompt: "绘图不可用时改走聊天生图" },
      file: { filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") }
    });
    let stored = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = await getTask(queued.id);
      if (["success", "failed"].includes(stored?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(stored?.status, "success");
    assert.equal(stored?.channelType, "chatplus");
    assert.equal(stored?.raw?.requestedModel, "gemini");
    assert.equal(stored?.raw?.upstreamModel, "gemini-3.1-pro");
    assert.equal(drawingCheckCount, 0);
    assert.equal(chatSubmitCount, 1);
  } finally {
    DrawingClient.prototype.check = originalDrawingCheck;
    ChatplusClient.prototype.createImageTask = originalChatCreateImageTask;
    await saveConfig(config);
  }
});

test("multipart admission releases the provisional model slot after the real model is parsed", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        enabledAbilities: { drawing: true, chatplus: false },
        defaultModelId: 1,
        geminiDrawingModelId: 2
      }
    }],
    accounts: [{
      id: "multipart-model-account",
      channelId: "shareai",
      name: "Multipart Model Account",
      username: "multipart-model@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
      meta: { abilities: { drawing: { status: "ok", quota: 50, balance: 50 } } }
    }]
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalDrawingUploadImage = DrawingClient.prototype.uploadImage;
  const originalDrawingCreateImageTask = DrawingClient.prototype.createImageTask;
  let runningAtSubmit = null;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 50,
    balance: 49,
    message: "drawing ok"
  });
  DrawingClient.prototype.uploadImage = async () => ({ uploadId: 1, upload: { id: 1 } });
  DrawingClient.prototype.createImageTask = async (input) => {
    runningAtSubmit = await getRuntimeStatus();
    return {
      externalId: "multipart-gemini-task",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: 2,
      imageCount: 1,
      imageUrls: ["https://images.example.test/multipart-gemini.png"],
      raw: {}
    };
  };

  const admission = await reserveImageTaskAdmission({ prompt: "before multipart parsing" });
  try {
    const result = await createImageTask({
      input: { model: "gemini", prompt: "after multipart parsing" },
      files: [{
        filename: "source.png",
        mimetype: "image/png",
        toBuffer: async () => Buffer.from("image")
      }],
      wait: true,
      admission
    });

    assert.equal(result.status, "success");
    assert.equal(runningAtSubmit.models.gpt.categories.image.running, 0);
    assert.equal(runningAtSubmit.models.gemini.categories.image.running, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    admission.release();
    await saveConfig(config);
    DrawingClient.prototype.check = originalDrawingCheck;
    DrawingClient.prototype.uploadImage = originalDrawingUploadImage;
    DrawingClient.prototype.createImageTask = originalDrawingCreateImageTask;
  }
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

test("chatplus image fallback ignores drawing model aliases", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: {
      id: "shareai:chatplus",
      settings: {
        baseUrl: "https://www.chatplus.cc",
        defaultChatModel: "gpt",
        chatModels: [{
          key: "gpt",
          name: "GPT",
          carType: "chatgpt",
          model: "gpt-chat-configured",
          strategy: "balanced",
          enabled: true,
          default: true
        }]
      }
    },
    account: { id: "account-chatplus-model", username: "chatplus-model@example.com" },
    sessionLock: async (work) => work()
  });
  let submitted = null;
  let conversationBody = null;
  client.fetchCars = async () => [{
    id: "car-chatplus-model",
    status: 1,
    count: 0,
    cooldown: 0,
    desc: "ok",
    label: "ok",
    imageRemaining: 20,
    isPro: false,
    isVirtual: false,
    realCarIDs: []
  }];
  client.enterCar = async (carId, carType) => {
    client.carId = carId;
    client.carType = carType;
    client.portalLoggedIn = true;
  };
  client.loadInit = async () => ({
    default_model_slug: "gpt-init-default",
    limits_progress: [{ feature_name: "image_gen", remaining: 20 }]
  });
  client.uploadChatImages = async () => [];
  client.http = async (pathName, options = {}) => {
    assert.equal(pathName, "/backend-api/conversation");
    conversationBody = options.body;
    return {
      status: 200,
      headers: {},
      body: `data: {"conversation_id":"conversation-chatplus-model"}\n\ndata: [DONE]\n\n`
    };
  };

  const result = await client.createImageTask({
    prompt: "change background",
    model: "gpt-image-2",
    files: [{ filename: "source.png" }],
    waitForImages: false,
    onSubmitted: async (value) => {
      submitted = value;
    }
  });

  assert.equal(conversationBody.model, "gpt-chat-configured");
  assert.equal(submitted.externalId, "conversation-chatplus-model");
  assert.equal(result.modelId, "gpt");
  assert.equal(result.status, "waiting_upstream");
});

test("chatplus policy refusal is returned as a failed task with the original message", async () => {
  const message = "We’re so sorry, but the image we created may violate our guardrails concerning similarity to third-party content. If you think we got it wrong, please retry or edit your prompt.";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-policy", username: "policy@example.com" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    mapping: {
      result: {
        message: {
          author: { role: "assistant" },
          content: { parts: [message] }
        }
      }
    }
  });
  client.imageUrlsFrom = async () => [];

  const result = await client.getTask("conversation-policy");

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, message);
});

test("chatplus cancelled image task notice is returned as cancelled", async () => {
  const message = "The above image generation task was cancelled by the user and therefore the generated image is incomplete. The image will not finish generating and is not completed or successful.";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-cancelled-image", username: "cancelled@example.com" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    mapping: {
      result: {
        message: {
          author: { role: "assistant" },
          content: { parts: [message] }
        }
      }
    }
  });
  client.imageUrlsFrom = async () => [];

  const result = await client.getTask("conversation-cancelled-image");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorMessage, message);
});

test("submitted relay policy refusal is returned as content policy without retrying another account", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-policy-wait",
      channelId: "shareai",
      name: "policy-wait@example.com",
      username: "policy-wait@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }, {
      id: "account-policy-unused",
      channelId: "shareai",
      name: "policy-unused@example.com",
      username: "policy-unused@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const policyMessage = "We're so sorry, but the prompt may violate our content policies. If you think we got it wrong, please retry or edit your prompt.";
  const message = `中转服务返回错误: ${policyMessage}`;
  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  let submissionCount = 0;
  ChatplusClient.prototype.createImageTask = async () => {
    submissionCount += 1;
    const error = new Error(message);
    error.imageSubmissionAttempted = true;
    error.imageSubmissionConfirmed = true;
    error.upstreamText = message;
    error.status = 502;
    throw error;
  };

  try {
    await assert.rejects(
      () => createImageTask({
        input: { channel: "chatplus", prompt: "policy refusal test" },
        files: [{ filename: "source.png", mimetype: "image/png" }],
        wait: true
      }),
      (error) => {
        assert.equal(error.message, message);
        assert.equal(error.status, 400);
        assert.equal(error.code, "content_policy");
        assert.equal(error.task.status, "failed");
        assert.equal(error.task.responseJson.failureType, "upstream_no_image");
        assert.equal(error.task.responseJson.submissionConfirmed, true);
        assert.equal(error.task.responseJson.failureReason, message);
        assert.equal(error.task.responseJson.message, message);
        assert.equal(error.task.responseJson.upstreamText, message);
        assert.deepEqual(
          error.task.submissionChannels.map((item) => [item.channelId, item.accountId]),
          [["shareai:chatplus", "account-policy-wait"]]
        );
        assert.deepEqual(error.task.generationChannels, []);
        return true;
      }
    );
    assert.equal(submissionCount, 1);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("提交结果无法确认时不会换账号重发，并准确标记为未完整提交", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gemini"
      }
    }],
    accounts: ["first", "second"].map((name) => ({
      id: `uncertain-${name}`,
      channelId: "shareai",
      name: `Uncertain ${name}`,
      username: `${name}@example.test`,
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }))
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  let submissionCount = 0;
  ChatplusClient.prototype.createImageTask = async () => {
    submissionCount += 1;
    const error = new Error("connection reset");
    error.code = "ECONNRESET";
    error.imageSubmissionAttempted = true;
    throw error;
  };

  try {
    await assert.rejects(
      () => createImageTask({
        input: { channel: "chatplus", model: "gemini", prompt: "提交结果不确定测试" },
        files: [{ filename: "source.png", mimetype: "image/png" }],
        wait: true
      }),
      (error) => {
        assert.equal(error.task.status, "failed");
        assert.equal(error.task.responseJson.code, "ECONNRESET");
        assert.equal(error.task.responseJson.failureType, "submission_failed");
        assert.equal(error.task.responseJson.submissionConfirmed, false);
        assert.equal(error.task.responseJson.failureReason, "connection reset");
        assert.match(error.task.responseJson.message, /^提交失败：图片和生图要求未完整提交到上游/);
        assert.notEqual(error.task.raw.submitted, true);
        assert.equal(error.task.submissionChannels.length, 0);
        assert.equal(error.task.generationChannels.length, 0);
        return true;
      }
    );
    assert.equal(submissionCount, 1);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    await saveConfig(config);
  }
});

test("上游先创建会话后生图失败时会保存会话编号并标记已提交", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gpt"
      }
    }],
    accounts: [{
      id: "confirmed-image-failure",
      channelId: "shareai",
      name: "Confirmed image failure",
      username: "confirmed-image-failure@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  ChatplusClient.prototype.createImageTask = async () => {
    const error = new Error("图片生成次数已达到限制");
    error.code = "UPSTREAM_IMAGE_LIMIT";
    error.status = 429;
    error.imageSubmissionAttempted = true;
    error.imageSubmissionConfirmed = true;
    error.conversationId = "conversation-confirmed-image-failure";
    error.upstreamExplicitFailure = true;
    error.upstreamText = "图片生成次数已达到限制，请稍后重试";
    throw error;
  };

  try {
    await assert.rejects(
      () => createImageTask({
        input: { channel: "chatplus", model: "gpt", prompt: "先创建会话再失败" },
        files: [{ filename: "source.png", mimetype: "image/png" }],
        wait: true
      }),
      (error) => {
        assert.equal(error.task.status, "failed");
        assert.equal(error.task.externalId, "conversation-confirmed-image-failure");
        assert.equal(error.task.raw.conversationId, "conversation-confirmed-image-failure");
        assert.equal(error.task.raw.submitted, true);
        assert.equal(error.task.responseJson.failureType, "upstream_no_image");
        assert.equal(error.task.responseJson.submissionConfirmed, true);
        assert.match(error.task.responseJson.message, /^上游生成失败：/);
        assert.deepEqual(
          error.task.submissionChannels.map((item) => [item.channelId, item.accountId]),
          [["shareai:chatplus", "confirmed-image-failure"]]
        );
        assert.deepEqual(error.task.generationChannels, []);
        return true;
      }
    );
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    await saveConfig(config);
  }
});

test("账户额度明确用完后切换账户，并在恢复时间前不再使用", async () => {
  const config = await loadConfig();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gemini"
      }
    }],
    accounts: ["empty", "healthy"].map((name, index) => ({
      id: `quota-switch-${name}`,
      channelId: "shareai",
      name: `Quota switch ${name}`,
      username: `${name}@example.test`,
      password: "test",
      enabled: true,
      priority: index + 1,
      status: "ok",
      meta: { abilities: { chatplus: { status: "ok", message: "聊天账号可用" } } }
    }))
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const calls = [];
  ChatplusClient.prototype.createImageTask = async function createQuotaSwitchTask(input) {
    calls.push(this.account.id);
    if (this.account.id === "quota-switch-empty") {
      const error = new Error("当前 Gemini 账号的使用次数已用完。");
      error.status = 429;
      error.code = "CHAT_USAGE_LIMIT";
      error.quotaEmpty = true;
      error.quotaReason = "chat_usage_limit";
      error.quotaModel = "gemini";
      error.quotaConfirmedByUpstream = true;
      error.quotaResetAt = resetAt;
      error.cooldownUntil = resetAt;
      error.imageSubmissionAttempted = true;
      error.imageSubmissionConfirmed = false;
      throw error;
    }
    return {
      externalId: `conversation-${calls.length}`,
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 1,
      imageUrls: [`https://images.example.test/quota-switch-${calls.length}.png`],
      raw: {}
    };
  };

  try {
    const request = (prompt) => createImageTask({
      input: { channel: "chatplus", model: "gemini", prompt },
      files: [{ filename: "source.png", mimetype: "image/png" }],
      wait: true
    });
    const first = await request("额度切换测试一");
    const storedAfterFirst = await loadConfig();
    const emptyStatus = storedAfterFirst.accounts
      .find((account) => account.id === "quota-switch-empty")
      .meta.abilities.chatplus;

    assert.equal(first.status, "success");
    assert.equal(first.accountId, "quota-switch-healthy");
    assert.deepEqual(calls, ["quota-switch-empty", "quota-switch-healthy"]);
    assert.equal(emptyStatus.status, "quota_empty");
    assert.equal(emptyStatus.quotaConfirmedByUpstream, true);
    assert.equal(emptyStatus.quotaResetAt, resetAt);
    assert.equal(emptyStatus.cooldownUntil, resetAt);

    calls.length = 0;
    const second = await request("额度切换测试二");
    assert.equal(second.status, "success");
    assert.equal(second.accountId, "quota-switch-healthy");
    assert.deepEqual(calls, ["quota-switch-healthy"]);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    await saveConfig(config);
  }
});

test("参考图上传失败会返回准确阶段和上游原始回复", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    imageStorage: { mode: "never", autoCleanup: false, retentionDays: 7 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gemini"
      }
    }],
    accounts: [{
      id: "upload-failed-account",
      channelId: "shareai",
      name: "Upload failed account",
      username: "upload-failed@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: { abilities: { chatplus: { status: "ok", message: "聊天账号可用" } } }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const upstreamText = "{\n  \"error\": \"request_error\",\n  \"message\": \"车队失效，请重新选择\"\n}";
  ChatplusClient.prototype.createImageTask = async (input) => {
    await input.onStage?.({
      id: "source-upload-failed",
      key: "source_upload",
      label: "上传原图",
      status: "failed",
      durationMs: 1200
    });
    const error = new Error("Gemini 图片上传前检查失败：500");
    error.status = 500;
    error.body = upstreamText;
    error.upstreamText = upstreamText;
    error.noRetry = true;
    throw error;
  };

  try {
    await assert.rejects(
      () => createImageTask({
        input: { channel: "chatplus", model: "gemini", prompt: "上传阶段失败测试" },
        files: [{ filename: "source.png", mimetype: "image/png" }],
        wait: true
      }),
      (error) => {
        assert.equal(error.task.responseJson.failureType, "submission_failed");
        assert.equal(error.task.responseJson.submissionConfirmed, false);
        assert.equal(error.task.responseJson.failureReason, "车队失效，请重新选择");
        assert.deepEqual(error.task.responseJson.failureStage, { key: "source_upload", label: "上传原图" });
        assert.equal(error.task.responseJson.upstreamText, upstreamText);
        assert.match(error.task.responseJson.message, /停在“上传原图”/);
        assert.equal(error.task.submissionChannels.length, 0);
        return true;
      }
    );
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    await saveConfig(config);
  }
});

test("fast drawing quota check waits long enough for normal account checks", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    accounts: [{
      id: "account-fast-drawing-quota",
      channelId: "shareai",
      name: "fast-drawing-quota@example.com",
      username: "fast-drawing-quota@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 2, message: "ready for preflight refresh" },
          chatplus: { status: "quota_empty", balance: 0, message: "skip chatplus" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalUploadImage = DrawingClient.prototype.uploadImage;
  const originalCreateImageTask = DrawingClient.prototype.createImageTask;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    if (checkCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return {
      status: "ok",
      balance: 50,
      quota: 50,
      message: "drawing account ok"
    };
  };
  DrawingClient.prototype.uploadImage = async () => ({
    uploadId: 1,
    upload: { id: 1 }
  });
  DrawingClient.prototype.createImageTask = async (input) => ({
    externalId: "drawing-fast-quota-task",
    status: "success",
    taskType: "img2img",
    prompt: input.prompt,
    imageCount: 0,
    imageUrls: [],
    raw: {}
  });

  try {
    const result = await createImageTask({
      input: { channel: "drawing", prompt: "fast quota check" },
      files: [{
        filename: "source.png",
        mimetype: "image/png",
        toBuffer: async () => Buffer.from("image")
      }],
      wait: true
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(checkCount >= 1, true);
    assert.equal(result.status, "success");
    assert.equal(result.accountId, "account-fast-drawing-quota");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20));
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.uploadImage = originalUploadImage;
    DrawingClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("drawing policy refusal is stored as content policy", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        enabledAbilities: { drawing: true, chatplus: false }
      }
    }],
    accounts: [{
      id: "account-drawing-policy",
      channelId: "shareai",
      name: "drawing-policy@example.com",
      username: "drawing-policy@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 10, message: "drawing ok" }
        }
      }
    }]
  });

  const id = "task-drawing-policy-refusal";
  const policyMessage = "We're so sorry, but the prompt may violate our content policies.";
  await upsertTask({
    id,
    externalId: 12345,
    status: "processing",
    taskType: "img2img",
    prompt: "policy refusal",
    channelId: "shareai:drawing",
    channelName: "ShareAI/绘图站",
    channelType: "drawing",
    accountId: "account-drawing-policy",
    accountName: "drawing-policy@example.com",
    raw: { submitted: true },
    createdAt: new Date().toISOString()
  });

  const originalGetTask = DrawingClient.prototype.getTask;
  DrawingClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "failed",
    taskType: "img2img",
    imageCount: 0,
    imageUrls: [],
    errorMessage: `中转服务返回错误：${policyMessage}`,
    raw: { submitted: true }
  });

  try {
    const result = await refreshTask(id);
    assert.equal(result.status, "failed");
    assert.equal(result.responseJson.code, "content_policy");
    assert.match(result.responseJson.message, /content policies/);
  } finally {
    DrawingClient.prototype.getTask = originalGetTask;
    await saveConfig(config);
  }
});

test("有上游编号的旧任务超过等待时间后保持等待上游", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    waitTimeoutSec: 300,
    accounts: [{
      id: "account-waiting",
      channelId: "shareai",
      name: "等待测试账号",
      username: "test@example.com",
      password: "test",
      enabled: true
    }]
  });
  const id = "task-restart-with-upstream-id";
  await upsertTask({
    id,
    externalId: "conversation-waiting",
    status: "processing",
    taskType: "img2img",
    prompt: "测试等待上游状态",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-waiting",
    accountName: "等待测试账号",
    raw: {
      queued: false,
      submitted: true,
      submittedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      selectedCarId: "car-waiting",
      selectedCarType: "chatgpt"
    },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  ChatplusClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "processing",
    imageCount: 0,
    imageUrls: [],
    raw: { conversationId: externalId }
  });
  try {
    const firstRefresh = await refreshTask(id);
    const secondRefresh = await refreshTask(id);
    assert.equal(firstRefresh.status, "waiting_upstream");
    assert.equal(secondRefresh.status, "waiting_upstream");
    assert.equal(secondRefresh.errorMessage, "");
    assert.equal(secondRefresh.raw.waitingUpstream, true);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
  }
});

test("等待上游查询异常会记录原因，连续三十分钟后停止且可手动重查", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    waitTimeoutSec: 300,
    accounts: [{
      id: "account-upstream-timeout",
      channelId: "shareai",
      name: "上游等待测试账号",
      username: "upstream-timeout@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-upstream-refresh-timeout";
  const submittedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await upsertTask({
    id,
    externalId: "conversation-upstream-refresh-timeout",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gpt",
    prompt: "上游查询异常测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-upstream-timeout",
    accountName: "上游等待测试账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      queued: false,
      submitted: true,
      submittedAt,
      waitingUpstream: true,
      waitingSince: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      selectedCarId: "car-upstream-timeout",
      selectedCarType: "chatgpt"
    },
    createdAt: submittedAt,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  const statsBefore = await listTaskStats();
  ChatplusClient.prototype.getTask = async () => {
    const error = new Error("身份验证失败，请重新登录");
    error.status = 401;
    throw error;
  };

  try {
    const first = await refreshTask(id);
    assert.equal(first.status, "waiting_upstream");
    assert.equal(first.raw.refreshError, true);
    assert.equal(first.raw.refreshErrorCount, 1);
    assert.match(first.raw.refreshErrorMessage, /身份验证失败/);
    assert.match(first.responseJson.message, /自动重试/);
    const firstErrorAt = first.raw.refreshErrorFirstAt;

    await upsertTask({
      ...first,
      raw: {
        ...first.raw,
        waitingSince: new Date(Date.now() - 31 * 60 * 1000).toISOString()
      }
    });
    const interrupted = await refreshTask(id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.errorMessage, "");
    assert.equal(interrupted.raw.refreshErrorCount, 2);
    assert.equal(interrupted.raw.refreshErrorFirstAt, firstErrorAt);
    assert.equal(interrupted.raw.upstreamWaitExpired, true);
    assert.equal(interrupted.raw.waitingUpstream, false);
    assert.match(interrupted.responseJson.message, /连续 30 分钟/);
    assert.match(interrupted.responseJson.message, /不计入失败/);
    assert.deepEqual(await listTaskStats(), statsBefore);

    ChatplusClient.prototype.getTask = async (externalId) => ({
      externalId,
      status: "failed",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "上游明确返回任务失败。",
      raw: { conversationId: externalId }
    });
    const retried = await refreshTask(id);
    assert.equal(retried.status, "failed");
    assert.match(retried.errorMessage, /^上游生成失败：/);
    assert.equal(retried.responseJson.failureType, "upstream_no_image");
    assert.equal(retried.responseJson.submissionConfirmed, true);
    assert.equal(retried.responseJson.failureReason, "上游明确返回任务失败。");
    assert.equal(retried.raw.upstreamWaitExpired, false);
    assert.equal(retried.raw.interrupted, false);
    assert.equal(retried.raw.refreshError, false);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(config);
  }
});

test("上游持续返回处理中超过三十分钟也会停止自动查询", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    waitTimeoutSec: 300,
    accounts: [{
      id: "account-upstream-pending-timeout",
      channelId: "shareai",
      name: "上游处理中测试账号",
      username: "upstream-pending@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-upstream-pending-timeout";
  const waitingSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  await upsertTask({
    id,
    externalId: "conversation-upstream-pending-timeout",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gpt",
    prompt: "上游长期处理中测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-upstream-pending-timeout",
    accountName: "上游处理中测试账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      queued: false,
      submitted: true,
      submittedAt: waitingSince,
      waitingUpstream: true,
      waitingSince,
      selectedCarId: "car-upstream-pending-timeout",
      selectedCarType: "chatgpt"
    },
    createdAt: waitingSince,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  ChatplusClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "waiting_upstream",
    imageCount: 0,
    imageUrls: [],
    errorMessage: "",
    raw: { conversationId: externalId }
  });

  try {
    const result = await refreshTask(id);
    assert.equal(result.status, "interrupted");
    assert.equal(result.raw.upstreamWaitExpired, true);
    assert.equal(result.raw.refreshError, false);
    assert.equal(result.raw.lastUpstreamCheckStatus, "waiting_upstream");
    assert.match(result.responseJson.message, /停止自动查询/);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(config);
  }
});

test("刷新时拿到无效图片文件会保留任务并继续尝试保存", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-invalid-image-refresh",
      channelId: "shareai",
      name: "图片保存测试账号",
      username: "invalid-image-refresh@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-invalid-image-refresh";
  const imageUrl = "https://one.aishare.icu/backend-api/files/file-invalid/download";
  const waitingSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await upsertTask({
    id,
    externalId: "conversation-invalid-image-refresh",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gpt",
    prompt: "无效图片保存测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-invalid-image-refresh",
    accountName: "图片保存测试账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      queued: false,
      submitted: true,
      submittedAt: waitingSince,
      waitingUpstream: true,
      waitingSince,
      selectedCarId: "car-invalid-image-refresh",
      selectedCarType: "chatgpt"
    },
    createdAt: waitingSince,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  ChatplusClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "success",
    imageCount: 1,
    imageUrls: [imageUrl],
    errorMessage: "",
    raw: {
      conversationId: externalId,
      selectedCarId: "car-invalid-image-refresh",
      selectedCarType: "chatgpt"
    }
  });
  ChatplusClient.prototype.downloadResultImage = async () => {
    const error = new Error("图片保存失败：上游返回的不是图片。");
    error.code = "INVALID_IMAGE_DOWNLOAD";
    throw error;
  };

  try {
    const result = await refreshTask(id);
    assert.equal(result.status, "waiting_upstream");
    assert.equal(result.raw.upstreamCompleted, true);
    assert.equal(result.raw.imageMirrorPending, true);
    assert.equal(result.raw.imageMirrorRetryCount, 1);
    assert.equal(result.raw.resultSaveErrorCode, "INVALID_IMAGE_DOWNLOAD");
    assert.deepEqual(result.raw.originalImageUrls, [imageUrl]);
    assert.match(result.responseJson.message, /重新保存/);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await upsertTask({
      ...(await getTask(id)),
      status: "interrupted",
      completedAt: new Date().toISOString()
    });
    await saveConfig(config);
  }
});

test("图片保存失败后交给后台重试，不在同一轮连续下载", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-gemini-mirror-recovery",
      channelId: "shareai",
      name: "Gemini 恢复测试账号",
      username: "gemini-recovery@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  const placeholderUrl = "http://googleusercontent.com/image_generation_content/0_462";
  const upstreamUrl = "https://one.aishare.icu/gemini/images/gg-dl/recoverable-image";
  let downloadAttempt = 0;
  const downloadedUrls = [];
  ChatplusClient.prototype.createImageTask = async (input) => {
    await input.onSubmitted?.({
      externalId: "c_gemini_mirror_recovery",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 0,
      imageUrls: [],
      raw: {
        conversationId: "c_gemini_mirror_recovery",
        chatModel: "gemini",
        selectedCarId: "gemini-car",
        selectedCarType: "gemini"
      }
    });
    return {
      externalId: "c_gemini_mirror_recovery",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 2,
      imageUrls: [placeholderUrl, upstreamUrl],
      raw: {
        conversationId: "c_gemini_mirror_recovery",
        chatModel: "gemini",
        selectedCarId: "gemini-car",
        selectedCarType: "gemini"
      }
    };
  };
  ChatplusClient.prototype.downloadResultImage = async (url) => {
    downloadedUrls.push(url);
    downloadAttempt += 1;
    if (downloadAttempt === 1) {
      const error = new Error("curl: (97) connection to proxy closed");
      error.code = "CURL_PROXY_ERROR";
      error.curlCode = 97;
      throw error;
    }
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      contentType: "image/png"
    };
  };

  let localFilename = "";
  try {
    const waiting = await createImageTask({
      input: {
        channel: "chatplus",
        model: "gemini",
        accountId: "account-gemini-mirror-recovery",
        prompt: "Gemini 图片转存恢复测试"
      },
      files: [{ filename: "source.png", mimetype: "image/png" }],
      wait: true
    });

    assert.equal(waiting.status, "waiting_upstream");
    assert.equal(waiting.raw.imageMirrorPending, true);
    assert.deepEqual(downloadedUrls, [upstreamUrl]);

    const recovered = await refreshTask(waiting.id);
    assert.equal(recovered.status, "success");
    assert.equal(recovered.imageCount, 1);
    assert.match(recovered.imageUrls[0], /^https:\/\/api\.example\.test\/uploads\/results\/.+\.png$/);
    assert.equal(recovered.imageUrls.includes(upstreamUrl), false);
    assert.deepEqual(downloadedUrls, [upstreamUrl, upstreamUrl]);
    localFilename = path.basename(new URL(recovered.imageUrls[0]).pathname);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(config);
    if (localFilename) {
      await rm(path.join(process.cwd(), "outputs", "results", localFilename), { force: true });
    }
  }
});

test("图生图先返回原图时等待上游的新图，不会把原图保存成结果", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-duplicate-input-result",
      channelId: "shareai",
      name: "原图误收测试账号",
      username: "duplicate-input-result@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const generatedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
  const duplicateUrl = "https://one.aishare.icu/gemini/images/gg-dl/duplicate-input-result";
  const generatedUrl = "https://one.aishare.icu/gemini/images/gg-dl/generated-result";
  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const originalGetTask = ChatplusClient.prototype.getTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  const downloadedUrls = [];
  let localFilename = "";
  let getTaskCalls = 0;

  ChatplusClient.prototype.createImageTask = async (input) => {
    await input.onSubmitted?.({
      externalId: "c_duplicate_input_result",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 0,
      imageUrls: [],
      raw: {
        conversationId: "c_duplicate_input_result",
        chatModel: "gemini",
        selectedCarId: "gemini-car",
        selectedCarType: "gemini"
      }
    });
    return {
      externalId: "c_duplicate_input_result",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gemini",
      imageCount: 1,
      imageUrls: [duplicateUrl],
      raw: {
        conversationId: "c_duplicate_input_result",
        chatModel: "gemini",
        selectedCarId: "gemini-car",
        selectedCarType: "gemini"
      }
    };
  };
  ChatplusClient.prototype.getTask = async (externalId) => {
    getTaskCalls += 1;
    return {
      externalId,
      status: "success",
      imageCount: 1,
      imageUrls: [generatedUrl],
      errorMessage: "",
      raw: {
        conversationId: externalId,
        selectedCarId: "gemini-car",
        selectedCarType: "gemini"
      }
    };
  };
  ChatplusClient.prototype.downloadResultImage = async (url) => {
    downloadedUrls.push(url);
    return {
      buffer: url === duplicateUrl ? sourceBytes : generatedBytes,
      contentType: "image/png"
    };
  };

  try {
    const waiting = await createImageTask({
      input: {
        channel: "chatplus",
        model: "gemini",
        accountId: "account-duplicate-input-result",
        prompt: "等待真正的生成图"
      },
      files: [{
        filename: "source.png",
        mimetype: "image/png",
        toBuffer: async () => sourceBytes
      }],
      wait: true
    });

    assert.equal(waiting.status, "waiting_upstream");
    assert.equal(waiting.raw.imageMirrorPending, true);
    assert.equal(waiting.raw.resultSaveErrorCode, "DUPLICATE_INPUT_IMAGE_RESULT");
    assert.deepEqual(downloadedUrls, [duplicateUrl]);

    const recovered = await refreshTask(waiting.id);
    assert.equal(recovered.status, "success");
    assert.equal(getTaskCalls, 1);
    assert.deepEqual(downloadedUrls, [duplicateUrl, duplicateUrl, generatedUrl]);
    assert.equal(recovered.imageCount, 1);
    assert.match(recovered.imageUrls[0], /^https:\/\/api\.example\.test\/uploads\/results\/.+\.png$/);
    localFilename = path.basename(new URL(recovered.imageUrls[0]).pathname);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    ChatplusClient.prototype.getTask = originalGetTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(config);
    if (localFilename) {
      await rm(path.join(process.cwd(), "outputs", "results", localFilename), { force: true });
    }
  }
});

test("Gemini 旧图片地址失效后会读取新地址并恢复", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-gemini-fresh-url",
      channelId: "shareai",
      name: "Gemini 新地址恢复测试账号",
      username: "gemini-fresh-url@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-gemini-fresh-url";
  const oldUrl = "https://one.aishare.icu/gemini/images/gg-dl/expired-image";
  const newUrl = "https://one.aishare.icu/gemini/images/gg-dl/refreshed-image";
  const now = new Date().toISOString();
  await upsertTask({
    id,
    externalId: "c_gemini_fresh_url",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gemini",
    prompt: "Gemini 新地址恢复测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-gemini-fresh-url",
    accountName: "Gemini 新地址恢复测试账号",
    imageCount: 1,
    imageUrls: [oldUrl],
    raw: {
      submitted: true,
      upstreamCompleted: true,
      imageMirrorPending: true,
      originalImageUrls: [oldUrl],
      waitingSince: now,
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: now,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  const downloadedUrls = [];
  let localFilename = "";
  ChatplusClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "success",
    imageCount: 1,
    imageUrls: [newUrl],
    raw: {
      conversationId: externalId,
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    }
  });
  ChatplusClient.prototype.downloadResultImage = async (url) => {
    downloadedUrls.push(url);
    if (url === oldUrl) {
      const error = new Error("图片保存失败：上游图片地址返回 500。");
      error.status = 500;
      throw error;
    }
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      contentType: "image/png"
    };
  };

  try {
    const recovered = await refreshTask(id);
    assert.equal(recovered.status, "success", JSON.stringify(recovered.responseJson || recovered.raw || {}));
    assert.equal(recovered.imageCount, 1);
    assert.match(recovered.imageUrls[0], /^https:\/\/api\.example\.test\/uploads\/results\/.+\.png$/);
    assert.equal(downloadedUrls.includes(oldUrl), true);
    assert.equal(downloadedUrls.includes(newUrl), true);
    assert.equal(recovered.raw.imageMirrorPending, false);
    assert.deepEqual(recovered.raw.originalImageUrls, [newUrl]);
    assert.deepEqual(
      recovered.submissionChannels.map((item) => [item.channelId, item.accountId]),
      [["shareai:chatplus", "account-gemini-fresh-url"]]
    );
    assert.deepEqual(
      recovered.generationChannels.map((item) => [item.channelId, item.accountId]),
      [["shareai:chatplus", "account-gemini-fresh-url"]]
    );
    localFilename = path.basename(new URL(recovered.imageUrls[0]).pathname);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(config);
    if (localFilename) {
      await rm(path.join(process.cwd(), "outputs", "results", localFilename), { force: true });
    }
  }
});

test("Gemini 图片地址长期失效后会停止等待且不计失败", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-gemini-expired-mirror",
      channelId: "shareai",
      name: "Gemini 失效地址测试账号",
      username: "gemini-expired-mirror@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-gemini-expired-mirror";
  const expiredUrl = "https://one.aishare.icu/gemini/images/gg-dl/permanently-expired";
  const waitingSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  await upsertTask({
    id,
    externalId: "c_gemini_expired_mirror",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gemini",
    prompt: "Gemini 失效地址停止等待测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-gemini-expired-mirror",
    accountName: "Gemini 失效地址测试账号",
    imageCount: 1,
    imageUrls: [expiredUrl],
    raw: {
      submitted: true,
      upstreamCompleted: true,
      imageMirrorPending: true,
      originalImageUrls: [expiredUrl],
      waitingSince,
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: waitingSince,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  let upstreamReadCount = 0;
  let downloadCount = 0;
  ChatplusClient.prototype.getTask = async (externalId) => {
    upstreamReadCount += 1;
    return {
      externalId,
      status: "success",
      imageCount: 1,
      imageUrls: [expiredUrl],
      raw: { conversationId: externalId }
    };
  };
  ChatplusClient.prototype.downloadResultImage = async () => {
    downloadCount += 1;
    const error = new Error("图片保存失败：上游图片地址返回 500。");
    error.status = 500;
    throw error;
  };

  try {
    const interrupted = await refreshTask(id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.imageCount, 0, JSON.stringify(interrupted.responseJson || interrupted.raw || {}));
    assert.deepEqual(interrupted.imageUrls, []);
    assert.equal(interrupted.errorMessage, "");
    assert.equal(interrupted.raw.imageMirrorPending, false);
    assert.equal(interrupted.raw.imageMirrorGaveUp, true);
    assert.equal(upstreamReadCount, 0);
    assert.equal(downloadCount, 0);
    assert.match(interrupted.responseJson.message, /任务已停止，不计入失败/);
    assert.ok(interrupted.completedAt);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(config);
  }
});

test("旧任务重试次数耗尽后仍可恢复被临时地址挡住的真实图片", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    publicBaseUrl: "https://api.example.test",
    imageStorage: { mode: "smart", autoCleanup: false, retentionDays: 7 },
    accounts: [{
      id: "account-gemini-placeholder-recovery",
      channelId: "shareai",
      name: "Gemini 临时地址恢复测试账号",
      username: "gemini-placeholder-recovery@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-gemini-placeholder-recovery";
  const placeholderUrl = "http://googleusercontent.com/image_generation_content/0_462";
  const realUrl = "https://one.aishare.icu/gemini/images/gg-dl/recoverable-after-placeholder";
  const interruptedAt = new Date().toISOString();
  await upsertTask({
    id,
    externalId: "c_gemini_placeholder_recovery",
    status: "interrupted",
    taskType: "img2img",
    modelId: "gemini",
    prompt: "临时地址恢复测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-gemini-placeholder-recovery",
    accountName: "Gemini 临时地址恢复测试账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      submitted: true,
      upstreamCompleted: true,
      imageMirrorGaveUp: true,
      imageMirrorPending: false,
      imageMirrorRetryCount: 20,
      originalImageUrls: [placeholderUrl, realUrl],
      waitingSince: interruptedAt,
      interruptedAt,
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: interruptedAt,
    completedAt: interruptedAt
  });

  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  let downloadedUrl = "";
  let localFilename = "";
  ChatplusClient.prototype.downloadResultImage = async (url) => {
    downloadedUrl = url;
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      contentType: "image/png"
    };
  };

  try {
    const recovered = await refreshTask(id);
    assert.equal(recovered.status, "success", JSON.stringify(recovered.responseJson || recovered.raw || {}));
    assert.equal(recovered.imageCount, 1);
    assert.equal(downloadedUrl, realUrl);
    localFilename = path.basename(new URL(recovered.imageUrls[0]).pathname);
  } finally {
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(config);
    if (localFilename) {
      await rm(path.join(process.cwd(), "outputs", "results", localFilename), { force: true });
    }
  }
});

test("没有真实上游编号的旧 Gemini 任务会停止而不是永久处理中", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-old-gemini",
      channelId: "shareai",
      name: "旧 Gemini 测试账号",
      username: "old-gemini@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });
  const id = "task-old-gemini-without-result";
  await upsertTask({
    id,
    externalId: "old-gemini-without-conversation-id",
    status: "processing",
    taskType: "img2img",
    modelId: "gemini",
    prompt: "旧 Gemini 任务",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-old-gemini",
    accountName: "旧 Gemini 测试账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      queued: false,
      submitted: true,
      submittedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      chatModel: "gemini",
      selectedCarId: "old-gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let getTaskCount = 0;
  ChatplusClient.prototype.getTask = async () => {
    getTaskCount += 1;
    throw new Error("不应调用普通聊天详情");
  };
  try {
    const result = await refreshTask(id);
    assert.equal(getTaskCount, 0);
    assert.equal(result.status, "interrupted");
    assert.equal(result.raw.geminiResultMissing, true);
    assert.match(result.responseJson.message, /不计入失败/);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(config);
  }
});

test("Gemini 已生成图片但本地漏收时，查看详情会补回并保存结果", async () => {
  const originalConfig = await loadConfig();
  const channel = {
    id: "gemini-history-recovery",
    name: "Gemini补图测试渠道",
    type: "shareai",
    enabled: true,
    settings: {
      chatBaseUrl: "https://cloudlian.cn",
      defaultChatModel: "gemini",
      chatModels: [{ key: "gemini", name: "Gemini", carType: "gemini", enabled: true, default: true }]
    }
  };
  const account = {
    id: "account-gemini-history-recovery",
    channelId: channel.id,
    name: "Gemini补图测试账号",
    username: "gemini-history-recovery@example.com",
    password: "test",
    enabled: true,
    status: "ok"
  };
  await saveConfig({
    ...originalConfig,
    imageStorage: { ...(originalConfig.imageStorage || {}), mode: "smart" },
    channels: [channel, ...originalConfig.channels.filter((item) => item.id !== channel.id)],
    accounts: [account, ...originalConfig.accounts.filter((item) => item.id !== account.id)]
  });

  const id = "task-gemini-history-recovery";
  const generatedUrl = "https://cloudlian.cn/gemini/images/gg/generated-after-text";
  await upsertTask({
    id,
    externalId: "c_ce144bba99281e12",
    status: "failed",
    taskType: "img2img",
    modelId: "gemini",
    prompt: "恢复上游已经生成的图片",
    channelId: `${channel.id}:chatplus`,
    channelName: `${channel.name}/聊天生图`,
    channelType: "chatplus",
    accountId: account.id,
    accountName: account.name,
    imageCount: 0,
    imageUrls: [],
    errorMessage: "**Refine Brush Details** I'm now zeroing in on the product details.",
    raw: {
      submitted: true,
      conversationId: "c_ce144bba99281e12",
      chatModel: "gemini",
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  const originalDownloadResultImage = ChatplusClient.prototype.downloadResultImage;
  let queried = null;
  let downloadedUrl = "";
  let localFilename = "";
  ChatplusClient.prototype.getTask = async function getTaskFromHistory(externalId, context) {
    queried = { externalId, context, baseUrl: this.baseUrl };
    return {
      externalId,
      status: "success",
      imageCount: 1,
      imageUrls: [generatedUrl],
      errorMessage: "",
      raw: {
        conversationId: externalId,
        selectedCarId: context.carId,
        selectedCarType: context.carType
      }
    };
  };
  ChatplusClient.prototype.downloadResultImage = async (url) => {
    downloadedUrl = url;
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      contentType: "image/png"
    };
  };

  try {
    const detail = await inspectUpstreamTask(id);
    const saved = await getTask(id);

    assert.equal(queried.externalId, "c_ce144bba99281e12");
    assert.equal(queried.context.carId, "gemini-car");
    assert.equal(queried.context.carType, "gemini");
    assert.equal(queried.baseUrl, "https://cloudlian.cn");
    assert.equal(downloadedUrl, generatedUrl);
    assert.equal(detail.status, "success");
    assert.equal(detail.detailSource, "upstream");
    assert.equal(detail.imageUrls.length, 1);
    assert.equal(saved.status, "success");
    assert.deepEqual(saved.imageUrls, detail.imageUrls);
    localFilename = path.basename(detail.imageUrls[0]);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    ChatplusClient.prototype.downloadResultImage = originalDownloadResultImage;
    await saveConfig(originalConfig);
    if (localFilename) {
      await rm(path.join(process.cwd(), "outputs", "results", localFilename), { force: true });
    }
  }
});

test("停用账号的等待上游旧任务不会继续登录刷新", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-disabled-refresh",
      channelId: "shareai",
      name: "停用刷新测试账号",
      username: "disabled-refresh@example.com",
      password: "test",
      enabled: false,
      status: "ok",
      meta: {
        abilities: {
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const id = "task-disabled-refresh";
  await upsertTask({
    id,
    externalId: "conversation-disabled-refresh",
    status: "waiting_upstream",
    taskType: "img2img",
    prompt: "停用账号旧任务",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-disabled-refresh",
    accountName: "停用刷新测试账号",
    raw: {
      queued: false,
      submitted: true,
      submittedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let getTaskCount = 0;
  ChatplusClient.prototype.getTask = async () => {
    getTaskCount += 1;
    throw new Error("不应该刷新停用账号任务");
  };

  try {
    const result = await refreshTask(id);
    const stored = await getTask(id);

    assert.equal(getTaskCount, 0);
    assert.equal(result.status, "interrupted");
    assert.equal(stored.status, "interrupted");
    assert.equal(stored.raw.disabledRefreshSkipped, true);
    assert.match(stored.responseJson.message, /账号已停用/);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
  }
});

test("停用账号恢复后会自动重新查询此前中断的上游生图任务", async () => {
  const originalConfig = await loadConfig();
  const account = {
    id: "account-auto-retry-after-recovery",
    channelId: "shareai",
    name: "自动恢复测试账号",
    username: "auto-retry@example.com",
    password: "test",
    enabled: false,
    status: "ok",
    meta: { abilities: { chatplus: { status: "ok", message: "聊天账号可用" } } }
  };
  await saveConfig({ ...originalConfig, defaultChannel: "shareai", accounts: [account] });

  const id = "task-auto-retry-after-recovery";
  await upsertTask({
    id,
    externalId: "conversation-auto-retry-after-recovery",
    status: "waiting_upstream",
    taskType: "img2img",
    prompt: "账号恢复后自动查询",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: account.id,
    accountName: account.name,
    raw: { submitted: true, submittedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let getTaskCount = 0;
  ChatplusClient.prototype.getTask = async (externalId) => {
    getTaskCount += 1;
    return {
      externalId,
      status: "success",
      imageCount: 1,
      imageUrls: ["https://example.test/recovered-image.png"],
      errorMessage: "",
      raw: { conversationId: externalId }
    };
  };

  try {
    await refreshProcessingTasks();
    const interrupted = await getTask(id);
    assert.equal(getTaskCount, 0);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.raw.disabledRefreshSkipped, true);

    await saveConfig({ ...originalConfig, defaultChannel: "shareai", accounts: [{ ...account, enabled: true }] });
    await refreshProcessingTasks();
    const recovered = await getTask(id);
    assert.ok(getTaskCount >= 1);
    assert.equal(recovered.status, "success");
    assert.equal(recovered.imageCount, 1);
    assert.equal(recovered.raw.interrupted, false);
    assert.equal(recovered.raw.manualRefreshAvailable, false);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("旧任务所属账号缺失时会停止自动查询，账号恢复后可手动重查", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: []
  });

  const id = "task-missing-refresh-account";
  const waitingSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await upsertTask({
    id,
    externalId: "conversation-missing-refresh-account",
    status: "waiting_upstream",
    taskType: "img2img",
    modelId: "gpt",
    prompt: "缺失账号恢复测试",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-missing-refresh",
    accountName: "已删除账号",
    imageCount: 0,
    imageUrls: [],
    raw: {
      queued: false,
      submitted: true,
      submittedAt: waitingSince,
      waitingUpstream: true,
      waitingSince
    },
    createdAt: waitingSince,
    completedAt: null
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let getTaskCount = 0;
  ChatplusClient.prototype.getTask = async (externalId) => {
    getTaskCount += 1;
    return {
      externalId,
      status: "failed",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "上游明确返回任务失败。",
      raw: { conversationId: externalId }
    };
  };

  try {
    const interrupted = await refreshTask(id);
    assert.equal(getTaskCount, 0);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.raw.refreshTargetMissing, true);
    assert.equal(interrupted.raw.manualRefreshAvailable, true);
    assert.match(interrupted.responseJson.message, /没有可用账号/);
    assert.match(interrupted.responseJson.message, /不计入失败/);

    await saveConfig({
      ...config,
      defaultChannel: "shareai",
      accounts: [{
        id: "account-missing-refresh",
        channelId: "shareai",
        name: "恢复后的账号",
        username: "recovered-refresh@example.com",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            chatplus: { status: "ok", message: "聊天账号可用" }
          }
        }
      }]
    });
    const retried = await refreshTask(id);
    assert.equal(getTaskCount, 1);
    assert.equal(retried.status, "failed");
    assert.equal(retried.raw.manualRefreshAvailable, false);
    assert.equal(retried.raw.interrupted, false);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(config);
  }
});

test("后台可以用服务器账号读取上游聊天详情", async () => {
  const config = await loadConfig();
  const originalConfig = JSON.parse(JSON.stringify(config));
  const shareAIChannel = {
    id: "shareai",
    name: "ShareAI账号",
    type: "shareai",
    enabled: true,
    priority: 1,
    settings: {
      ...(config.channels.find((item) => item.id === "shareai")?.settings || {}),
      chatBaseUrl: "https://one.aishare.icu",
      drawingBaseUrl: "https://drawing.aishare.icu"
    }
  };
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    channels: [
      shareAIChannel,
      ...config.channels.filter((item) => item.id !== "shareai")
    ],
    accounts: [
      ...config.accounts.filter((item) => item.id !== "account-upstream-detail"),
      {
        id: "account-upstream-detail",
        channelId: "shareai",
        name: "详情测试账号",
        username: "upstream-detail@example.com",
        password: "test",
        enabled: true,
        status: "ok"
      }
    ]
  });

  await upsertTask({
    id: "task-upstream-detail",
    externalId: "conversation-upstream-detail",
    status: "failed",
    taskType: "img2img",
    prompt: "读取上游详情",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-upstream-detail",
    accountName: "详情测试账号",
    errorMessage: "本地失败记录",
    raw: {
      conversationId: "conversation-upstream-detail",
      selectedCarId: "car-upstream-detail",
      selectedCarType: "chatgpt"
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let seen = null;
  ChatplusClient.prototype.getTask = async function getTask(externalId, context) {
    seen = {
      externalId,
      context,
      accountId: this.account.id,
      baseUrl: this.baseUrl
    };
    return {
      externalId,
      status: "failed",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "上游返回了文字说明",
      raw: {
        conversationId: externalId,
        title: "New chat",
        selectedCarId: "car-upstream-detail"
      }
    };
  };

  try {
    const detail = await inspectUpstreamTask("task-upstream-detail");

    assert.equal(seen.externalId, "conversation-upstream-detail");
    assert.equal(seen.context.carId, "car-upstream-detail");
    assert.equal(seen.accountId, "account-upstream-detail");
    assert.equal(seen.baseUrl, "https://one.aishare.icu");
    assert.equal(detail.conversationId, "conversation-upstream-detail");
    assert.equal(detail.title, "New chat");
    assert.equal(detail.carId, "car-upstream-detail");
    assert.equal(detail.errorMessage, "上游返回了文字说明");
    assert.equal(detail.conversationUrl, "https://one.aishare.icu/c/conversation-upstream-detail");
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("Gemini 本地备用编号不会被当成真实上游对话", async () => {
  const originalConfig = await loadConfig();
  const shareAIChannel = {
    id: "shareai",
    name: "ShareAI账号",
    type: "shareai",
    enabled: true,
    settings: {
      baseUrl: "https://one.aishare.icu",
      defaultChatModel: "gemini",
      chatModels: [{
        key: "gemini",
        name: "Gemini",
        carType: "gemini",
        strategy: "thinking",
        enabled: true,
        default: true
      }]
    }
  };
  await saveConfig({
    ...originalConfig,
    defaultChannel: "shareai",
    channels: [
      shareAIChannel,
      ...originalConfig.channels.filter((item) => item.id !== "shareai")
    ],
    accounts: [
      ...originalConfig.accounts.filter((item) => item.id !== "account-gemini-local-id"),
      {
        id: "account-gemini-local-id",
        channelId: "shareai",
        name: "Gemini编号测试账号",
        username: "gemini-local-id@example.com",
        password: "test",
        enabled: true,
        status: "ok"
      }
    ]
  });
  await upsertTask({
    id: "task-gemini-local-id",
    externalId: "6a881587-cb5e-4f00-9c74-e5ac904bf377",
    status: "failed",
    taskType: "img2img",
    modelId: "gemini",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-gemini-local-id",
    accountName: "Gemini编号测试账号",
    raw: { chatModel: "gemini" },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let queriedUpstream = false;
  ChatplusClient.prototype.getTask = async function getTask() {
    queriedUpstream = true;
    return {};
  };

  try {
    await assert.rejects(
      () => inspectUpstreamTask("task-gemini-local-id"),
      /还没有保存上游对话编号/
    );
    assert.equal(queriedUpstream, false);

    await upsertTask({
      id: "task-gemini-local-id",
      raw: {
        chatModel: "gemini",
        conversationId: "**Refine Brush Details** I'm now zeroing in on the product details."
      }
    });
    await assert.rejects(
      () => inspectUpstreamTask("task-gemini-local-id"),
      /还没有保存上游对话编号/
    );
    assert.equal(queriedUpstream, false);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("Gemini 真实会话详情使用已保存结果和正确打开地址", async () => {
  const originalConfig = await loadConfig();
  const shareAIChannel = {
    id: "gemini-detail-channel",
    name: "Gemini详情测试渠道",
    type: "shareai",
    enabled: true,
    settings: {
      chatBaseUrl: "https://cloudlian.cn",
      defaultChatModel: "gemini",
      chatModels: [{ key: "gemini", name: "Gemini", enabled: true, default: true }]
    }
  };
  await saveConfig({
    ...originalConfig,
    channels: [
      shareAIChannel,
      ...originalConfig.channels.filter((item) => item.id !== shareAIChannel.id)
    ],
    accounts: [
      ...originalConfig.accounts.filter((item) => item.id !== "account-gemini-detail"),
      {
        id: "account-gemini-detail",
        channelId: shareAIChannel.id,
        name: "Gemini详情测试账号",
        username: "gemini-detail@example.com",
        password: "test",
        enabled: true,
        status: "ok"
      }
    ]
  });
  await upsertTask({
    id: "task-gemini-detail",
    externalId: "c_ce144bba99281e12",
    status: "success",
    taskType: "img2img",
    modelId: "gemini",
    channelId: `${shareAIChannel.id}:chatplus`,
    channelName: `${shareAIChannel.name}/聊天生图`,
    channelType: "chatplus",
    accountId: "account-gemini-detail",
    accountName: "Gemini详情测试账号",
    imageCount: 1,
    imageUrls: ["https://example.test/gemini-result.png"],
    raw: {
      chatModel: "gemini",
      conversationId: "c_ce144bba99281e12",
      selectedCarId: "gemini-car",
      selectedCarType: "gemini"
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let queriedUpstream = false;
  ChatplusClient.prototype.getTask = async () => {
    queriedUpstream = true;
    throw new Error("不应调用 GPT 会话详情接口");
  };

  try {
    const detail = await inspectUpstreamTask("task-gemini-detail");
    assert.equal(queriedUpstream, false);
    assert.equal(detail.detailSource, "stored");
    assert.equal(detail.conversationId, "c_ce144bba99281e12");
    assert.equal(detail.conversationUrl, "https://cloudlian.cn/app/ce144bba99281e12");
    assert.deepEqual(detail.imageUrls, ["https://example.test/gemini-result.png"]);
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("已提交但被中间 JSON 误判失败的聊天生图会自动恢复", async () => {
  const originalConfig = await loadConfig();
  await saveConfig({
    ...originalConfig,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-recover-early-image-json",
      channelId: "shareai",
      name: "中间结果恢复测试账号",
      username: "recover-early-image-json@example.com",
      password: "test",
      enabled: true,
      status: "ok"
    }]
  });

  const intermediateMessage = JSON.stringify({
    prompt: null,
    size: null,
    n: 1,
    referenced_image_ids: ["file-source"]
  });
  await upsertTask({
    id: "task-recover-early-image-json",
    externalId: "conversation-recover-early-image-json",
    status: "failed",
    taskType: "img2img",
    prompt: "恢复延迟图片",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-recover-early-image-json",
    accountName: "中间结果恢复测试账号",
    imageCount: 0,
    imageUrls: [],
    errorMessage: intermediateMessage,
    responseJson: { status: "failed", message: intermediateMessage },
    raw: {
      submitted: true,
      conversationId: "conversation-recover-early-image-json"
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  ChatplusClient.prototype.getTask = async () => ({
    externalId: "conversation-recover-early-image-json",
    status: "success",
    imageCount: 1,
    imageUrls: ["https://one.example.test/recovered.png"],
    errorMessage: "",
    raw: { conversationId: "conversation-recover-early-image-json" }
  });

  try {
    const recovered = await refreshTask("task-recover-early-image-json");
    assert.equal(recovered.status, "success");
    assert.equal(recovered.imageCount, 1);
    assert.deepEqual(recovered.imageUrls, ["https://one.example.test/recovered.png"]);
    assert.equal(recovered.errorMessage, "");
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("聊天生图异步提交拿到编号后不等待图片", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-submit-only", username: "submit-only@example.com" },
    sessionLock: async (work) => work()
  });
  let submitted = null;
  let waitCount = 0;
  client.withImageQuotaFallback = async (_prompt, _input, work) => work({
    events: [],
    conversationId: "conversation-submit-only",
    messageId: "message-submit-only",
    model: "gpt",
    upstreamModel: "gpt-image",
    route: { key: "gpt" },
    selected: { carId: "car-submit-only", carType: "chatgpt", strategy: "image" }
  });
  client.waitForConversationImages = async () => {
    waitCount += 1;
    return ["https://example.com/should-not-wait.png"];
  };

  const result = await client.createImageTask({
    prompt: "异步提交测试",
    files: [{ filename: "source.png" }],
    waitForImages: false,
    onSubmitted: async (value) => {
      submitted = value;
    }
  });

  assert.equal(waitCount, 0);
  assert.equal(submitted.status, "processing");
  assert.equal(result.status, "waiting_upstream");
  assert.equal(result.externalId, "conversation-submit-only");
});

test("后台聊天生图提交后立即改由后台查询结果", async () => {
  const originalConfig = await loadConfig();
  await saveConfig({
    ...originalConfig,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-chat-image",
      channelId: "shareai",
      name: "后台查询测试账号",
      username: "background-chat-image@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", balance: 0, message: "跳过绘图站" },
          chatplus: { status: "ok", balance: 20, message: "聊天站可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const originalGetTask = ChatplusClient.prototype.getTask;
  let receivedWaitForImages = null;
  ChatplusClient.prototype.createImageTask = async (input) => {
    receivedWaitForImages = input.waitForImages;
    await input.onSubmitted?.({
      externalId: "conversation-background-chat-image",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      imageCount: 0,
      imageUrls: [],
      raw: {
        conversationId: "conversation-background-chat-image",
        selectedCarId: "car-background-chat-image",
        selectedCarType: "chatgpt"
      }
    });
    return {
      externalId: "conversation-background-chat-image",
      status: "waiting_upstream",
      taskType: "img2img",
      prompt: input.prompt,
      imageCount: 0,
      imageUrls: [],
      raw: {
        conversationId: "conversation-background-chat-image",
        selectedCarId: "car-background-chat-image",
        selectedCarType: "chatgpt"
      }
    };
  };
  ChatplusClient.prototype.getTask = async (externalId) => ({
    externalId,
    status: "failed",
    taskType: "img2img",
    imageCount: 0,
    imageUrls: [],
    errorMessage: "当前车位图片生成次数已用完，系统已暂停使用该车位。",
    raw: { conversationId: externalId, imageCarQuotaExhausted: true }
  });

  let queued = null;
  try {
    queued = await queueImageTask({
      input: { channel: "chatplus", prompt: "后台查询测试" },
      files: [{ filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") }]
    });

    for (let attempt = 0; attempt < 160; attempt += 1) {
      const task = await getTask(queued.id);
      if (task?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(receivedWaitForImages, false);
    assert.equal((await getTask(queued.id)).status, "failed");
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("聊天生图没有上游编号时不能算已提交", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-no-upstream-id", username: "no-upstream-id@example.com" },
    sessionLock: async (work) => work()
  });
  let submittedCount = 0;
  let prepareCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    prepareCount += 1;
    const carId = `car-no-upstream-id-${prepareCount}`;
    ignoredCarIds.add(carId);
    client.portalLoggedIn = true;
    client.cookies = ["portal=ok", `car=${carId}`];
    return {
      route: { key: "gpt", strategy: "image" },
      selected: { carId, carType: "chatgpt", strategy: "image" },
      init: { default_model_slug: "gpt-test" }
    };
  };
  const originalHttp = ChatplusClient.prototype.http;
  ChatplusClient.prototype.http = async function (pathName) {
    if (pathName !== "/backend-api/conversation") throw new Error(`unexpected request: ${pathName}`);
    return {
      status: 200,
      headers: {},
      body: `data: {"message":{"id":"message-only"}}\n\ndata: [DONE]\n\n`
    };
  };

  try {
    await assert.rejects(
      () => client.createTextTask({
        prompt: "no upstream id",
        concurrentSubmit: true,
        waitForImages: false,
        onSubmitted: async () => {
          submittedCount += 1;
        }
      }),
      /连续两个车位都没有创建对话/
    );
    assert.equal(submittedCount, 0);
    assert.equal(prepareCount, 2);
  } finally {
    ChatplusClient.prototype.http = originalHttp;
  }
});

test("同一账号的聊天生图依次提交时复用同一车位", async () => {
  let sessionTail = Promise.resolve();
  const sessionLock = (work) => {
    const current = sessionTail.catch(() => {}).then(work);
    sessionTail = current;
    return current;
  };
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-shared-session", username: "shared-session@example.com" },
    sessionLock
  });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let enterCarCount = 0;
  let initCount = 0;
  let activeSubmitSteps = 0;
  let maxSubmitSteps = 0;
  let conversationIndex = 0;
  const trackSubmitStep = async (work) => {
    activeSubmitSteps += 1;
    maxSubmitSteps = Math.max(maxSubmitSteps, activeSubmitSteps);
    try {
      await delay(20);
      return await work();
    } finally {
      activeSubmitSteps -= 1;
    }
  };

  client.fetchCars = async () => ["one", "two", "three"].map((suffix, index) => ({
    id: `car-separated-session-${suffix}`,
    status: 1,
    count: index,
    cooldown: 0,
    desc: "ok",
    label: "ok",
    imageRemaining: 20,
    isPro: false,
    isVirtual: false,
    realCarIDs: []
  }));
  client.enterCar = async (carId, carType) => {
    enterCarCount += 1;
    client.carId = carId;
    client.carType = carType;
    client.portalLoggedIn = true;
    client.cookies = ["portal=ok", `car=${carId}`];
    await delay(20);
  };
  client.loadInit = async () => {
    initCount += 1;
    return {
      default_model_slug: "gpt-test",
      limits_progress: [{ feature_name: "image_gen", remaining: 20 }]
    };
  };
  const originalHttp = ChatplusClient.prototype.http;
  ChatplusClient.prototype.http = async function (pathName, options = {}) {
    if (pathName === "/backend-api/files") {
      assert.equal(this.cookies.includes("portal=ok"), true);
      assert.equal(this.cookies.some((cookie) => cookie.startsWith("car=car-separated-session-")), true);
      const fileName = options.body?.file_name || "source.png";
      return trackSubmitStep(async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          file_id: `file-${fileName}`,
          upload_url: `https://upload.example/${encodeURIComponent(fileName)}`
        })
      }));
    }
    if (String(pathName).startsWith("https://upload.example/")) {
      return trackSubmitStep(async () => ({ status: 201, headers: {}, body: "" }));
    }
    if (String(pathName).startsWith("/backend-api/files/") && String(pathName).endsWith("/uploaded")) {
      return trackSubmitStep(async () => ({ status: 200, headers: {}, body: JSON.stringify({ status: "success" }) }));
    }
    if (pathName !== "/backend-api/conversation") throw new Error(`unexpected request: ${pathName}`);
    return trackSubmitStep(async () => {
      conversationIndex += 1;
      return {
        status: 200,
        headers: {},
        body: `data: {"conversation_id":"conversation-${conversationIndex}"}\n\ndata: [DONE]\n\n`
      };
    });
  };
  client.ensureConversationUpdates = async () => null;
  client.conversationDetail = async () => ({ status: "finished_successfully" });
  client.imageUrlsFrom = async () => ["https://example.test/generated.png"];

  const results = [];
  try {
    for (const color of ["red", "blue", "black"]) {
      const result = await client.createImageTask({
        prompt: `change background to ${color}`,
        files: [{
          filename: `${color}.png`,
          mimetype: "image/png",
          toBuffer: async () => Buffer.from("image")
        }],
        concurrentSubmit: true,
        waitForImages: false
      });
      results.push(result);
      const completed = await client.getTask(result.externalId, { imageTask: true });
      assert.equal(completed.status, "success");
    }
  } finally {
    ChatplusClient.prototype.http = originalHttp;
  }

  assert.equal(enterCarCount, 1);
  assert.equal(initCount, 1);
  assert.equal(client.cookies.some((cookie) => cookie.startsWith("upload=")), false);
  assert.equal(maxSubmitSteps, 1, "聊天生图总体并发为 1 时应依次上传和提交");
  assert.deepEqual(results.map((result) => result.status), ["waiting_upstream", "waiting_upstream", "waiting_upstream"]);
  assert.equal(new Set(results.map((result) => result.externalId)).size, 3);
  assert.deepEqual(results.map((result) => result.raw.selectedCarId), [
    "car-separated-session-one",
    "car-separated-session-one",
    "car-separated-session-one"
  ]);
});

test("聊天生图满载时立即拒绝，释放名额后才能重新提交", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 5, drawingImage: 5, chatImage: 5 },
    accounts: [{
      id: "account-durable-slot",
      channelId: "shareai",
      name: "durable-slot@example.com",
      username: "durable-slot@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", balance: 0, message: "跳过绘图站" },
          chatplus: { status: "ok", balance: 20, message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  const submittedJobs = [];
  ChatplusClient.prototype.createImageTask = async (input) => {
    const job = String(input.prompt || "");
    submittedJobs.push(job);
    await input.onStage?.({
      id: `stage-${job}`,
      key: "car_enter",
      label: "进入车位",
      status: "success",
      carId: `car-${job}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1200
    });
    await input.onSubmitted?.({
      externalId: `conversation-${job}`,
      status: "processing",
      taskType: "img2img",
      prompt: job,
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: `conversation-${job}` }
    });
    return {
      externalId: `conversation-${job}`,
      status: "waiting_upstream",
      taskType: "img2img",
      prompt: job,
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: `conversation-${job}` }
    };
  };

  try {
    const ownWaitingTasks = (tasks) => tasks.filter((task) =>
      task.accountId === "account-durable-slot"
      && task.status === "waiting_upstream"
    );

    await Promise.all([queueImageTask({
      input: { channel: "chatplus", prompt: "job-1" },
      files: [{
        filename: "source-1.png",
        mimetype: "image/png",
        previewUrl: "/uploads/previews/source-1.png",
        buffer: Buffer.from("x")
      }]
    })]);

    let tasks = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      tasks = await listTasks();
      if (ownWaitingTasks(tasks).length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(submittedJobs.length, 1);
    assert.equal(ownWaitingTasks(tasks).length, 1);
    assert.deepEqual(
      tasks.find((task) => task.prompt === "job-1")?.inputImageUrls,
      ["/uploads/previews/source-1.png"]
    );
    assert.deepEqual(
      tasks.find((task) => task.prompt === "job-1")?.raw?.stageTimings?.map((stage) => stage.id),
      ["stage-job-1"]
    );
    await assert.rejects(
      queueImageTask({
        input: { channel: "chatplus", prompt: "job-6" },
        files: [{ filename: "source-6.png", mimetype: "image/png", buffer: Buffer.from("x") }]
      }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "CONCURRENCY_LIMIT");
        return true;
      }
    );

    tasks = await listTasks();
    assert.equal(tasks.some((task) => task.prompt === "job-6"), false);
    assert.equal(submittedJobs.includes("job-6"), false);

    const completed = tasks.find((task) => task.prompt === "job-1");
    await upsertTask({
      ...completed,
      status: "success",
      imageCount: 1,
      imageUrls: ["https://example.com/job-1.png"],
      completedAt: new Date().toISOString()
    });

    const acceptedSixth = await queueImageTask({
      input: { channel: "chatplus", prompt: "job-6" },
      files: [{ filename: "source-6.png", mimetype: "image/png", buffer: Buffer.from("x") }]
    });
    assert.equal(acceptedSixth.status, "processing");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      tasks = await listTasks();
      if (tasks.some((task) => task.prompt === "job-6" && task.status === "waiting_upstream")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(submittedJobs.includes("job-6"), true);
    assert.equal(ownWaitingTasks(tasks).length, 1);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("异步文字生图满载时也立即拒绝，不创建排队任务", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "text-image-no-queue",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "text-image-no-queue",
      type: "chatplus",
      name: "Text Image No Queue",
      enabled: true,
      settings: {
        baseUrl: "https://chat.example.test",
        defaultChatModel: "gpt"
      }
    }],
    accounts: [{
      id: "text-image-no-queue-account",
      channelId: "text-image-no-queue",
      name: "Text Image No Queue Account",
      username: "text-image-no-queue@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
      meta: { abilities: { chatplus: { status: "ok" } } }
    }]
  });
  await upsertTask({
    id: "text-image-no-queue-blocker",
    externalId: "text-image-no-queue-upstream",
    status: "waiting_upstream",
    taskType: "text2img",
    modelId: "gpt",
    channelId: "text-image-no-queue",
    channelName: "Text Image No Queue",
    channelType: "chatplus",
    accountId: "text-image-no-queue-account",
    accountName: "Text Image No Queue Account",
    raw: { submitted: true, chatModel: "gpt" },
    createdAt: new Date().toISOString()
  });

  await assert.rejects(
    queueTextTask({ channel: "text-image-no-queue", prompt: "must not queue" }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "CONCURRENCY_LIMIT");
      return true;
    }
  );
  assert.equal((await listTasks()).some((task) => task.prompt === "must not queue"), false);
});
