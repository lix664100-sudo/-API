import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-account-recovery-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion, createImageTask, createTextTask, getRuntimeStatus } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient, normalizeDrawingTask } = await import("../src/channels/drawing.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("账号检测遇到失效车位后会自动换车", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-check", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let selectedCount = 0;
  let enteredCount = 0;
  client.selectCar = async () => ({
    carId: `car-${++selectedCount}`,
    carType: "chatgpt",
    strategy: "image"
  });
  client.enterCar = async () => {
    enteredCount += 1;
    if (enteredCount < 3) {
      throw new Error("用户没有有效的chatgpt订阅");
    }
  };
  client.resetSession = async () => {};
  client.loadInit = async () => ({
    default_model_slug: "auto",
    limits_progress: [{ feature_name: "image_gen", remaining: 19 }]
  });

  const result = await client.check();

  assert.equal(result.status, "ok");
  assert.equal(result.meta.selectedCarId, "car-3");
  assert.equal(enteredCount, 3);
});

test("任务到来时会自动恢复掉线账号", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-offline",
      channelId: "shareai",
      name: "掉线测试账号",
      username: "test@example.com",
      password: "test",
      enabled: true,
      status: "disconnected",
      message: "自动找车失败",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图积分不足" },
          chatplus: { status: "disconnected", message: "自动找车失败" }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 19,
      balance: 19,
      message: "聊天账号可用"
    };
  };
  ChatplusClient.prototype.createChatCompletion = async () => ({
    externalId: "conversation-recovered",
    model: "gpt",
    content: "恢复成功",
    imageUrls: [],
    raw: {}
  });

  try {
    const response = await createChatCompletion({
      messages: [{ role: "user", content: "测试自动恢复" }]
    });
    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-offline");

    assert.equal(checkCount, 1);
    assert.equal(response.choices[0].message.content, "恢复成功");
    assert.equal(response.task.status, "success");
    assert.equal(account.meta.abilities.chatplus.status, "ok");
  } finally {
    ChatplusClient.prototype.check = originalCheck;
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("同一聊天账号的对话和生图不会同时登录", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    accounts: [{
      id: "account-exclusive",
      channelId: "shareai",
      name: "独享测试账号",
      username: "exclusive@example.com",
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

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  let activeLogins = 0;
  let maxActiveLogins = 0;
  const trackLogin = async () => {
    activeLogins += 1;
    maxActiveLogins = Math.max(maxActiveLogins, activeLogins);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      activeLogins -= 1;
    }
  };

  ChatplusClient.prototype.createChatCompletion = async () => {
    await trackLogin();
    return {
      externalId: "conversation-exclusive",
      model: "gpt",
      content: "对话完成",
      imageUrls: [],
      raw: {}
    };
  };
  ChatplusClient.prototype.createImageTask = async (input) => {
    await trackLogin();
    return {
      externalId: "image-exclusive",
      status: "success",
      taskType: "img2img",
      prompt: input.prompt,
      modelId: "gpt",
      ratio: "1:1",
      imageCount: 1,
      imageUrls: [],
      raw: {}
    };
  };

  try {
    await Promise.all([
      createChatCompletion({
        channel: "chatplus",
        messages: [{ role: "user", content: "测试对话" }]
      }),
      createImageTask({
        input: { channel: "chatplus", prompt: "测试改图" },
        files: [{ filename: "test.png", mimetype: "image/png" }],
        wait: true
      })
    ]);

    assert.equal(maxActiveLogins, 1);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("每条绘图任务提交前检查额度，提交后更新页面额度", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-drawing-quota",
      channelId: "shareai",
      name: "绘图额度测试账号",
      username: "drawing@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 9, message: "旧额度" },
          chatplus: { status: "quota_empty", balance: 0, message: "聊天图片额度不足" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalCreateTextTask = DrawingClient.prototype.createTextTask;
  let checkCount = 0;
  let submitCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return checkCount === 1
      ? { status: "ok", quota: 50, balance: 2, message: "绘图账号可用" }
      : { status: "quota_empty", quota: 50, balance: 0, message: "绘图积分不足" };
  };
  DrawingClient.prototype.createTextTask = async (input) => {
    submitCount += 1;
    return {
      externalId: "drawing-quota-task",
      status: "processing",
      taskType: "text2img",
      prompt: input.prompt,
      imageCount: 0,
      imageUrls: [],
      raw: {}
    };
  };

  try {
    const task = await createTextTask({ channel: "drawing", prompt: "测试额度刷新" });
    let drawingStatus = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stored = await loadConfig();
      drawingStatus = stored.accounts[0]?.meta?.abilities?.drawing;
      if (drawingStatus?.balance === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(task.externalId, "drawing-quota-task");
    assert.equal(submitCount, 1);
    assert.equal(checkCount, 2);
    assert.equal(drawingStatus.status, "quota_empty");
    assert.equal(drawingStatus.balance, 0);
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createTextTask = originalCreateTextTask;
  }
});

test("绘图额度为零时不会提交任务", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-drawing-empty",
      channelId: "shareai",
      name: "绘图零额度测试账号",
      username: "drawing-empty@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 2, message: "旧额度" },
          chatplus: { status: "quota_empty", balance: 0, message: "聊天图片额度不足" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalCreateTextTask = DrawingClient.prototype.createTextTask;
  let submitCount = 0;
  DrawingClient.prototype.check = async () => ({
    status: "quota_empty",
    quota: 50,
    balance: 0,
    message: "绘图积分不足"
  });
  DrawingClient.prototype.createTextTask = async () => {
    submitCount += 1;
    throw new Error("不应提交");
  };

  try {
    await assert.rejects(
      createTextTask({ channel: "drawing", prompt: "零额度不能提交" }),
      /绘图积分不足/
    );
    assert.equal(submitCount, 0);
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createTextTask = originalCreateTextTask;
  }
});

test("绘图站中转 500 显示准确提示", () => {
  const task = normalizeDrawingTask({
    id: 34874,
    status: "failed",
    items: [{ error_message: "中转接口请求失败，状态码：500" }]
  });

  assert.equal(task.errorMessage, "绘图站上游服务异常（500），不是额度不足，请稍后重试。");
});

test("同一账号绘图上游连续失败三次后冷却十分钟", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    accounts: [{
      id: "account-drawing-cooldown",
      channelId: "shareai",
      name: "绘图冷却测试账号",
      username: "drawing-cooldown@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", quota: 50, balance: 10, message: "绘图账号可用" },
          chatplus: { status: "ok", balance: 20, message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalCreateTextTask = DrawingClient.prototype.createTextTask;
  let submitCount = 0;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 50,
    balance: 10,
    message: "绘图账号可用"
  });
  DrawingClient.prototype.createTextTask = async (input) => {
    submitCount += 1;
    if ([1, 2, 4, 5, 6].includes(submitCount)) {
      return normalizeDrawingTask({
        id: 35000 + submitCount,
        status: "failed",
        task_type: "text2img",
        prompt: input.prompt,
        items: [{ error_message: "中转接口请求失败，状态码：500" }]
      });
    }
    return normalizeDrawingTask({
      id: 35004,
      status: "success",
      task_type: "text2img",
      prompt: input.prompt,
      items: [{ image_url: "https://example.com/result.png" }]
    });
  };

  try {
    for (let index = 1; index <= 2; index += 1) {
      const task = await createTextTask({ channel: "drawing", prompt: `中途成功前失败 ${index}` }, true);
      assert.equal(task.status, "failed");
    }
    const resetTask = await createTextTask({ channel: "drawing", prompt: "成功后重新计数" }, true);
    assert.equal(resetTask.status, "success");
    let stored = await loadConfig();
    assert.equal(stored.accounts[0].meta.abilities.drawing.upstreamFailureStreak, 0);

    for (let index = 1; index <= 3; index += 1) {
      const task = await createTextTask({ channel: "drawing", prompt: `连续失败 ${index}` }, true);
      assert.equal(task.status, "failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    stored = await loadConfig();
    let account = stored.accounts[0];
    let drawing = account.meta.abilities.drawing;
    const runtime = await getRuntimeStatus();

    assert.equal(drawing.status, "cooldown");
    assert.equal(drawing.upstreamFailureStreak, 3);
    assert.ok(Date.parse(drawing.cooldownUntil) - Date.now() > 9 * 60 * 1000);
    assert.equal(account.meta.abilities.chatplus.status, "ok");
    assert.equal(runtime.available.drawingImage, 0);
    assert.equal(runtime.available.chatImage, 2);
    await assert.rejects(
      createTextTask({ channel: "drawing", prompt: "冷却期间不能再调用" }, true),
      (error) => error?.status === 503
    );

    drawing = {
      ...drawing,
      cooldownUntil: new Date(Date.now() - 1000).toISOString()
    };
    await saveConfig({
      ...stored,
      accounts: [{
        ...account,
        meta: {
          ...account.meta,
          abilities: {
            ...account.meta.abilities,
            drawing
          }
        }
      }]
    });

    const recoveredTask = await createTextTask({ channel: "drawing", prompt: "冷却结束自动恢复" }, true);
    stored = await loadConfig();
    account = stored.accounts[0];
    drawing = account.meta.abilities.drawing;

    assert.equal(recoveredTask.status, "success");
    assert.equal(submitCount, 7);
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.upstreamFailureStreak, 0);
    assert.equal(drawing.cooldownUntil, null);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createTextTask = originalCreateTextTask;
  }
});
