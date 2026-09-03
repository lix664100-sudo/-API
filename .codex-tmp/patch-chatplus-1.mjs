import { readFileSync, writeFileSync } from "node:fs";
const file = "src/channels/chatplus.js";
let src = readFileSync(file, "utf8");
let count = 0;
function replace(oldText, newText, label) {
  const occurrences = src.split(oldText).length - 1;
  if (occurrences !== 1) throw new Error(`[${label}] expected 1 occurrence, found ${occurrences}`);
  src = src.replace(oldText, newText);
  count += 1;
  console.log(`ok: ${label}`);
}

// H1 import
replace(
  `import { isImagePolicyFailureMessage } from "../task-error-policy.js";`,
  `import { isImagePolicyFailureMessage } from "../task-error-policy.js";
import {
  adoptPortalSession,
  invalidatePortalSession,
  portalSessionKey,
  savePortalSession,
  shareSessionFromCookies
} from "../portal-session-pool.js";`,
  "H1 import"
);

// H2 constants
replace(
  `const MAX_CHAT_CAR_ATTEMPTS = 8;`,
  `const MAX_CHAT_CAR_ATTEMPTS = 8;
const AUTH_KICK_FAST_FAIL_LIMIT = 3;
const CHAT_IMAGE_UPLOAD_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_IMAGE_UPLOAD_CACHE_MAX = 200;`,
  "H2 constants"
);

// H3 helpers after tagCarPoolUnavailable
replace(
  `function tagCarPoolUnavailable(error) {
  error.code ||= "CHAT_CAR_POOL_UNAVAILABLE";
  error.carPoolUnavailable = true;
  error.authScope = "car";
  return error;
}`,
  `function tagCarPoolUnavailable(error) {
  error.code ||= "CHAT_CAR_POOL_UNAVAILABLE";
  error.carPoolUnavailable = true;
  error.authScope = "car";
  return error;
}

function accountSessionContentionError(attemptMessages = []) {
  const error = new Error(
    \`账号被其他登录占用，连续 \${Math.max(attemptMessages.length, AUTH_KICK_FAST_FAIL_LIMIT)} 次被挤下线，已停止自动重试。请检查该账号是否在其他设备或系统登录，或稍后再试。\`
  );
  error.code = "ACCOUNT_SESSION_CONTENDED";
  error.status = 409;
  error.authScope = "account";
  error.noRetry = true;
  error.carAttempts = [...attemptMessages];
  return error;
}

const chatImageUploadCache = new Map();

function chatImageUploadCacheKey(accountId, carId, revision, digest) {
  return \`\${accountId || "account"}::\${carId || ""}::\${revision}::\${digest}\`;
}

function readChatImageUploadCache(key) {
  const entry = chatImageUploadCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CHAT_IMAGE_UPLOAD_CACHE_TTL_MS) {
    chatImageUploadCache.delete(key);
    return null;
  }
  return entry.asset;
}

function writeChatImageUploadCache(key, asset) {
  if (chatImageUploadCache.size >= CHAT_IMAGE_UPLOAD_CACHE_MAX) {
    const oldestKey = chatImageUploadCache.keys().next().value;
    if (oldestKey !== undefined) chatImageUploadCache.delete(oldestKey);
  }
  chatImageUploadCache.set(key, { at: Date.now(), asset });
}

function cloneUploadAsset(asset = {}) {
  return {
    part: { ...(asset.part || {}) },
    attachment: { ...(asset.attachment || {}) }
  };
}`,
  "H3 helpers"
);

// H4 client methods after assertConfigured
replace(
  `  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个聊天账号还没有填写账号或密码。");
    }
  }`,
  `  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个聊天账号还没有填写账号或密码。");
    }
  }

  portalSessionPoolKey() {
    return portalSessionKey({
      username: this.account?.username,
      password: this.account?.password,
      proxyUrl: proxyUrlFor(this.account)
    });
  }

  tryAdoptSharedPortalSession() {
    if (this.portalLoggedIn) return false;
    const entry = adoptPortalSession(this.portalSessionPoolKey());
    if (!entry || !entry.cookies.length) return false;
    if (entry.baseUrl) this.baseUrl = entry.baseUrl;
    this.cookies = [...entry.cookies];
    this.portalLoggedIn = true;
    return true;
  }

  rememberSharedPortalSession() {
    if (!this.portalLoggedIn || !this.cookies.length) return;
    savePortalSession(this.portalSessionPoolKey(), {
      baseUrl: this.baseUrl,
      cookies: this.cookies,
      shareSession: shareSessionFromCookies(this.cookies)
    });
  }

  invalidateSharedPortalSession() {
    invalidatePortalSession(this.portalSessionPoolKey(), {
      shareSession: shareSessionFromCookies(this.cookies)
    });
  }`,
  "H4 client methods"
);

// H5a performPortalLogin adoption
replace(
  `    }, async () => {
      this.assertConfigured();
      let selected;
      try {
        selected = await useAvailableShareAiPortal({
          configuredUrls: [this.baseUrl, this.configuredBaseUrl],`,
  `    }, async () => {
      this.assertConfigured();
      if (options.forceFreshPortalLogin !== true && this.tryAdoptSharedPortalSession()) {
        return { adoptedSharedSession: true };
      }
      let selected;
      try {
        selected = await useAvailableShareAiPortal({
          configuredUrls: [this.baseUrl, this.configuredBaseUrl],`,
  "H5a adoption branch"
);

// H5b remember after login
replace(
  `      this.baseUrl = selected.url;
      this.portalLoggedIn = true;
    });
  }

  async loginPortal(options = {}) {`,
  `      this.baseUrl = selected.url;
      this.portalLoggedIn = true;
      this.rememberSharedPortalSession();
    });
  }

  async loginPortal(options = {}) {`,
  "H5b remember session"
);

// H6 loadAccountUsages auth retry
replace(
  `    } catch (error) {
      if (portalRetried || !isShareAiPortalConnectionError(error)) throw error;
      reportShareAiPortalFailure({
        proxyUrl: proxyUrlFor(this.account),
        url: this.baseUrl
      });
      await this.sessionLock(async () => {
        this.resetSession();
        await this.performPortalLogin(options);
      });
      return this.loadAccountUsages(options, true);
    }
  }

  async loadAccountUsage(options = {}, modelKey = "") {`,
  `    } catch (error) {
      if (!portalRetried && isAuthSessionError(error)) {
        await this.sessionLock(async () => {
          this.invalidateSharedPortalSession();
          this.resetSession();
          await this.performPortalLogin(options);
        });
        return this.loadAccountUsages(options, true);
      }
      if (portalRetried || !isShareAiPortalConnectionError(error)) throw error;
      reportShareAiPortalFailure({
        proxyUrl: proxyUrlFor(this.account),
        url: this.baseUrl
      });
      await this.sessionLock(async () => {
        this.resetSession();
        await this.performPortalLogin(options);
      });
      return this.loadAccountUsages(options, true);
    }
  }

  async loadAccountUsage(options = {}, modelKey = "") {`,
  "H6 usages auth retry"
);

// H8 invalidatePreparedChatSession
replace(
  `    await this.sessionLock(async () => {
      if (revision !== this.sessionRevision) return;
      this.resetSession();
      invalidated = true;
    });
    return invalidated;`,
  `    await this.sessionLock(async () => {
      if (revision !== this.sessionRevision) return;
      this.invalidateSharedPortalSession();
      this.resetSession();
      invalidated = true;
    });
    return invalidated;`,
  "H8 invalidate on prepared session reset"
);

// H9a prepareChatSession counter declaration
replace(
  `    const errors = [];
    let subscriptionMissingAttempts = 0;
    let subscriptionExpiredAttempts = 0;
    let recheckProCars = input.recheckProCars === true;`,
  `    const errors = [];
    let subscriptionMissingAttempts = 0;
    let subscriptionExpiredAttempts = 0;
    let authKickAttempts = 0;
    let recheckProCars = input.recheckProCars === true;`,
  "H9a prepareChatSession counter"
);

// H9b prepareChatSession retryable block
replace(
  `        if (retryableCarError) {
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.sessionLock(async () => this.resetSession());
        }`,
  `        if (retryableCarError) {
          if (isAuthSessionError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.sessionLock(async () => {
            this.invalidateSharedPortalSession();
            this.resetSession();
          });
        }`,
  "H9b prepareChatSession fast fail"
);

writeFileSync(file, src);
console.log(`done, ${count} replacements applied`);
