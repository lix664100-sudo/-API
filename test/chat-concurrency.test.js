import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-concurrency-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, listTasks, loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion, getRuntimeStatus, queueChatCompletion } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

function chatAccount(id, priority = 1, chatConcurrency = 1) {
  return {
    id,
    channelId: "shareai",
    name: id,
    username: `${id}@example.test`,
    password: "test",
    enabled: true,
    priority,
    status: "ok",
    concurrency: { chat: chatConcurrency, drawingImage: 1, chatImage: 1 },
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

async function waitForTaskByPrompt(prompt, status = "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = (await listTasks()).find((item) => item.prompt === prompt);
    if (task && (!status || task.status === status)) return task;
    await delay(10);
  }
  return (await listTasks()).find((item) => item.prompt === prompt) || null;
}

test("异步对话并发已满时创建排队记录并在空闲后继续", async () => {
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
  let queuedTask = null;
  try {
    firstTask = await queueChatCompletion(chatInput("占用唯一并发"));
    await firstEntered;
    const beforeCount = (await listTasks()).length;

    queuedTask = await queueChatCompletion(chatInput("并发满时的新请求"));
    const storedQueuedTask = await getTask(queuedTask.id);
    const runtime = await getRuntimeStatus();

    assert.equal(queuedTask.status, "queued");
    assert.equal(storedQueuedTask.status, "queued");
    assert.equal(storedQueuedTask.raw.waitingForSlot, true);
    assert.equal(runtime.queued.chat, 1);
    assert.equal((await listTasks()).length, beforeCount + 1);
    assert.equal(submitCount, 1);

    releaseFirst();
    const [firstFinished, queuedFinished] = await Promise.all([
      waitForTerminalTask(firstTask.id),
      waitForTerminalTask(queuedTask.id)
    ]);
    assert.equal(firstFinished.status, "success");
    assert.equal(queuedFinished.status, "success");
    assert.equal(queuedFinished.raw.waitingForSlot, false);
    assert.ok(queuedFinished.raw.stageTimings.some((stage) => stage.key === "account_queue"));
    assert.equal(submitCount, 2);
  } finally {
    releaseFirst?.();
    if (firstTask?.id) await waitForTerminalTask(firstTask.id);
    if (queuedTask?.id) await waitForTerminalTask(queuedTask.id);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("同一账号的三条普通对话会真正同时处理", async () => {
  await saveChatAccounts([chatAccount("chat-parallel", 1, 3)]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseRequests;
  let reportAllEntered;
  let activeCount = 0;
  let maxActiveCount = 0;
  const concurrentSubmitFlags = [];
  const allEntered = new Promise((resolve) => {
    reportAllEntered = resolve;
  });
  const holdRequests = new Promise((resolve) => {
    releaseRequests = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    concurrentSubmitFlags.push(input.concurrentSubmit === true);
    if (activeCount === 3) reportAllEntered();
    try {
      await holdRequests;
      return {
        externalId: `conversation-parallel-${String(input.messages?.[0]?.content || "")}`,
        model: "gpt",
        content: "完成",
        imageUrls: [],
        raw: {}
      };
    } finally {
      activeCount -= 1;
    }
  };

  let requests = [];
  try {
    requests = [1, 2, 3].map((index) => createChatCompletion(chatInput(`并发对话-${index}`)));
    const enteredTogether = await Promise.race([
      allEntered.then(() => true),
      delay(500).then(() => false)
    ]);

    assert.equal(enteredTogether, true);
    assert.equal(maxActiveCount, 3);
    assert.deepEqual(concurrentSubmitFlags, [true, true, true]);
    releaseRequests();
    const responses = await Promise.all(requests);
    assert.equal(responses.length, 3);
  } finally {
    releaseRequests?.();
    await Promise.allSettled(requests);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("同步对话满载时也会留下排队记录并等待空闲名额", async () => {
  await saveChatAccounts([chatAccount("chat-sync-queue")]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseFirst;
  let reportFirstEntered;
  const firstEntered = new Promise((resolve) => { reportFirstEntered = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    const content = String(input.messages?.[0]?.content || "");
    if (content === "同步占用并发") {
      reportFirstEntered();
      await holdFirst;
    }
    return {
      externalId: `conversation-${content}`,
      model: "gpt",
      content: "完成",
      imageUrls: [],
      raw: {}
    };
  };

  let firstRequest = null;
  let queuedRequest = null;
  try {
    firstRequest = createChatCompletion(chatInput("同步占用并发"));
    await firstEntered;
    queuedRequest = createChatCompletion(chatInput("同步等待空闲"));
    const queuedTask = await waitForTaskByPrompt("同步等待空闲", "queued");

    assert.equal(queuedTask?.status, "queued");
    assert.equal(queuedTask?.raw?.waitingForSlot, true);

    releaseFirst();
    const responses = await Promise.all([firstRequest, queuedRequest]);
    const finishedQueuedTask = await getTask(queuedTask.id);
    assert.equal(responses.length, 2);
    assert.equal(finishedQueuedTask.status, "success");
    assert.ok(finishedQueuedTask.raw.stageTimings.some((stage) => stage.key === "account_queue"));
  } finally {
    releaseFirst?.();
    await Promise.allSettled([firstRequest, queuedRequest].filter(Boolean));
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("前一条对话失败后也会释放名额继续处理排队任务", async () => {
  await saveChatAccounts([chatAccount("chat-failure-release")]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseFailure;
  let reportFailureEntered;
  const failureEntered = new Promise((resolve) => { reportFailureEntered = resolve; });
  const holdFailure = new Promise((resolve) => { releaseFailure = resolve; });
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    const content = String(input.messages?.[0]?.content || "");
    if (content === "失败后释放") {
      reportFailureEntered();
      await holdFailure;
      const error = new Error("上游拒绝了第一条对话");
      error.status = 400;
      throw error;
    }
    return {
      externalId: "conversation-after-failure",
      model: "gpt",
      content: "排队任务完成",
      imageUrls: [],
      raw: {}
    };
  };

  let failedRequest = null;
  let failedTask = null;
  let queuedTask = null;
  try {
    failedRequest = createChatCompletion(chatInput("失败后释放")).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    await failureEntered;
    failedTask = await waitForTaskByPrompt("失败后释放", "processing");
    queuedTask = await queueChatCompletion(chatInput("失败后的排队任务"));
    assert.equal((await getTask(queuedTask.id)).status, "queued");

    releaseFailure();
    const [failedOutcome, succeeded] = await Promise.all([
      failedRequest,
      waitForTerminalTask(queuedTask.id)
    ]);
    assert.equal(failedOutcome.ok, false);
    assert.equal(failedOutcome.error.task.status, "failed");
    assert.equal(succeeded.status, "success");
  } finally {
    releaseFailure?.();
    await failedRequest?.catch(() => {});
    if (failedTask?.id) await waitForTerminalTask(failedTask.id);
    if (queuedTask?.id) await waitForTerminalTask(queuedTask.id);
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
