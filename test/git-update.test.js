import assert from "node:assert/strict";
import test from "node:test";
import {
  accountGitProxies,
  gitProxyEnvironment,
  inspectGitUpdateState,
  redactGitProxyCredentials,
  updateCommandEnvironment
} from "../src/git-update.js";

const activeProxyA = "proxy-a.example.test|9001|user-a|password-a|2026-08-10";
const activeProxyB = "http://user-b:password-b@proxy-b.example.test:9002";

function updateConfig(accounts) {
  return { accounts };
}

function account(proxyUrl, options = {}) {
  return {
    id: options.id || proxyUrl,
    enabled: options.enabled !== false,
    proxyUrl
  };
}

function successfulLocalCommand(command) {
  if (command === "git rev-parse --is-inside-work-tree") return { stdout: "true\n" };
  if (command === "git rev-parse HEAD") return { stdout: "local-commit\n" };
  if (command.includes("--symbolic-full-name")) return { stdout: "origin/main\n" };
  if (command === 'git rev-parse "@{u}"') return { stdout: "remote-commit\n" };
  return { stdout: "" };
}

test("账号 Git 代理会排除停用、过期和无效配置，并去掉重复代理", () => {
  const proxies = accountGitProxies(updateConfig([
    account(activeProxyA, { id: "a" }),
    account(activeProxyA, { id: "duplicate-a" }),
    account("proxy-disabled.example.test|9003|user|password|2026-08-10", { enabled: false }),
    account("proxy-expired.example.test|9004|user|password|2026-07-26"),
    account("not-a-valid-pipe|bad"),
    account(activeProxyB, { id: "b" })
  ]), {
    now: Date.parse("2026-07-27T00:00:00+08:00"),
    random: () => 0.999
  });

  assert.equal(proxies.length, 2);
  assert.match(proxies[0].url, /^socks5h:\/\/user-a:password-a@proxy-a\.example\.test:9001$/);
  assert.equal(proxies[1].url, activeProxyB);
});

test("服务器直连失败后，Git 检查遇到坏代理会自动换下一条", async () => {
  const attempts = [];
  const timeouts = [];
  const fetch = async (options) => {
    const proxyUrl = options.env.GIT_CONFIG_VALUE_0;
    const route = proxyUrl ? new URL(proxyUrl).hostname : "direct";
    attempts.push(route);
    timeouts.push(options.timeout);
    if (!proxyUrl) {
      const error = new Error("direct failed");
      error.stderr = "direct failed";
      throw error;
    }
    if (proxyUrl.includes("proxy-a.example.test")) {
      const error = new Error("first proxy failed");
      error.stderr = "first proxy failed";
      throw error;
    }
  };

  const result = await inspectGitUpdateState({
    cwd: "/test/repo",
    config: updateConfig([account(activeProxyA), account(activeProxyB)]),
    execute: async (command) => successfulLocalCommand(command),
    fetch,
    baseEnv: { TEST_ENV: "kept" },
    random: () => 0.999,
    now: Date.parse("2026-07-27T00:00:00+08:00"),
    timeoutMs: 180_000
  });

  assert.deepEqual(attempts, ["direct", "proxy-a.example.test", "proxy-b.example.test"]);
  assert.deepEqual(timeouts, [60_000, 30_000, 30_000]);
  assert.equal(result.checked, true);
  assert.equal(result.upToDate, false);
  assert.equal(result.gitEnv.TEST_ENV, "kept");
  assert.equal(new URL(result.gitEnv.GIT_CONFIG_VALUE_0).hostname, "proxy-b.example.test");
});

test("首次直连和所有账号代理失败后会再次尝试服务器直连", async () => {
  const attempts = [];
  const fetch = async (options) => {
    const proxyUrl = options.env.GIT_CONFIG_VALUE_0;
    attempts.push(proxyUrl ? new URL(proxyUrl).hostname : "direct");
    if (attempts.length < 4) {
      const error = new Error("proxy failed");
      error.stderr = proxyUrl
        ? `无法连接 ${options.env.GIT_CONFIG_VALUE_0}`
        : "服务器直连失败";
      throw error;
    }
  };

  const result = await inspectGitUpdateState({
    cwd: "/test/repo",
    config: updateConfig([account(activeProxyA), account(activeProxyB)]),
    execute: async (command) => successfulLocalCommand(command),
    fetch,
    baseEnv: { TEST_ENV: "direct-fallback" },
    random: () => 0.999,
    now: Date.parse("2026-07-27T00:00:00+08:00")
  });

  assert.deepEqual(attempts, ["direct", "proxy-a.example.test", "proxy-b.example.test", "direct"]);
  assert.equal(result.checked, true);
  assert.equal(result.gitEnv.TEST_ENV, "direct-fallback");
  assert.equal(result.gitEnv.GIT_CONFIG_VALUE_0, undefined);
});

test("代理和服务器直连都失败时停止更新并隐藏代理密码", async () => {
  const fetch = async (options) => {
    const error = new Error("fetch failed");
    error.stderr = options.env.GIT_CONFIG_VALUE_0
      ? `无法连接 ${options.env.GIT_CONFIG_VALUE_0}`
      : "服务器直连失败";
    throw error;
  };

  const result = await inspectGitUpdateState({
    cwd: "/test/repo",
    config: updateConfig([account(activeProxyA), account(activeProxyB)]),
    execute: async (command) => successfulLocalCommand(command),
    fetch,
    random: () => 0.999,
    now: Date.parse("2026-07-27T00:00:00+08:00")
  });

  assert.equal(result.checked, false);
  assert.equal(result.message, "账号代理和服务器直连都无法连接代码仓库，未执行更新。");
  assert.doesNotMatch(result.stderr, /password-a|password-b/);
  assert.match(result.stderr, /\[账号代理\]/);
  assert.match(result.stderr, /服务器直连（首次）：服务器直连失败/);
  assert.match(result.stderr, /服务器直连（重试）：服务器直连失败/);
});

test("没有可用账号代理时保留原来的直连检查", async () => {
  let fetchEnv;
  const fetch = async (options) => { fetchEnv = options.env; };

  const result = await inspectGitUpdateState({
    cwd: "/test/repo",
    config: updateConfig([]),
    execute: async (command) => successfulLocalCommand(command),
    fetch,
    baseEnv: { TEST_ENV: "direct" }
  });

  assert.equal(result.checked, true);
  assert.equal(fetchEnv.TEST_ENV, "direct");
  assert.equal(fetchEnv.GIT_CONFIG_VALUE_0, undefined);
});

test("没有可用账号代理时，直连超时会自动重试并显示明确原因", async () => {
  const timeouts = [];
  const fetch = async (options) => {
    timeouts.push(options.timeout);
    const error = new Error("Command failed: git fetch --quiet");
    error.killed = true;
    error.signal = "SIGTERM";
    throw error;
  };

  const result = await inspectGitUpdateState({
    cwd: "/test/repo",
    config: updateConfig([]),
    execute: async (command) => successfulLocalCommand(command),
    fetch,
    timeoutMs: 180_000
  });

  assert.deepEqual(timeouts, [90_000, 90_000]);
  assert.equal(result.checked, false);
  assert.equal(result.message, "无法连接代码仓库，已自动重试，未执行更新。");
  assert.match(result.stderr, /服务器直连（首次）：连接代码仓库超时。/);
  assert.match(result.stderr, /服务器直连（重试）：连接代码仓库超时。/);
  assert.doesNotMatch(result.stderr, /Command failed/);
});

test("正式更新输出不会泄露代理密码", () => {
  const env = gitProxyEnvironment("socks5h://user:secret@proxy.example.test:9001");
  const output = redactGitProxyCredentials(
    "failed with socks5h://user:secret@proxy.example.test:9001 and secret",
    env
  );

  assert.equal(output, "failed with [账号代理] and ***");
});

test("正式更新使用国内 npm 下载源并保留选中的 Git 代理", () => {
  const gitEnv = gitProxyEnvironment("socks5h://user:secret@proxy.example.test:9001", {
    TEST_ENV: "kept"
  });
  const env = updateCommandEnvironment(gitEnv);

  assert.equal(env.TEST_ENV, "kept");
  assert.equal(env.GIT_CONFIG_VALUE_0, "socks5h://user:secret@proxy.example.test:9001");
  assert.equal(env.npm_config_registry, "https://registry.npmmirror.com");
});
