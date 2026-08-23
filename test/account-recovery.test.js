import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-account-recovery-"));
process.env.DATA_DIR = dataDir;
const activeSubscriptionExpireAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const { closeStorage, loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { checkAccount, clearAccountCooldown, createChatCompletion, createImageTask, createTextTask, getRuntimeStatus, recoverUnavailableChatAccounts } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient, drawingSevereFailureReason, normalizeDrawingTask } = await import("../src/channels/drawing.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("停用账号单独检测不会登录", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-disabled-check",
      channelId: "shareai",
      name: "停用检测账号",
      username: "disabled-check@example.com",
      password: "test",
      enabled: false,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", message: "绘图账号可用" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("不应该检测停用账号");
  };
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("不应该检测停用账号");
  };

  try {
    const result = await checkAccount("account-disabled-check");

    assert.equal(checkCount, 0);
    assert.equal(result.checkSkipped, true);
    assert.equal(result.disabled, true);
    assert.match(result.message, /账号已停用/);
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("未激活账号检测时保持未激活且不会登录", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-activation-required",
      channelId: "shareai",
      name: "未激活账号",
      username: "activation-required@example.com",
      password: "test",
      enabled: true,
      status: "activation_required",
      message: "账号已注册但尚未激活。",
      meta: {
        abilities: {
          drawing: { status: "activation_required", message: "未激活" },
          chatplus: { status: "activation_required", message: "未激活" }
        }
      }
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => { checkCount += 1; };
  DrawingClient.prototype.check = async () => { checkCount += 1; };

  try {
    const result = await checkAccount("account-activation-required");
    assert.equal(checkCount, 0);
    assert.equal(result.status, "activation_required");
    assert.equal(result.activationRequired, true);
    assert.equal(result.checkSkipped, true);
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("停用账号不会被后台自动恢复登录", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-disabled-recovery",
      channelId: "shareai",
      name: "停用恢复账号",
      username: "disabled-recovery@example.com",
      password: "test",
      enabled: false,
      status: "disconnected",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图额度不足" },
          chatplus: { status: "disconnected", message: "聊天掉线" }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("不应该恢复停用账号");
  };

  try {
    const results = await recoverUnavailableChatAccounts();

    assert.equal(checkCount, 0);
    assert.equal(results.length, 0);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("绘图账号检测不再请求已下线的统计地址", async () => {
  const client = new DrawingClient({
    config: {
      mainBaseUrl: "https://main.example.test",
      drawingBaseUrl: "https://drawing.example.test"
    },
    channel: {
      id: "shareai:drawing",
      settings: { baseUrl: "https://drawing.example.test" }
    },
    account: {
      id: "drawing-profile-only",
      username: "drawing-profile-only@example.test",
      password: "test"
    }
  });
  const requestedPaths = [];
  client.ensureLogin = async () => {};
  client.request = async (pathName) => {
    requestedPaths.push(pathName);
    if (pathName === "/api/v1/profile") {
      return {
        quota_points: 100,
        balance: 44,
        external_sub_expire_at: "2026-08-16T05:22:00+08:00"
      };
    }
    throw new Error(`不应再请求旧地址：${pathName}`);
  };

  const result = await client.check();

  assert.deepEqual(requestedPaths, ["/api/v1/profile"]);
  assert.equal(result.status, "ok");
  assert.equal(result.quota, 100);
  assert.equal(result.balance, 44);
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
  client.loadAccountUsages = async () => ({
    gpt: {
      quota: 220,
      used: 31,
      balance: 189,
      quotaResetAt: "2026-07-22T19:32:29+08:00",
      expireAt: activeSubscriptionExpireAt,
      period: "12h"
    }
  });

  const result = await client.check();

  assert.equal(result.status, "ok");
  assert.equal(result.quota, null);
  assert.equal(result.balance, null);
  assert.equal(result.used, null);
  assert.equal(result.quotaResetAt, "");
  assert.equal(result.quotaConfirmedByUpstream, false);
  assert.deepEqual(result.meta.referenceUsage.gpt, {
    quota: 220,
    used: 31,
    balance: 189,
    quotaResetAt: "2026-07-22T19:32:29+08:00",
    expireAt: activeSubscriptionExpireAt,
    period: "12h"
  });
  assert.equal(result.meta.selectedCarId, "car-3");
  assert.equal(enteredCount, 3);
});

test("共享车位全部认证失败时不会冒充账号掉线", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-car-pool", username: "car-pool@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let selectedCount = 0;
  client.selectCar = async () => ({
    carId: `expired-car-${++selectedCount}`,
    carType: "chatgpt",
    strategy: "image"
  });
  client.enterCar = async () => {
    const error = new Error("用户认证失败，请重新登录");
    error.status = 403;
    throw error;
  };

  await assert.rejects(
    client.prepareChatSession({ model: "gpt" }, new Set(), 2),
    (error) => {
      assert.equal(error.code, "CHAT_CAR_POOL_UNAVAILABLE");
      assert.equal(error.carPoolUnavailable, true);
      assert.equal(error.authScope, "car");
      return true;
    }
  );
  assert.equal(selectedCount, 2);
});

test("上传原图时共享车位认证失败也不会冒充账号掉线", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-upload-car-pool", username: "upload-car-pool@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let attemptCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    const carId = `upload-expired-car-${++attemptCount}`;
    ignoredCarIds.add(carId);
    return {
      route: { key: "gpt", model: "gpt-test" },
      init: { default_model_slug: "gpt-test" },
      selected: { carId, carType: "chatgpt" },
      revision: client.sessionRevision
    };
  };
  client.uploadChatImages = async () => {
    const error = new Error("认证失败，请重新登陆");
    error.status = 401;
    throw error;
  };
  client.rememberProCarsUnavailable = async () => {};
  client.rememberAuthFailedCar = () => {};
  client.invalidatePreparedChatSession = async () => {};

  await assert.rejects(
    client.sendConversation("测试上传原图", {
      imageGeneration: true,
      files: [{ filename: "source.png" }]
    }),
    (error) => {
      assert.equal(error.code, "CHAT_CAR_POOL_UNAVAILABLE");
      assert.equal(error.carPoolUnavailable, true);
      assert.equal(error.authScope, "car");
      return true;
    }
  );
  assert.ok(attemptCount > 1);
});

test("自动换完车仍失败时会保留共享车位故障身份", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-car-switch", username: "car-switch@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let attemptCount = 0;
  client.prepareChatSession = async () => {
    attemptCount += 1;
    const error = new Error("GPT 自动找车失败：用户认证失败，请重新登录");
    error.code = "CHAT_CAR_POOL_UNAVAILABLE";
    error.carPoolUnavailable = true;
    error.authScope = "car";
    throw error;
  };

  await assert.rejects(
    client.sendConversation("测试自动换车"),
    (error) => {
      assert.equal(error.code, "CHAT_CAR_POOL_UNAVAILABLE");
      assert.equal(error.carPoolUnavailable, true);
      assert.equal(error.authScope, "car");
      return true;
    }
  );
  assert.ok(attemptCount > 1);
});

test("检测账号时共享车位不可用只标记线路异常", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-car-pool-check",
      channelId: "shareai",
      name: "共享车位检测账号",
      username: "car-pool-check@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", message: "绘图账号可用" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 100,
    balance: 80,
    message: "绘图账号可用"
  });
  ChatplusClient.prototype.check = async () => {
    const error = new Error("GPT 自动找车失败：车位一：用户认证失败，请重新登录");
    error.code = "CHAT_CAR_POOL_UNAVAILABLE";
    error.carPoolUnavailable = true;
    error.authScope = "car";
    throw error;
  };

  try {
    await assert.rejects(
      checkAccount("account-car-pool-check"),
      /上游共享车位暂时不可用/
    );

    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-car-pool-check");
    assert.equal(account.status, "error");
    assert.equal(account.meta.abilities.chatplus.status, "error");
    assert.doesNotMatch(account.message, /掉线/);
    assert.match(account.meta.abilities.chatplus.message, /上游共享车位暂时不可用/);
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("手动检测确认 PRO 可用后会彻底清除旧限制", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-pro-recovered",
      channelId: "shareai",
      name: "PRO 恢复账号",
      username: "pro-recovered@example.com",
      password: "test",
      enabled: true,
      status: "error",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", quota: 100, balance: 0, message: "绘图积分不足" },
          chatplus: {
            status: "error",
            message: "PRO 暂不可用",
            meta: {
              proCarsUnavailable: true,
              proCarsUnavailableReason: "plan_mismatch",
              proCarsUnavailableUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
          }
        }
      }
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => ({
    status: "quota_empty",
    quota: 100,
    balance: 0,
    message: "绘图积分不足"
  });
  ChatplusClient.prototype.check = async () => ({
    status: "ok",
    expireAt: activeSubscriptionExpireAt,
    message: "聊天账号可用",
    meta: {
      chatModel: "gpt",
      proCarRestriction: { active: false, until: "" },
      referenceUsage: {
        gpt: { quota: 220, balance: 195, expireAt: activeSubscriptionExpireAt }
      }
    }
  });

  try {
    const result = await checkAccount("account-pro-recovered");
    const stored = await loadConfig();
    const chatMeta = stored.accounts.find((item) => item.id === "account-pro-recovered")
      .meta.abilities.chatplus.meta;

    assert.equal(result.status, "ok");
    assert.equal(chatMeta.proCarsUnavailable, undefined);
    assert.equal(chatMeta.proCarsUnavailableReason, undefined);
    assert.equal(chatMeta.proCarsUnavailableUntil, undefined);
    assert.equal(chatMeta.proCarRestriction, undefined);
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("检测账号时门户认证失败仍然标记为掉线", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-portal-login-check",
      channelId: "shareai",
      name: "门户登录检测账号",
      username: "portal-login-check@example.com",
      password: "test",
      enabled: true,
      status: "ok"
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => ({ status: "ok", message: "绘图账号可用" });
  ChatplusClient.prototype.check = async () => {
    const error = new Error("身份验证失败，请重新登录");
    error.status = 401;
    throw error;
  };

  try {
    await assert.rejects(checkAccount("account-portal-login-check"), /身份验证失败/);

    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-portal-login-check");
    assert.equal(account.status, "disconnected");
    assert.equal(account.meta.abilities.chatplus.status, "disconnected");
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("改图任务遇到共享车位故障时返回正式提示并保留账号在线", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-car-pool-task",
      channelId: "shareai",
      name: "共享车位任务账号",
      username: "car-pool-task@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", balance: 0, message: "绘图积分不足" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateImageTask = ChatplusClient.prototype.createImageTask;
  ChatplusClient.prototype.createImageTask = async () => {
    const error = new Error("自动换车失败：GPT 自动找车失败：用户认证失败，请重新登录");
    error.code = "CHAT_CAR_POOL_UNAVAILABLE";
    error.carPoolUnavailable = true;
    error.authScope = "car";
    throw error;
  };

  try {
    await assert.rejects(
      createImageTask({
        input: { channel: "chatplus", prompt: "共享车位故障测试" },
        files: [{ filename: "source.png", mimetype: "image/png" }],
        wait: true
      }),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, "CHAT_CAR_POOL_UNAVAILABLE");
        assert.equal(error.message, "上游共享车位暂时不可用，任务未能提交。请稍后重试。");
        assert.equal(error.task.responseJson.failureType, undefined);
        assert.equal(error.task.attempts[0].carPoolUnavailable, true);
        return true;
      }
    );

    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-car-pool-task");
    assert.equal(account.status, "error");
    assert.equal(account.meta.abilities.chatplus.status, "error");
    assert.match(account.meta.abilities.chatplus.message, /上游共享车位暂时不可用/);
  } finally {
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("GPT 套餐时间已过期时不再沿用旧的可用状态", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-expired-plan", username: "expired-plan@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let sessionCount = 0;
  client.loadAccountUsages = async () => ({
    gpt: {
      quota: 220,
      used: 0,
      balance: 220,
      quotaResetAt: "",
      expireAt: new Date(Date.now() - 60_000).toISOString(),
      period: "12h"
    }
  });
  client.prepareChatSession = async () => {
    sessionCount += 1;
    return {
      init: {},
      route: { key: "gpt" },
      selected: { carId: "expired-car", strategy: "balanced" }
    };
  };

  await assert.rejects(
    client.check(),
    (error) => error.code === "CHAT_SUBSCRIPTION_EXPIRED"
  );
  assert.equal(sessionCount, 0);
});

test("无有效 GPT 订阅时即使绘图可用也标记套餐已过期", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-no-subscription",
      channelId: "shareai",
      name: "套餐过期测试账号",
      username: "no-subscription@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", message: "绘图账号可用" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalChatCheck = ChatplusClient.prototype.check;
  const originalDrawingCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 100,
    balance: 80,
    message: "绘图账号可用"
  });
  ChatplusClient.prototype.check = async () => {
    const error = new Error("GPT 自动找车失败：车位一：用户没有有效的chatgpt订阅；车位二：用户没有有效的chatgpt订阅");
    error.code = "CHAT_SUBSCRIPTION_EXPIRED";
    error.subscriptionExpired = true;
    throw error;
  };

  try {
    await assert.rejects(
      checkAccount("account-no-subscription"),
      /GPT 套餐已过期/
    );

    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-no-subscription");
    assert.equal(account.status, "subscription_expired");
    assert.equal(account.meta.abilities.drawing.status, "ok");
    assert.equal(account.meta.abilities.chatplus.status, "subscription_expired");
    assert.equal(account.meta.abilities.chatplus.expireAt, "");
  } finally {
    ChatplusClient.prototype.check = originalChatCheck;
    DrawingClient.prototype.check = originalDrawingCheck;
  }
});

test("账号检测步骤超时后会自动重试并使用二十秒等待时间", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gemini" } },
    account: { id: "account-check-retry", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let usageAttempts = 0;
  client.loadAccountUsages = async (options) => {
    usageAttempts += 1;
    assert.equal(options.timeoutSec, 20);
    if (usageAttempts === 1) {
      const error = new Error("聊天站响应慢，代理可能可用但请求超时。");
      error.status = 504;
      throw error;
    }
    return {
      gemini: {
        quota: 70,
        used: 1,
        balance: 69,
        quotaResetAt: "",
        expireAt: activeSubscriptionExpireAt,
        period: "24h"
      }
    };
  };
  client.prepareChatSession = async (input) => {
    assert.equal(input.checkTimeoutSec, 20);
    return {
      route: { key: "gemini", model: "gemini" },
      init: {},
      selected: { carId: "gemini-car", carType: "gemini", strategy: "balanced" }
    };
  };

  const result = await client.check();

  assert.equal(usageAttempts, 2);
  assert.equal(result.status, "ok");
  assert.equal(result.meta.selectedCarId, "gemini-car");
});

test("账号检测连续两次请求超时会记录具体失败步骤", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gemini" } },
    account: { id: "account-check-step", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let usageAttempts = 0;
  client.loadAccountUsages = async () => {
    usageAttempts += 1;
    const error = new Error("聊天站响应慢，代理可能可用但请求超时。");
    error.status = 504;
    throw error;
  };

  await assert.rejects(
    client.check(),
    (error) => {
      assert.equal(error.code, "ACCOUNT_CHECK_TIMEOUT");
      assert.equal(error.accountCheckTimeout, true);
      assert.equal(error.accountCheckStep, "读取账号额度");
      assert.match(error.message, /读取账号额度超时/);
      return true;
    }
  );
  assert.equal(usageAttempts, 2);
});

test("读取旧任务遇到登录失效会重新登录并回到原车位", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://one.aishare.icu" } },
    account: { id: "account-task-session", username: "task-session@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.portalLoggedIn = true;
  client.cookies = ["expired=session"];
  client.carId = "stale-car";

  let resetCount = 0;
  let loginCount = 0;
  let enterCarCount = 0;
  let detailReadCount = 0;
  const resetSession = client.resetSession.bind(client);
  client.resetSession = () => {
    resetCount += 1;
    resetSession();
  };
  client.performPortalLogin = async () => {
    loginCount += 1;
    client.portalLoggedIn = true;
    client.cookies = ["portal=fresh"];
  };
  client.performEnterCar = async (carId, carType) => {
    enterCarCount += 1;
    client.carId = carId;
    client.carType = carType;
    client.cookies.push(`car=${carId}`);
  };
  client.createSubmitClient = () => client;
  client.json = async (pathName) => {
    assert.equal(pathName, "/backend-api/conversation/conversation-session-recovery");
    detailReadCount += 1;
    if (detailReadCount === 1) {
      const error = new Error("身份验证失败，请重新登录");
      error.status = 401;
      throw error;
    }
    return { mapping: {} };
  };
  client.imageUrlsFrom = async () => [];

  const result = await client.getTask("conversation-session-recovery", {
    carId: "original-car",
    carType: "chatgpt"
  });

  assert.equal(result.status, "waiting_upstream");
  assert.equal(resetCount, 1);
  assert.equal(loginCount, 1);
  assert.equal(enterCarCount, 2);
  assert.equal(detailReadCount, 2);
  assert.equal(client.carId, "original-car");
  assert.equal(client.cookies.includes("expired=session"), false);
  assert.equal(client.cookies.includes("portal=fresh"), true);
});

test("读取旧任务即使没有报错也会在第一次查询前回到原车位", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://one.aishare.icu" } },
    account: { id: "account-task-original-car", username: "task-original-car@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.portalLoggedIn = true;
  client.carId = "stale-car";
  const events = [];
  client.performEnterCar = async (carId) => {
    events.push(`enter:${carId}`);
  };
  client.createSubmitClient = () => client;
  client.conversationDetail = async () => {
    events.push(`read:${client.carId}`);
    return { mapping: {} };
  };
  client.imageUrlsFrom = async () => [];

  const result = await client.getTask("conversation-valid-empty", {
    carId: "original-car",
    carType: "chatgpt"
  });

  assert.equal(result.status, "waiting_upstream");
  assert.deepEqual(events, ["enter:original-car", "read:original-car"]);
});

test("两个旧任务同时查询时会各自使用原车位的独立状态", async () => {
  let lockTail = Promise.resolve();
  const sessionLock = (work) => {
    const current = lockTail.catch(() => {}).then(work);
    lockTail = current;
    return current;
  };
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { baseUrl: "https://one.aishare.icu" } },
    account: { id: "account-task-concurrent-cars", username: "task-concurrent-cars@example.com", password: "test" },
    sessionLock
  });
  client.portalLoggedIn = true;
  client.performEnterCar = async () => {};
  client.createSubmitClient = ({ snapshot }) => ({
    conversationDetail: async (externalId) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { externalId, taskCarId: snapshot.carId };
    }
  });
  client.imageUrlsFrom = async (detail) => [
    `https://example.test/${detail.taskCarId}/${detail.externalId}.png`
  ];
  client.rememberImageSuccessfulCar = async () => {};

  const [first, second] = await Promise.all([
    client.getTask("conversation-a", { carId: "car-a", carType: "chatgpt" }),
    client.getTask("conversation-b", { carId: "car-b", carType: "chatgpt" })
  ]);

  assert.deepEqual(first.imageUrls, ["https://example.test/car-a/conversation-a.png"]);
  assert.deepEqual(second.imageUrls, ["https://example.test/car-b/conversation-b.png"]);
});

test("第一次账号检测超时保留可用状态，连续两次才异常，成功后清零", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    channels: [{
      id: "shareai",
      name: "ShareAI账号",
      type: "shareai",
      enabled: true,
      priority: 1,
      settings: {
        ...config.channels.find((item) => item.id === "shareai")?.settings,
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gemini"
      }
    }],
    accounts: [{
      id: "account-timeout-preserve",
      channelId: "shareai",
      name: "检测超时保护账号",
      username: "timeout-preserve@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          chatplus: {
            status: "ok",
            message: "聊天账号可用",
            quota: null,
            balance: null
          }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  const timeoutError = () => {
    const error = new Error("读取账号额度超时，聊天站连续两次没有及时响应。");
    error.status = 504;
    error.code = "ACCOUNT_CHECK_TIMEOUT";
    error.accountCheckTimeout = true;
    error.accountCheckStep = "读取账号额度";
    return error;
  };
  ChatplusClient.prototype.check = async () => {
    throw timeoutError();
  };

  try {
    const first = await checkAccount("account-timeout-preserve");
    assert.equal(first.status, "ok");
    assert.equal(first.meta.abilities.chatplus.status, "ok");
    assert.equal(first.meta.abilities.chatplus.meta.accountCheck.status, "timeout");
    assert.equal(first.meta.abilities.chatplus.meta.accountCheck.consecutiveTimeouts, 1);

    await assert.rejects(
      checkAccount("account-timeout-preserve"),
      /连续两次检测超时/
    );
    const afterSecond = await loadConfig();
    const failedAccount = afterSecond.accounts.find((item) => item.id === "account-timeout-preserve");
    assert.equal(failedAccount.status, "error");
    assert.equal(failedAccount.meta.abilities.chatplus.status, "error");
    assert.equal(failedAccount.meta.abilities.chatplus.meta.accountCheck.status, "failed");
    assert.equal(failedAccount.meta.abilities.chatplus.meta.accountCheck.consecutiveTimeouts, 2);

    ChatplusClient.prototype.check = async () => ({
      status: "ok",
      quota: null,
      balance: null,
      quotaResetAt: "",
      expireAt: "",
      message: "聊天账号可用",
      meta: {}
    });
    const recovered = await checkAccount("account-timeout-preserve");
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.meta.abilities.chatplus.meta.accountCheck.status, "ok");
    assert.equal(recovered.meta.abilities.chatplus.meta.accountCheck.consecutiveTimeouts, 0);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
    await saveConfig(config);
  }
});

test("GPT 账号信息会换算真实总额度、剩余额度和重置时间", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-usage-fields", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      limit: 220,
      userUsed: "37",
      per: "12h",
      resetTimeChatgpt: "2026-07-22 19:32:29",
      expireTime: "2026-08-16 05:22:44"
    }
  });

  const usage = await client.loadAccountUsage({ timeoutSec: 8 });

  assert.deepEqual(usage, {
    quota: 220,
    used: 37,
    balance: 183,
    quotaResetAt: "2026-07-22T19:32:29+08:00",
    expireAt: "2026-08-16T05:22:44+08:00",
    period: "12h"
  });
});

test("Gemini 账号信息只读取 Gemini 自己的额度和重置时间", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: {
      id: "shareai:chatplus",
      settings: {
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", enabled: false, default: true },
          { key: "gemini", name: "Gemini", enabled: true, default: false }
        ]
      }
    },
    account: { id: "account-gemini-usage", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      limit: 20,
      userUsed: 1,
      resetTimeChatgpt: "",
      per: "12h",
      geminiLimit: 100,
      geminiUsed: "7",
      geminiPer: "24h",
      resetTimeGemini: "2026-07-27 00:00:00",
      geminiExpireTime: "2026-08-24 23:49:00"
    }
  });

  const usage = await client.loadAccountUsage({ timeoutSec: 8 });

  assert.deepEqual(usage, {
    quota: 100,
    used: 7,
    balance: 93,
    quotaResetAt: "2026-07-27T00:00:00+08:00",
    expireAt: "2026-08-24T23:49:00+08:00",
    period: "24h"
  });
});

test("Gemini 没有返回重置时间时按北京时间次日零点显示", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gemini" } },
    account: { id: "account-gemini-midnight", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      geminiLimit: 70,
      geminiUsed: "5",
      geminiPer: "24h",
      resetTimeGemini: ""
    }
  });

  const usage = await client.loadAccountUsage({ timeoutSec: 8 });

  assert.equal(usage.quota, 70);
  assert.equal(usage.used, 5);
  assert.equal(usage.balance, 65);
  assert.match(usage.quotaResetAt, /^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/);
  const remainingMs = Date.parse(usage.quotaResetAt) - Date.now();
  assert.ok(remainingMs > 0 && remainingMs <= 24 * 60 * 60 * 1000);
});

test("Grok 账号信息只读取 Grok 自己的额度和重置时间", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "grok" } },
    account: { id: "account-grok-usage", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      limit: 20,
      userUsed: 1,
      resetTimeChatgpt: "2026-07-27 01:00:00",
      grokLimit: 80,
      grokUsed: "12",
      grokPer: "12h",
      resetTimeGrok: "2026-07-27 02:00:00",
      grokExpireTime: "2026-08-20 12:00:00"
    }
  });

  const usage = await client.loadAccountUsage({ timeoutSec: 8 });

  assert.deepEqual(usage, {
    quota: 80,
    used: 12,
    balance: 68,
    quotaResetAt: "2026-07-27T02:00:00+08:00",
    expireAt: "2026-08-20T12:00:00+08:00",
    period: "12h"
  });
});

test("PLUS 车位有图片额度时账号检测不会误判为无额度", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-plus-image", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loadAccountUsages = async () => ({
    gpt: {
      quota: 220,
      used: 106,
      balance: 114,
      quotaResetAt: "2026-07-26T07:36:45+08:00",
      expireAt: activeSubscriptionExpireAt,
      period: "12h"
    }
  });
  client.loginPortal = async () => {};
  client.json = async (pathName) => {
    assert.equal(pathName, "/frontend-api/carpage");
    return {
      code: 1,
      data: {
        list: [{
          carID: "plus-image-car",
          status: 1,
          count: 0,
          desc: "空闲|推荐",
          label: "PLUS",
          isPro: false,
          usage: {
            image_gen: {
              remaining: 48,
              reset_at_ts: 1785028472,
              reset_in: 44696
            }
          }
        }]
      }
    };
  };
  client.enterCar = async (carId, carType) => {
    client.carId = carId;
    client.carType = carType;
    client.portalLoggedIn = true;
  };
  client.loadInit = async () => ({
    default_model_slug: "gpt-5-6-thinking",
    limits_progress: [{ feature_name: "image_gen", remaining: 48, reset_after: "2026-07-26T07:36:45+00:00" }]
  });

  const result = await client.check();

  assert.equal(result.status, "ok");
  assert.equal(result.balance, null);
  assert.equal(result.quotaResetAt, "");
  assert.equal(result.meta.selectedCarId, "plus-image-car");
  assert.equal(result.meta.imageLimit, undefined);
});

test("Gemini 数据缺失时不会借用 GPT 额度，但仍保留共享套餐有效期", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gemini" } },
    account: { id: "account-gemini-expire", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      limit: 70,
      userUsed: "8",
      per: "1d",
      expireTime: "2026-07-24 23:41:00",
      expireTimeChatgpt: "2026-07-25 23:42:03"
    }
  });

  const usage = await client.loadAccountUsage({ timeoutSec: 8 });

  assert.deepEqual(usage, {
    quota: null,
    used: null,
    balance: null,
    quotaResetAt: "",
    expireAt: "2026-07-25T23:42:03+08:00",
    period: ""
  });
});

test("后台显示额度为零时直接暂停账号，不再进入车位", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-usage-empty", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let prepareCount = 0;
  client.loadAccountUsages = async () => ({
    gpt: {
      quota: 220,
      used: 220,
      balance: 0,
      quotaResetAt: "2026-07-22T19:32:29+08:00",
      expireAt: activeSubscriptionExpireAt,
      period: "12h"
    }
  });
  client.prepareChatSession = async () => {
    prepareCount += 1;
    return {
      route: { key: "gpt", model: "gpt-test" },
      init: { default_model_slug: "gpt-test" },
      selected: { carId: "car-dashboard-zero", carType: "chatgpt", strategy: "balanced" }
    };
  };

  const result = await client.check();

  assert.equal(prepareCount, 0);
  assert.equal(result.status, "quota_empty");
  assert.equal(result.quota, 220);
  assert.equal(result.balance, 0);
  assert.equal(result.used, 220);
  assert.equal(result.quotaReason, "chat_usage_limit");
  assert.equal(result.quotaModel, "gpt");
  assert.equal(result.quotaResetAt, "2026-07-22T19:32:29+08:00");
  assert.equal(result.quotaConfirmedByUpstream, true);
  assert.equal(result.meta.selectedCarId, undefined);
});

test("额度恢复核验会检查指定模型的额度和页面", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: {
      id: "shareai:chatplus",
      settings: {
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", enabled: true, default: true },
          { key: "gemini", name: "Gemini", enabled: true }
        ]
      }
    },
    account: { id: "account-model-recovery", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  const geminiUsage = {
    quota: 70,
    used: 0,
    balance: 70,
    quotaResetAt: "2026-07-30T00:00:00+08:00",
    expireAt: activeSubscriptionExpireAt,
    period: "24h"
  };
  client.loadAccountUsages = async () => ({
    gpt: { quota: 220, used: 220, balance: 0 },
    gemini: geminiUsage
  });
  client.prepareChatSession = async (input) => {
    assert.equal(input.model, "gemini");
    return {
      route: { key: "gemini" },
      init: {},
      selected: { carId: "gemini-recovery-car", strategy: "thinking" }
    };
  };

  const result = await client.check({ model: "gemini" });

  assert.equal(result.status, "ok");
  assert.equal(result.meta.chatModel, "gemini");
  assert.deepEqual(result.meta.recoveryUsage, geminiUsage);
});

test("后台观察额度时只读取额度，不进入聊天页面", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-quota-only", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let prepareCount = 0;
  const gptUsage = {
    quota: 220,
    used: 43,
    balance: 177,
    quotaResetAt: "",
    expireAt: activeSubscriptionExpireAt,
    period: "12h"
  };
  client.loadAccountUsages = async () => ({ gpt: gptUsage });
  client.prepareChatSession = async () => {
    prepareCount += 1;
    throw new Error("后台观察额度时不应进入聊天页面");
  };

  const result = await client.check({ model: "gpt", quotaOnly: true });

  assert.equal(prepareCount, 0);
  assert.equal(result.status, "ok");
  assert.equal(result.message, "聊天额度已更新");
  assert.deepEqual(result.meta.referenceUsage.gpt, gptUsage);
});

test("聊天总额度用完后立即停用账户并保留刷新时间", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-submit-limit", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let prepareCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    prepareCount += 1;
    const carId = `car-limit-${prepareCount}`;
    ignoredCarIds.add(carId);
    return {
      route: { key: "gpt", model: "gpt-test" },
      init: { default_model_slug: "gpt-test" },
      selected: { carId, carType: "chatgpt" }
    };
  };
  client.uploadChatImages = async () => [];
  client.http = async () => ({
    status: 403,
    headers: {},
    body: JSON.stringify({
      detail: {
        message: "您的账号当前的使用次数已达上限: 已使用220，预占中0，合计占用220/220，本次需要1，剩余0，请2026-07-22 19:32:29后重试或购买更高使用量的套餐。"
      }
    })
  });

  await assert.rejects(
    client.sendConversation("额度测试", {}),
    (error) => {
      assert.equal(error.code, "CHAT_USAGE_LIMIT");
      assert.equal(error.quotaEmpty, true);
      assert.equal(error.quota, 220);
      assert.equal(error.balance, 0);
      assert.equal(error.used, 220);
      assert.equal(error.quotaResetAt, "2026-07-22T19:32:29+08:00");
      assert.equal(error.quotaConfirmedByUpstream, true);
      return true;
    }
  );
  assert.equal(prepareCount, 1);
});

test("GPT 聊天生图会忽略旧模型并使用网页当前模型", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: {
      id: "shareai:chatplus",
      settings: {
        defaultChatModel: "gpt",
        chatModels: [{
          key: "gpt",
          name: "GPT",
          carType: "chatgpt",
          model: "gpt-5-5-instant",
          enabled: true,
          default: true
        }]
      }
    },
    account: { id: "account-current-gpt-model", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let submittedModel = "";
  client.prepareChatSession = async (input) => ({
    route: client.chatRouteForInput(input),
    init: { default_model_slug: "gpt-5-6-thinking" },
    selected: { carId: "current-gpt-car", carType: "chatgpt" }
  });
  client.uploadChatImages = async () => [];
  client.http = async (pathName, options) => {
    assert.equal(pathName, "/backend-api/conversation");
    submittedModel = options.body.model;
    return {
      status: 200,
      headers: {},
      body: "data: {\"conversation_id\":\"conversation-current-model\"}\n\ndata: [DONE]\n\n"
    };
  };

  const result = await client.sendConversation("当前模型测试", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(submittedModel, "gpt-5-6-thinking");
  assert.equal(result.upstreamModel, "gpt-5-6-thinking");
  assert.equal(result.conversationId, "conversation-current-model");
});

test("GPT 聊天生图被 403 拒绝时保留上游原文", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-submit-refused", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  let prepareCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    prepareCount += 1;
    const carId = `refused-gpt-car-${prepareCount}`;
    ignoredCarIds.add(carId);
    return ({
    route: { key: "gpt", model: "" },
    init: { default_model_slug: "gpt-5-6-thinking" },
    selected: { carId, carType: "chatgpt" }
    });
  };
  client.uploadChatImages = async () => [];
  client.http = async () => ({
    status: 403,
    headers: {},
    body: JSON.stringify({ detail: { message: "当前模型不允许提交图片生成请求。" } })
  });

  await assert.rejects(
    client.sendConversation("拒绝原文测试", {
      imageGeneration: true,
      requireConversationId: true
    }),
    (error) => {
      assert.match(error.message, /车位失效：连续两个车位都没有创建对话/);
      assert.match(error.message, /当前模型不允许提交图片生成请求/);
      assert.equal(error.code, "UPSTREAM_CONVERSATION_NOT_CREATED");
      assert.equal(error.upstreamText, "当前模型不允许提交图片生成请求。");
      assert.equal(error.upstreamExplicitFailure, true);
      assert.equal(error.imageSubmissionAttempted, true);
      assert.deepEqual(error.carAttempts.map((item) => item.carId), [
        "refused-gpt-car-1",
        "refused-gpt-car-2"
      ]);
      return true;
    }
  );
});

test("GPT 聊天生图返回 403 登录失效时会重新登录并换车", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-relogin-on-403", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  const selectedCars = [];
  let requestCount = 0;
  let resetCount = 0;
  const resetSession = client.resetSession.bind(client);
  client.resetSession = () => {
    resetCount += 1;
    resetSession();
  };
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    const carId = ignoredCarIds.has("expired-login-car") ? "healthy-login-car" : "expired-login-car";
    ignoredCarIds.add(carId);
    selectedCars.push(carId);
    return {
      route: { key: "gpt", model: "" },
      init: { default_model_slug: "gpt-5-6-thinking" },
      selected: { carId, carType: "chatgpt" }
    };
  };
  client.uploadChatImages = async () => [];
  client.http = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        status: 403,
        headers: {},
        body: JSON.stringify({ detail: { message: "您的账号在其他设备登录，请重新登录" } })
      };
    }
    return {
      status: 200,
      headers: {},
      body: "data: {\"conversation_id\":\"conversation-after-relogin\"}\n\ndata: [DONE]\n\n"
    };
  };

  const result = await client.sendConversation("403 重新登录测试", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(requestCount, 2);
  assert.equal(resetCount, 1);
  assert.equal(result.conversationId, "conversation-after-relogin");
  assert.deepEqual(selectedCars, ["expired-login-car", "healthy-login-car"]);
});

test("GPT 聊天生图外层 403 包含聊天记录 401 时会换车", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-switch-on-wrapped-401", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  const selectedCars = [];
  let requestCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    const carId = ignoredCarIds.has("deleted-chat-car") ? "healthy-chat-car" : "deleted-chat-car";
    ignoredCarIds.add(carId);
    selectedCars.push(carId);
    return {
      route: { key: "gpt", model: "" },
      init: { default_model_slug: "gpt-5-6-thinking" },
      selected: { carId, carType: "chatgpt" }
    };
  };
  client.uploadChatImages = async () => [];
  client.http = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        status: 403,
        headers: {},
        body: JSON.stringify({
          detail: {
            message: "后端返回错误：401。该车队的聊天记录已删除，请点击【换车继续聊】。"
          }
        })
      };
    }
    return {
      status: 200,
      headers: {},
      body: "data: {\"conversation_id\":\"conversation-after-switch\"}\n\ndata: [DONE]\n\n"
    };
  };

  const result = await client.sendConversation("403 包含 401 换车测试", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(requestCount, 2);
  assert.equal(result.conversationId, "conversation-after-switch");
  assert.deepEqual(selectedCars, ["deleted-chat-car", "healthy-chat-car"]);
});

test("GPT 聊天生图明确返回 401 时会换下一个车位", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "gpt" } },
    account: { id: "account-switch-on-401", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  const selectedCars = [];
  let requestCount = 0;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    const carId = ignoredCarIds.has("deleted-chat-car") ? "healthy-chat-car" : "deleted-chat-car";
    ignoredCarIds.add(carId);
    selectedCars.push(carId);
    return {
      route: { key: "gpt", model: "" },
      init: { default_model_slug: "gpt-5-6-thinking" },
      selected: { carId, carType: "chatgpt" }
    };
  };
  client.uploadChatImages = async () => [];
  client.http = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        status: 401,
        headers: {},
        body: JSON.stringify({
          detail: {
            message: "该车队的聊天记录已删除，请点击【换车继续聊】。"
          }
        })
      };
    }
    return {
      status: 200,
      headers: {},
      body: "data: {\"conversation_id\":\"conversation-healthy\"}\n\ndata: [DONE]\n\n"
    };
  };
  const result = await client.sendConversation("401 换车测试", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(requestCount, 2);
  assert.equal(result.conversationId, "conversation-healthy");
  assert.deepEqual(selectedCars, ["deleted-chat-car", "healthy-chat-car"]);
});

test("Grok 和 Gemini 即使返回 403，也会优先识别明确用完提示", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: { id: "shareai:chatplus", settings: { defaultChatModel: "grok" } },
    account: { id: "account-multi-model-limit", username: "test@example.com", password: "test" },
    sessionLock: async (work) => work()
  });
  client.http = async () => ({
    status: 403,
    headers: {},
    body: "usage count has reached the limit"
  });

  await assert.rejects(
    client.sendGrokConversation(
      "额度测试",
      { files: [] },
      { key: "grok", strategy: "balanced", model: "grok-test" },
      { carId: "grok-car", carType: "grok" }
    ),
    (error) => (
      error.code === "CHAT_USAGE_LIMIT"
      && error.quotaConfirmedByUpstream === true
      && error.quotaReason === "chat_usage_limit"
    )
  );

  client.geminiSession.bl = "gemini-session";
  client.uploadGeminiImages = async () => [];
  await assert.rejects(
    client.sendGeminiConversation(
      "额度测试",
      { files: [] },
      { key: "gemini", strategy: "thinking", model: "" },
      { carId: "gemini-car", carType: "gemini" }
    ),
    (error) => (
      error.code === "CHAT_USAGE_LIMIT"
      && error.quotaConfirmedByUpstream === true
      && error.quotaReason === "chat_usage_limit"
    )
  );
});

test("后台额度数字不扣减，明确用完后只由真实成功请求恢复", async () => {
  const config = await loadConfig();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-chat-usage-cycle",
      channelId: "shareai",
      name: "聊天额度周期测试账号",
      username: "usage-cycle@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      cooldownUntil: null,
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图积分不足" },
          chatplus: {
            status: "ok",
            quota: 220,
            used: 218,
            balance: 2,
            quotaResetAt: resetAt,
            cooldownUntil: null,
            quotaReason: "",
            message: "聊天账号可用",
            meta: { chatUsage: { quota: 220, used: 218, balance: 2, period: "12h" } }
          }
        }
      }
    }]
  });

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  const originalCheck = ChatplusClient.prototype.check;
  let submitCount = 0;
  let checkCount = 0;
  ChatplusClient.prototype.createChatCompletion = async () => ({
    externalId: `conversation-usage-${++submitCount}`,
    model: "gpt",
    content: "测试成功",
    imageUrls: [],
    raw: {}
  });
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 220,
      used: 0,
      balance: 220,
      quotaResetAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      cooldownUntil: null,
      quotaReason: "",
      message: "聊天账号可用",
      meta: { chatUsage: { quota: 220, used: 0, balance: 220, period: "12h" } }
    };
  };

  try {
    await createChatCompletion({ channel: "chatplus", messages: [{ role: "user", content: "成功请求" }] });

    let stored = await loadConfig();
    let account = stored.accounts[0];
    let chatplus = account.meta.abilities.chatplus;
    assert.equal(submitCount, 1);
    assert.equal(chatplus.quota, null);
    assert.equal(chatplus.used, null);
    assert.equal(chatplus.balance, null);
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.quotaReason, "");
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
    assert.equal(account.cooldownUntil, null);

    chatplus = {
      ...chatplus,
      status: "quota_empty",
      quota: null,
      used: null,
      balance: null,
      quotaReason: "chat_usage_limit",
      quotaConfirmedByUpstream: true,
      quotaResetAt: resetAt,
      cooldownUntil: resetAt,
      lastCheckAt: new Date().toISOString()
    };
    await saveConfig({
      ...stored,
      accounts: [{
        ...account,
        cooldownUntil: chatplus.cooldownUntil,
        meta: {
          ...account.meta,
          abilities: { ...account.meta.abilities, chatplus }
        }
      }]
    });

    const waiting = await recoverUnavailableChatAccounts();
    assert.equal(waiting.length, 0);
    assert.equal(checkCount, 0);
    await assert.rejects(
      createChatCompletion({ channel: "chatplus", messages: [{ role: "user", content: "还没到恢复时间" }] }),
      /冷却|额度|可用/
    );
    assert.equal(submitCount, 1);

    stored = await loadConfig();
    account = stored.accounts[0];
    chatplus = {
      ...account.meta.abilities.chatplus,
      quotaResetAt: new Date(Date.now() - 1000).toISOString(),
      cooldownUntil: new Date(Date.now() - 1000).toISOString()
    };
    await saveConfig({
      ...stored,
      accounts: [{
        ...account,
        cooldownUntil: chatplus.cooldownUntil,
        meta: {
          ...account.meta,
          abilities: { ...account.meta.abilities, chatplus }
        }
      }]
    });

    await createChatCompletion({ channel: "chatplus", messages: [{ role: "user", content: "到点后真实请求" }] });
    stored = await loadConfig();
    account = stored.accounts[0];
    chatplus = account.meta.abilities.chatplus;

    assert.equal(submitCount, 2);
    assert.equal(checkCount, 0);
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.quota, null);
    assert.equal(chatplus.balance, null);
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
    assert.equal(account.cooldownUntil, null);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
    ChatplusClient.prototype.check = originalCheck;
  }
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

test("没有任务时后台也会自动恢复失效的聊天线路", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-recovery",
      channelId: "shareai",
      name: "后台恢复测试账号",
      username: "background@example.com",
      password: "test",
      enabled: true,
      status: "disconnected",
      message: "共享线路失效",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图积分不足" },
          chatplus: { status: "disconnected", message: "共享线路失效" }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 18,
      balance: 18,
      message: "聊天账号可用"
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-background-recovery");

    assert.equal(checkCount, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(account.status, "ok");
    assert.equal(account.meta.abilities.chatplus.status, "ok");
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("套餐续费后后台会自动恢复过期账号", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-subscription-recovery",
      channelId: "shareai",
      name: "套餐续费恢复账号",
      username: "subscription-recovery@example.com",
      password: "test",
      enabled: true,
      status: "subscription_expired",
      message: "GPT 套餐已过期",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图积分不足" },
          chatplus: { status: "subscription_expired", message: "GPT 套餐已过期" }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: null,
      balance: null,
      expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      message: "聊天账号可用",
      meta: {
        chatModel: "gpt",
        referenceUsage: {
          gpt: {
            quota: 220,
            balance: 220,
            expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          }
        }
      }
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-subscription-recovery");

    assert.equal(checkCount, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(account.status, "ok");
    assert.equal(account.meta.abilities.chatplus.status, "ok");
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("同一聊天账号的对话和生图等待接口可以并行处理", async () => {
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
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const trackRequest = async () => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      activeRequests -= 1;
    }
  };

  ChatplusClient.prototype.createChatCompletion = async () => {
    await trackRequest();
    return {
      externalId: "conversation-exclusive",
      model: "gpt",
      content: "对话完成",
      imageUrls: [],
      raw: {}
    };
  };
  ChatplusClient.prototype.createImageTask = async (input) => {
    await trackRequest();
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

    assert.equal(maxActiveRequests, 2);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
    ChatplusClient.prototype.createImageTask = originalCreateImageTask;
  }
});

test("绘图额度不足且聊天生图并发已满时直接提示并发上限", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    accounts: [{
      id: "account-concurrency-limit",
      channelId: "shareai",
      name: "并发上限测试账号",
      username: "concurrency-limit@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 1, message: "绘图账号可用" },
          chatplus: { status: "ok", balance: 20, message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalChatCreateTextTask = ChatplusClient.prototype.createTextTask;
  let releaseActiveTask;
  let markActiveTaskStarted;
  const activeTaskStarted = new Promise((resolve) => { markActiveTaskStarted = resolve; });
  const holdActiveTask = new Promise((resolve) => { releaseActiveTask = resolve; });

  DrawingClient.prototype.check = async () => ({
    status: "quota_empty",
    quota: 50,
    balance: 0,
    message: "绘图积分不足"
  });
  ChatplusClient.prototype.createTextTask = async (input) => {
    markActiveTaskStarted();
    await holdActiveTask;
    return {
      externalId: "chat-image-concurrency-task",
      status: "success",
      taskType: "text2img",
      prompt: input.prompt,
      modelId: "gpt",
      ratio: "1:1",
      imageCount: 1,
      imageUrls: ["https://example.com/result.png"],
      raw: {}
    };
  };

  const activeTask = createTextTask({ channel: "chatplus", prompt: "占用聊天生图并发" }, true);
  await activeTaskStarted;
  try {
    await assert.rejects(
      createTextTask({ prompt: "并发已满时的新任务" }, true),
      (error) => {
        assert.equal(error?.status, 429);
        assert.match(error?.message || "", /^并发上限/);
        assert.match(error?.message || "", /绘图积分不足|任务正在处理中/);
        return true;
      }
    );
  } finally {
    releaseActiveTask();
    await activeTask;
    DrawingClient.prototype.check = originalDrawingCheck;
    ChatplusClient.prototype.createTextTask = originalChatCreateTextTask;
  }
});

test("聊天生图等待接口按配置并发提交，超过配置才提示上限", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 4 },
    accounts: [{
      id: "account-chatplus-queue-limit",
      channelId: "shareai",
      name: "聊天排队测试账号",
      username: "chatplus-queue-limit@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", balance: 1, message: "绘图账号可用" },
          chatplus: { status: "ok", balance: 20, message: "聊天账号可用" }
        }
      }
    }]
  });

  const queueLimitConfig = await loadConfig();
  await saveConfig({
    ...queueLimitConfig,
    accounts: queueLimitConfig.accounts.map((account) => account.id === "account-chatplus-queue-limit"
      ? {
          ...account,
          meta: {
            ...(account.meta || {}),
            abilities: {
              ...(account.meta?.abilities || {}),
              drawing: { status: "quota_empty", balance: 0, message: "绘图积分不足" }
            }
          }
        }
      : account)
  });

  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalChatCreateImageTask = ChatplusClient.prototype.createImageTask;
  let drawingCheckCount = 0;
  let releaseActiveTasks;
  let markAllTasksStarted;
  let activeCount = 0;
  let maxActiveCount = 0;
  const concurrentSubmitFlags = [];
  const allTasksStarted = new Promise((resolve) => { markAllTasksStarted = resolve; });
  const holdActiveTasks = new Promise((resolve) => { releaseActiveTasks = resolve; });

  DrawingClient.prototype.check = async () => {
    drawingCheckCount += 1;
    throw new Error("已知无额度的绘图站不应该再次检测");
  };
  ChatplusClient.prototype.createImageTask = async (input) => {
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    concurrentSubmitFlags.push(input.concurrentSubmit === true);
    if (activeCount === 4) markAllTasksStarted();
    try {
      await holdActiveTasks;
      return {
        externalId: `chat-image-${input.prompt}`,
        status: "success",
        taskType: "img2img",
        prompt: input.prompt,
        modelId: "gpt",
        ratio: "1:1",
        imageCount: 1,
        imageUrls: ["https://example.com/result.png"],
        raw: {}
      };
    } finally {
      activeCount -= 1;
    }
  };

  const file = { filename: "test.png", mimetype: "image/png" };
  const activeTasks = Array.from({ length: 4 }, (_item, index) => createImageTask({
    input: { prompt: `聊天生图并发-${index + 1}` },
    files: [file],
    wait: true
  }));
  await allTasksStarted;
  assert.equal(maxActiveCount, 4);
  assert.deepEqual(concurrentSubmitFlags, [true, true, true, true]);

  const startedAt = Date.now();
  try {
    await assert.rejects(
      createImageTask({
        input: { prompt: "超过聊天生图并发的新任务" },
        files: [file],
        wait: true
      }),
      (error) => {
        assert.equal(error?.status, 429);
        assert.match(error?.message || "", /^并发上限/);
        assert.match(error?.message || "", /任务正在处理中/);
        assert.ok(Date.now() - startedAt < 1000);
        return true;
      }
    );
    assert.equal(drawingCheckCount, 0);
  } finally {
    releaseActiveTasks();
    await Promise.all(activeTasks);
    DrawingClient.prototype.check = originalDrawingCheck;
    ChatplusClient.prototype.createImageTask = originalChatCreateImageTask;
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

test("绘图站中转返回文本时保留上游原文", () => {
  const upstreamText = "I wasn't able to generate the image due to an error on my side.";
  const task = normalizeDrawingTask({
    id: 45745,
    status: "failed",
    items: [{
      error_message: "中转返回文本",
      result_text: upstreamText
    }]
  });

  assert.equal(task.errorMessage, upstreamText);
  assert.equal(task.upstreamText, upstreamText);
  assert.equal(task.raw.items[0].result_text, upstreamText);
});

test("绘图站严重中转失败会被识别为上游异常", () => {
  assert.equal(drawingSevereFailureReason("中转接口请求失败，状态码：500"), "upstream_500");
  assert.equal(drawingSevereFailureReason("中转返回文本"), "relay_text");
  assert.equal(drawingSevereFailureReason("中转请求超时，已超过 1000 秒"), "relay_timeout");
});

test("同一账号绘图上游连续失败三次后冷却三十分钟", async () => {
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
    assert.ok(Date.parse(drawing.cooldownUntil) - Date.now() > 29 * 60 * 1000);
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

test("手动解除绘图冷却后账号会立即恢复可用", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    accounts: [{
      id: "account-manual-clear-drawing-cooldown",
      channelId: "shareai",
      name: "manual clear drawing cooldown",
      username: "manual-clear-drawing-cooldown@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "cooldown",
            quota: 50,
            balance: 8,
            cooldownUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            cooldownReason: "drawing_upstream_error",
            upstreamFailureCode: "upstream_500",
            upstreamFailureStreak: 3,
            message: "drawing cooling"
          },
          chatplus: { status: "ok", balance: 20, message: "chat ok" }
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
    balance: 8,
    message: "drawing ok"
  });
  DrawingClient.prototype.createTextTask = async (input) => {
    submitCount += 1;
    return normalizeDrawingTask({
      id: 36000 + submitCount,
      status: "success",
      task_type: "text2img",
      prompt: input.prompt,
      items: [{ image_url: "https://example.com/manual-clear-result.png" }]
    });
  };

  try {
    const before = await getRuntimeStatus();
    assert.equal(before.available.drawingImage, 0);
    await assert.rejects(
      createTextTask({ channel: "drawing", prompt: "still cooling" }, true),
      (error) => error?.status === 503
    );
    assert.equal(submitCount, 0);

    await clearAccountCooldown("account-manual-clear-drawing-cooldown");

    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;
    assert.equal(stored.accounts[0].status, "ok");
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.cooldownUntil, null);
    assert.equal(drawing.cooldownReason, "");
    assert.equal(drawing.upstreamFailureCode, "");
    assert.equal(drawing.upstreamFailureStreak, 0);

    const after = await getRuntimeStatus();
    assert.equal(after.available.drawingImage, 2);
    const task = await createTextTask({ channel: "drawing", prompt: "after manual clear" }, true);
    assert.equal(task.status, "success");
    assert.equal(submitCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createTextTask = originalCreateTextTask;
  }
});

test("绘图站提示上传过于频繁时按上游时间立即冷却", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    accounts: [{
      id: "account-drawing-rate-limit",
      channelId: "shareai",
      name: "绘图限流测试账号",
      username: "drawing-rate-limit@example.com",
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
  const originalUploadImage = DrawingClient.prototype.uploadImage;
  let uploadCount = 0;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 50,
    balance: 10,
    message: "绘图账号可用"
  });
  DrawingClient.prototype.uploadImage = async () => {
    uploadCount += 1;
    throw new Error("上传过于频繁，请 354 秒后再试");
  };

  try {
    await assert.rejects(createImageTask({
      input: { channel: "drawing", prompt: "触发上游限流" },
      file: { filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") },
      wait: true
    }), /上传过于频繁/);

    const stored = await loadConfig();
    const account = stored.accounts[0];
    const drawing = account.meta.abilities.drawing;
    const remaining = Date.parse(drawing.cooldownUntil) - Date.now();

    assert.equal(drawing.status, "cooldown");
    assert.equal(drawing.cooldownReason, "drawing_rate_limited");
    assert.equal(drawing.upstreamFailureStreak, 0);
    assert.match(drawing.message, /暂停绘图 354 秒/);
    assert.ok(remaining > 350 * 1000 && remaining <= 354 * 1000);
    assert.equal(account.meta.abilities.chatplus.status, "ok");
    await assert.rejects(
      createImageTask({
        input: { channel: "drawing", prompt: "冷却时不能重复提交" },
        file: { filename: "source.png", mimetype: "image/png", buffer: Buffer.from("image") },
        wait: true
      }),
      (error) => error?.status === 503
    );
    assert.equal(uploadCount, 1);
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.uploadImage = originalUploadImage;
  }
});

test("background recovery refreshes expired drawing quota", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-recovery",
      channelId: "shareai",
      name: "Background Drawing Recovery",
      username: "background-drawing@example.com",
      password: "test",
      enabled: true,
      status: "quota_empty",
      meta: {
        abilities: {
          drawing: {
            status: "quota_empty",
            quota: 50,
            balance: 0,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing quota empty"
          },
          chatplus: { status: "quota_empty", message: "chat image quota empty" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 50,
      balance: 50,
      quotaResetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      message: "drawing ok"
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "account-background-drawing-recovery");

    assert.equal(checkCount, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].channelId, "shareai:drawing");
    assert.equal(results[0].recovered, true);
    assert.equal(account.status, "ok");
    assert.equal(account.meta.abilities.drawing.status, "ok");
    assert.equal(account.meta.abilities.drawing.balance, 50);
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("绘图状态误标为可用且余额不足时仍会后台恢复", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-stale-status",
      channelId: "shareai",
      name: "Background Drawing Stale Status",
      username: "background-drawing-stale@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "ok",
            quota: 100,
            balance: 1,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing ok"
          },
          chatplus: { status: "ok", message: "chat image ok" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 100,
      balance: 100,
      quotaResetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      message: "drawing ok"
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;

    assert.equal(checkCount, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].channelId, "shareai:drawing");
    assert.equal(results[0].recovered, true);
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.balance, 100);
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("绘图仍有余额但重置时间已到也会向上游更新", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-positive-balance",
      channelId: "shareai",
      name: "Drawing Positive Balance",
      username: "drawing-positive-balance@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "ok",
            quota: 100,
            balance: 6,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing ok"
          },
          chatplus: { status: "ok", message: "chat ok" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  const nextResetAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 100,
      balance: 14,
      quotaResetAt: nextResetAt,
      message: "drawing ok"
    };
  };

  try {
    const firstResults = await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;

    assert.equal(checkCount, 1);
    assert.equal(firstResults[0].recovered, true);
    assert.equal(secondResults.length, 0);
    assert.equal(drawing.balance, 14);
    assert.equal(drawing.quotaResetAt, nextResetAt);
    assert.equal(drawing.quotaResetSource, "upstream");
    assert.equal(drawing.meta.quotaRefresh.status, "success");
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("绘图额度核验失败会保留现有额度并延后重试", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-refresh-failed",
      channelId: "shareai",
      name: "Drawing Refresh Failed",
      username: "drawing-refresh-failed@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "ok",
            quota: 100,
            balance: 6,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing ok"
          },
          chatplus: { status: "ok", message: "chat ok" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("upstream temporarily unavailable");
  };

  try {
    await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;

    assert.equal(checkCount, 1);
    assert.equal(secondResults.length, 0);
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.balance, 6);
    assert.equal(drawing.meta.quotaRefresh.status, "failed");
    assert.ok(Date.parse(drawing.meta.quotaRefresh.retryAt) > Date.now());
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("绘图仍未恢复且上游没给新时间时会稍后复查", async () => {
  const config = await loadConfig();
  const pastResetAt = new Date(Date.now() - 1000).toISOString();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-still-empty",
      channelId: "shareai",
      name: "Drawing Still Empty",
      username: "drawing-still-empty@example.com",
      password: "test",
      enabled: true,
      status: "quota_empty",
      meta: {
        abilities: {
          drawing: {
            status: "quota_empty",
            quota: 100,
            balance: 0,
            quotaResetAt: pastResetAt,
            message: "drawing quota empty"
          },
          chatplus: { status: "ok", message: "chat ok" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "quota_empty",
      quota: 100,
      balance: 0,
      quotaResetAt: pastResetAt,
      message: "drawing quota empty"
    };
  };

  try {
    await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;

    assert.equal(checkCount, 1);
    assert.equal(secondResults.length, 0);
    assert.equal(drawing.quotaResetAt, "");
    assert.equal(drawing.meta.quotaRefresh.status, "waiting");
    assert.ok(Date.parse(drawing.meta.quotaRefresh.retryAt) > Date.now());
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("绘图有额度但上游没给新时间时也会定期重新核验", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-background-drawing-missing-reset-time",
      channelId: "shareai",
      name: "Drawing Missing Reset Time",
      username: "drawing-missing-reset-time@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "ok",
            quota: 100,
            balance: 6,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing ok"
          },
          chatplus: { status: "ok", message: "chat ok" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 100,
      balance: 14,
      quotaResetAt: "",
      message: "drawing ok"
    };
  };

  try {
    await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;

    assert.equal(checkCount, 1);
    assert.equal(secondResults.length, 0);
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.balance, 14);
    assert.equal(drawing.quotaResetAt, "");
    assert.equal(drawing.meta.quotaRefresh.status, "success");
    assert.ok(Date.parse(drawing.meta.quotaRefresh.retryAt) > Date.now());
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("账号有上游任务在处理时不会刷新额度", async () => {
  const config = await loadConfig();
  const accountId = "account-background-drawing-busy";
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: accountId,
      channelId: "shareai",
      name: "Drawing Busy",
      username: "drawing-busy@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "ok",
            quota: 100,
            balance: 6,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing ok"
          },
          chatplus: { status: "ok", message: "chat ok" }
        }
      }
    }]
  });
  await upsertTask({
    id: "busy-drawing-quota-refresh-task",
    externalId: "upstream-busy-drawing-task",
    accountId,
    channelId: "shareai:drawing",
    channelType: "drawing",
    taskType: "text2img",
    status: "waiting_upstream",
    raw: { submitted: true }
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("busy account should not refresh");
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    assert.equal(checkCount, 0);
    assert.equal(results.length, 0);
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

async function saveChatUsageRecoveryFixture({
  lastCheckAt,
  quotaResetAt,
  cooldownUntil = quotaResetAt,
  quotaModel = "gemini",
  referenceUsage = null
}) {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-chat-usage-background-recovery",
      channelId: "shareai",
      name: "Chat Usage Background Recovery",
      username: "chat-usage-background@example.com",
      password: "test",
      enabled: true,
      status: "quota_empty",
      lastCheckAt,
      meta: {
        abilities: {
          drawing: { status: "ok", message: "drawing ok" },
          chatplus: {
            status: "quota_empty",
            quota: null,
            used: null,
            balance: null,
            quotaReason: "chat_usage_limit",
            quotaModel,
            quotaConfirmedByUpstream: true,
            quotaResetAt,
            cooldownUntil,
            lastCheckAt,
            message: "chat usage empty",
            ...(referenceUsage ? { meta: { chatModel: quotaModel, referenceUsage } } : {})
          }
        }
      }
    }]
  });
}

async function saveAvailableChatUsageObservationFixture({ lastCheckAt, referenceUsage }) {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-chat-usage-observation",
      channelId: "shareai",
      name: "Chat Usage Observation",
      username: "chat-usage-observation@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      lastCheckAt,
      meta: {
        abilities: {
          drawing: { status: "ok", message: "drawing ok" },
          chatplus: {
            status: "ok",
            lastCheckAt,
            message: "chat ok",
            meta: { chatModel: "gpt", referenceUsage }
          }
        }
      }
    }]
  });
}

test("仍可用账号的重置时间到了也会自动刷新额度", async () => {
  const pastResetAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await saveAvailableChatUsageObservationFixture({
    lastCheckAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    referenceUsage: {
      gemini: { quota: 70, used: 19, balance: 51, quotaResetAt: pastResetAt, period: "24h" }
    }
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  let quotaOnly = false;
  ChatplusClient.prototype.check = async (options = {}) => {
    checkCount += 1;
    quotaOnly = options.quotaOnly;
    return {
      status: "ok",
      meta: {
        chatModel: "gemini",
        recoveryUsage: { quota: 70, used: 19, balance: 51, quotaResetAt: pastResetAt, period: "24h" },
        referenceUsage: {
          gemini: { quota: 70, used: 19, balance: 51, quotaResetAt: pastResetAt, period: "24h" }
        }
      }
    };
  };

  try {
    const firstResults = await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const resetAt = Date.parse(stored.accounts[0].meta.abilities.chatplus.meta.referenceUsage.gemini.quotaResetAt);

    assert.equal(checkCount, 1);
    assert.equal(quotaOnly, true);
    assert.equal(firstResults[0].recovered, true);
    assert.equal(secondResults.length, 0);
    assert.ok(resetAt > Date.now());
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("GPT 观察到真实恢复后会记住下一次十二小时重置时间", async () => {
  await saveAvailableChatUsageObservationFixture({
    lastCheckAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    referenceUsage: {
      gpt: { quota: 220, used: 43, balance: 177, quotaResetAt: "", period: "12h" }
    }
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async (options = {}) => {
    checkCount += 1;
    assert.equal(options.quotaOnly, true);
    return {
      status: "ok",
      meta: {
        chatModel: "gpt",
        recoveryUsage: { quota: 220, used: 0, balance: 220, quotaResetAt: "", period: "12h" },
        referenceUsage: {
          gpt: { quota: 220, used: 0, balance: 220, quotaResetAt: "", period: "12h" }
        }
      }
    };
  };

  const startedAt = Date.now();
  try {
    const firstResults = await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const usage = stored.accounts[0].meta.abilities.chatplus.meta.referenceUsage.gpt;
    const resetAt = Date.parse(usage.quotaResetAt);

    assert.equal(checkCount, 1);
    assert.equal(firstResults[0].recovered, true);
    assert.equal(secondResults.length, 0);
    assert.ok(Date.parse(usage.quotaResetObservedAt) >= startedAt);
    assert.ok(resetAt >= startedAt + 12 * 60 * 60 * 1000);
    assert.ok(resetAt <= Date.now() + 12 * 60 * 60 * 1000 + 1000);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天额度不足未满 1 小时不会后台复查", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    quotaResetAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("不应该复查");
  };

  try {
    const results = await recoverUnavailableChatAccounts();

    assert.equal(checkCount, 0);
    assert.equal(results.length, 0);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天明确用完超过 1 小时后由后台核验恢复", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
    quotaResetAt: ""
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  let checkedModel = "";
  ChatplusClient.prototype.check = async (options = {}) => {
    checkCount += 1;
    checkedModel = options.model;
    return {
      status: "ok",
      quota: null,
      balance: null,
      meta: {
        chatModel: "gemini",
        recoveryUsage: {
          quota: 70,
          used: 0,
          balance: 70,
          quotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      }
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;

    assert.equal(results.length, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(checkCount, 1);
    assert.equal(checkedModel, "gemini");
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.balance, null);
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天重置时间到了会由后台核验恢复", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    quotaResetAt: new Date(Date.now() - 1000).toISOString()
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: null,
      balance: null,
      meta: {
        chatModel: "gemini",
        recoveryUsage: {
          quota: 70,
          used: 0,
          balance: 70,
          quotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      }
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;

    assert.equal(results.length, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(checkCount, 1);
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.balance, null);
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天旧状态已有明确剩余额度时不会被下次重置时间挡住", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    cooldownUntil: new Date(Date.now() - 1000).toISOString(),
    quotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    referenceUsage: {
      gemini: {
        quota: 70,
        used: 0,
        balance: 70,
        quotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }
    }
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      meta: {
        chatModel: "gemini",
        recoveryUsage: { quota: 70, used: 0, balance: 70 }
      }
    };
  };

  try {
    const results = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;

    assert.equal(checkCount, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天重置后额度仍为零会保持用完状态并延后复查", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    quotaResetAt: new Date(Date.now() - 1000).toISOString()
  });

  const originalCheck = ChatplusClient.prototype.check;
  const nextResetAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: null,
      balance: null,
      meta: {
        chatModel: "gemini",
        recoveryUsage: {
          quota: 70,
          used: 70,
          balance: 0,
          quotaResetAt: nextResetAt
        }
      }
    };
  };

  try {
    const firstResults = await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;

    assert.equal(checkCount, 1);
    assert.equal(firstResults.length, 1);
    assert.equal(firstResults[0].recovered, false);
    assert.equal(firstResults[0].status, "quota_empty");
    assert.equal(secondResults.length, 0);
    assert.equal(chatplus.status, "quota_empty");
    assert.equal(chatplus.quotaConfirmedByUpstream, true);
    assert.equal(chatplus.quotaResetAt, nextResetAt);
    assert.equal(chatplus.cooldownUntil, nextResetAt);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天重置后后台仍报告零且没有新时间时延后一小时复查", async () => {
  const pastResetAt = new Date(Date.now() - 1000).toISOString();
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    quotaResetAt: pastResetAt
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "quota_empty",
      quota: 70,
      used: 70,
      balance: 0,
      quotaResetAt: pastResetAt,
      cooldownUntil: null,
      quotaReason: "chat_usage_limit",
      quotaModel: "gemini",
      quotaConfirmedByUpstream: true,
      meta: {
        chatModel: "gemini",
        recoveryUsage: { quota: 70, used: 70, balance: 0, quotaResetAt: pastResetAt },
        referenceUsage: {
          gemini: { quota: 70, used: 70, balance: 0, quotaResetAt: pastResetAt }
        }
      }
    };
  };

  try {
    const firstResults = await recoverUnavailableChatAccounts();
    const secondResults = await recoverUnavailableChatAccounts();
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    const retryAt = Date.parse(chatplus.cooldownUntil || "");

    assert.equal(checkCount, 1);
    assert.equal(firstResults[0].status, "quota_empty");
    assert.equal(secondResults.length, 0);
    assert.ok(retryAt >= Date.now() + 50 * 60 * 1000);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天额度后台恢复并发触发时只核验一次", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    quotaResetAt: new Date(Date.now() - 1000).toISOString()
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  let releaseCheck;
  let reportEntered;
  const entered = new Promise((resolve) => {
    reportEntered = resolve;
  });
  const held = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    reportEntered();
    await held;
    return {
      status: "ok",
      quota: null,
      balance: null,
      meta: {
        chatModel: "gemini",
        recoveryUsage: {
          quota: 70,
          used: 0,
          balance: 70,
          quotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      }
    };
  };

  try {
    const first = recoverUnavailableChatAccounts();
    await entered;
    const second = recoverUnavailableChatAccounts();
    releaseCheck();
    const [firstResults, secondResults] = await Promise.all([first, second]);

    assert.equal(checkCount, 1);
    assert.equal(firstResults[0].recovered, true);
    assert.equal(secondResults[0].recovered, true);
  } finally {
    releaseCheck?.();
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天额度恢复时只放行一个真实探测请求", async () => {
  await saveChatUsageRecoveryFixture({
    lastCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    quotaResetAt: new Date(Date.now() - 1000).toISOString(),
    referenceUsage: {
      gemini: {
        quota: 70,
        used: 70,
        balance: 0,
        quotaResetAt: new Date(Date.now() - 1000).toISOString(),
        period: "24h"
      }
    }
  });

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  let submitCount = 0;
  let releaseFirst;
  let reportEntered;
  const firstEntered = new Promise((resolve) => {
    reportEntered = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  ChatplusClient.prototype.createChatCompletion = async () => {
    submitCount += 1;
    reportEntered();
    await holdFirst;
    return {
      externalId: "single-recovery-probe",
      model: "gemini",
      content: "恢复成功",
      imageUrls: [],
      raw: {}
    };
  };

  try {
    const first = createChatCompletion({
      channel: "chatplus",
      model: "gemini",
      messages: [{ role: "user", content: "第一个恢复探测" }]
    });
    await firstEntered;

    await assert.rejects(
      createChatCompletion({
        channel: "chatplus",
        model: "gemini",
        messages: [{ role: "user", content: "并发恢复探测" }]
      }),
      /正在处理|并发|繁忙|失败/
    );
    assert.equal(submitCount, 1);

    releaseFirst();
    await first;
    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.quotaConfirmedByUpstream, false);
    assert.equal(chatplus.meta.referenceUsage.gemini, undefined);
  } finally {
    releaseFirst?.();
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});

test("聊天调用成功后保留已知的正数额度", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-chat-positive-usage",
      channelId: "shareai",
      name: "Chat Positive Usage",
      username: "chat-positive-usage@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok", quota: 100, balance: 100 },
          chatplus: {
            status: "ok",
            meta: {
              chatModel: "gpt",
              referenceUsage: {
                gpt: {
                  quota: 220,
                  used: 7,
                  balance: 213,
                  quotaResetAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                  period: "12h"
                }
              }
            }
          }
        }
      }
    }]
  });

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  ChatplusClient.prototype.createChatCompletion = async () => ({
    externalId: "positive-usage-chat",
    model: "gpt",
    content: "调用成功",
    imageUrls: [],
    raw: {}
  });

  try {
    await createChatCompletion({
      channel: "chatplus",
      model: "gpt",
      messages: [{ role: "user", content: "保留额度" }]
    });

    const stored = await loadConfig();
    const usage = stored.accounts[0].meta.abilities.chatplus.meta.referenceUsage.gpt;
    assert.equal(usage.quota, 220);
    assert.equal(usage.balance, 213);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});
