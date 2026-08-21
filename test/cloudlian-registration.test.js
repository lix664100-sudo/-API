import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudlianChannelBaseUrl,
  createCloudlianRegistrationService
} from "../src/cloudlian-registration.js";

function clone(value) {
  return structuredClone(value);
}

function createHarness(options = {}) {
  let config = {
    waitTimeoutSec: 30,
    concurrency: { chat: 3, drawingImage: 2, chatImage: 2 },
    channels: [{
      id: "cloudlian-channel",
      name: "Cloudlian",
      type: "shareai",
      enabled: true,
      settings: {
        chatBaseUrl: "https://cloudlian.cn/",
        drawingBaseUrl: "https://drawing.aishare.icu/",
        enabledAbilities: { drawing: false, chatplus: true }
      }
    }],
    accounts: []
  };
  const registered = new Set();
  const usages = new Map();
  const calls = { register: [], exchange: [], proxy: [] };
  let usernameIndex = 0;

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
        return { code: 1, msg: "ok" };
      }
      throw new Error(`unexpected path: ${path}`);
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

  return {
    service,
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
  assert.equal(first.status, "activation_failed");
  assert.equal(harness.config().accounts[0].enabled, false);

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
