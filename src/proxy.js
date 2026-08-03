import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";
import {
  BrokenCircuitError,
  CircuitState,
  ConsecutiveBreaker,
  circuitBreaker,
  handleWhen
} from "cockatiel";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PROXY_EXIT_IP_URLS = [
  "https://api.ipify.org?format=json"
];
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;
const IPV6_RE = /\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:.]{1,}\b/i;
const DEFAULT_PROXY_FAILURE_THRESHOLD = 2;
const DEFAULT_PROXY_RECOVERY_DELAY_MS = 5 * 60 * 1000;

export function parsePipeProxy(value) {
  const text = String(value || "").trim();
  if (!text.includes("|")) return null;

  const parts = text.split("|").map((part) => part.trim());
  if (parts.length < 4) return null;

  const [host, portText, username, password, expiresAt = ""] = parts;
  const port = Number(portText);
  if (!host || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    host,
    port: String(port),
    username,
    password,
    expiresAt
  };
}

export function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const pipeProxy = parsePipeProxy(text);
  if (pipeProxy) {
    const user = encodeURIComponent(pipeProxy.username);
    const password = encodeURIComponent(pipeProxy.password);
    return `socks5://${user}:${password}@${pipeProxy.host}:${pipeProxy.port}`;
  }

  return URL_SCHEME_RE.test(text) ? text : `http://${text}`;
}

export function safeProxyEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) {
    return {
      proxyConfigured: false,
      proxyLabel: "默认服务器IP",
      proxyProtocol: "",
      proxyHost: "",
      proxyPort: ""
    };
  }

  const pipeProxy = parsePipeProxy(text);
  if (pipeProxy) {
    return {
      proxyConfigured: true,
      proxyLabel: pipeProxy.host,
      proxyProtocol: "socks5",
      proxyHost: pipeProxy.host,
      proxyPort: pipeProxy.port,
      expiresAt: pipeProxy.expiresAt
    };
  }

  try {
    const url = new URL(normalizeProxyUrl(text));
    return {
      proxyConfigured: true,
      proxyLabel: url.hostname || "已配置代理",
      proxyProtocol: url.protocol.replace(/:$/, ""),
      proxyHost: url.hostname || "",
      proxyPort: url.port || "",
      expiresAt: ""
    };
  } catch {
    return {
      proxyConfigured: true,
      proxyLabel: "已配置代理",
      proxyProtocol: "",
      proxyHost: "",
      proxyPort: "",
      expiresAt: ""
    };
  }
}

function proxyExpired(expiresAt) {
  if (!expiresAt) return false;
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ? `${expiresAt}T23:59:59+08:00`
    : expiresAt;
  const time = Date.parse(dateText);
  return Number.isFinite(time) && time < Date.now();
}

function extractIpText(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    const json = JSON.parse(text);
    const ip = extractIpText(json.ip || json.query || json.origin || "");
    if (ip) return ip;
  } catch {
    // Plain text IP responses are handled below.
  }

  return text.match(IPV4_RE)?.[0] || text.match(IPV6_RE)?.[0] || "";
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new URL(url), {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function lookupProxyExitIp(agent, timeoutMs, urls = PROXY_EXIT_IP_URLS) {
  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        redirect: "follow",
        agent
      }, timeoutMs);
      const text = await response.text();
      if (!response.ok) throw new Error(`IP 查询失败：${response.status}`);
      const ip = extractIpText(text);
      if (!ip) throw new Error("没有拿到真实代理 IP");
      return ip;
    } catch {
      // 出口地址只用于展示，查询失败不能把可用代理判成故障。
    }
  }
  return "";
}

async function checkTargetReachable(agent, targetUrl, timeoutMs) {
  const response = await fetchWithTimeout(targetUrl, {
    method: "HEAD",
    redirect: "manual",
    agent
  }, timeoutMs);
  response.body?.destroy?.();
  if (response.status === 407) {
    const error = new Error("代理账号或密码不正确");
    error.code = "PROXY_AUTH_REQUIRED";
    throw error;
  }
  return response;
}

function proxyCheckFailureMessage(error) {
  if (error?.name === "AbortError") return "代理连接超时";
  if (error?.code === "PROXY_AUTH_REQUIRED") return "代理账号或密码不正确";
  return "代理无法连接目标站";
}

export async function checkProxyReachability(value, targetUrl, timeoutMs = 8000, options = {}) {
  const endpoint = safeProxyEndpoint(value);
  if (!endpoint.proxyConfigured) return { ok: true, ...endpoint };
  if (!endpoint.proxyHost) return { ok: false, ...endpoint, message: "代理 IP 格式不正确" };
  if (proxyExpired(endpoint.expiresAt)) return { ok: false, ...endpoint, message: "代理 IP 已到期" };

  const agent = new ProxyAgent({ getProxyForUrl: () => normalizeProxyUrl(value) });
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250));
  const startedAt = Date.now();
  let lastError = null;
  let attemptCount = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    attemptCount += 1;
    try {
      await checkTargetReachable(agent, targetUrl, timeoutMs);
      const realIp = await lookupProxyExitIp(
        agent,
        Math.min(timeoutMs, 3000),
        Array.isArray(options.exitIpUrls) ? options.exitIpUrls : PROXY_EXIT_IP_URLS
      );
      return {
        ok: true,
        ...endpoint,
        realIp,
        checkedAt: new Date().toISOString(),
        attemptCount,
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return {
    ok: false,
    ...endpoint,
    realIp: "",
    checkedAt: new Date().toISOString(),
    attemptCount,
    latencyMs: Date.now() - startedAt,
    message: proxyCheckFailureMessage(lastError)
  };
}

export function isProxyConnectionError(error) {
  if (!error) return false;
  if (error.proxyFailed === true) return true;
  const code = String(error.code || error.curlCode || "").trim().toUpperCase();
  if (code.startsWith("IMAGE_")) return false;
  if ([
    "ABORT_ERR",
    "CURL_PROXY_ERROR",
    "CURL_TIMEOUT",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "PROXY_AUTH_REQUIRED",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)) return true;
  if (error.name === "AbortError") return true;
  return /代理.{0,12}(?:超时|失败|不可用|无法连接|关闭|握手)|目标网站打不开|连接.{0,12}超时|请求超时|fetch failed|timed? ?out|connection reset|connection to proxy closed|proxy handshake|could not resolve proxy|failed to connect/i
    .test(String(error.message || ""));
}

function circuitStateName(state) {
  if (state === CircuitState.Open) return "open";
  if (state === CircuitState.HalfOpen) return "half_open";
  if (state === CircuitState.Isolated) return "open";
  return "closed";
}

function proxyCooldownError(state, cause) {
  const error = new Error("代理线路暂时不可用，系统将在 5 分钟后自动尝试恢复。", { cause });
  error.code = "PROXY_COOLDOWN";
  error.status = 503;
  error.proxyFailed = true;
  error.proxyCooldownUntil = state.retryAt || "";
  return error;
}

export function createProxyCircuitProtection(options = {}) {
  const failureThreshold = Math.max(1, Number(options.failureThreshold || DEFAULT_PROXY_FAILURE_THRESHOLD));
  const recoveryDelayMs = Math.max(1, Number(options.recoveryDelayMs || DEFAULT_PROXY_RECOVERY_DELAY_MS));
  const circuits = new Map();

  function keyFor(value) {
    return normalizeProxyUrl(value);
  }

  function entryFor(value) {
    const key = keyFor(value);
    let entry = circuits.get(key);
    if (!entry) {
      entry = {
        policy: circuitBreaker(handleWhen(isProxyConnectionError), {
          halfOpenAfter: recoveryDelayMs,
          breaker: new ConsecutiveBreaker(failureThreshold)
        })
      };
      circuits.set(key, entry);
    }
    return entry;
  }

  function state(value) {
    const entry = circuits.get(keyFor(value));
    if (!entry) return { status: "closed", retryAt: "" };
    const serialized = entry.policy.toJSON().ownState;
    const openedAt = Number(serialized.openedAt || 0);
    return {
      status: circuitStateName(entry.policy.state),
      retryAt: openedAt > 0 ? new Date(openedAt + recoveryDelayMs).toISOString() : ""
    };
  }

  async function execute(value, work) {
    if (!String(value || "").trim()) return work();
    const entry = entryFor(value);
    try {
      const outcome = await entry.policy.execute(async () => {
        try {
          return { ok: true, value: await work() };
        } catch (error) {
          if (isProxyConnectionError(error)) throw error;
          return { ok: false, error };
        }
      });
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } catch (error) {
      const currentState = state(value);
      if (error instanceof BrokenCircuitError) throw proxyCooldownError(currentState, error);
      if (isProxyConnectionError(error) && currentState.status === "open") {
        throw proxyCooldownError(currentState, error);
      }
      throw error;
    }
  }

  async function recordFailure(value, error, count = 1) {
    if (!String(value || "").trim()) return state(value);
    const entry = entryFor(value);
    for (let index = 0; index < Math.max(1, Number(count || 1)); index += 1) {
      if (entry.policy.state === CircuitState.Open) break;
      try {
        await entry.policy.execute(async () => { throw error; });
      } catch {
        // 这里只记录检测结果，原错误由调用方展示。
      }
    }
    return state(value);
  }

  function reset(value) {
    circuits.delete(keyFor(value));
  }

  return { execute, recordFailure, reset, state };
}

const proxyCircuitProtection = createProxyCircuitProtection();

export function runWithProxyCircuit(value, work) {
  return proxyCircuitProtection.execute(value, work);
}

export function recordProxyCircuitFailure(value, error, count = 1) {
  return proxyCircuitProtection.recordFailure(value, error, count);
}

export function resetProxyCircuit(value) {
  proxyCircuitProtection.reset(value);
}

export function proxyCircuitState(value) {
  return proxyCircuitProtection.state(value);
}
