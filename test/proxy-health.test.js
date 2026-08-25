import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-proxy-health-"));
process.env.DATA_DIR = dataDir;

const {
  checkProxyReachability,
  createProxyCircuitProtection
} = await import("../src/proxy.js");
const { checkAccount, checkAllAccounts, createTextTask } = await import("../src/channel-manager.js");
const { DrawingClient } = await import("../src/channels/drawing.js");
const { closeStorage, loadConfig, saveConfig } = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    proxyUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

function delayedResponse(response, delayMs, statusCode = 204) {
  setTimeout(() => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(statusCode);
    response.end();
  }, delayMs);
}

test("手动代理检测第一次超时后会复试，成功后只查询一次出口地址", async () => {
  let targetAttempts = 0;
  let exitIpQueries = 0;
  const { server, proxyUrl } = await listen((request, response) => {
    if (request.url.includes("target.example.test")) {
      targetAttempts += 1;
      if (targetAttempts === 1) delayedResponse(response, 60);
      else {
        response.writeHead(204);
        response.end();
      }
      return;
    }
    if (request.url.includes("ip.example.test")) {
      exitIpQueries += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ip":"203.0.113.9"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const result = await checkProxyReachability(
      proxyUrl,
      "http://target.example.test/health",
      20,
      { retryDelayMs: 5, exitIpUrls: ["http://ip.example.test/"] }
    );

    assert.equal(result.ok, true);
    assert.equal(result.realIp, "203.0.113.9");
    assert.equal(result.attemptCount, 2);
    assert.equal(targetAttempts, 2);
    assert.equal(exitIpQueries, 1);
  } finally {
    await closeServer(server);
  }
});

test("手动代理检测连续两次超时后才判定不可用", async () => {
  let targetAttempts = 0;
  const { server, proxyUrl } = await listen((_request, response) => {
    targetAttempts += 1;
    delayedResponse(response, 60);
  });

  try {
    const result = await checkProxyReachability(
      proxyUrl,
      "http://target.example.test/health",
      20,
      { retryDelayMs: 5, exitIpUrls: [] }
    );

    assert.equal(result.ok, false);
    assert.equal(result.message, "代理连接超时");
    assert.equal(result.attemptCount, 2);
    assert.equal(targetAttempts, 2);
  } finally {
    await closeServer(server);
  }
});

test("手动代理检测不会把代理认证失败误判成可用", async () => {
  let targetAttempts = 0;
  const { server, proxyUrl } = await listen((_request, response) => {
    targetAttempts += 1;
    response.writeHead(407, { "proxy-authenticate": 'Basic realm="proxy"' });
    response.end();
  });

  try {
    const result = await checkProxyReachability(
      proxyUrl,
      "http://target.example.test/health",
      20,
      { retryDelayMs: 5, exitIpUrls: [] }
    );

    assert.equal(result.ok, false);
    assert.equal(result.message, "代理账号或密码不正确");
    assert.equal(result.attemptCount, 2);
    assert.equal(targetAttempts, 2);
  } finally {
    await closeServer(server);
  }
});

test("代理线路连续失败两次后暂停，恢复时只放行一个尝试", async () => {
  const protection = createProxyCircuitProtection({
    failureThreshold: 2,
    recoveryDelayMs: 30
  });
  const proxyUrl = "http://proxy.example.test:8080";
  const timeoutError = () => Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });

  await assert.rejects(protection.execute(proxyUrl, async () => { throw timeoutError(); }), /ETIMEDOUT/);
  assert.equal(protection.state(proxyUrl).status, "closed");

  await assert.rejects(
    protection.execute(proxyUrl, async () => { throw new Error("账号额度不足"); }),
    /账号额度不足/
  );
  await assert.rejects(protection.execute(proxyUrl, async () => { throw timeoutError(); }), /ETIMEDOUT/);
  assert.equal(protection.state(proxyUrl).status, "closed");

  await assert.rejects(
    protection.execute(proxyUrl, async () => { throw timeoutError(); }),
    (error) => error.code === "PROXY_COOLDOWN"
  );
  assert.equal(protection.state(proxyUrl).status, "open");

  let blockedWorkCalls = 0;
  await assert.rejects(
    protection.execute(proxyUrl, async () => { blockedWorkCalls += 1; }),
    (error) => error.code === "PROXY_COOLDOWN"
  );
  assert.equal(blockedWorkCalls, 0);

  await new Promise((resolve) => setTimeout(resolve, 40));
  let recoveryCalls = 0;
  const recoveryResults = await Promise.allSettled([
    protection.execute(proxyUrl, async () => {
      recoveryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw timeoutError();
    }),
    protection.execute(proxyUrl, async () => {
      recoveryCalls += 1;
      throw timeoutError();
    })
  ]);

  assert.equal(recoveryCalls, 1);
  assert.equal(recoveryResults.every((item) => item.status === "rejected" && item.reason.code === "PROXY_COOLDOWN"), true);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await protection.execute(proxyUrl, async () => "恢复成功"), "恢复成功");
  assert.equal(protection.state(proxyUrl).status, "closed");
});

test("检测全部账号时不再额外探测代理，并同时处理多个账号", async () => {
  let targetChecks = 0;
  let exitIpConnects = 0;
  let activeChecks = 0;
  let maxActiveChecks = 0;
  const { server, proxyUrl } = await listen((request, response) => {
    targetChecks += 1;
    response.writeHead(204);
    response.end();
  });
  server.on("connect", (_request, socket) => {
    exitIpConnects += 1;
    socket.end();
  });

  const originalCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => {
    activeChecks += 1;
    maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeChecks -= 1;
    return {
      status: "ok",
      quota: 100,
      balance: 80,
      message: "绘图账号可用"
    };
  };

  try {
    const config = await loadConfig();
    await saveConfig({
      ...config,
      defaultChannel: "shared-proxy",
      channels: [{
        id: "shared-proxy",
        name: "共享代理渠道",
        type: "shareai",
        enabled: true,
        priority: 1,
        settings: {
          drawingBaseUrl: "http://target.example.test",
          enabledAbilities: { drawing: true, chatplus: false }
        }
      }],
      accounts: ["account-a", "account-b"].map((id) => ({
        id,
        channelId: "shared-proxy",
        name: id,
        username: `${id}@example.test`,
        password: "password",
        proxyUrl,
        enabled: true,
        status: "ok",
        meta: { abilities: { drawing: { status: "ok", quota: 100, balance: 80 } } }
      }))
    });

    const results = await checkAllAccounts();
    const stored = await loadConfig();

    assert.equal(results.length, 2);
    assert.equal(results.every((item) => item.ok), true);
    assert.equal(maxActiveChecks, 2);
    assert.equal(targetChecks, 0);
    assert.equal(exitIpConnects, 0);
    assert.equal(stored.accounts.every((account) => account.meta.proxyCheck.status === "ok"), true);
  } finally {
    DrawingClient.prototype.check = originalCheck;
    await closeServer(server);
  }
});

test("同时重复检测同一个账号时只登录一次", async () => {
  const originalCheck = DrawingClient.prototype.check;
  let checkCalls = 0;
  DrawingClient.prototype.check = async () => {
    checkCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: "ok", quota: 100, balance: 80, message: "绘图账号可用" };
  };

  try {
    const config = await loadConfig();
    await saveConfig({
      ...config,
      defaultChannel: "deduplicated-check",
      channels: [{
        id: "deduplicated-check",
        name: "重复检测保护",
        type: "shareai",
        enabled: true,
        priority: 1,
        settings: {
          drawingBaseUrl: "https://drawing.example.test",
          enabledAbilities: { drawing: true, chatplus: false }
        }
      }],
      accounts: [{
        id: "deduplicated-account",
        channelId: "deduplicated-check",
        name: "重复检测账号",
        username: "deduplicated@example.test",
        password: "password",
        enabled: true,
        status: "ok",
        meta: { abilities: { drawing: { status: "ok", quota: 100, balance: 80 } } }
      }]
    });

    const [first, second] = await Promise.all([
      checkAccount("deduplicated-account"),
      checkAccount("deduplicated-account")
    ]);

    assert.equal(first.status, "ok");
    assert.equal(second.status, "ok");
    assert.equal(checkCalls, 1);
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("正常生图任务不再额外探测代理", async () => {
  let proxyRequests = 0;
  const { server, proxyUrl } = await listen((_request, response) => {
    proxyRequests += 1;
    response.writeHead(204);
    response.end();
  });
  server.on("connect", (_request, socket) => {
    proxyRequests += 1;
    socket.end();
  });

  const originalCheck = DrawingClient.prototype.check;
  const originalCreateTextTask = DrawingClient.prototype.createTextTask;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 100,
    balance: 80,
    message: "绘图账号可用"
  });
  DrawingClient.prototype.createTextTask = async (input) => ({
    externalId: "proxy-no-preflight-task",
    status: "processing",
    taskType: "text2img",
    prompt: input.prompt,
    imageCount: 0,
    imageUrls: [],
    raw: {}
  });

  try {
    const config = await loadConfig();
    await saveConfig({
      ...config,
      defaultChannel: "task-proxy",
      channels: [{
        id: "task-proxy",
        name: "任务代理渠道",
        type: "shareai",
        enabled: true,
        priority: 1,
        settings: {
          drawingBaseUrl: "http://target.example.test",
          enabledAbilities: { drawing: true, chatplus: false }
        }
      }],
      accounts: [{
        id: "task-proxy-account",
        channelId: "task-proxy",
        name: "任务代理账号",
        username: "task-proxy@example.test",
        password: "password",
        proxyUrl,
        enabled: true,
        status: "ok",
        meta: { abilities: { drawing: { status: "ok", quota: 100, balance: 80 } } }
      }]
    });

    const task = await createTextTask({ channel: "task-proxy:drawing", prompt: "不额外检测代理" });

    assert.equal(task.externalId, "proxy-no-preflight-task");
    assert.equal(proxyRequests, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    DrawingClient.prototype.check = originalCheck;
    DrawingClient.prototype.createTextTask = originalCreateTextTask;
    await closeServer(server);
  }
});
