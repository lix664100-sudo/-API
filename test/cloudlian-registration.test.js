import assert from "node:assert/strict";
import test from "node:test";
import {
  chatActivationBaseUrl,
  cloudlianChannelBaseUrl,
  createChatAccountActivationService,
  createCloudlianBatchRegistrationService,
  createCloudlianRegistrationService
} from "../src/cloudlian-registration.js";

function clone(value) {
  return structuredClone(value);
}

function createHarness(options = {}) {
  let config = {
    waitTimeoutSec: 30,
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    channels: clone(options.channels || [{
      id: "cloudlian-channel",
      name: "Cloudlian",
      type: "shareai",
      enabled: true,
      settings: {
        chatBaseUrl: "https://cloudlian.cn/",
        drawingBaseUrl: "https://drawing.aishare.icu/",
        enabledAbilities: { drawing: false, chatplus: true }
      }
    }]),
    accounts: clone(options.accounts || [])
  };
  const registered = new Set();
  const usages = new Map();
  const calls = { register: [], exchange: [], proxy: [] };
  let usernameIndex = 0;
  config.accounts.forEach((account) => {
    registered.add(account.username);
    usages.set(account.username, clone(options.initialUsages || { gemini: { quota: 70, balance: 0 } }));
  });

  const loadConfig = async () => clone(config);
  const saveAccount = async (input) => {
    const index = config.accounts.findIndex((item) => item.id === input.id);
    const current = index >= 0 ? config.accounts[index] : {};
    const next = { ...current, ...clone(input) };
    if (index >= 0) config.accounts[index] = next;
    else config.accounts.push(next);
    return clone(config);
  };

  const createClient = ({ account }) => ({
    async json(path, request = {}) {
      if (path === "/frontend-api/getLoginConfig") {
        return {
          code: 1,
          data: {
            isEnableRegister: true,
            isEnableExchange: true,
            isEnableMailRegister: false,
            isEnableRegisterTurnstile: options.turnstile === true,
            isInviteRegister: false
          }
        };
      }
      if (path === "/frontend-api/register") {
        calls.register.push(clone(request.body));
        if (options.registerDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.registerDelayMs));
        }
        registered.add(account.username);
        usages.set(account.username, { gemini: { quota: 0, balance: 0 } });
        return { code: 1, msg: "ok" };
      }
      if (path === "/frontend-api/exchange") {
        calls.exchange.push(clone(request.body));
        if (options.rejectCode && request.body.redemptionCode === options.rejectCode) {
          return { code: 0, msg: "激活码不正确" };
        }
        usages.set(account.username, { gemini: { quota: 70, balance: 70 } });
        if (options.exchangeThrowsAfterApply) throw new Error("目标站响应中断");
        return { code: 1, msg: "ok" };
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async performPortalLogin() {
      if (!registered.has(account.username)) throw new Error("账号不存在");
    },
    async loadAccountUsages() {
      if (!registered.has(account.username)) throw new Error("账号不存在");
      return clone(usages.get(account.username));
    }
  });

  const service = createCloudlianRegistrationService({
    loadConfig,
    saveAccount,
    createClient,
    createUsername: () => `cltest${++usernameIndex}`,
    checkProxyReachability: async (value) => {
      calls.proxy.push(value);
      return options.proxyFails
        ? { ok: false, message: "注册 IP 无法连接目标站。" }
        : { ok: true };
    }
  });
  const activationService = createChatAccountActivationService({
    loadConfig,
    saveAccount,
    createClient
  });

  return {
    service,
    activationService,
    calls,
    config: () => clone(config)
  };
}

test("只允许纯聊天的 cloudlian.cn 渠道使用自动注册", () => {
  const supported = {
    type: "shareai",
    settings: {
      chatBaseUrl: "https://cloudlian.cn/",
      enabledAbilities: { drawing: false, chatplus: true }
    }
  };
  assert.equal(cloudlianChannelBaseUrl(supported), "https://cloudlian.cn");
  assert.equal(cloudlianChannelBaseUrl({
    ...supported,
    settings: { ...supported.settings, enabledAbilities: { drawing: true, chatplus: true } }
  }), "");
  assert.equal(cloudlianChannelBaseUrl({
    type: "chatplus",
    settings: { baseUrl: "https://example.com" }
  }), "");
  assert.equal(chatActivationBaseUrl({
    type: "shareai",
    settings: {
      chatBaseUrl: "https://chat.example.com/",
      enabledAbilities: { drawing: true, chatplus: true }
    }
  }), "https://chat.example.com");
});

test("随机账号注册成功后兑换激活码并自动启用", async () => {
  const harness = createHarness();
  const result = await harness.service({
    channelId: "cloudlian-channel",
    activationCode: "CODE-OK",
    proxyUrl: ""
  });

  assert.equal(result.status, "ready");
  assert.equal(result.username, "cltest1");
  assert.deepEqual(harness.calls.register, [{
    userToken: "cltest1",
    password: "123456",
    email: "",
    emailCode: "",
    inviterId: "",
    token: ""
  }]);
  assert.deepEqual(harness.calls.exchange, [{
    userToken: "cltest1",
    redemptionCode: "CODE-OK"
  }]);
  const [account] = harness.config().accounts;
  assert.equal(account.password, "123456");
  assert.equal(account.enabled, true);
  assert.equal(account.meta.registration.status, "completed");
  assert.equal(JSON.stringify(account).includes("CODE-OK"), false);
});

test("同一激活码并发提交只注册一次，完成后再次提交不会重复兑换", async () => {
  const harness = createHarness({ registerDelayMs: 20 });
  const input = { channelId: "cloudlian-channel", activationCode: "CODE-ONE" };
  const [first, second] = await Promise.all([harness.service(input), harness.service(input)]);

  assert.equal(first.accountId, second.accountId);
  assert.equal(harness.calls.register.length, 1);
  assert.equal(harness.calls.exchange.length, 1);

  const repeated = await harness.service(input);
  assert.equal(repeated.status, "already_bound");
  assert.equal(harness.calls.register.length, 1);
  assert.equal(harness.calls.exchange.length, 1);
});

test("激活码填写错误时保留账号，修正后继续同一个账号", async () => {
  const harness = createHarness({ rejectCode: "CODE-BAD" });
  const first = await harness.service({
    channelId: "cloudlian-channel",
    activationCode: "CODE-BAD"
  });
  assert.equal(first.status, "activation_required");
  assert.equal(harness.config().accounts[0].enabled, true);
  assert.equal(harness.config().accounts[0].status, "activation_required");

  const second = await harness.service({
    channelId: "cloudlian-channel",
    activationCode: "CODE-GOOD",
    resumeAccountId: first.accountId
  });
  assert.equal(second.status, "ready");
  assert.equal(second.accountId, first.accountId);
  assert.equal(harness.calls.register.length, 1);
  assert.equal(harness.config().accounts.length, 1);
  assert.equal(harness.config().accounts[0].enabled, true);
});

test("代理或目标站注册规则不符合时不会创建账号或消耗激活码", async () => {
  const badProxy = createHarness({ proxyFails: true });
  await assert.rejects(
    badProxy.service({
      channelId: "cloudlian-channel",
      activationCode: "CODE-PROXY",
      proxyUrl: "127.0.0.1:8080"
    }),
    /无法连接/
  );
  assert.equal(badProxy.config().accounts.length, 0);
  assert.equal(badProxy.calls.register.length, 0);

  const captcha = createHarness({ turnstile: true });
  await assert.rejects(
    captcha.service({ channelId: "cloudlian-channel", activationCode: "CODE-CAPTCHA" }),
    /人工验证/
  );
  assert.equal(captcha.config().accounts.length, 0);
  assert.equal(captcha.calls.register.length, 0);
});

test("批量注册逐行保留结果并拦截本次重复激活码", async () => {
  let running = 0;
  let maxRunning = 0;
  const calls = [];
  const batch = createCloudlianBatchRegistrationService(async (input) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    calls.push(clone(input));
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    return { accountId: `account-${calls.length}`, status: "ready", message: "完成" };
  });

  const result = await batch({
    channelId: "cloudlian-channel",
    rows: [
      { rowId: "1", activationCode: "CODE-1", proxyUrl: "1.1.1.1:80" },
      { rowId: "2", activationCode: "CODE-2", proxyUrl: "" },
      { rowId: "3", activationCode: "CODE-1", proxyUrl: "" },
      { rowId: "4", activationCode: "CODE-4", proxyUrl: "" }
    ]
  });

  assert.equal(calls.length, 3);
  assert.ok(maxRunning <= 3);
  assert.equal(result.results[2].status, "duplicate");
  assert.deepEqual(result.summary, { total: 4, success: 3, pending: 0, failed: 1 });
  assert.equal(calls[0].proxyUrl, "1.1.1.1:80");
});

test("套餐到期账号可以用新激活码续期并保留账号配置", async () => {
  const account = {
    id: "expired-account",
    channelId: "cloudlian-channel",
    name: "到期账号",
    username: "expired-user",
    password: "123456",
    proxyUrl: "127.0.0.1:8080",
    enabled: true,
    status: "subscription_expired",
    meta: { abilities: { chatplus: { status: "subscription_expired" } } }
  };
  const harness = createHarness({ accounts: [account] });
  const result = await harness.activationService({
    accountId: account.id,
    activationCode: "RENEW-CODE"
  });

  assert.equal(result.status, "ready");
  assert.equal(harness.calls.register.length, 0);
  assert.equal(harness.calls.exchange.length, 1);
  const saved = harness.config().accounts[0];
  assert.equal(saved.id, account.id);
  assert.equal(saved.proxyUrl, account.proxyUrl);
  assert.equal(saved.enabled, true);
  assert.equal(saved.status, "unknown");
  assert.equal(saved.meta.abilities.chatplus.status, "unknown");
  assert.equal(JSON.stringify(saved).includes("RENEW-CODE"), false);
});

test("未激活账号兑换失败时继续保留，换正确激活码后恢复", async () => {
  const account = {
    id: "inactive-account",
    channelId: "cloudlian-channel",
    name: "未激活账号",
    username: "inactive-user",
    password: "123456",
    enabled: true,
    status: "activation_required",
    meta: {
      registration: { provider: "cloudlian", status: "activation_required" },
      abilities: { chatplus: { status: "activation_required" } }
    }
  };
  const harness = createHarness({ accounts: [account], rejectCode: "BAD-RENEW" });
  const failed = await harness.activationService({ accountId: account.id, activationCode: "BAD-RENEW" });
  assert.equal(failed.status, "activation_failed");
  assert.equal(harness.config().accounts[0].enabled, true);
  assert.equal(harness.config().accounts[0].status, "activation_required");

  const completed = await harness.activationService({ accountId: account.id, activationCode: "GOOD-RENEW" });
  assert.equal(completed.status, "ready");
  assert.equal(harness.config().accounts[0].meta.registration.status, "completed");
});

test("同一目标站的激活码不能绑定到第二个账号", async () => {
  const accounts = ["first", "second"].map((name) => ({
    id: `${name}-account`,
    channelId: "cloudlian-channel",
    name,
    username: `${name}-user`,
    password: "123456",
    enabled: true,
    status: "subscription_expired",
    meta: {}
  }));
  const harness = createHarness({ accounts });
  await harness.activationService({ accountId: accounts[0].id, activationCode: "ONE-TIME-CODE" });
  await assert.rejects(
    harness.activationService({ accountId: accounts[1].id, activationCode: "ONE-TIME-CODE" }),
    /已经用于其他账号/
  );
  assert.equal(harness.calls.exchange.length, 1);
});

test("自动注册和已有账号续期并发时同一激活码只处理一次", async () => {
  const existing = {
    id: "existing-account",
    channelId: "cloudlian-channel",
    name: "已有账号",
    username: "existing-user",
    password: "123456",
    enabled: true,
    status: "subscription_expired",
    meta: {}
  };
  const harness = createHarness({ accounts: [existing], registerDelayMs: 20 });
  const registration = harness.service({
    channelId: "cloudlian-channel",
    activationCode: "SHARED-CODE"
  });
  const renewal = harness.activationService({
    accountId: existing.id,
    activationCode: "SHARED-CODE"
  });
  const [registered, renewed] = await Promise.allSettled([registration, renewal]);

  assert.equal(registered.status, "fulfilled");
  assert.equal(renewed.status, "rejected");
  assert.match(renewed.reason.message, /正在处理中/);
  assert.equal(harness.calls.exchange.length, 1);
});

test("续期码无效时保留账号原来的套餐到期状态", async () => {
  const account = {
    id: "expired-account",
    channelId: "cloudlian-channel",
    name: "到期账号",
    username: "expired-user",
    password: "123456",
    enabled: true,
    status: "subscription_expired",
    message: "套餐已过期",
    meta: { abilities: { chatplus: { status: "subscription_expired" } } }
  };
  const harness = createHarness({ accounts: [account], rejectCode: "BAD-CODE" });
  const result = await harness.activationService({ accountId: account.id, activationCode: "BAD-CODE" });

  assert.equal(result.status, "activation_failed");
  const saved = harness.config().accounts[0];
  assert.equal(saved.enabled, true);
  assert.equal(saved.status, "subscription_expired");
  assert.equal(saved.meta.abilities.chatplus.status, "subscription_expired");
});

test("兑换响应中断但额度已经变化时自动确认成功，不会重复兑换", async () => {
  const account = {
    id: "uncertain-account",
    channelId: "cloudlian-channel",
    name: "待续期账号",
    username: "uncertain-user",
    password: "123456",
    enabled: true,
    status: "subscription_expired",
    meta: {}
  };
  const harness = createHarness({ accounts: [account], exchangeThrowsAfterApply: true });
  const result = await harness.activationService({ accountId: account.id, activationCode: "RECOVER-CODE" });

  assert.equal(result.status, "ready");
  assert.equal(harness.calls.exchange.length, 1);
  assert.equal(harness.config().accounts[0].status, "unknown");
});

test("聊天绘图共账号渠道激活后会等待两边一起检测", async () => {
  const channel = {
    id: "combined-channel",
    name: "共账号渠道",
    type: "shareai",
    enabled: true,
    settings: {
      chatBaseUrl: "https://chat.example.com/",
      drawingBaseUrl: "https://drawing.example.com/",
      enabledAbilities: { drawing: true, chatplus: true }
    }
  };
  const account = {
    id: "combined-account",
    channelId: channel.id,
    name: "共用账号",
    username: "combined-user",
    password: "123456",
    enabled: true,
    status: "subscription_expired",
    meta: {
      abilities: {
        drawing: { status: "subscription_expired" },
        chatplus: { status: "subscription_expired" }
      }
    }
  };
  const harness = createHarness({ channels: [channel], accounts: [account] });
  const result = await harness.activationService({ accountId: account.id, activationCode: "COMBINED-CODE" });

  assert.equal(result.status, "ready");
  const saved = harness.config().accounts[0];
  assert.equal(saved.meta.abilities.chatplus.status, "unknown");
  assert.equal(saved.meta.abilities.drawing.status, "unknown");
});
