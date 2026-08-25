import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-concurrency-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, listTasks, loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion, queueChatCompletion } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

function chatAccount(id, priority = 1) {
  return {
    id,
    channelId: "shareai",
    name: id,
    username: `${id}@example.test`,
    password: "test",
    enabled: true,
    priority,
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

async function saveChatAccounts(accounts) {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    accounts
  });
}

function chatInput(content, extra = {}) {
  return {
    channel: "chatplus",
    model: "gpt",
    messages: [{ role: "user", content }],
    ...extra
  };
}

async function waitForTerminalTask(taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await getTask(taskId);
    if (["success", "failed", "interrupted"].includes(task?.status)) return task;
    await delay(10);
  }
  return getTask(taskId);
}

test("异步对话并发已满时立即拒绝且不创建任务记录", async () => {
  await saveChatAccounts([chatAccount("chat-full")]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseFirst;
  let reportFirstEntered;
  let submitCount = 0;
  const firstEntered = new Promise((resolve) => {
    reportFirstEntered = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async () => {
    submitCount += 1;
    reportFirstEntered();
    await holdFirst;
    return {
      externalId: `conversation-full-${submitCount}`,
      model: "gpt",
      content: "完成",
      imageUrls: [],
      raw: {}
    };
  };

  let firstTask = null;
  let unexpectedTask = null;
  try {
    firstTask = await queueChatCompletion(chatInput("占用唯一并发"));
    await firstEntered;
    const beforeCount = (await listTasks()).length;

    let rejection = null;
    try {
      unexpectedTask = await queueChatCompletion(chatInput("并发满时的新请求"));
    } catch (error) {
      rejection = error;
    }

    assert.equal(rejection?.status, 429);
    assert.equal(rejection?.code, "CONCURRENCY_LIMIT");
    assert.equal((await listTasks()).length, beforeCount);
    assert.equal(submitCount, 1);
  } finally {
    releaseFirst?.();
    if (firstTask?.id) await waitForTerminalTask(firstTask.id);
    if (unexpectedTask?.id) await waitForTerminalTask(unexpectedTask.id);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("对话切换备用账号前重新检查该账号的并发", async () => {
  await saveChatAccounts([
    chatAccount("chat-primary", 1),
    chatAccount("chat-busy-fallback", 2)
  ]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseBusyAccount;
  let reportBusyAccountEntered;
  let busyAccountCalls = 0;
  const busyAccountEntered = new Promise((resolve) => {
    reportBusyAccountEntered = resolve;
  });
  const holdBusyAccount = new Promise((resolve) => {
    releaseBusyAccount = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async function (input) {
    const content = String(input?.messages?.[0]?.content || "");
    if (this.account.id === "chat-busy-fallback") {
      busyAccountCalls += 1;
      if (content === "占用备用账号") {
        reportBusyAccountEntered();
        await holdBusyAccount;
      }
      return {
        externalId: `conversation-busy-${busyAccountCalls}`,
        model: "gpt",
        content: "备用账号完成",
        imageUrls: [],
        raw: {}
      };
    }

    const error = new Error("主账号登录失效");
    error.status = 401;
    throw error;
  };

  let busyRequest = null;
  let fallbackRequest = null;
  try {
    busyRequest = createChatCompletion(chatInput("占用备用账号", {
      account_id: "chat-busy-fallback",
      strict_account: true
    }));
    await busyAccountEntered;

    fallbackRequest = createChatCompletion(chatInput("主账号失败后尝试备用账号", {
      account_id: "chat-primary"
    })).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    const outcome = await Promise.race([
      fallbackRequest,
      delay(200, { timeout: true })
    ]);

    assert.equal(outcome.timeout, undefined, "备用账号已满时不应继续排队等待");
    assert.equal(outcome.ok, false);
    assert.equal(busyAccountCalls, 1, "不应把新请求打进已经满载的备用账号");
  } finally {
    releaseBusyAccount?.();
    await busyRequest?.catch(() => {});
    await fallbackRequest?.catch(() => {});
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});
