import { exec } from "node:child_process";
import { promisify } from "node:util";
import { normalizeProxyUrl, safeProxyEndpoint } from "./proxy.js";

const execAsync = promisify(exec);
const minimumProxyTimeoutMs = 5_000;
const maximumProxyTimeoutMs = 30_000;

function proxyExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ? `${expiresAt}T23:59:59+08:00`
    : expiresAt;
  const time = Date.parse(dateText);
  return Number.isFinite(time) && time < now;
}

function shuffle(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function gitProxyUrl(value) {
  return normalizeProxyUrl(value).replace(/^socks5:/i, "socks5h:");
}

export function accountGitProxies(config = {}, options = {}) {
  const now = Number(options.now ?? Date.now());
  const random = typeof options.random === "function" ? options.random : Math.random;
  const unique = new Map();

  for (const account of config.accounts || []) {
    if (account?.enabled === false) continue;
    const value = String(account?.proxyUrl || account?.proxy || "").trim();
    if (!value) continue;
    const endpoint = safeProxyEndpoint(value);
    if (!endpoint.proxyHost || proxyExpired(endpoint.expiresAt, now)) continue;
    const url = gitProxyUrl(value);
    if (!url || unique.has(url)) continue;
    unique.set(url, { url });
  }

  return shuffle([...unique.values()], random);
}

export function gitProxyEnvironment(proxyUrl, baseEnv = process.env) {
  if (!proxyUrl) return { ...baseEnv };
  return {
    ...baseEnv,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.proxy",
    GIT_CONFIG_VALUE_0: proxyUrl
  };
}

export function updateCommandEnvironment(gitEnv = process.env, npmRegistry = "") {
  return {
    ...gitEnv,
    npm_config_registry: String(npmRegistry || "https://registry.npmmirror.com").trim()
  };
}

export function redactGitProxyCredentials(value, env = {}) {
  const proxyUrl = String(env.GIT_CONFIG_VALUE_0 || "");
  let text = String(value || "");
  if (!proxyUrl) return text;
  text = text.split(proxyUrl).join("[账号代理]");
  try {
    const parsed = new URL(proxyUrl);
    const encodedPassword = parsed.password;
    const decodedPassword = decodeURIComponent(encodedPassword);
    if (encodedPassword) text = text.split(encodedPassword).join("***");
    if (decodedPassword && decodedPassword !== encodedPassword) {
      text = text.split(decodedPassword).join("***");
    }
  } catch {
    // The complete proxy value was already removed above.
  }
  return text;
}

function commandOptions(cwd, timeoutMs, maxBuffer, env = process.env) {
  return {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer,
    env
  };
}

function commandErrorText(error) {
  return String(error?.stderr || error?.message || "");
}

export async function inspectGitUpdateState(options = {}) {
  const {
    cwd,
    config = {},
    timeoutMs = 120_000,
    maxBuffer = 2 * 1024 * 1024,
    execute = execAsync,
    baseEnv = process.env,
    random = Math.random,
    now = Date.now()
  } = options;
  const localOptions = commandOptions(cwd, timeoutMs, maxBuffer, baseEnv);

  try {
    const inside = await execute("git rev-parse --is-inside-work-tree", localOptions);
    if (String(inside.stdout || "").trim() !== "true") {
      return { checked: false, message: "当前目录不是代码仓库，未执行更新。" };
    }

    const local = await execute("git rev-parse HEAD", localOptions);
    const upstream = await execute('git rev-parse --abbrev-ref --symbolic-full-name "@{u}"', localOptions);
    const proxies = accountGitProxies(config, { random, now });
    let gitEnv = null;
    let lastFetchError = null;

    if (proxies.length) {
      const maximumAttempts = Math.max(1, Math.floor(timeoutMs / minimumProxyTimeoutMs));
      const candidates = proxies.slice(0, maximumAttempts);
      const proxyTimeoutMs = Math.max(
        minimumProxyTimeoutMs,
        Math.min(maximumProxyTimeoutMs, Math.floor(timeoutMs / candidates.length))
      );
      for (const proxy of candidates) {
        const candidateEnv = gitProxyEnvironment(proxy.url, baseEnv);
        try {
          await execute(
            "git fetch --quiet",
            commandOptions(cwd, proxyTimeoutMs, maxBuffer, candidateEnv)
          );
          gitEnv = candidateEnv;
          break;
        } catch (error) {
          lastFetchError = error;
        }
      }
      if (!gitEnv) {
        return {
          checked: false,
          message: "账号代理均无法连接 GitHub，未执行更新。",
          stderr: redactGitProxyCredentials(
            commandErrorText(lastFetchError),
            gitProxyEnvironment(candidates.at(-1)?.url, baseEnv)
          )
        };
      }
    } else {
      try {
        await execute("git fetch --quiet", localOptions);
        gitEnv = { ...baseEnv };
      } catch (error) {
        return {
          checked: false,
          message: "无法连接代码仓库，未执行更新。",
          stderr: commandErrorText(error)
        };
      }
    }

    const remote = await execute(
      'git rev-parse "@{u}"',
      commandOptions(cwd, timeoutMs, maxBuffer, gitEnv)
    );
    const localCommit = String(local.stdout || "").trim();
    const remoteCommit = String(remote.stdout || "").trim();
    return {
      checked: true,
      upToDate: Boolean(localCommit && remoteCommit && localCommit === remoteCommit),
      localCommit,
      remoteCommit,
      upstream: String(upstream.stdout || "").trim(),
      gitEnv
    };
  } catch (error) {
    const stderr = commandErrorText(error);
    if (/not a git repository/i.test(stderr)) {
      return { checked: false, message: "当前目录不是代码仓库，未执行更新。", stderr };
    }
    return {
      checked: false,
      message: "无法确认当前是否为最新版，未执行更新。",
      stderr
    };
  }
}
