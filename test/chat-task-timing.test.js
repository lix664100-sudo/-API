import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-task-timing-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, loadConfig, saveConfig, taskListItem } = await import("../src/storage.js");
const { createChatCompletion, queueChatCompletion } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

function chatAccount() {
  return {
    id: "account-chat-task-timing",
    channelId: "shareai",
    name: "对话耗时测试账号",
    username: "chat-task-timing@example.test",
    password: "test",
    enabled: true,
    status: "ok",
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    meta: {
      abilities: {
        drawing: { status: "quota_empty", message: "绘图额度不足" },
        chatplus: { status: "ok", message: "对话账号可用" }
      }
    }
  };
}

async function prepareAccount() {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    accounts: [chatAccount()]
  });
}

function chatInput(content) {
  return {
    channel: "chatplus",
    model: "gpt",
    messages: [{ role: "user", content }]
  };
}

function timing(id, status = "success") {
  return {
    id,
    key: "upstream_generation",
    label: "等待上游处理",
    status,
    startedAt: "2026-08-25T00:00:00.000Z",
    finishedAt: "2026-08-25T00:00:01.500Z",
    durationMs: 1500,
    carId: "timed-chat-car",
    carType: "chatgpt"
  };
}

function upstreamTimings(task) {
  return (task?.raw?.stageTimings || []).filter((stage) => stage.key === "upstream_generation");
}

async function waitForTerminalTask(taskId) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const task = await getTask(taskId);
    if (["success", "failed", "interrupted"].includes(task?.status)) return task;
    await delay(10);
  }
  return getTask(taskId);
}

test("同步和异步对话成功后都会保存耗时明细", async () => {
  await prepareAccount();
  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    const content = String(input?.messages?.[0]?.content || "");
    const id = content.includes("异步") ? "async-chat-stage" : "sync-chat-stage";
    return {
      externalId: `conversation-${id}`,
      model: "gpt",
      content: "完成",
      imageUrls: [],
      raw: { stageTimings: [timing(id)] }
    };
  };

  try {
    const syncResponse = await createChatCompletion(chatInput("同步对话"));
    assert.deepEqual(upstreamTimings(syncResponse.task), [timing("sync-chat-stage")]);

    const queued = await queueChatCompletion(chatInput("异步对话"));
    const asyncTask = await waitForTerminalTask(queued.id);
    assert.equal(asyncTask.status, "success");
    assert.deepEqual(upstreamTimings(asyncTask), [timing("async-chat-stage")]);
    await delay(20);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("普通对话失败后也会保存失败前的耗时明细", async () => {
  await prepareAccount();
  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  ChatplusClient.prototype.createChatCompletion = async () => {
    const error = new Error("上游拒绝了这次对话");
    error.status = 400;
    error.stageTimings = [timing("failed-chat-stage", "failed")];
    throw error;
  };

  try {
    await assert.rejects(
      createChatCompletion(chatInput("失败对话")),
      (error) => {
        assert.equal(error.task?.status, "failed");
        assert.deepEqual(upstreamTimings(error.task), [timing("failed-chat-stage", "failed")]);
        return true;
      }
    );
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("普通对话发往上游后会立即更新提交渠道和当前阶段", async () => {
  await prepareAccount();
  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseUpstream;
  let reportUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    reportUpstreamStarted = resolve;
  });
  const holdUpstream = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    const activeStage = {
      id: "live-chat-stage",
      key: "upstream_generation",
      label: "等待上游处理",
      status: "processing",
      startedAt: new Date().toISOString(),
      carId: "live-chat-car",
      carType: "chatgpt"
    };
    await input.onStageStart(activeStage);
    reportUpstreamStarted();
    await holdUpstream;
    await input.onStage({
      ...activeStage,
      status: "success",
      finishedAt: new Date().toISOString(),
      durationMs: 20
    });
    return {
      externalId: "conversation-live-stage",
      model: "gpt",
      content: "完成",
      imageUrls: [],
      raw: {}
    };
  };

  let queued = null;
  try {
    queued = await queueChatCompletion(chatInput("实时状态对话"));
    await upstreamStarted;
    const activeTask = await getTask(queued.id);

    assert.equal(activeTask.status, "processing");
    assert.equal(activeTask.raw.submitted, true);
    assert.equal(activeTask.raw.activeStage.label, "等待上游处理");
    assert.equal(activeTask.raw.selectedCarId, "live-chat-car");
    assert.equal(activeTask.submissionChannels.length, 1);
    assert.equal(taskListItem(activeTask).raw.activeStage.label, "等待上游处理");

    releaseUpstream();
    const finishedTask = await waitForTerminalTask(queued.id);
    assert.equal(finishedTask.status, "success");
    assert.equal(finishedTask.raw.activeStage, undefined);
    assert.ok(finishedTask.raw.stageTimings.some((stage) => stage.id === "live-chat-stage"));
  } finally {
    releaseUpstream?.();
    if (queued?.id) await waitForTerminalTask(queued.id);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});
