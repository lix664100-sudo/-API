import { createHash } from "node:crypto";
import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";

const DEFAULT_DIRECTORY_URL = "https://home.aishare.icu/";
const DIRECTORY_CACHE_MS = 10 * 60 * 1000;
const DIRECTORY_RETRY_MS = 30 * 1000;
const PORTAL_FAILURE_COOLDOWN_MS = 60 * 1000;
const PREFERRED_PORTAL_MS = 24 * 60 * 60 * 1000;
const MAX_ROUTE_CACHE_ENTRIES = 200;

const directoryCaches = new Map();
const preferredPortals = new Map();
const portalFailures = new Map();

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizedDirectoryUrl(value) {
  const fallback = DEFAULT_DIRECTORY_URL;
  try {
    const url = new URL(String(value || fallback));
    if (url.protocol !== "https:") return fallback;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

function normalizePortalUrl(value, official = false) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (official ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) return "";
    if (!url.hostname || url.username || url.password) return "";
    if (official && url.port && url.port !== "443") return "";
    url.search = "";
    url.hash = "";
    if (official) url.pathname = "";
    const path = url.pathname === "/" ? "" : trimSlash(url.pathname);
    return `${url.origin}${path}`;
  } catch {
    return "";
  }
}

function uniquePortalUrls(values, official = false) {
  return [...new Set((values || []).map((value) => normalizePortalUrl(value, official)).filter(Boolean))];
}

function quotedValues(value) {
  const values = [];
  const pattern = /(['"`])([^'"`]+)\1/g;
  for (const match of String(value || "").matchAll(pattern)) values.push(match[2]);
  return values;
}

export function parseShareAiPortalUrls(html) {
  const source = String(html || "");
  const regular = [];
  const priority = [];

  const arrayPattern = /\b([A-Z\d_]*NODES?)\s*=\s*\[([\s\S]*?)\]/g;
  for (const match of source.matchAll(arrayPattern)) {
    const target = /PRIORITY|FALLBACK|BACKUP/.test(match[1]) ? priority : regular;
    target.push(...quotedValues(match[2]));
  }

  const singlePattern = /\b([A-Z\d_]*NODE)\s*=\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(singlePattern)) {
    const target = /PRIORITY|FALLBACK|BACKUP/.test(match[1]) ? priority : regular;
    target.push(match[3]);
  }

  return uniquePortalUrls([...regular, ...priority], true);
}

function routeKeyFor(proxyUrl) {
  const route = String(proxyUrl || "").trim();
  if (!route) return "direct";
  return `proxy:${createHash("sha256").update(route).digest("hex")}`;
}

function portalFailureKey(routeKey, url) {
  return `${routeKey}::${url}`;
}

function pruneRouteCaches(now = Date.now()) {
  for (const [key, value] of preferredPortals) {
    if (!value?.url || value.expiresAt <= now) preferredPortals.delete(key);
  }
  for (const [key, expiresAt] of portalFailures) {
    if (expiresAt <= now) portalFailures.delete(key);
  }
  while (preferredPortals.size > MAX_ROUTE_CACHE_ENTRIES) {
    preferredPortals.delete(preferredPortals.keys().next().value);
  }
  while (portalFailures.size > MAX_ROUTE_CACHE_ENTRIES * 5) {
    portalFailures.delete(portalFailures.keys().next().value);
  }
}

function preferredPortal(routeKey, now = Date.now()) {
  pruneRouteCaches(now);
  return preferredPortals.get(routeKey)?.url || "";
}

function portalOnCooldown(routeKey, url, now = Date.now()) {
  return Number(portalFailures.get(portalFailureKey(routeKey, url)) || 0) > now;
}

function rememberPortalSuccess(routeKey, url) {
  const normalized = normalizePortalUrl(url);
  if (!normalized) return;
  preferredPortals.set(routeKey, {
    url: normalized,
    expiresAt: Date.now() + PREFERRED_PORTAL_MS
  });
  portalFailures.delete(portalFailureKey(routeKey, normalized));
  pruneRouteCaches();
}

function rememberPortalFailure(routeKey, url) {
  const normalized = normalizePortalUrl(url);
  if (!normalized) return;
  const preferred = preferredPortals.get(routeKey);
  if (preferred?.url === normalized) preferredPortals.delete(routeKey);
  portalFailures.set(
    portalFailureKey(routeKey, normalized),
    Date.now() + PORTAL_FAILURE_COOLDOWN_MS
  );
  pruneRouteCaches();
}

async function defaultDirectoryLoader({
  directoryUrl,
  proxyUrl,
  timeoutMs,
  fetchImpl,
  proxyAgentFactory
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const agent = proxyUrl ? proxyAgentFactory(proxyUrl) : undefined;
  try {
    const response = await fetchImpl(directoryUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      },
      redirect: "follow",
      agent,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`官方线路页返回 ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    agent?.destroy?.();
  }
}

async function loadDirectoryHtml(options) {
  const loader = options.directoryLoader || defaultDirectoryLoader;
  try {
    return await loader(options);
  } catch (error) {
    if (!options.proxyUrl) throw error;
    return loader({ ...options, proxyUrl: "" });
  }
}

function directoryCacheFor(directoryUrl) {
  let cache = directoryCaches.get(directoryUrl);
  if (!cache) {
    cache = { urls: [], expiresAt: 0, retryAt: 0, promise: null };
    directoryCaches.set(directoryUrl, cache);
  }
  return cache;
}

async function discoverPortalUrls(options = {}, force = false) {
  const directoryUrl = normalizedDirectoryUrl(
    options.directoryUrl || process.env.SHAREAI_DIRECTORY_URL || DEFAULT_DIRECTORY_URL
  );
  const cache = directoryCacheFor(directoryUrl);
  const now = Date.now();
  if (cache.promise) return cache.promise;
  if (!force && cache.expiresAt > now) return cache.urls;
  if (cache.retryAt > now) return cache.urls;

  cache.promise = (async () => {
    try {
      const html = await loadDirectoryHtml({
        directoryUrl,
        proxyUrl: String(options.proxyUrl || ""),
        timeoutMs: Math.max(1_000, Number(options.directoryTimeoutMs || 5_000)),
        fetchImpl: options.fetchImpl || fetch,
        directoryLoader: options.directoryLoader,
        proxyAgentFactory: options.proxyAgentFactory
          || ((proxyUrl) => new ProxyAgent({ getProxyForUrl: () => proxyUrl }))
      });
      const urls = parseShareAiPortalUrls(html);
      if (!urls.length) throw new Error("官方线路页没有返回可用入口");
      cache.urls = urls;
      cache.expiresAt = Date.now() + DIRECTORY_CACHE_MS;
      cache.retryAt = 0;
      return urls;
    } catch {
      cache.retryAt = Date.now() + DIRECTORY_RETRY_MS;
      return cache.urls;
    } finally {
      cache.promise = null;
    }
  })();
  return cache.promise;
}

function cachedPortalUrls(options = {}) {
  const directoryUrl = normalizedDirectoryUrl(
    options.directoryUrl || process.env.SHAREAI_DIRECTORY_URL || DEFAULT_DIRECTORY_URL
  );
  return directoryCaches.get(directoryUrl)?.urls || [];
}

function orderedCandidates(routeKey, configuredUrls, discoveredUrls) {
  return uniquePortalUrls([
    preferredPortal(routeKey),
    ...(configuredUrls || []),
    ...(discoveredUrls || [])
  ]);
}

function candidatesOutsideCooldown(routeKey, candidates, retryCooled) {
  const available = candidates.filter((url) => !portalOnCooldown(routeKey, url));
  return available.length || !retryCooled ? available : candidates;
}

function compactFailureMessage(value) {
  return String(value || "")
    .replace(/:\/\/[^/@\s]+@/g, "://***@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function portalsUnavailableError(attempts) {
  const last = attempts.at(-1)?.error;
  const detail = compactFailureMessage(last?.message);
  const error = new Error(
    `ShareAI 当前没有可用的登录入口，系统已自动尝试 ${attempts.length} 条线路。${detail ? `最后一次失败：${detail}` : "请稍后重试。"}`
  );
  error.code = "SHAREAI_PORTAL_UNAVAILABLE";
  error.status = 502;
  error.portalUnavailable = true;
  error.attemptedUrls = attempts.map((item) => item.url);
  error.cause = last;
  return error;
}

export function isShareAiPortalAccountRejection(value) {
  const text = String(value || "").replace(/\s+/g, " ");
  return /(?:账号|账户|用户|邮箱|手机号|密码|口令|凭证).{0,20}(?:错误|不正确|不存在|无效|停用|禁用|封禁|冻结)|(?:错误|不正确|无效).{0,12}(?:账号|账户|用户|邮箱|手机号|密码|口令|凭证)|(?:invalid|incorrect|unknown|disabled|banned|blocked).{0,20}(?:account|user|email|password|credential)|(?:account|user|email|password|credential).{0,20}(?:invalid|incorrect|unknown|disabled|banned|blocked)/i.test(text);
}

export function isShareAiPortalConnectionError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return [404, 408, 425, 429].includes(status)
    || status >= 500
    || /^CURL_(?:\d+|TLS|TIMEOUT|PROXY)/i.test(code)
    || /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPROTO|UND_ERR_)/i.test(code)
    || code === "INVALID_UPSTREAM_RESPONSE"
    || /SSL_ERROR_SYSCALL|TLS handshake|socket disconnected|连接失败|连接超时|请求超时|无法连接|打不开|network|timed?\s*out|connection (?:refused|reset|closed)/i.test(message);
}

export function reportShareAiPortalFailure({ proxyUrl = "", url = "" } = {}) {
  const normalized = normalizePortalUrl(url);
  if (!normalized) return;
  rememberPortalFailure(routeKeyFor(proxyUrl), normalized);
}

export async function useAvailableShareAiPortal(options = {}) {
  if (typeof options.attempt !== "function") throw new TypeError("缺少 ShareAI 入口登录方法");
  const configuredUrls = uniquePortalUrls(options.configuredUrls || []);
  const routeKey = routeKeyFor(options.proxyUrl);
  const attempts = [];
  const attempted = new Set();

  const tryCandidates = async (values, retryCooled = false) => {
    const candidates = candidatesOutsideCooldown(
      routeKey,
      orderedCandidates(routeKey, configuredUrls, values),
      retryCooled
    );
    for (const url of candidates) {
      if (attempted.has(url)) continue;
      attempted.add(url);
      try {
        const value = await options.attempt(url);
        rememberPortalSuccess(routeKey, url);
        return { url, value };
      } catch (error) {
        if (error?.portalAccountRejected === true) throw error;
        attempts.push({ url, error });
        rememberPortalFailure(routeKey, url);
      }
    }
    return null;
  };

  const cached = cachedPortalUrls(options);
  const initial = await tryCandidates(cached);
  if (initial) return initial;

  const discovered = await discoverPortalUrls(options, cached.length > 0);
  const recovered = await tryCandidates(discovered, true);
  if (recovered) return recovered;

  throw portalsUnavailableError(attempts);
}

export function resetShareAiPortalRoutingForTests() {
  directoryCaches.clear();
  preferredPortals.clear();
  portalFailures.clear();
}
