import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-source-id-"));
process.env.DATA_DIR = dataDir;

const {
  closeStorage,
  getTaskBySourceTaskId,
  listChatplusConversationUpdates,
  listTasks,
  loadConfig,
  saveConfig,
  upsertTask
} = await import("../src/storage.js");
const { createImageTask, getRuntimeStatus, refreshTask } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const {
  recordChatplusConversationUpdate,
  resetChatplusConversationUpdatesForTests
} = await import("../src/chatplus-conversation-updates.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

after(async () => {
  resetChatplusConversationUpdatesForTests();
  await closeStorage();
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

test("相同调用方任务 ID 的不同提交会分别保留，同一次提交仍更新原记录", async () => {
  const sourceTaskId = "task_xituwang_source_api_1234abcd";
  const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 60 * 60 * 1000 + 5000).toISOString();

  await upsertTask({
    id: "local-source-task-original",
    sourceTaskId,
    status: "processing",
    taskType: "img2img",
    modelId: "gpt",
    requestJson: { client_task_id: sourceTaskId },
    createdAt
  });

  await upsertTask({
    id: "local-source-task-original",
    sourceTaskId,
    status: "failed",
    taskType: "img2img",
    modelId: "gpt",
    errorMessage: "GPT 请求超时",
    responseJson: { ok: false, code: "TIMEOUT", sourceTaskId },
    completedAt
  });

  await upsertTask({
    id: "local-source-task-gemini",
    sourceTaskId,
    status: "failed",
    taskType: "img2img",
    modelId: "gemini",
    errorMessage: "Gemini 未返回图片",
    requestJson: { client_task_id: sourceTaskId, model: "Gemini" },
    responseJson: { ok: false, code: "UPSTREAM_NO_IMAGE", sourceTaskId },
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 30 * 60 * 1000 + 5000).toISOString()
  });

  const tasks = await listTasks();
  const matched = tasks.filter((task) => task.sourceTaskId === sourceTaskId);

  assert.equal(matched.length, 2);
  assert.deepEqual(
    matched.map((task) => [task.id, task.modelId, task.responseJson.code]),
    [
      ["local-source-task-gemini", "gemini", "UPSTREAM_NO_IMAGE"],
      ["local-source-task-original", "gpt", "TIMEOUT"]
    ]
  );
  assert.equal((await getTaskBySourceTaskId(sourceTaskId)).id, "local-source-task-gemini");
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

test("chatplus 只返回当前对话分支中用户可见的生成图", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-visible-image-account", username: "visible-image@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.imageDownloadUrl = async (fileId) => `https://one.example.test/files/${fileId}.png`;

  const imageUrls = await client.imageUrlsFrom({
    current_node: "finalText",
    mapping: {
      user: {
        parent: null,
        message: {
          author: { role: "user" },
          content: { parts: ["file-service://file_source"] }
        }
      },
      hiddenIntermediate: {
        parent: "user",
        message: {
          author: { role: "assistant" },
          metadata: { is_visually_hidden_from_conversation: true },
          content: { content_type: "image_asset_pointer", parts: ["file-service://file_intermediate"] }
        }
      },
      finalImage: {
        parent: "hiddenIntermediate",
        message: {
          author: { role: "assistant" },
          content: { content_type: "image_asset_pointer", parts: ["file-service://file_final"] }
        }
      },
      finalText: {
        parent: "finalImage",
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["图片已经生成。"] }
        }
      },
      otherBranch: {
        parent: "user",
        message: {
          author: { role: "assistant" },
          content: { content_type: "image_asset_pointer", parts: ["file-service://file_other_branch"] }
        }
      }
    }
  }, { generatedOnly: true });

  assert.deepEqual(imageUrls, ["https://one.example.test/files/file_final.png"]);
});

test("chatplus 能取回当前分支中被隐藏的生图工具结果", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-hidden-image-account", username: "hidden-image@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.imageDownloadUrl = async (fileId) => `https://one.example.test/files/${fileId}.png`;

  const imageUrls = await client.imageUrlsFrom({
    current_node: "finalText",
    mapping: {
      user: {
        parent: null,
        message: { author: { role: "user" }, content: { parts: ["生成一张图片"] } }
      },
      hiddenImageTool: {
        parent: "user",
        message: {
          author: { role: "tool" },
          metadata: { is_visually_hidden_from_conversation: true, image_gen_title: "图片" },
          content: { content_type: "multimodal_text", parts: [{ asset_pointer: "sediment://file_generated" }] }
        }
      },
      finalText: {
        parent: "hiddenImageTool",
        message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["已完成"] } }
      },
      otherBranch: {
        parent: "user",
        message: {
          author: { role: "tool" },
          metadata: { image_gen_title: "旧图片" },
          content: { content_type: "multimodal_text", parts: [{ asset_pointer: "sediment://file_old" }] }
        }
      }
    }
  }, { generatedOnly: true });

  assert.deepEqual(imageUrls, ["https://one.example.test/files/file_generated.png"]);
});

test("chatplus image wait treats prompt JSON as an intermediate response", async () => {
  const promptEnvelope = JSON.stringify({ prompt: "整理后的绘图提示词" });
  const resultUrl = "https://one.example.test/generated-after-prompt.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-prompt-account", username: "prompt@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  let imageReadCount = 0;
  client.imageUrlsFrom = async () => {
    imageReadCount += 1;
    return imageReadCount === 1 ? [] : [resultUrl];
  };
  client.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: [promptEnvelope] }
        }
      }
    }
  });

  const imageUrls = await client.waitForConversationImages([{
    message: {
      author: { role: "assistant" },
      content: { parts: [promptEnvelope] }
    }
  }], "conversation-with-prompt-envelope", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
  assert.equal(imageReadCount, 2);
});

test("chatplus task refresh keeps prompt JSON in progress", async () => {
  const promptEnvelope = JSON.stringify({ prompt: "整理后的绘图提示词" });
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-prompt-refresh-account", username: "prompt-refresh@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.loginPortal = async () => {};
  client.imageUrlsFrom = async () => [];
  client.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: [promptEnvelope] }
        }
      }
    }
  });

  const task = await client.getTask("conversation-with-prompt-envelope");

  assert.equal(task.status, "waiting_upstream");
  assert.equal(task.errorMessage, "");
  assert.deepEqual(task.imageUrls, []);
});

test("chatplus task refresh bypasses cached conversation results", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-refresh-account", username: "refresh@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  const loginOptions = [];
  let detailRequest = null;
  client.loginPortal = async (options) => {
    loginOptions.push(options);
  };
  client.json = async (pathName, options) => {
    detailRequest = { pathName, options };
    return { mapping: {} };
  };

  const task = await client.getTask("conversation-no-cache", { timeoutSec: 30 });

  assert.equal(task.status, "waiting_upstream");
  assert.match(detailRequest.pathName, /^\/backend-api\/conversation\/conversation-no-cache\?_\=\d+$/);
  assert.equal(detailRequest.options.timeoutSec, 30);
  assert.equal(detailRequest.options.headers["cache-control"], "no-cache");
  assert.equal(detailRequest.options.headers.pragma, "no-cache");
  assert.deepEqual(loginOptions, [{ timeoutSec: 30 }]);
});

test("chatplus task refresh reads a completed image from the realtime result channel", async () => {
  resetChatplusConversationUpdatesForTests();
  const conversationId = "conversation-realtime-complete";
  const resultUrl = "https://one.example.test/generated-from-realtime-channel.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-async-sync-account", username: "async-sync@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};

  const requests = [];
  client.json = async (pathName, options = {}) => {
    requests.push({ pathName, options });
    if (pathName.includes("/stream_status")) return { status: "COMPLETE" };
    return {
      async_status: 5,
      current_node: "pending-tool",
      mapping: {
        "pending-tool": {
          parent: null,
          message: {
            author: { role: "tool" },
            content: { content_type: "multimodal_text", parts: [] },
            metadata: { ghostrider: { status: "intermediate" } },
            status: "finished_successfully"
          }
        }
      }
    };
  };
  recordChatplusConversationUpdate({
    type: "conversation-update",
    payload: {
      conversation_id: conversationId,
      task_id: "upstream-task-from-realtime",
      update_type: "async-task-update-message",
      update_content: {
        message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: resultUrl }]
          },
          metadata: { ghostrider: { status: "final" } },
          status: "finished_successfully"
        }
      }
    }
  });

  const task = await client.getTask(conversationId, { timeoutSec: 30 });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
  assert.equal(requests.some((item) => item.pathName.endsWith("/async-status")), false);
  assert.equal(task.raw.resultChannelUpdateCount, 1);
  assert.equal(task.raw.upstreamTaskId, "upstream-task-from-realtime");
});

test("chatplus task refresh recovers a realtime image after the memory cache is reset", async () => {
  resetChatplusConversationUpdatesForTests();
  const conversationId = "conversation-durable-realtime-complete";
  const resultUrl = "https://one.example.test/generated-from-durable-realtime.png";
  recordChatplusConversationUpdate({
    type: "conversation-update",
    payload: {
      conversation_id: conversationId,
      update_type: "async-task-completed",
      update_content: {
        message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: resultUrl }]
          },
          status: "finished_successfully"
        }
      }
    }
  });
  const persistedUpdates = await listChatplusConversationUpdates(conversationId);
  resetChatplusConversationUpdatesForTests();

  const staleDetail = { async_status: 5, mapping: {} };
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-durable-update-account", username: "durable-update@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.ensureConversationUpdates = async () => null;
  client.conversationDetail = async () => staleDetail;
  client.refreshCompletedConversation = async () => staleDetail;

  const task = await client.getTask(conversationId, { persistedUpdates, timeoutSec: 30 });

  assert.equal(persistedUpdates.length, 1);
  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
});

test("chatplus task refresh recovers a stale conversation by its saved upstream task id", async () => {
  const conversationId = "conversation-saved-upstream-task";
  const upstreamTaskId = "upstream-task-saved";
  const resultUrl = "https://one.example.test/generated-from-saved-task.png";
  const staleDetail = { async_status: 5, mapping: {} };
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-saved-task-account", username: "saved-task@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.ensureConversationUpdates = async () => null;
  client.conversationDetail = async () => staleDetail;
  client.refreshCompletedConversation = async () => staleDetail;

  const requests = [];
  client.json = async (pathName) => {
    requests.push(pathName);
    assert.equal(pathName, `/backend-api/task/${upstreamTaskId}`);
    return {
      task_id: upstreamTaskId,
      conversation_id: conversationId,
      status: "completed",
      image_gen_message: {
        author: { role: "tool" },
        content: {
          content_type: "multimodal_text",
          parts: [{ type: "image_url", image_url: resultUrl }]
        }
      }
    };
  };

  const task = await client.getTask(conversationId, { upstreamTaskId, timeoutSec: 30 });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
  assert.equal(task.raw.upstreamTaskId, upstreamTaskId);
  assert.deepEqual(requests, [`/backend-api/task/${upstreamTaskId}`]);
});

test("chatplus task refresh discovers the upstream task when the ordinary conversation stays stale", async () => {
  const conversationId = "conversation-discovered-upstream-task";
  const upstreamTaskId = "upstream-task-discovered";
  const resultUrl = "https://one.example.test/generated-from-task-list.png";
  const staleDetail = { async_status: 5, mapping: {} };
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-discovered-task-account", username: "discovered-task@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.ensureConversationUpdates = async () => null;
  client.conversationDetail = async () => staleDetail;
  client.refreshCompletedConversation = async () => staleDetail;

  const requests = [];
  client.json = async (pathName) => {
    requests.push(pathName);
    assert.equal(pathName, "/backend-api/tasks");
    return {
      cursor: null,
      tasks: [{
        task_id: upstreamTaskId,
        conversation_id: conversationId,
        status: "completed",
        image_gen_message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: resultUrl }]
          }
        }
      }]
    };
  };

  const task = await client.getTask(conversationId, { timeoutSec: 30 });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
  assert.equal(task.raw.upstreamTaskId, upstreamTaskId);
  assert.deepEqual(requests, ["/backend-api/tasks"]);
});

test("chatplus saves a discovered upstream task id before returning the submitted task", async () => {
  const upstreamTaskId = "upstream-task-before-return";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-capture-task-account", username: "capture-task@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.discoverImageGenerationTask = async () => ({
    taskId: upstreamTaskId,
    task: null,
    imageUrls: [],
    failure: null
  });
  const submitted = [];
  const conversation = {
    conversationId: "conversation-capture-upstream-task",
    events: [],
    model: "gpt",
    upstreamModel: "gpt-image-test",
    route: { key: "gpt" },
    selected: { carId: "car-capture", carType: "chatgpt" }
  };

  await client.captureImageTaskRegistration(
    conversation,
    { onSubmitted: async (value) => submitted.push(value) },
    "生成一张测试图片",
    "text2img"
  );

  assert.equal(conversation.upstreamTaskId, upstreamTaskId);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].raw.upstreamTaskId, upstreamTaskId);
});

test("chatplus task refresh picks up a later realtime result without resubmitting", async () => {
  resetChatplusConversationUpdatesForTests();
  const conversationId = "conversation-realtime-later";
  const resultUrl = "https://one.example.test/generated-after-realtime-update.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-async-repeat-account", username: "async-repeat@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};

  const requests = [];
  client.json = async (pathName, options = {}) => {
    requests.push({ pathName, options });
    if (pathName.includes("/stream_status")) return { status: "COMPLETE" };
    return {
      async_status: 5,
      current_node: "pending-tool",
      mapping: {
        "pending-tool": {
          parent: null,
          message: {
            author: { role: "tool" },
            content: { content_type: "multimodal_text", parts: [] },
            metadata: { ghostrider: { status: "intermediate" } },
            status: "finished_successfully"
          }
        }
      }
    };
  };

  const first = await client.getTask(conversationId, { timeoutSec: 30 });
  recordChatplusConversationUpdate({
    type: "conversation-update",
    payload: {
      conversation_id: conversationId,
      update_type: "async-task-completed",
      update_content: {
        message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: resultUrl }]
          },
          metadata: { ghostrider: { status: "final" } },
          status: "finished_successfully"
        }
      }
    }
  });
  const second = await client.getTask(conversationId, { timeoutSec: 30 });

  assert.equal(first.status, "waiting_upstream");
  assert.equal(second.status, "success");
  assert.deepEqual(second.imageUrls, [resultUrl]);
  assert.equal(requests.some((item) => item.pathName.endsWith("/async-status")), false);
  assert.equal(client.completedConversationSyncs.size, 0);
});

test("chatplus completed stream checks deduplicate simultaneous reads and release their cache", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-async-dedupe-account", username: "async-dedupe@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  let releaseStream;
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });
  let streamChecks = 0;
  client.conversationStreamStatus = async () => {
    streamChecks += 1;
    await streamGate;
    return { status: "COMPLETE" };
  };
  client.conversationDetail = async () => ({ async_status: 5, mapping: {} });

  const first = client.refreshCompletedConversation("conversation-async-dedupe", { async_status: 5 });
  const second = client.refreshCompletedConversation("conversation-async-dedupe", { async_status: 5 });
  await Promise.resolve();
  releaseStream();
  await Promise.all([first, second]);

  assert.equal(streamChecks, 1);
  assert.equal(client.completedConversationSyncs.size, 0);
});

test("chatplus task refresh does not sync an async image that is still running", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-async-running-account", username: "async-running@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};

  const requests = [];
  client.json = async (pathName, options = {}) => {
    requests.push({ pathName, options });
    if (pathName.includes("/stream_status")) return { status: "IN_PROGRESS" };
    return {
      async_status: 5,
      current_node: "pending-tool",
      mapping: {
        "pending-tool": {
          parent: null,
          message: {
            author: { role: "tool" },
            content: { content_type: "multimodal_text", parts: [] },
            metadata: { ghostrider: { status: "intermediate" } },
            status: "finished_successfully"
          }
        }
      }
    };
  };

  const task = await client.getTask("conversation-async-running", { timeoutSec: 30 });

  assert.equal(task.status, "waiting_upstream");
  assert.equal(requests.some((item) => item.pathName.endsWith("/async-status")), false);
});

test("chatplus task refresh keeps image parameters in progress until the image appears", async () => {
  const imageParameters = JSON.stringify({
    prompt: null,
    size: null,
    n: 1,
    transparent_background: false,
    is_style_transfer: false,
    referenced_image_ids: ["file_0000000018b4822f8811592d655f3f38"]
  });
  const resultUrl = "https://one.example.test/generated-after-parameters.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-parameters-account", username: "parameters@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.loginPortal = async () => {};
  let readCount = 0;
  client.json = async () => {
    readCount += 1;
    return {
      mapping: {
        assistant: {
          message: {
            author: { role: "assistant" },
            content: {
              parts: readCount === 1
                ? [imageParameters]
                : [{ type: "image_url", image_url: resultUrl }]
            }
          }
        }
      }
    };
  };

  const pending = await client.getTask("conversation-with-image-parameters");
  assert.equal(pending.status, "waiting_upstream");
  assert.equal(pending.errorMessage, "");

  const completed = await client.getTask("conversation-with-image-parameters");
  assert.equal(completed.status, "success");
  assert.deepEqual(completed.imageUrls, [resultUrl]);
});

test("chatplus image wait ignores skipped mainline marker and keeps waiting", async () => {
  const marker = "{\"skipped_mainline\":true}";
  const resultUrl = "https://one.example.test/generated-result.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-marker-account", username: "marker@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  let imageReadCount = 0;
  client.imageUrlsFrom = async () => {
    imageReadCount += 1;
    return imageReadCount === 1 ? [] : [resultUrl];
  };
  client.json = async () => ({ mapping: {} });

  const imageUrls = await client.waitForConversationImages([{
    message: {
      author: { role: "assistant" },
      content: { parts: [marker] }
    }
  }], "conversation-with-skipped-mainline", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
  assert.equal(imageReadCount, 2);
});

test("chatplus image wait treats search tool output as an intermediate response", async () => {
  const searchAction = String.raw`search(\"\u5546\u54c1\u8d44\u6599\")`;
  const resultUrl = "https://one.example.test/generated-after-search.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-search-account", username: "search@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  let imageReadCount = 0;
  let detailReadCount = 0;
  client.imageUrlsFrom = async () => {
    imageReadCount += 1;
    return imageReadCount === 1 ? [] : [resultUrl];
  };
  client.imageGenerationTaskState = async () => null;
  client.json = async () => {
    detailReadCount += 1;
    return {
      mapping: {
        assistant: {
          message: {
            author: { role: "assistant" },
            content: { parts: [searchAction] }
          }
        }
      }
    };
  };

  const imageUrls = await client.waitForConversationImages([{
    message: {
      author: { role: "assistant" },
      content: { parts: [searchAction] }
    }
  }], "conversation-with-search-action", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
  assert.equal(detailReadCount, 1);
  assert.equal(imageReadCount, 2);
});

test("chatplus image wait checks conversation detail before treating quota metadata as failure", async () => {
  const resultUrl = "https://one.example.test/generated-after-quota-metadata.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-quota-metadata-account", username: "quota@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.imageUrlsFrom = async (value) => (
    value?.mapping ? [resultUrl] : []
  );
  client.conversationDetail = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["图片生成完成"] }
        }
      }
    }
  });

  const imageUrls = await client.waitForConversationImages([{
    metadata: { async_source: "image_gen" },
    author: { role: "assistant" },
    content: { parts: ["You've hit the image generation limit. You can create more images after 2026-09-02 21:55:57."] }
  }], "conversation-with-quota-metadata", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
});

test("chatplus image wait recognizes generated image URLs without file extensions", async () => {
  const resultUrl = "https://cdn.example.test/image_generation_content/generated-123";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-extensionless-image-account", username: "image@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  const imageUrls = await client.waitForConversationImages([{
    author: { role: "assistant" },
    content: { parts: [`生成结果：${resultUrl}`] }
  }], "conversation-with-extensionless-image", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
});

test("chatplus image wait keeps waiting for a non-final progress message", async () => {
  const progressMessage = "正在查询商品资料并准备图片。";
  const resultUrl = "https://one.example.test/generated-after-progress.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-progress-account", username: "progress@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  let imageReadCount = 0;
  client.imageUrlsFrom = async () => {
    imageReadCount += 1;
    return imageReadCount === 1 ? [] : [resultUrl];
  };
  client.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: false,
          content: { content_type: "text", parts: [progressMessage] }
        }
      }
    }
  });

  const imageUrls = await client.waitForConversationImages([{
    message: {
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: false,
      content: { content_type: "text", parts: [progressMessage] }
    }
  }], "conversation-with-progress-message", 30, { generatedOnly: true });

  assert.deepEqual(imageUrls, [resultUrl]);
  assert.equal(imageReadCount, 2);
});

test("chatplus image wait discovers a task when the initial response is empty", async () => {
  const resultUrl = "https://one.example.test/generated-from-empty-response.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-empty-image-account", username: "empty-image@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.imageUrlsFrom = async () => [];
  client.conversationDetail = async () => ({ async_status: null, mapping: {} });
  client.imageGenerationTaskState = async () => ({
    taskId: "upstream-task-empty-response",
    task: null,
    imageUrls: [resultUrl],
    failure: null
  });

  const imageUrls = await client.waitForConversationImages(
    [],
    "conversation-empty-image-response",
    30,
    { generatedOnly: true }
  );

  assert.deepEqual(imageUrls, [resultUrl]);
});

test("chatplus image task refresh checks task list when async status is empty", async () => {
  const conversationId = "conversation-empty-async-status";
  const upstreamTaskId = "upstream-task-empty-async-status";
  const resultUrl = "https://one.example.test/generated-from-empty-async-status.png";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-empty-async-status-account", username: "empty-async-status@example.test", password: "password" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.ensureConversationUpdates = async () => null;
  client.conversationDetail = async () => ({ async_status: null, mapping: {} });
  client.conversationStreamStatus = async () => ({ status: "IN_PROGRESS" });

  const requests = [];
  client.json = async (pathName) => {
    requests.push(pathName);
    assert.equal(pathName, "/backend-api/tasks");
    return {
      cursor: null,
      tasks: [{
        task_id: upstreamTaskId,
        conversation_id: conversationId,
        status: "completed",
        image_gen_message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: resultUrl }]
          }
        }
      }]
    };
  };

  const task = await client.getTask(conversationId, {
    imageTask: true,
    timeoutSec: 30
  });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
  assert.equal(task.raw.upstreamTaskId, upstreamTaskId);
  assert.deepEqual(requests, ["/backend-api/tasks"]);
});

test("chatplus task refresh keeps search tool output in progress", async () => {
  const searchAction = "search(\"商品资料\")";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-search-refresh-account", username: "search-refresh@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.loginPortal = async () => {};
  client.imageUrlsFrom = async () => [];
  client.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: [searchAction] }
        }
      }
    }
  });

  const task = await client.getTask("conversation-with-search-action");

  assert.equal(task.status, "waiting_upstream");
  assert.equal(task.errorMessage, "");
  assert.deepEqual(task.imageUrls, []);
});

test("chatplus task refresh prefers the final assistant reply over longer search thoughts", async () => {
  const finalMessage = "I wasn't able to generate the image due to an error on my side.";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-final-reply-account", username: "final-reply@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.loginPortal = async () => {};
  client.imageUrlsFrom = async () => [];
  client.json = async () => ({
    current_node: "final",
    mapping: {
      search: {
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: false,
          content: {
            content_type: "thoughts",
            parts: [`search("${"商品资料 ".repeat(30)}")`]
          }
        }
      },
      final: {
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          content: { content_type: "text", parts: [finalMessage] }
        }
      }
    }
  });

  const task = await client.getTask("conversation-with-final-reply");

  assert.equal(task.status, "failed");
  assert.equal(task.errorMessage, finalMessage);
});

test("submitted chat image task misclassified from search output can resume refreshing", async () => {
  const originalConfig = await loadConfig();
  const searchAction = "search(\"商品资料\")";
  const wrappedFailure = `上游生成失败：图片和生图要求已完整提交，但上游没有返回图片。上游回复：${searchAction}`;
  await saveConfig({
    ...originalConfig,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-search-recovery",
      channelId: "shareai",
      name: "搜索中间结果恢复账号",
      username: "search-recovery@example.com",
      password: "test",
      enabled: true,
      status: "ok"
    }]
  });
  await upsertTask({
    id: "task-search-intermediate-recovery",
    externalId: "conversation-search-intermediate-recovery",
    status: "failed",
    taskType: "img2img",
    prompt: "恢复搜索后的图片",
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号/聊天生图",
    channelType: "chatplus",
    accountId: "account-search-recovery",
    accountName: "搜索中间结果恢复账号",
    imageCount: 0,
    imageUrls: [],
    upstreamText: searchAction,
    errorMessage: wrappedFailure,
    responseJson: { status: "failed", message: wrappedFailure, upstreamText: searchAction },
    raw: {
      submitted: true,
      conversationId: "conversation-search-intermediate-recovery"
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const originalGetTask = ChatplusClient.prototype.getTask;
  let refreshReadCount = 0;
  ChatplusClient.prototype.getTask = async () => {
    refreshReadCount += 1;
    return {
      externalId: "conversation-search-intermediate-recovery",
      status: "waiting_upstream",
      imageCount: 0,
      imageUrls: [],
      errorMessage: "",
      raw: { conversationId: "conversation-search-intermediate-recovery" }
    };
  };

  try {
    const recovered = await refreshTask("task-search-intermediate-recovery");
    assert.equal(refreshReadCount, 1);
    assert.equal(recovered.status, "waiting_upstream");
  } finally {
    ChatplusClient.prototype.getTask = originalGetTask;
    await saveConfig(originalConfig);
  }
});

test("chatplus task refresh keeps skipped mainline marker in progress", async () => {
  const marker = "{\"skipped_mainline\":true}";
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://one.example.test" } },
    account: { id: "chat-marker-refresh-account", username: "marker-refresh@example.test", password: "password" },
    sessionLock: async (work) => work()
  });

  client.loginPortal = async () => {};
  client.json = async () => ({
    mapping: {
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: [marker] }
        }
      }
    }
  });

  const task = await client.getTask("conversation-with-skipped-mainline");

  assert.equal(task.status, "waiting_upstream");
  assert.equal(task.errorMessage, "");
  assert.deepEqual(task.imageUrls, []);
});
