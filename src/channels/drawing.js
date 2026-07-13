import fetch, { Headers } from "node-fetch";
import { ProxyAgent } from "proxy-agent";
import { normalizeProxyUrl } from "../proxy.js";

const ACCOUNT_CHECK_TIMEOUT_MS = 3000;

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function proxyUrlFor(account) {
  return normalizeProxyUrl(account?.proxyUrl || account?.proxy || "");
}

function getCookieValue(setCookieHeaders, name) {
  const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
  for (const cookie of cookies) {
    const firstPart = String(cookie).split(";")[0];
    const separator = firstPart.indexOf("=");
    if (separator < 0) continue;
    const key = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();
    if (key === name && value) return value;
  }
  return "";
}

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;,\s]+=)/g);
}

function toAbsoluteUrl(baseUrl, url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url;
  return `${trimSlash(baseUrl)}${url.startsWith("/") ? "" : "/"}${url}`;
}

function isDrawingAuthError(error) {
  const text = `${error?.message || ""} ${error?.status || ""} ${error?.code || ""} ${JSON.stringify(error?.payload || {})}`;
  return /\b(401|403)\b|账号已在其他设备登录|其他设备登|身份验证失败|请重新登录|重新登录|重新登陆|未登录|未登陆|unauthorized|forbidden/i.test(text);
}

function isDrawingQuotaEmptyError(error) {
  const text = `${error?.message || ""} ${error?.status || ""} ${error?.code || ""} ${JSON.stringify(error?.payload || {})}`;
  return /(?:积分|余额|额度|配额).{0,16}(?:不足|不够|用完|耗尽|为\s*0|已满|上限|限制)|(?:quota|credit|balance|limit).{0,24}(?:insufficient|exhausted|empty|reached|used up)/i.test(text);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isZeroOrLess(value) {
  const number = numberOrNull(value);
  return number !== null && number <= 0;
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  if (!(timeoutMs > 0)) return fetch(url, fetchOptions);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: fetchOptions.signal || controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("目标网站打不开，可能是服务器 IP 被限制或代理不可用。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findFirstField(source, keys) {
  const stack = [source];
  const seen = new Set();
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const [key, value] of Object.entries(item)) {
      if (keys.has(key) && value !== null && value !== undefined && value !== "") return value;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

function quotaResetAtFrom(profile, stats) {
  return findFirstField({ profile, stats }, new Set([
    "quotaResetAt",
    "quota_reset_at",
    "quota_reset_time",
    "points_reset_at",
    "points_reset_time",
    "balance_reset_at",
    "balance_reset_time",
    "resetAt",
    "reset_at",
    "reset_time",
    "next_reset_at",
    "nextResetAt"
  ]));
}

export function drawingUpstreamFailureCode(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const relayFailure = text.match(/中转接口请求失败[^\d]*状态码\s*[:：]\s*(\d{3})/);
  if (relayFailure) return relayFailure[1];
  return text.match(/绘图站上游服务异常[（(](\d{3})[）)]/)?.[1] || "";
}

export function drawingRetryAfterSeconds(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const match = text.match(/上传过于频繁[^\d]*请\s*(\d+)\s*秒后再试/);
  const seconds = Number(match?.[1] || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

export function userFacingDrawingErrorMessage(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const failureCode = drawingUpstreamFailureCode(text);
  if (failureCode) return `绘图站上游服务异常（${failureCode}），不是额度不足，请稍后重试。`;
  return text;
}

export function normalizeDrawingTask(task, drawingBaseUrl = "") {
  const items = Array.isArray(task?.items) ? task.items : [];
  const itemError = items
    .map((item) => item?.error_message || item?.message || "")
    .filter(Boolean)
    .join("；");
  const imageUrls = items
    .map((item) => item?.image_url || item?.public_url || "")
    .filter(Boolean)
    .map((url) => toAbsoluteUrl(drawingBaseUrl, url));

  return {
    externalId: task?.id ?? task?.task_id ?? task?.taskNo ?? task?.task_no,
    taskNo: task?.task_no || task?.taskNo || "",
    status: task?.status || "unknown",
    prompt: task?.prompt || "",
    taskType: task?.task_type || task?.taskType || "",
    modelId: task?.model_id ?? task?.modelId,
    ratio: task?.ratio_label || task?.ratio || "",
    imageCount: Number(task?.image_count || imageUrls.length || 1),
    imageUrls,
    errorMessage: userFacingDrawingErrorMessage(task?.error_message || task?.message || itemError),
    raw: task
  };
}

export class DrawingClient {
  constructor({ config, channel, account, sessionLock }) {
    this.config = config;
    this.channel = channel;
    this.account = account;
    this.mainBaseUrl = trimSlash(config.mainBaseUrl || "https://ikun.aishare.icu");
    this.drawingBaseUrl = trimSlash(channel?.settings?.baseUrl || config.drawingBaseUrl || "https://drawing.aishare.icu");
    this.accessToken = "";
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    this.proxyUrl = proxyUrlFor(account);
    this.proxyAgent = this.proxyUrl ? new ProxyAgent({ getProxyForUrl: () => this.proxyUrl }) : null;
    this.contextSignature = this.makeContextSignature({ config, channel, account });
  }

  makeContextSignature({ config, channel, account }) {
    return [
      trimSlash(config?.mainBaseUrl || "https://ikun.aishare.icu"),
      trimSlash(channel?.settings?.baseUrl || config?.drawingBaseUrl || "https://drawing.aishare.icu"),
      String(account?.username || "").trim().toLowerCase(),
      String(account?.password || ""),
      proxyUrlFor(account)
    ].join("::");
  }

  updateContext({ config, channel, account, sessionLock }) {
    const nextSignature = this.makeContextSignature({ config, channel, account });
    const changed = nextSignature !== this.contextSignature;
    this.config = config;
    this.channel = channel;
    this.account = account;
    this.mainBaseUrl = trimSlash(config.mainBaseUrl || "https://ikun.aishare.icu");
    this.drawingBaseUrl = trimSlash(channel?.settings?.baseUrl || config.drawingBaseUrl || "https://drawing.aishare.icu");
    this.sessionLock = typeof sessionLock === "function" ? sessionLock : async (work) => work();
    if (changed) {
      this.contextSignature = nextSignature;
      this.accessToken = "";
      this.proxyUrl = proxyUrlFor(account);
      this.proxyAgent = this.proxyUrl ? new ProxyAgent({ getProxyForUrl: () => this.proxyUrl }) : null;
    }
  }

  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个绘图账号还没有填写账号或密码。");
    }
  }

  async performLogin(options = {}) {
    this.assertConfigured();
    const loginOptions = {
      method: "POST",
      headers: { "content-type": "application/json" },
      timeoutMs: options.timeoutMs,
      body: JSON.stringify({
        userToken: this.account.username,
        password: this.account.password,
        token: ""
      })
    };
    if (this.proxyAgent) loginOptions.agent = this.proxyAgent;

    const loginResponse = await fetchWithTimeout(`${this.mainBaseUrl}/frontend-api/login`, loginOptions);

    const loginPayload = await loginResponse.json().catch(() => null);
    if (!loginResponse.ok || loginPayload?.code !== 1) {
      throw new Error(loginPayload?.msg || `主站登录失败：${loginResponse.status}`);
    }

    const shareSession = getCookieValue(extractSetCookies(loginResponse.headers), "share-session");
    if (!shareSession) throw new Error("主站登录成功，但没有拿到会话。");

    const ssoData = await this.request("/api/v1/auth/external-sso", {
      method: "POST",
      auth: false,
      timeoutMs: options.timeoutMs,
      body: { "share-token": shareSession }
    });

    if (!ssoData?.access_token) throw new Error("绘图站登录失败。");
    this.accessToken = ssoData.access_token;
    return ssoData;
  }

  async login(options = {}) {
    return this.sessionLock(async () => {
      this.accessToken = "";
      return this.performLogin(options);
    });
  }

  async ensureLogin(options = {}) {
    if (this.accessToken) return;
    await this.sessionLock(async () => {
      if (!this.accessToken) await this.performLogin(options);
    });
  }

  async request(apiPath, options = {}, retried = false) {
    const headers = new Headers(options.headers || {});
    const isForm = options.body instanceof FormData;
    let authToken = "";
    if (options.auth !== false) {
      await this.ensureLogin({ timeoutMs: options.timeoutMs });
      authToken = this.accessToken;
      headers.set("Authorization", `Bearer ${authToken}`);
    }
    if (options.body && !isForm && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const requestOptions = {
      method: options.method || "GET",
      headers,
      timeoutMs: options.timeoutMs,
      body: isForm ? options.body : options.body ? JSON.stringify(options.body) : undefined
    };
    if (this.proxyAgent) requestOptions.agent = this.proxyAgent;

    const response = await fetchWithTimeout(`${this.drawingBaseUrl}${apiPath}`, requestOptions);

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text ? { message: text } : null;
    }
    if (!response.ok || payload?.code) {
      const message = payload?.message || payload?.msg || `绘图站请求失败：${response.status}`;
      const error = new Error(userFacingDrawingErrorMessage(message));
      error.status = response.status;
      error.code = payload?.code;
      error.payload = payload;
      if (isDrawingQuotaEmptyError(error)) {
        error.quotaEmpty = true;
        error.quotaResetAt = quotaResetAtFrom(payload, payload?.data);
      }
      if (options.auth !== false && !retried && isDrawingAuthError(error)) {
        await this.sessionLock(async () => {
          if (this.accessToken === authToken) {
            this.accessToken = "";
            await this.performLogin({ timeoutMs: options.timeoutMs });
          }
        });
        return this.request(apiPath, options, true);
      }
      throw error;
    }
    return payload?.data ?? payload;
  }

  async check() {
    const checkOptions = { timeoutMs: ACCOUNT_CHECK_TIMEOUT_MS };
    await this.ensureLogin(checkOptions);
    const [profile, stats] = await Promise.all([
      this.request("/api/v1/profile", checkOptions),
      this.request("/api/v1/profile/stats", checkOptions)
    ]);
    const balance = profile?.balance ?? profile?.quota_points ?? stats?.balance ?? null;
    const quota = profile?.quota_points ?? profile?.quota ?? stats?.quota ?? null;
    const quotaEmpty = isZeroOrLess(balance);
    return {
      status: quotaEmpty ? "quota_empty" : "ok",
      balance,
      quota,
      quotaResetAt: quotaResetAtFrom(profile, stats),
      expireAt: profile?.external_sub_expire_at || "",
      message: quotaEmpty ? "绘图积分不足" : "绘图账号可用",
      meta: { profile, stats }
    };
  }

  async getModels() {
    return this.request("/api/v1/models");
  }

  defaultModelId(input = {}) {
    return Number(
      input.model_id ||
      input.modelId ||
      this.channel?.settings?.defaultModelId ||
      this.config.defaultModelId ||
      1
    );
  }

  async createTextTask(input) {
    const payload = {
      task_type: "text2img",
      model_id: this.defaultModelId(input),
      ratio_label: input.ratio_label || input.ratio || this.config.defaultRatio || "1:1",
      image_count: Number(input.image_count || input.n || this.config.defaultImageCount || 1),
      prompt: String(input.prompt || "").trim(),
      negative_prompt: String(input.negative_prompt || input.negativePrompt || "").trim()
    };
    if (!payload.prompt) throw new Error("请输入生图描述。");
    const task = await this.request("/api/v1/draw/tasks", { method: "POST", body: payload });
    return normalizeDrawingTask(task, this.drawingBaseUrl);
  }

  async uploadImage(file) {
    const buffer = await file.toBuffer();
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: file.mimetype || "application/octet-stream" }), file.filename || "source.png");
    form.append("purpose", "img2img");
    const upload = await this.request("/api/v1/uploads/images", { method: "POST", body: form });
    const item = Array.isArray(upload?.items) ? upload.items[0] : upload;
    const uploadId = Number(item?.id || item?.upload_id || 0);
    if (!uploadId) throw new Error("源图上传失败。");
    return { uploadId, upload };
  }

  async createImageTask(input) {
    const payload = {
      task_type: "img2img",
      model_id: this.defaultModelId(input),
      ratio_label: input.ratio_label || input.ratio || this.config.defaultRatio || "1:1",
      image_count: Number(input.image_count || input.n || this.config.defaultImageCount || 1),
      prompt: String(input.prompt || "").trim(),
      negative_prompt: String(input.negative_prompt || input.negativePrompt || "").trim(),
      source_upload_ids: input.source_upload_ids || input.sourceUploadIds || []
    };
    if (!payload.prompt) throw new Error("请输入改图要求。");
    if (!payload.source_upload_ids.length) throw new Error("请上传源图。");
    const task = await this.request("/api/v1/draw/tasks", { method: "POST", body: payload });
    return normalizeDrawingTask(task, this.drawingBaseUrl);
  }

  async getTask(externalId) {
    const task = await this.request(`/api/v1/draw/tasks/${encodeURIComponent(externalId)}`);
    return normalizeDrawingTask(task, this.drawingBaseUrl);
  }

  async waitForTask(externalId) {
    while (true) {
      const task = await this.getTask(externalId);
      if (["success", "failed", "cancelled"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
}
