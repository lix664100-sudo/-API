import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ChatplusClient } from "./channels/chatplus.js";
import { checkProxyReachability, safeProxyEndpoint } from "./proxy.js";
import { loadConfig, saveAccount } from "./storage.js";

const PROVIDER = "cloudlian";
const FIXED_PASSWORD = "123456";
const MAX_ACTIVATION_CODE_LENGTH = 512;
const MAX_PROXY_LENGTH = 2048;
const MAX_REGISTER_ATTEMPTS = 3;
const COMPLETED_STATES = new Set(["completed"]);
const REGISTERED_STATES = new Set(["registered", "activating", "activation_failed", "activation_uncertain"]);

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

export function cloudlianChannelBaseUrl(channel = {}) {
  if (channel.type === "shareai") {
    if (!channelAbilityEnabled(channel, "chatplus") || channelAbilityEnabled(channel, "drawing")) return "";
  } else if (channel.type !== "chatplus") {
    return "";
  }

  const value = chatBaseUrl(channel);
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "cloudlian.cn" && !host.endsWith(".cloudlian.cn"))) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function activationCodeHash(channelId, activationCode) {
  return createHash("sha256").update(`${channelId}\n${activationCode}`).digest("hex");
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

function publicResult(account, status, message) {
  return {
    accountId: account.id,
    username: account.username,
    status,
    message
  };
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
      status: extra.account?.status || (state === "completed" ? "unknown" : "disabled"),
      message,
      enabled: state === "completed",
      meta: {
        ...(account.meta || {}),
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

    const clientChannel = {
      ...channel,
      id: `${channel.id}:cloudlian-registration`,
      type: "chatplus",
      settings: { ...(channel.settings || {}), baseUrl }
    };
    const makeClient = () => dependencies.createClient({ config, channel: clientChannel, account });
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
        usages = await client.loadAccountUsages();
      } catch (error) {
        const text = `账号已保留，但自动登录失败：${shortMessage(error?.message, "请稍后重试。")}`;
        account = await saveRegistrationState(account, "registration_failed", text, {
          registration: { activationCodeHash: codeHash }
        });
        return publicResult(account, "registration_failed", text);
      }
    } else {
      try {
        usages = await client.loadAccountUsages();
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
            usages = await client.loadAccountUsages();
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
        usages = await client.loadAccountUsages();
      } catch (error) {
        const text = `账号已注册，但自动登录失败：${shortMessage(error?.message, "请稍后重试。")}`;
        account = await saveRegistrationState(account, "registration_failed", text, {
          registration: { activationCodeHash: codeHash }
        });
        return publicResult(account, "registration_failed", text);
      }
    }

    const previousRegistration = registrationMeta(account);
    const currentUsageHash = usageHash(usages);
    if (
      previousRegistration.status === "activation_uncertain"
      && previousRegistration.activationBaselineHash
      && previousRegistration.activationBaselineHash !== currentUsageHash
    ) {
      const text = "账号已注册、激活并绑定。";
      account = await saveRegistrationState(account, "completed", text, {
        registration: {
          activationCodeHash: codeHash,
          completedAt: new Date().toISOString()
        }
      });
      return publicResult(account, "ready", text);
    }

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
        const text = `账号已注册，但激活失败：${shortMessage(payload?.msg || payload?.message, "请检查激活码后重试。")}`;
        account = await saveRegistrationState(account, "activation_failed", text, {
          registration: { activationCodeHash: codeHash, activationBaselineHash }
        });
        return publicResult(account, "activation_failed", text);
      }
    } catch (error) {
      try {
        client = makeClient();
        const refreshedUsageHash = usageHash(await client.loadAccountUsages());
        if (refreshedUsageHash !== activationBaselineHash) {
          const text = "账号已注册、激活并绑定。";
          account = await saveRegistrationState(account, "completed", text, {
            registration: {
              activationCodeHash: codeHash,
              completedAt: new Date().toISOString()
            }
          });
          return publicResult(account, "ready", text);
        }
      } catch {
        // The account stays disabled until the same request can be safely retried.
      }
      const text = `账号已注册，但激活结果暂时无法确认：${shortMessage(error?.message, "请稍后用同一激活码重试。")}`;
      account = await saveRegistrationState(account, "activation_uncertain", text, {
        registration: { activationCodeHash: codeHash, activationBaselineHash }
      });
      return publicResult(account, "activation_uncertain", text);
    }

    const text = "账号已注册、激活并绑定。";
    account = await saveRegistrationState(account, "completed", text, {
      registration: {
        activationCodeHash: codeHash,
        completedAt: new Date().toISOString()
      }
    });
    return publicResult(account, "ready", text);
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
    const operation = run(input).finally(() => {
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
