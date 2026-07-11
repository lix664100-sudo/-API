import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PROXY_EXIT_IP_URLS = [
  "https://api.ipify.org?format=json",
  "https://api64.ipify.org?format=json",
  "https://icanhazip.com"
];
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;
const IPV6_RE = /\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:.]{1,}\b/i;

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

async function lookupProxyExitIp(agent, timeoutMs) {
  const probes = PROXY_EXIT_IP_URLS.map(async (url) => {
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
  });

  return Promise.any(probes);
}

async function checkTargetReachable(agent, targetUrl, timeoutMs) {
  const response = await fetchWithTimeout(targetUrl, {
    method: "HEAD",
    redirect: "manual",
    agent
  }, timeoutMs);
  response.body?.destroy?.();
  return response;
}

export async function checkProxyReachability(value, targetUrl, timeoutMs = 3000) {
  const endpoint = safeProxyEndpoint(value);
  if (!endpoint.proxyConfigured) return { ok: true, ...endpoint };
  if (!endpoint.proxyHost) return { ok: false, ...endpoint, message: "代理 IP 格式不正确" };
  if (proxyExpired(endpoint.expiresAt)) return { ok: false, ...endpoint, message: "代理 IP 已到期" };

  const checkedAt = new Date().toISOString();
  const agent = new ProxyAgent({ getProxyForUrl: () => normalizeProxyUrl(value) });
  const [targetResult, ipResult] = await Promise.allSettled([
    checkTargetReachable(agent, targetUrl, timeoutMs),
    lookupProxyExitIp(agent, timeoutMs)
  ]);
  const realIp = ipResult.status === "fulfilled" ? ipResult.value : "";

  if (targetResult.status === "fulfilled") {
    return { ok: true, ...endpoint, realIp, checkedAt };
  }

  const error = targetResult.reason;
  return {
    ok: false,
    ...endpoint,
    realIp,
    checkedAt,
    message: error?.name === "AbortError" ? "代理连接超时" : "代理无法连接目标站"
  };
}
