import { createHash } from "node:crypto";

// ShareAI 门户对同一个账号只允许一个在线会话。
// 系统里同一个账号会被多个客户端使用(聊天能力、绘图能力、不同渠道各自一份)，
// 如果每个客户端都单独登录，就会互相把对方挤下线("您已在其他设备登陆")，
// 任务只能反复重新登录、换车，白白浪费几分钟。
// 这里维护一个"按账号共享"的门户登录结果池：
// 第一个客户端真正登录后，其他客户端直接复用这份会话，不再重复登录；
// 只有当会话确认失效时才作废，由下一个客户端重新登录并刷新共享池。

const POOL_SESSION_TTL_MS = 30 * 60 * 1000;
const pool = new Map();

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function portalSessionKey({ username, password, proxyUrl = "" } = {}) {
  const digest = createHash("sha256").update(String(password ?? "")).digest("hex");
  return [
    String(username || "").trim().toLowerCase(),
    digest,
    String(proxyUrl || "").trim()
  ].join("::");
}

export function shareSessionFromCookies(cookies = []) {
  for (const cookie of cookies) {
    const text = String(cookie || "").trim().split(";")[0].trim();
    if (/^share-session=/i.test(text)) return text.slice("share-session=".length).trim();
  }
  return "";
}

export function getPortalSession(key, { now = Date.now(), maxAgeMs = POOL_SESSION_TTL_MS } = {}) {
  const entry = pool.get(key);
  if (!entry) return null;
  if (now - entry.createdAt > maxAgeMs) {
    pool.delete(key);
    return null;
  }
  return entry;
}

export function adoptPortalSession(key, options = {}) {
  const entry = getPortalSession(key, options);
  if (!entry) return null;
  entry.lastUsedAt = options.now ?? Date.now();
  return {
    baseUrl: entry.baseUrl,
    cookies: [...entry.cookies],
    shareSession: entry.shareSession,
    createdAt: entry.createdAt
  };
}

export function savePortalSession(key, { baseUrl = "", cookies = [], shareSession = "", now = Date.now() } = {}) {
  const entry = {
    key,
    baseUrl: trimSlash(baseUrl),
    cookies: Array.isArray(cookies) ? [...cookies] : [],
    shareSession: String(shareSession || ""),
    createdAt: now,
    lastUsedAt: now
  };
  pool.set(key, entry);
  return entry;
}

export function invalidatePortalSession(key, { shareSession = "" } = {}) {
  const entry = pool.get(key);
  if (!entry) return false;
  // 如果池里已经换成了更新的会话，就不要拿旧的失效信息误删它。
  if (shareSession && entry.shareSession && entry.shareSession !== shareSession) return false;
  pool.delete(key);
  return true;
}

export function clearPortalSessions() {
  pool.clear();
}
