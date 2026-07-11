import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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

export async function checkProxyReachability(value, targetUrl, timeoutMs = 8000) {
  const endpoint = safeProxyEndpoint(value);
  if (!endpoint.proxyConfigured) return { ok: true, ...endpoint };
  if (!endpoint.proxyHost) return { ok: false, ...endpoint, message: "代理 IP 格式不正确" };
  if (proxyExpired(endpoint.expiresAt)) return { ok: false, ...endpoint, message: "代理 IP 已到期" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(targetUrl), {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      agent: new ProxyAgent({ getProxyForUrl: () => normalizeProxyUrl(value) })
    });
    response.body?.destroy?.();
    return { ok: true, ...endpoint, checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      ...endpoint,
      checkedAt: new Date().toISOString(),
      message: error?.name === "AbortError" ? "代理连接超时" : "代理无法连接目标站"
    };
  } finally {
    clearTimeout(timer);
  }
}
