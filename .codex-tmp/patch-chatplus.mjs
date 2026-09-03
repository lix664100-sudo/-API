import { readFileSync, writeFileSync } from "node:fs";
const file = "src/channels/chatplus.js";
let src = readFileSync(file, "utf8");
const isCRLF = src.includes("\r\n");
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

apply(
  `const MAX_CHAT_CAR_ATTEMPTS = 8;`,
  `const MAX_CHAT_CAR_ATTEMPTS = 8;
const AUTH_KICK_FAST_FAIL_LIMIT = 3;
const CHAT_IMAGE_UPLOAD_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_IMAGE_UPLOAD_CACHE_MAX = 200;`,
  "H2 constants"
);

apply(
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

apply(
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

apply(
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

apply(
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

apply(
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

apply(
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
  "H8 invalidate on prepared reset"
);

apply(
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

apply(
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

apply(
  `  createSubmitClient(session = {}) {
    const snapshot = session.snapshot || session.submitSessionSnapshot;
    if (!snapshot) return this;
    const client = new ChatplusClient({
      config: this.config,
      channel: this.channel,
      account: this.account,
      sessionLock: async (work) => work()
    });
    client.restoreSession(snapshot);
    return client;
  }`,
  `  createSubmitClient(session = {}) {
    const snapshot = session.snapshot || session.submitSessionSnapshot;
    if (!snapshot) return this;
    const client = new ChatplusClient({
      config: this.config,
      channel: this.channel,
      account: this.account,
      sessionLock: async (work) => work()
    });
    client.restoreSession(snapshot);
    if (Number.isInteger(session.revision)) client.sessionRevision = session.revision;
    return client;
  }`,
  "H13 submit client revision"
);

apply(
  `  async uploadChatImage(file) {
    const buffer = await file.toBuffer();
    const mimetype = file.mimetype || "image/png";
    if (!String(mimetype).startsWith("image/")) {
      const error = new Error("对话只能上传图片文件。");
      error.status = 400;
      throw error;
    }
    const filename = fileNameFromMime(mimetype, file.filename || \`image-\${randomUUID()}\`);
    const { width, height } = imageDimensions(buffer);
    const upload = await this.json("/backend-api/files", {`,
  `  async uploadChatImage(file, options = {}) {
    const buffer = await file.toBuffer();
    const mimetype = file.mimetype || "image/png";
    if (!String(mimetype).startsWith("image/")) {
      const error = new Error("对话只能上传图片文件。");
      error.status = 400;
      throw error;
    }
    const filename = fileNameFromMime(mimetype, file.filename || \`image-\${randomUUID()}\`);
    const { width, height } = imageDimensions(buffer);
    const digest = createHash("sha256").update(buffer).digest("hex");
    const cacheKey = chatImageUploadCacheKey(this.account?.id, this.carId, this.sessionRevision, digest);
    if (options.forceReupload !== true) {
      const cachedAsset = readChatImageUploadCache(cacheKey);
      if (cachedAsset) return cloneUploadAsset(cachedAsset);
    }
    const upload = await this.json("/backend-api/files", {`,
  "H11a upload cache lookup"
);

apply(
  `    const fileId = upload?.file_id;
    const uploadUrl = upload?.upload_url;
    if (!fileId || !uploadUrl) throw new Error("聊天图片上传初始化失败。");`,
  `    const fileId = upload?.file_id;
    const uploadUrl = upload?.upload_url;
    if (!fileId || !uploadUrl) {
      const upstreamText = upload?.detail?.message || upload?.message || upload?.msg || "";
      const authShapedError = new Error(upstreamText || "聊天图片上传初始化失败。");
      authShapedError.body = JSON.stringify(upload ?? {});
      if (isAuthSessionError(authShapedError)) {
        authShapedError.status = 401;
        throw authShapedError;
      }
      if (options.retriedAfterReauth !== true) {
        // 上传初始化失败通常是登录会话悄悄失效：重新登录一次再上传。
        await this.sessionLock(async () => {
          this.invalidateSharedPortalSession();
          this.resetSession();
          await this.performPortalLogin({
            ...(options.timeoutSec ? { timeoutSec: options.timeoutSec } : {}),
            ...(options.taskStageRecorder ? { taskStageRecorder: options.taskStageRecorder } : {})
          });
        });
        return this.uploadChatImage(file, { ...options, retriedAfterReauth: true });
      }
      throw new Error("聊天图片上传初始化失败。");
    }`,
  "H11b upload init fast fail"
);

apply(
  `    if (done?.status && done.status !== "success") throw new Error("聊天图片上传未完成。");

    return {
      part: {
        content_type: "image_asset_pointer",
        asset_pointer: \`file-service://\${fileId}\`,
        size_bytes: buffer.length,
        width,
        height
      },
      attachment: {
        id: fileId,
        name: filename,
        mimeType: mimetype,
        size: buffer.length,
        width,
        height
      }
    };
  }

  async uploadChatImages(files = []) {
    const assets = [];
    for (const file of files) assets.push(await this.uploadChatImage(file));
    return assets;
  }`,
  `    if (done?.status && done.status !== "success") throw new Error("聊天图片上传未完成。");

    const asset = {
      part: {
        content_type: "image_asset_pointer",
        asset_pointer: \`file-service://\${fileId}\`,
        size_bytes: buffer.length,
        width,
        height
      },
      attachment: {
        id: fileId,
        name: filename,
        mimeType: mimetype,
        size: buffer.length,
        width,
        height
      }
    };
    writeChatImageUploadCache(cacheKey, asset);
    return asset;
  }

  async uploadChatImages(files = [], options = {}) {
    const assets = [];
    for (const file of files) assets.push(await this.uploadChatImage(file, options));
    return assets;
  }`,
  "H11c upload cache store"
);

apply(
  `    const errors = [];
    const imageCarQuotaErrors = [];
    const unconfirmedCars = [];
    let carPoolErrorCount = 0;`,
  `    const errors = [];
    const imageCarQuotaErrors = [];
    const unconfirmedCars = [];
    let carPoolErrorCount = 0;
    let authKickAttempts = 0;`,
  "H10a sendConversation counter"
);

apply(
  `        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "调用失败");
          continue;
        }`,
  `        const retryableCarError = selected && (isAuthSessionError(error) || isCarPlanMismatchError(error));
        if (retryableCarError) {
          if (isAuthSessionError(error)) {
            authKickAttempts += 1;
            if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
              throw accountSessionContentionError(errors);
            }
          }
          await this.rememberProCarsUnavailable(error);
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
          recordCarError(error.message || "调用失败");
          continue;
        }`,
  "H10b sendConversation fast fail"
);

apply(
  `        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAuthSessionError(error)) {
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
        }`,
  `        if (Number(error.status || error.statusCode || 0) === 400) throw error;
        if (isAuthSessionError(error)) {
          authKickAttempts += 1;
          if (authKickAttempts >= AUTH_KICK_FAST_FAIL_LIMIT) {
            throw accountSessionContentionError(errors);
          }
          await this.rememberAuthFailedCar(selected, error);
          await this.invalidatePreparedChatSession(preparedSession);
        }`,
  "H10c standalone auth branch"
);

apply(
  `            }, async () => runSubmitStep(() => submitClient.uploadChatImages(sourceFiles)))`,
  `            }, async () => runSubmitStep(() => submitClient.uploadChatImages(sourceFiles, {
              taskStageRecorder: requestInput.taskStageRecorder
            })))`,
  "H12 pass recorder to upload"
);

apply(
  `                const timer = setTimeout(() => resolve(""), 5000);`,
  `                const timer = setTimeout(() => resolve(""), 3000);`,
  "H15a push wait 5s->3s"
);

apply(
  `      await new Promise((resolve) => setTimeout(resolve, 5000));`,
  `      await new Promise((resolve) => setTimeout(resolve, 3000));`,
  "H15b gemini poll 5s->3s"
);

apply(
  `          nextTaskProbeAt = Date.now() + (shouldCheckImageTasks ? 2000 : 5000);`,
  `          nextTaskProbeAt = Date.now() + (shouldCheckImageTasks ? 2000 : 3000);`,
  "H15c task probe 5s->3s"
);

apply(
  `        if (forceStreamStatus) nextStreamStatusProbeAt = Date.now() + 5000;`,
  `        if (forceStreamStatus) nextStreamStatusProbeAt = Date.now() + 3000;`,
  "H15d stream probe 5s->3s"
);

apply(
  `      await waitForChatplusConversationUpdate(
        conversationId,
        observedUpdateVersion,
        Math.min(5000, Math.max(1, deadline - Date.now()))
      );`,
  `      await waitForChatplusConversationUpdate(
        conversationId,
        observedUpdateVersion,
        Math.min(3000, Math.max(1, deadline - Date.now()))
      );`,
  "H15e update wait 5s->3s"
);

apply(
  `          const sameCarSession = this.portalLoggedIn
            && this.carId === taskCarId
            && this.carType === taskCarType;
          if (reset) this.resetSession();`,
  `          const sameCarSession = this.portalLoggedIn
            && this.carId === taskCarId
            && this.carType === taskCarType;
          if (reset) {
            this.invalidateSharedPortalSession();
            this.resetSession();
          }`,
  "H14a getTask car reset"
);

apply(
  `      if (reset) await this.sessionLock(async () => this.resetSession());
      await this.loginPortal(requestOptions);`,
  `      if (reset) {
        await this.sessionLock(async () => {
          this.invalidateSharedPortalSession();
          this.resetSession();
        });
      }
      await this.loginPortal(requestOptions);`,
  "H14b getTask plain reset"
);

writeFileSync(file, src);
console.log(`done: ${applied} replacements applied`);

