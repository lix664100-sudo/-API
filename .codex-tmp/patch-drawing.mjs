import { readFileSync, writeFileSync } from "node:fs";
const file = "src/channels/drawing.js";
let src = readFileSync(file, "utf8");
let applied = 0;

function escapeRegExpLine(line) {
  return line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function apply(oldText, newText, label) {
  const needleLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const pattern = new RegExp(needleLines.map(escapeRegExpLine).join("\\r?\\n"), "g");
  const matches = [...src.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`[${label}] no match found`);
  if (matches.length > 1) throw new Error(`[${label}] ambiguous: ${matches.length} occurrences`);
  const match = matches[0];
  const matchedText = match[0];
  const crlfCount = (matchedText.match(/\r\n/g) || []).length;
  const bareLfCount = (matchedText.match(/(?<!\r)\n/g) || []).length;
  const eol = crlfCount > bareLfCount ? "\r\n" : "\n";
  const replacement = newText.replace(/\r\n/g, "\n").split("\n").join(eol);
  src = src.slice(0, match.index) + replacement + src.slice(match.index + matchedText.length);
  applied += 1;
  console.log(`ok: ${label}`);
}

apply(
  `import {
  isShareAiPortalAccountRejection,
  useAvailableShareAiPortal
} from "../shareai-portal-router.js";`,
  `import {
  isShareAiPortalAccountRejection,
  useAvailableShareAiPortal
} from "../shareai-portal-router.js";
import {
  adoptPortalSession,
  invalidatePortalSession,
  portalSessionKey,
  savePortalSession
} from "../portal-session-pool.js";`,
  "D1 import"
);

apply(
  `    this.mainBaseUrl = this.configuredMainBaseUrl;
    this.drawingBaseUrl = trimSlash(channel?.settings?.baseUrl || config.drawingBaseUrl || "https://drawing.aishare.icu");
    this.accessToken = "";`,
  `    this.mainBaseUrl = this.configuredMainBaseUrl;
    this.drawingBaseUrl = trimSlash(channel?.settings?.baseUrl || config.drawingBaseUrl || "https://drawing.aishare.icu");
    this.accessToken = "";
    this.portalShareSession = "";`,
  "D2 constructor field"
);

apply(
  `    if (changed) {
      this.contextSignature = nextSignature;
      this.accessToken = "";
      this.mainBaseUrl = this.configuredMainBaseUrl;`,
  `    if (changed) {
      this.contextSignature = nextSignature;
      this.accessToken = "";
      this.portalShareSession = "";
      this.mainBaseUrl = this.configuredMainBaseUrl;`,
  "D3 updateContext reset"
);

apply(
  `  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个绘图账号还没有填写账号或密码。");
    }
  }`,
  `  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个绘图账号还没有填写账号或密码。");
    }
  }

  portalSessionPoolKey() {
    return portalSessionKey({
      username: this.account?.username,
      password: this.account?.password,
      proxyUrl: this.proxyUrl
    });
  }

  async exchangeShareSessionToken(shareSession, options = {}) {
    const ssoData = await this.request("/api/v1/auth/external-sso", {
      method: "POST",
      auth: false,
      timeoutMs: options.timeoutMs,
      body: { "share-token": shareSession }
    });
    if (!ssoData?.access_token) throw new Error("绘图站登录失败。");
    return ssoData;
  }`,
  "D4 pool key + sso helper"
);

apply(
  `  async performLogin(options = {}) {
    this.assertConfigured();
    let selected;`,
  `  async performLogin(options = {}) {
    this.assertConfigured();
    const poolKey = this.portalSessionPoolKey();
    const pooled = adoptPortalSession(poolKey);
    if (pooled?.shareSession) {
      try {
        const ssoData = await this.exchangeShareSessionToken(pooled.shareSession, {
          timeoutMs: options.timeoutMs
        });
        this.mainBaseUrl = pooled.baseUrl || this.configuredMainBaseUrl;
        this.accessToken = ssoData.access_token;
        this.portalShareSession = pooled.shareSession;
        return ssoData;
      } catch (error) {
        // 账号被拒或网络问题(没有状态码)时不动共享池，直接抛错；
        // 其余情况(如 401/403 会话失效)作废共享会话，走重新登录。
        if (error?.portalAccountRejected || !Number(error?.status || 0)) throw error;
        invalidatePortalSession(poolKey, { shareSession: pooled.shareSession });
      }
    }
    let selected;`,
  "D5 adoption path"
);

apply(
  `    this.mainBaseUrl = selected.url;
    const shareSession = selected.value;

    const ssoData = await this.request("/api/v1/auth/external-sso", {
      method: "POST",
      auth: false,
      timeoutMs: options.timeoutMs,
      body: { "share-token": shareSession }
    });

    if (!ssoData?.access_token) throw new Error("绘图站登录失败。");
    this.accessToken = ssoData.access_token;
    return ssoData;
  }`,
  `    this.mainBaseUrl = selected.url;
    const shareSession = selected.value;

    const ssoData = await this.exchangeShareSessionToken(shareSession, {
      timeoutMs: options.timeoutMs
    });
    this.accessToken = ssoData.access_token;
    this.portalShareSession = shareSession;
    savePortalSession(poolKey, {
      baseUrl: selected.url,
      cookies: [\`share-session=\${shareSession}\`],
      shareSession
    });
    return ssoData;
  }`,
  "D6 fresh login saves pool"
);

writeFileSync(file, src);
console.log(`done: ${applied} replacements applied`);
