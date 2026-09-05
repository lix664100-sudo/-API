import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-concurrency-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, listTasks, loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion, createTextTask, getRuntimeStatus, queueChatCompletion } = await import("../src/channel-manager.js");
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

test("异步对话并发已满时立即拒绝且不创建排队记录", async () => {
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
  try {
    firstTask = await queueChatCompletion(chatInput("占用唯一并发"));
    await firstEntered;
    const beforeCount = (await listTasks()).length;

    await assert.rejects(
      queueChatCompletion(chatInput("并发满时的新请求")),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
    assert.equal(submitCount, 1);
    assert.equal((await listTasks()).length, beforeCount);
    releaseFirst();
    assert.equal((await waitForTerminalTask(firstTask.id)).status, "success");
  } finally {
    releaseFirst?.();
    if (firstTask?.id) await waitForTerminalTask(firstTask.id);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("同一账号的三条普通对话只允许一条进入上游", async () => {
  await saveChatAccounts([chatAccount("chat-parallel", 1, 3)]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let releaseRequests;
  let activeCount = 0;
  let maxActiveCount = 0;
  let submitCount = 0;
  let reportFirstEntered;
  const firstEntered = new Promise((resolve) => { reportFirstEntered = resolve; });
  const concurrentSubmitFlags = [];
  const holdRequests = new Promise((resolve) => {
    releaseRequests = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async (input) => {
    submitCount += 1;
    reportFirstEntered();
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    concurrentSubmitFlags.push(input.concurrentSubmit === true);
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
    requests = [createChatCompletion(chatInput("并发对话-1"))];
    await firstEntered;
    requests.push(
      createChatCompletion(chatInput("并发对话-2")),
      createChatCompletion(chatInput("并发对话-3"))
    );
    const outcomesPromise = Promise.all(requests.map((request) => request.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )));
    assert.equal(submitCount, 1);
    releaseRequests();
    const outcomes = await outcomesPromise;
    assert.equal(outcomes.filter((item) => item.ok).length, 1);
    assert.equal(outcomes.filter((item) => !item.ok).length, 2);
    assert.ok(outcomes.filter((item) => !item.ok).every((item) => item.error.status === 429));
    assert.equal(maxActiveCount, 1);
    assert.deepEqual(concurrentSubmitFlags, [true]);
    assert.equal(submitCount, 1);
  } finally {
    releaseRequests?.();
    await Promise.allSettled(requests);
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("普通聊天和聊天生图会双向占用同一个名额", async () => {
  await saveChatAccounts([chatAccount("chat-shared-slot")]);

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  const originalCreateTextTask = ChatplusClient.prototype.createTextTask;
  let releaseChat;
  let releaseImage;
  let reportChatEntered;
  let reportImageEntered;
  let chatCalls = 0;
  let imageCalls = 0;
  const chatEntered = new Promise((resolve) => { reportChatEntered = resolve; });
  const imageEntered = new Promise((resolve) => { reportImageEntered = resolve; });
  const holdChat = new Promise((resolve) => { releaseChat = resolve; });
  const holdImage = new Promise((resolve) => { releaseImage = resolve; });

  ChatplusClient.prototype.createChatCompletion = async () => {
    chatCalls += 1;
    reportChatEntered();
    await holdChat;
    return { externalId: "conversation-shared", model: "gpt", content: "完成", imageUrls: [], raw: {} };
  };
  ChatplusClient.prototype.createTextTask = async (input) => {
    imageCalls += 1;
    reportImageEntered();
    await holdImage;
    return {
      externalId: "image-shared",
      status: "success",
      taskType: "text2img",
      prompt: input.prompt,
      modelId: "gpt",
      imageCount: 1,
      imageUrls: ["https://example.com/shared.png"],
      raw: {}
    };
  };

  let chatRequest = null;
  let imageRequest = null;
  try {
    chatRequest = createChatCompletion(chatInput("聊天占用"));
    await chatEntered;
    await assert.rejects(
      createTextTask({ channel: "chatplus", prompt: "聊天期间生图" }, true),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
    assert.equal(imageCalls, 0);
    releaseChat();
    await chatRequest;

    imageRequest = createTextTask({ channel: "chatplus", prompt: "生图占用" }, true);
    await imageEntered;
    await assert.rejects(
      createChatCompletion(chatInput("生图期间聊天")),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
    assert.equal(chatCalls, 1);
    releaseImage();
    assert.equal((await imageRequest).status, "success");
  } finally {
    releaseChat?.();
    releaseImage?.();
    await Promise.allSettled([chatRequest, imageRequest].filter(Boolean));
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
    ChatplusClient.prototype.createTextTask = originalCreateTextTask;
  }
});

test("同步对话满载时立即拒绝且不留下排队记录", async () => {
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
  try {
    firstRequest = createChatCompletion(chatInput("同步占用并发"));
    await firstEntered;
    await assert.rejects(
      createChatCompletion(chatInput("同步等待空闲")),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );

    releaseFirst();
    assert.equal((await firstRequest).task.status, "success");
  } finally {
    releaseFirst?.();
    await Promise.allSettled([firstRequest].filter(Boolean));
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("前一条对话失败后会释放名额继续处理新任务", async () => {
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
  let rejectedWhileBusy = null;
  try {
    failedRequest = createChatCompletion(chatInput("失败后释放")).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    await failureEntered;
    failedTask = await waitForTaskByPrompt("失败后释放", "processing");
    rejectedWhileBusy = createChatCompletion(chatInput("失败时的新任务")).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    const rejected = await rejectedWhileBusy;
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.status, 429);

    releaseFailure();
    const failedOutcome = await failedRequest;
    const configAfterFailure = await loadConfig();
    await saveConfig({
      ...configAfterFailure,
      accounts: configAfterFailure.accounts.map((account) => account.id === "chat-failure-release"
        ? { ...account, enabled: true, status: "ok", meta: { ...(account.meta || {}), abilities: { ...(account.meta?.abilities || {}), chatplus: { status: "ok" } } } }
        : account)
    });
    const succeeded = await createChatCompletion(chatInput("失败后释放的新任务"));
    assert.equal(failedOutcome.ok, false);
    assert.equal(failedOutcome.error.task.status, "failed");
    assert.equal(succeeded.task.status, "success");
  } finally {
    releaseFailure?.();
    await failedRequest?.catch(() => {});
    if (failedTask?.id) await waitForTerminalTask(failedTask.id);
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
