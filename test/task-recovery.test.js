import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-recovery-"));
process.env.DATA_DIR = dataDir;

const { getTask, listTasks, listTaskStats, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { createImageTask, queueImageTask, refreshProcessingTasks, refreshTask } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

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
      status: "quota_empty",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", balance: 0, message: "needs refresh" },
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

test("聊天生图没有上游编号时不能算已提交", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-no-upstream-id", username: "no-upstream-id@example.com" },
    sessionLock: async (work) => work()
  });
  let submittedCount = 0;
  client.prepareChatSession = async () => {
    client.portalLoggedIn = true;
    client.cookies = ["portal=ok", "car=car-no-upstream-id"];
    return {
      route: { key: "gpt", strategy: "image" },
      selected: { carId: "car-no-upstream-id", carType: "chatgpt", strategy: "image" },
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
      /上游任务编号/
    );
    assert.equal(submittedCount, 0);
  } finally {
    ChatplusClient.prototype.http = originalHttp;
  }
});

test("聊天生图并发提交会共用一次已准备好的账号会话", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://www.chatplus.cc" } },
    account: { id: "account-shared-session", username: "shared-session@example.com" },
    sessionLock: async (work) => work()
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

  client.fetchCars = async () => [{
    id: "car-shared-session",
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
      assert.equal(this.cookies.includes("car=car-shared-session"), true);
      assert.equal(this.cookies.some((cookie) => cookie.startsWith("upload=")), false);
      const fileName = options.body?.file_name || "source.png";
      this.cookies = [...this.cookies, `upload=${fileName}`];
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
      const uploadCookies = this.cookies.filter((cookie) => cookie.startsWith("upload="));
      assert.equal(uploadCookies.length, 1);
      conversationIndex += 1;
      return {
        status: 200,
        headers: {},
        body: `data: {"conversation_id":"conversation-${conversationIndex}"}\n\ndata: [DONE]\n\n`
      };
    });
  };

  let results = [];
  try {
    results = await Promise.all(["red", "blue", "black"].map((color) => client.createImageTask({
      prompt: `change background to ${color}`,
      files: [{
        filename: `${color}.png`,
        mimetype: "image/png",
        toBuffer: async () => Buffer.from("image")
      }],
      concurrentSubmit: true,
      waitForImages: false
    })));
  } finally {
    ChatplusClient.prototype.http = originalHttp;
  }

  assert.equal(enterCarCount, 1);
  assert.equal(initCount, 1);
  assert.equal(client.cookies.some((cookie) => cookie.startsWith("upload=")), false);
  assert.equal(maxSubmitSteps > 1, true);
  assert.deepEqual(results.map((result) => result.status), ["waiting_upstream", "waiting_upstream", "waiting_upstream"]);
  assert.equal(new Set(results.map((result) => result.externalId)).size, 3);
});

test("聊天生图等待上游任务会继续占用并发名额", async () => {
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

    await Promise.all(Array.from({ length: 5 }, (_item, index) => queueImageTask({
      input: { channel: "chatplus", prompt: `job-${index + 1}` },
      files: [{ filename: `source-${index + 1}.png`, mimetype: "image/png", buffer: Buffer.from("x") }]
    })));

    let tasks = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      tasks = await listTasks();
      if (ownWaitingTasks(tasks).length >= 5) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(submittedJobs.length, 5);
    assert.equal(ownWaitingTasks(tasks).length, 5);
    await assert.rejects(
      () => queueImageTask({
        input: { channel: "chatplus", prompt: "job-6" },
        files: [{ filename: "source-6.png", mimetype: "image/png", buffer: Buffer.from("x") }]
      }),
      (error) => error?.status === 429
    );

    const completed = tasks.find((task) => task.prompt === "job-1");
    await upsertTask({
      ...completed,
      status: "success",
      imageCount: 1,
      imageUrls: ["https://example.com/job-1.png"],
      completedAt: new Date().toISOString()
    });

    await queueImageTask({
      input: { channel: "chatplus", prompt: "job-6" },
      files: [{ filename: "source-6.png", mimetype: "image/png", buffer: Buffer.from("x") }]
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      tasks = await listTasks();
      if (tasks.some((task) => task.prompt === "job-6" && task.status === "waiting_upstream")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(submittedJobs.includes("job-6"), true);
    assert.equal(ownWaitingTasks(tasks).length, 5);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});
