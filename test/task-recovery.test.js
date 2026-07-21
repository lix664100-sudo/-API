import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-recovery-"));
process.env.DATA_DIR = dataDir;

const { getTask, listTasks, listTaskStats, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { createImageTask, refreshProcessingTasks, refreshTask } = await import("../src/channel-manager.js");
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

test("wait image task returns upstream policy refusal without wrapping it as timeout", async () => {
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
    }]
  });

  const message = "We’re so sorry, but the image we created may violate our guardrails concerning similarity to third-party content. If you think we got it wrong, please retry or edit your prompt.";
  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  ChatplusClient.prototype.createImageTask = async (input) => {
    await input.onSubmitted?.({
      externalId: "conversation-policy-wait",
      status: "processing",
      taskType: "img2img",
      prompt: input.prompt,
      imageCount: 0,
      imageUrls: [],
      raw: { conversationId: "conversation-policy-wait" }
    });
    const error = new Error(message);
    error.upstreamExplicitFailure = true;
    error.upstreamStatus = "failed";
    error.status = 400;
    error.code = "content_policy";
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
        assert.equal(error.task.responseJson.message, message);
        return true;
      }
    );
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
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
