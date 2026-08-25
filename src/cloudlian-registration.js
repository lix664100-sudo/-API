import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ChatplusClient } from "./channels/chatplus.js";
import { checkProxyReachability, safeProxyEndpoint } from "./proxy.js";
import { loadConfig, saveAccount } from "./storage.js";

const PROVIDER = "cloudlian";
const FIXED_PASSWORD = "123456";
const MAX_ACTIVATION_CODE_LENGTH = 512;
const MAX_PROXY_LENGTH = 2048;
const MAX_REGISTER_ATTEMPTS = 3;
const MAX_BATCH_REGISTRATIONS = 500;
const BATCH_REGISTRATION_CONCURRENCY = 3;
const MAX_BATCH_ACCOUNT_ACTIVATIONS = 500;
const BATCH_ACCOUNT_ACTIVATION_CONCURRENCY = 3;
const ACTIVATION_REQUEST_TIMEOUT_SEC = 20;
const COMPLETED_STATES = new Set(["completed"]);
const REGISTERED_STATES = new Set(["registered", "activating", "activation_required", "activation_uncertain"]);
const activeActivationOperations = new Map();
const activeExchangeReservations = new Map();

function inputError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function shortMessage(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : fallback;
}

function registrationMeta(account = {}) {
  const registration = account.meta?.registration;
  return registration?.provider === PROVIDER ? registration : {};
}

function chatBaseUrl(channel = {}) {
  if (channel.type === "shareai") return String(channel.settings?.chatBaseUrl || "").trim();
  if (channel.type === "chatplus") return String(channel.settings?.baseUrl || "").trim();
  return "";
}

function channelAbilityEnabled(channel, ability) {
  const enabled = channel?.settings?.enabledAbilities;
  return !enabled || typeof enabled !== "object" || enabled[ability] !== false;
}

export function chatActivationBaseUrl(channel = {}) {
  if (channel.type === "shareai" && !channelAbilityEnabled(channel, "chatplus")) return "";
  if (!["shareai", "chatplus"].includes(channel.type)) return "";
  const value = chatBaseUrl(channel);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function cloudlianChannelBaseUrl(channel = {}) {
  if (channel.type === "shareai" && channelAbilityEnabled(channel, "drawing")) return "";
  const baseUrl = chatActivationBaseUrl(channel);
  if (!baseUrl) return "";
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === "cloudlian.cn" || host.endsWith(".cloudlian.cn") ? baseUrl : "";
}

function activationCodeHash(channelId, activationCode) {
  return createHash("sha256").update(`${channelId}\n${activationCode}`).digest("hex");
}

function exchangeCodeHash(baseUrl, activationCode) {
  return createHash("sha256").update(`${baseUrl}\n${activationCode}`).digest("hex");
}

function reserveExchangeCode(baseUrl, activationCode, accountId) {
  const key = exchangeCodeHash(baseUrl, activationCode);
  if (activeExchangeReservations.has(key)) {
    throw inputError("这个激活码正在处理中，请等待当前操作完成。", 409);
  }
  const token = Symbol(accountId);
  activeExchangeReservations.set(key, token);
  return () => {
    if (activeExchangeReservations.get(key) === token) activeExchangeReservations.delete(key);
  };
}

function reserveActivationOperation(activationCode) {
  const key = activationCodeHash("shared-activation-operation", activationCode);
  if (activeActivationOperations.has(key)) {
    throw inputError("这个激活码正在处理中，请等待当前操作完成。", 409);
  }
  const token = Symbol(activationCode);
  activeActivationOperations.set(key, token);
  return () => {
    if (activeActivationOperations.get(key) === token) activeActivationOperations.delete(key);
  };
}

function usageHash(usage) {
  return createHash("sha256").update(JSON.stringify(usage || {})).digest("hex");
}

function randomUsername() {
  return `cl${randomBytes(7).toString("hex")}`;
}

function upstreamAccepted(payload) {
  return payload?.code === 1;
}

function duplicateUsername(payload) {
  return /(?:已存在|存在|重复|占用|already exists|taken|duplicate)/i.test(String(payload?.msg || payload?.message || ""));
}

function loginConfigData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
}

function assertSupportedLoginConfig(payload) {
  if (payload?.code !== undefined && payload.code !== 1) {
    throw inputError(shortMessage(payload?.msg || payload?.message, "无法读取目标站注册设置。"), 502);
  }
  const settings = loginConfigData(payload);
  if (settings.isEnableRegister !== true) throw inputError("目标站目前已关闭注册。", 409);
  if (settings.isEnableExchange !== true) throw inputError("目标站目前已关闭激活码兑换。", 409);
  if (settings.isEnableMailRegister === true) throw inputError("目标站目前要求邮箱验证，暂时不能自动注册。", 409);
  if (settings.isEnableRegisterTurnstile === true) throw inputError("目标站目前要求人工验证，暂时不能自动注册。", 409);
  if (settings.isInviteRegister === true) throw inputError("目标站目前要求邀请码，暂时不能自动注册。", 409);
}

function assertExchangeEnabled(payload) {
  if (payload?.code !== undefined && payload.code !== 1) {
    throw inputError(shortMessage(payload?.msg || payload?.message, "无法读取目标站激活设置。"), 502);
  }
  if (loginConfigData(payload).isEnableExchange !== true) {
    throw inputError("目标站目前已关闭激活码兑换。", 409);
  }
}

function publicResult(account, status, message) {
  return {
    accountId: account.id,
    username: account.username,
    status,
    message
  };
}

function activationHistory(account = {}) {
  return Array.isArray(account.meta?.activations) ? account.meta.activations : [];
}

function activationRecordMeta(account, baseUrl, activationCode) {
  const codeHash = exchangeCodeHash(baseUrl, activationCode);
  const history = activationHistory(account).filter((item) => item?.codeHash !== codeHash).slice(-49);
  return {
    activations: [...history, {
      provider: "chatplus-exchange",
      codeHash,
      redeemedAt: new Date().toISOString()
    }]
  };
}

function activationStatusMeta(channel, account, status, message) {
  if (channel.type !== "shareai") return account.meta || {};
  const abilities = { ...(account.meta?.abilities || {}) };
  if (channelAbilityEnabled(channel, "drawing")) {
    abilities.drawing = { ...(abilities.drawing || {}), status, message };
  }
  if (channelAbilityEnabled(channel, "chatplus")) {
    abilities.chatplus = { ...(abilities.chatplus || {}), status, message };
  }
  return { ...(account.meta || {}), abilities };
}

function loginConfigClient(dependencies, config, channel, account, baseUrl) {
  return dependencies.createClient({
    config,
    channel: {
      ...channel,
      id: `${channel.id}:activation`,
      type: "chatplus",
      settings: { ...(channel.settings || {}), baseUrl }
    },
    account
  });
}

async function loginWithOptionalUsages(client, options = {}) {
  await client.performPortalLogin(options);
  try {
    return await client.loadAccountUsages(options);
  } catch {
    return null;
  }
}

export function createCloudlianRegistrationService(overrides = {}) {
  const dependencies = {
    loadConfig,
    saveAccount,
    checkProxyReachability,
    createClient: (context) => new ChatplusClient(context),
    createUsername: randomUsername,
    ...overrides
  };
  const activeRegistrations = new Map();
  const activeAccountRegistrations = new Map();

  async function saveRegistrationState(account, state, message, extra = {}) {
    const previous = registrationMeta(account);
    const now = new Date().toISOString();
    const next = {
      ...account,
      ...extra.account,
      status: extra.account?.status || (state === "completed" ? "unknown" : state === "activation_required" ? "activation_required" : "disabled"),
      message,
      enabled: ["completed", "activation_required"].includes(state),
      meta: {
        ...(account.meta || {}),
        ...(extra.meta || {}),
        registration: {
          ...previous,
          provider: PROVIDER,
          status: state,
          message,
          updatedAt: now,
          ...(previous.createdAt ? {} : { createdAt: now }),
          ...(extra.registration || {})
        }
      }
    };
    const config = await dependencies.saveAccount(next);
    return config.accounts.find((item) => item.id === next.id) || next;
  }

  async function run(input) {
    const channelId = String(input?.channelId || "").trim();
    const activationCode = String(input?.activationCode || "").trim();
    const proxyUrl = String(input?.proxyUrl || "").trim();
    const resumeAccountId = String(input?.resumeAccountId || "").trim();
    if (!channelId) throw inputError("请选择要绑定的渠道。");
    if (!activationCode) throw inputError("请输入激活码。");
    if (activationCode.length > MAX_ACTIVATION_CODE_LENGTH) throw inputError("激活码过长，请检查后重试。");
    if (proxyUrl.length > MAX_PROXY_LENGTH) throw inputError("注册 IP 内容过长，请检查后重试。");

    const config = await dependencies.loadConfig();
    const channel = config.channels.find((item) => item.id === channelId);
    if (!channel) throw inputError("所选渠道不存在。", 404);
    const baseUrl = cloudlianChannelBaseUrl(channel);
    if (!baseUrl) throw inputError("这个渠道不是可自动注册的 cloudlian.cn 聊天渠道。", 409);

    const codeHash = activationCodeHash(channelId, activationCode);
    const exchangeHash = exchangeCodeHash(baseUrl, activationCode);
    const accountWithRedeemedCode = config.accounts.find((item) =>
      activationHistory(item).some((record) => record?.codeHash === exchangeHash)
    );
    if (accountWithRedeemedCode) {
      return publicResult(accountWithRedeemedCode, "already_bound", "这个激活码已经绑定，无需重复注册。");
    }
    const accountWithCode = config.accounts.find((item) =>
      item.channelId === channelId && registrationMeta(item).activationCodeHash === codeHash
    );
    if (COMPLETED_STATES.has(registrationMeta(accountWithCode).status)) {
      return publicResult(accountWithCode, "already_bound", "这个激活码已经绑定，无需重复注册。");
    }

    const resumeAccount = resumeAccountId
      ? config.accounts.find((item) => item.id === resumeAccountId && item.channelId === channelId)
      : null;
    const canResume = resumeAccount
      && registrationMeta(resumeAccount).provider === PROVIDER
      && !COMPLETED_STATES.has(registrationMeta(resumeAccount).status);
    let account = accountWithCode || (canResume ? resumeAccount : null);

    const proxyEndpoint = safeProxyEndpoint(proxyUrl);
    if (proxyEndpoint.proxyConfigured && !proxyEndpoint.proxyHost) throw inputError("注册 IP 格式不正确。");
    if (proxyEndpoint.proxyConfigured) {
      const proxyCheck = await dependencies.checkProxyReachability(proxyUrl, baseUrl, 8000);
      if (!proxyCheck.ok) throw inputError(proxyCheck.message || "注册 IP 无法连接目标站。");
    }

    if (!account) {
      const username = dependencies.createUsername();
      account = {
        id: `account-${randomUUID()}`,
        channelId,
        name: username,
        username,
        password: FIXED_PASSWORD,
        proxyUrl,
        enabled: false,
        priority: 1,
        routingWeight: 1,
        status: "disabled",
        message: "正在注册账号。",
        meta: {}
      };
    } else {
      account = {
        ...account,
        password: account.password || FIXED_PASSWORD,
        proxyUrl
      };
    }

    const makeClient = () => loginConfigClient(dependencies, config, channel, account, baseUrl);
    let client = makeClient();
    const loginConfig = await client.json("/frontend-api/getLoginConfig");
    assertSupportedLoginConfig(loginConfig);

    account = await saveRegistrationState(account, registrationMeta(account).status || "pending", "正在注册账号。", {
      registration: { activationCodeHash: codeHash }
    });
    client = makeClient();

    const state = registrationMeta(account).status;
    let usages = null;
    let registered = REGISTERED_STATES.has(state);

    if (registered) {
      try {
        usages = await loginWithOptionalUsages(client);
      } catch (error) {
        const text = `账号已保留，但自动登录失败：${shortMessage(error?.message, "请稍后重试。")}`;
        account = await saveRegistrationState(account, "registration_failed", text, {
          registration: { activationCodeHash: codeHash }
        });
        return publicResult(account, "registration_failed", text);
      }
    } else {
      try {
        usages = await loginWithOptionalUsages(client);
        registered = true;
      } catch {
        // A pending account normally does not exist upstream yet.
      }
    }

    if (!registered) {
      for (let attempt = 0; attempt < MAX_REGISTER_ATTEMPTS; attempt += 1) {
        try {
          const payload = await client.json("/frontend-api/register", {
            method: "POST",
            body: {
              userToken: account.username,
              password: FIXED_PASSWORD,
              email: "",
              emailCode: "",
              inviterId: "",
              token: ""
            }
          });
          if (upstreamAccepted(payload)) {
            registered = true;
            break;
          }
          if (duplicateUsername(payload) && attempt + 1 < MAX_REGISTER_ATTEMPTS) {
            const username = dependencies.createUsername();
            account = await saveRegistrationState(account, "pending", "正在重新生成账号。", {
              account: { name: username, username },
              registration: { activationCodeHash: codeHash }
            });
            client = makeClient();
            continue;
          }
          const text = `注册失败：${shortMessage(payload?.msg || payload?.message, "目标站拒绝了注册请求。")}`;
          account = await saveRegistrationState(account, "registration_failed", text, {
            registration: { activationCodeHash: codeHash }
          });
          return publicResult(account, "registration_failed", text);
        } catch (error) {
          try {
            client = makeClient();
            usages = await loginWithOptionalUsages(client);
            registered = true;
            break;
          } catch {
            const text = `注册结果暂时无法确认：${shortMessage(error?.message, "目标站没有响应。请稍后用同一激活码重试。")}`;
            account = await saveRegistrationState(account, "registration_uncertain", text, {
              registration: { activationCodeHash: codeHash }
            });
            return publicResult(account, "registration_uncertain", text);
          }
        }
      }
    }

    if (!registered) {
      const text = "注册失败，请稍后重试。";
      account = await saveRegistrationState(account, "registration_failed", text, {
        registration: { activationCodeHash: codeHash }
      });
      return publicResult(account, "registration_failed", text);
    }

    if (!usages) {
      try {
        client = makeClient();
        usages = await loginWithOptionalUsages(client);
      } catch (error) {
        const text = `账号已注册，但自动登录失败：${shortMessage(error?.message, "请稍后重试。")}`;
        account = await saveRegistrationState(account, "registration_failed", text, {
          registration: { activationCodeHash: codeHash }
        });
        return publicResult(account, "registration_failed", text);
      }
    }

    const previousRegistration = registrationMeta(account);
    const currentUsageHash = usages ? usageHash(usages) : "";
    if (
      previousRegistration.status === "activation_uncertain"
      && previousRegistration.activationBaselineHash
      && currentUsageHash
      && previousRegistration.activationBaselineHash !== currentUsageHash
    ) {
      const text = "账号已注册、激活并绑定。";
      account = await saveRegistrationState(account, "completed", text, {
        meta: activationRecordMeta(account, baseUrl, activationCode),
        registration: {
          activationCodeHash: codeHash,
          completedAt: new Date().toISOString()
        }
      });
      return publicResult(account, "ready", text);
    }

    const releaseExchangeCode = reserveExchangeCode(baseUrl, activationCode, account.id);
    try {
      const activationBaselineHash = previousRegistration.activationBaselineHash || currentUsageHash;
      account = await saveRegistrationState(account, "activating", "账号已注册，正在激活。", {
        registration: { activationCodeHash: codeHash, activationBaselineHash }
      });

      try {
        const payload = await client.json("/frontend-api/exchange", {
          method: "POST",
          body: {
            userToken: account.username,
            redemptionCode: activationCode
          }
        });
        if (!upstreamAccepted(payload)) {
          const text = `账号已注册但尚未激活：${shortMessage(payload?.msg || payload?.message, "请更换激活码后重试。")}`;
          account = await saveRegistrationState(account, "activation_required", text, {
            account: { status: "activation_required" },
            meta: activationStatusMeta(channel, account, "activation_required", "未激活"),
            registration: { activationCodeHash: codeHash, activationBaselineHash }
          });
          return publicResult(account, "activation_required", text);
        }
      } catch (error) {
        try {
          client = makeClient();
          const refreshedUsages = await loginWithOptionalUsages(client);
          const refreshedUsageHash = refreshedUsages ? usageHash(refreshedUsages) : "";
          if (activationBaselineHash && refreshedUsageHash && refreshedUsageHash !== activationBaselineHash) {
            const text = "账号已注册、激活并绑定。";
            account = await saveRegistrationState(account, "completed", text, {
              meta: activationRecordMeta(account, baseUrl, activationCode),
              registration: {
                activationCodeHash: codeHash,
                completedAt: new Date().toISOString()
              }
            });
            return publicResult(account, "ready", text);
          }
        } catch {
          // Keep the account so retrying the same code can safely recover.
        }
        const text = `账号已注册，但激活结果暂时无法确认：${shortMessage(error?.message, "请稍后用同一激活码重试。")}`;
        account = await saveRegistrationState(account, "activation_uncertain", text, {
          registration: { activationCodeHash: codeHash, activationBaselineHash }
        });
        return publicResult(account, "activation_uncertain", text);
      }

      const text = "账号已注册、激活并绑定。";
      account = await saveRegistrationState(account, "completed", text, {
        meta: activationRecordMeta(account, baseUrl, activationCode),
        registration: {
          activationCodeHash: codeHash,
          completedAt: new Date().toISOString()
        }
      });
      return publicResult(account, "ready", text);
    } finally {
      releaseExchangeCode();
    }
  }

  return async function registerCloudlianAccount(input = {}) {
    const channelId = String(input.channelId || "").trim();
    const activationCode = String(input.activationCode || "").trim();
    const resumeAccountId = String(input.resumeAccountId || "").trim();
    const key = activationCode ? activationCodeHash(channelId, activationCode) : `${channelId}:missing`;
    if (activeRegistrations.has(key)) return activeRegistrations.get(key);
    if (resumeAccountId && activeAccountRegistrations.has(resumeAccountId)) {
      throw inputError("这个账号正在处理中，请等待当前操作完成。", 409);
    }
    const releaseActivation = activationCode ? reserveActivationOperation(activationCode) : () => {};
    const operation = run(input).finally(() => {
      releaseActivation();
      if (activeRegistrations.get(key) === operation) activeRegistrations.delete(key);
      if (resumeAccountId && activeAccountRegistrations.get(resumeAccountId) === operation) {
        activeAccountRegistrations.delete(resumeAccountId);
      }
    });
    activeRegistrations.set(key, operation);
    if (resumeAccountId) activeAccountRegistrations.set(resumeAccountId, operation);
    return operation;
  };
}

export const registerCloudlianAccount = createCloudlianRegistrationService();

export function createCloudlianBatchRegistrationService(registerAccount = registerCloudlianAccount) {
  return async function registerCloudlianAccounts(input = {}) {
    const channelId = String(input.channelId || "").trim();
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!channelId) throw inputError("请选择要绑定的渠道。");
    if (!rows.length) throw inputError("请至少输入一条激活码。");
    if (rows.length > MAX_BATCH_REGISTRATIONS) throw inputError(`一次最多处理 ${MAX_BATCH_REGISTRATIONS} 条激活码。`);

    const results = new Array(rows.length);
    const seen = new Set();
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index] || {};
        const rowId = String(row.rowId || index + 1);
        const activationCode = String(row.activationCode || "").trim();
        const proxyUrl = String(row.proxyUrl || "").trim();
        const duplicateKey = activationCode ? activationCodeHash(channelId, activationCode) : "";
        if (!activationCode) {
          results[index] = { rowId, status: "failed", message: "缺少激活码。" };
          continue;
        }
        if (activationCode.length > MAX_ACTIVATION_CODE_LENGTH) {
          results[index] = { rowId, status: "failed", message: "激活码过长，请检查后重试。" };
          continue;
        }
        if (proxyUrl.length > MAX_PROXY_LENGTH) {
          results[index] = { rowId, status: "failed", message: "注册 IP 内容过长，请检查后重试。" };
          continue;
        }
        if (seen.has(duplicateKey)) {
          results[index] = { rowId, status: "duplicate", message: "这条激活码在本次导入中重复。" };
          continue;
        }
        seen.add(duplicateKey);
        try {
          results[index] = {
            rowId,
            ...(await registerAccount({ channelId, activationCode, proxyUrl }))
          };
        } catch (error) {
          results[index] = {
            rowId,
            status: "failed",
            message: shortMessage(error?.message, "处理失败，请稍后重试。")
          };
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(BATCH_REGISTRATION_CONCURRENCY, rows.length) },
      () => worker()
    ));
    const successfulStatuses = new Set(["ready", "already_bound"]);
    const pendingStatuses = new Set(["activation_required", "activation_uncertain", "registration_uncertain"]);
    return {
      results,
      summary: {
        total: results.length,
        success: results.filter((item) => successfulStatuses.has(item?.status)).length,
        pending: results.filter((item) => pendingStatuses.has(item?.status)).length,
        failed: results.filter((item) => !successfulStatuses.has(item?.status) && !pendingStatuses.has(item?.status)).length
      }
    };
  };
}

export const registerCloudlianAccounts = createCloudlianBatchRegistrationService();

function resetAccountAfterActivation(channel, account, message) {
  const next = {
    ...account,
    enabled: true,
    status: "unknown",
    message,
    meta: { ...(account.meta || {}) }
  };
  if (channel.type === "shareai") {
    const abilities = { ...(next.meta.abilities || {}) };
    if (channelAbilityEnabled(channel, "drawing")) {
      abilities.drawing = { status: "unknown", message: "等待检测" };
    }
    if (channelAbilityEnabled(channel, "chatplus")) {
      abilities.chatplus = { status: "unknown", message: "等待检测" };
    }
    next.meta.abilities = abilities;
  }
  return next;
}

function failedActivationAccount(channel, account, message, attempt) {
  const wasUnactivated = account.status === "activation_required"
    || registrationMeta(account).status === "activation_required";
  const next = {
    ...account,
    message,
    meta: {
      ...(wasUnactivated ? activationStatusMeta(channel, account, "activation_required", "未激活") : account.meta || {}),
      activationAttempt: attempt
    }
  };
  if (wasUnactivated) {
    next.enabled = true;
    next.status = "activation_required";
  }
  return next;
}

export function createChatAccountActivationService(overrides = {}) {
  const dependencies = {
    loadConfig,
    saveAccount,
    createClient: (context) => new ChatplusClient(context),
    ...overrides
  };
  const activeCodes = new Map();
  const activeAccounts = new Map();

  async function saveSuccessfulActivation(channel, account, baseUrl, activationCode) {
    const text = "激活成功，正在检测账号。";
    const next = resetAccountAfterActivation(channel, account, text);
    const registration = registrationMeta(account);
    next.meta = {
      ...next.meta,
      ...activationRecordMeta(account, baseUrl, activationCode)
    };
    delete next.meta.activationAttempt;
    if (registration.provider === PROVIDER) {
      next.meta.registration = {
        ...registration,
        status: "completed",
        message: text,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        activationCodeHash: activationCodeHash(channel.id, activationCode)
      };
    }
    const savedConfig = await dependencies.saveAccount(next);
    const saved = savedConfig.accounts.find((item) => item.id === account.id) || next;
    return publicResult(saved, "ready", text);
  }

  async function run(input) {
    const accountId = String(input.accountId || "").trim();
    const activationCode = String(input.activationCode || "").trim();
    if (!accountId) throw inputError("请选择要激活的账号。");
    if (!activationCode) throw inputError("请输入激活码。");
    if (activationCode.length > MAX_ACTIVATION_CODE_LENGTH) throw inputError("激活码过长，请检查后重试。");

    const config = await dependencies.loadConfig();
    const account = config.accounts.find((item) => item.id === accountId);
    if (!account) throw inputError("账号不存在。", 404);
    const channel = config.channels.find((item) => item.id === account.channelId);
    if (!channel) throw inputError("账号所属渠道不存在。", 404);
    const baseUrl = chatActivationBaseUrl(channel);
    if (!baseUrl) throw inputError("这个账号不支持激活码激活。", 409);

    const codeHash = exchangeCodeHash(baseUrl, activationCode);
    const boundAccount = config.accounts.find((item) =>
      item.id !== accountId && activationHistory(item).some((record) => record?.codeHash === codeHash)
    );
    if (boundAccount) throw inputError("这个激活码已经用于其他账号。", 409);
    if (activationHistory(account).some((record) => record?.codeHash === codeHash)) {
      return publicResult(account, "already_bound", "这个激活码已经用于当前账号，无需重复激活。");
    }

    const releaseExchangeCode = reserveExchangeCode(baseUrl, activationCode, account.id);
    try {
      const client = loginConfigClient(dependencies, config, channel, account, baseUrl);
      const requestOptions = { timeoutSec: ACTIVATION_REQUEST_TIMEOUT_SEC };
      const loginConfig = await client.json("/frontend-api/getLoginConfig", requestOptions);
      assertExchangeEnabled(loginConfig);

      let usages;
      try {
        usages = await loginWithOptionalUsages(client, requestOptions);
      } catch (error) {
        throw inputError(`账号登录失败：${shortMessage(error?.message, "请检查账号和密码。")}`, 409);
      }

      const currentUsageHash = usages ? usageHash(usages) : "";
      const previousAttempt = account.meta?.activationAttempt;
      if (
        previousAttempt?.codeHash === codeHash
        && previousAttempt.baselineHash
        && currentUsageHash
        && previousAttempt.baselineHash !== currentUsageHash
      ) {
        return saveSuccessfulActivation(channel, account, baseUrl, activationCode);
      }

      const attempt = {
        codeHash,
        baselineHash: previousAttempt?.codeHash === codeHash && previousAttempt.baselineHash
          ? previousAttempt.baselineHash
          : currentUsageHash,
        startedAt: new Date().toISOString()
      };
      await dependencies.saveAccount({
        ...account,
        meta: { ...(account.meta || {}), activationAttempt: attempt }
      });

      try {
        const payload = await client.json("/frontend-api/exchange", {
          method: "POST",
          timeoutSec: ACTIVATION_REQUEST_TIMEOUT_SEC,
          body: {
            userToken: account.username,
            redemptionCode: activationCode
          }
        });
        if (!upstreamAccepted(payload)) {
          const text = `激活失败：${shortMessage(payload?.msg || payload?.message, "请检查激活码后重试。")}`;
          await dependencies.saveAccount(failedActivationAccount(channel, account, text, attempt));
          return publicResult(account, "activation_failed", text);
        }
      } catch (error) {
        try {
          const verificationClient = loginConfigClient(dependencies, config, channel, account, baseUrl);
          const refreshed = await loginWithOptionalUsages(verificationClient, requestOptions);
          const refreshedHash = refreshed ? usageHash(refreshed) : "";
          if (attempt.baselineHash && refreshedHash && attempt.baselineHash !== refreshedHash) {
            return saveSuccessfulActivation(channel, account, baseUrl, activationCode);
          }
        } catch {
          // Keep the attempt so retrying the same code can safely recover.
        }
        const text = `激活结果暂时无法确认：${shortMessage(error?.message, "请稍后用同一激活码重试。")}`;
        await dependencies.saveAccount(failedActivationAccount(channel, account, text, attempt));
        return publicResult(account, "activation_uncertain", text);
      }

      return saveSuccessfulActivation(channel, account, baseUrl, activationCode);
    } finally {
      releaseExchangeCode();
    }
  }

  return async function activateChatAccount(input = {}) {
    const accountId = String(input.accountId || "").trim();
    const activationCode = String(input.activationCode || "").trim();
    const key = activationCode ? activationCodeHash("chat-account-activation", activationCode) : `${accountId}:missing`;
    const matchingOperation = activeCodes.get(key);
    if (matchingOperation?.accountId === accountId) return matchingOperation.promise;
    if (matchingOperation) throw inputError("这个激活码正在用于其他账号，请等待当前操作完成。", 409);
    if (accountId && activeAccounts.has(accountId)) throw inputError("这个账号正在激活，请等待当前操作完成。", 409);
    const releaseActivation = activationCode ? reserveActivationOperation(activationCode) : () => {};
    const operation = run(input).finally(() => {
      releaseActivation();
      if (activeCodes.get(key)?.promise === operation) activeCodes.delete(key);
      if (activeAccounts.get(accountId) === operation) activeAccounts.delete(accountId);
    });
    activeCodes.set(key, { accountId, promise: operation });
    if (accountId) activeAccounts.set(accountId, operation);
    return operation;
  };
}

export const activateChatAccount = createChatAccountActivationService();

function activationSubscriptionExpired(status = {}, now = Date.now()) {
  if (status.status === "subscription_expired") return true;
  const modelKey = String(status.meta?.chatModel || status.quotaModel || "gpt").trim().toLowerCase() || "gpt";
  const expireAt = status.meta?.referenceUsage?.[modelKey]?.expireAt || status.expireAt || "";
  const expireTime = Date.parse(expireAt);
  return Number.isFinite(expireTime) && expireTime <= now;
}

export function accountNeedsActivationRenewal(account = {}, now = Date.now()) {
  if (account.enabled === false) return false;
  const statuses = [
    account.status,
    account.meta?.registration?.status,
    ...Object.values(account.meta?.abilities || {}).map((ability) => ability?.status)
  ];
  if (statuses.some((status) => [
    "subscription_expired",
    "subscription_missing",
    "activation_required"
  ].includes(status))) return true;
  const expirySources = [
    account,
    account.meta?.registration,
    ...Object.values(account.meta?.abilities || {})
  ].filter(Boolean);
  return expirySources.some((status) => activationSubscriptionExpired(status, now));
}

export function createChatAccountBatchActivationService(overrides = {}) {
  const dependencies = {
    loadConfig,
    activateAccount: activateChatAccount,
    ...overrides
  };

  return async function activateChatAccounts(input = {}) {
    const channelId = String(input.channelId || "").trim();
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!channelId) throw inputError("请选择要续费的渠道。");
    if (!rows.length) throw inputError("请至少输入一条激活码。");
    if (rows.length > MAX_BATCH_ACCOUNT_ACTIVATIONS) {
      throw inputError(`一次最多处理 ${MAX_BATCH_ACCOUNT_ACTIVATIONS} 条激活码。`);
    }

    const config = await dependencies.loadConfig();
    const channel = config.channels.find((item) => item.id === channelId);
    if (!channel) throw inputError("续费渠道不存在。", 404);
    const baseUrl = chatActivationBaseUrl(channel);
    if (!baseUrl) throw inputError("这个渠道不支持激活码续费。", 409);

    const accountsById = new Map(config.accounts.map((account) => [account.id, account]));
    const results = new Array(rows.length);
    const seenCodes = new Set();
    const seenAccounts = new Set();
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index] || {};
        const rowId = String(row.rowId || index + 1);
        const accountId = String(row.accountId || "").trim();
        const activationCode = String(row.activationCode || "").trim();
        const duplicateCodeKey = activationCode.toLowerCase();

        if (!activationCode) {
          results[index] = { rowId, accountId, status: "failed", message: "缺少激活码。" };
          continue;
        }
        if (activationCode.length > MAX_ACTIVATION_CODE_LENGTH) {
          results[index] = { rowId, accountId, status: "failed", message: "激活码过长，请检查后重试。" };
          continue;
        }
        if (seenCodes.has(duplicateCodeKey)) {
          results[index] = { rowId, accountId, status: "duplicate", message: "这条激活码在本次续费中重复。" };
          continue;
        }
        seenCodes.add(duplicateCodeKey);
        if (!accountId) {
          results[index] = { rowId, accountId, status: "failed", message: "请选择要续费的账号。" };
          continue;
        }
        if (seenAccounts.has(accountId)) {
          results[index] = { rowId, accountId, status: "duplicate", message: "这个账号在本次续费中重复。" };
          continue;
        }
        seenAccounts.add(accountId);

        const account = accountsById.get(accountId);
        if (!account || account.channelId !== channelId) {
          results[index] = { rowId, accountId, status: "failed", message: "账号不属于当前渠道，请重新预览。" };
          continue;
        }
        if (!accountNeedsActivationRenewal(account)) {
          results[index] = { rowId, accountId, status: "failed", message: "账号当前不需要续费，请刷新后重新预览。" };
          continue;
        }
        const redeemedCodeHash = exchangeCodeHash(baseUrl, activationCode);
        if (activationHistory(account).some((record) => record?.codeHash === redeemedCodeHash)) {
          results[index] = { rowId, accountId, status: "failed", message: "这个激活码以前已用于当前账号，请更换新的激活码。" };
          continue;
        }

        try {
          results[index] = {
            rowId,
            accountId,
            ...(await dependencies.activateAccount({ accountId, activationCode }))
          };
        } catch (error) {
          results[index] = {
            rowId,
            accountId,
            status: "failed",
            message: shortMessage(error?.message, "续费失败，请稍后重试。")
          };
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(BATCH_ACCOUNT_ACTIVATION_CONCURRENCY, rows.length) },
      () => worker()
    ));

    const successfulStatuses = new Set(["ready", "already_bound"]);
    const pendingStatuses = new Set(["activation_uncertain"]);
    return {
      results,
      summary: {
        total: results.length,
        success: results.filter((item) => successfulStatuses.has(item?.status)).length,
        pending: results.filter((item) => pendingStatuses.has(item?.status)).length,
        failed: results.filter((item) => !successfulStatuses.has(item?.status) && !pendingStatuses.has(item?.status)).length
      }
    };
  };
}

export const activateChatAccounts = createChatAccountBatchActivationService();
