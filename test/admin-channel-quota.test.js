import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");
const functionMatch = adminHtml.match(
  /function aggregateChatReferenceUsage\(accounts, channelType, modelKeys\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function chatQuotaText/
);

assert.ok(functionMatch, "管理后台中应存在聊天额度汇总方法");

const functionSource = functionMatch[0].replace(/\r?\n\r?\n      function chatQuotaText$/, "");
const aggregateChatReferenceUsage = vm.runInNewContext(
  `(${functionSource.replace(/^function /, "function ")})`
);

const resetFunctionMatch = adminHtml.match(
  /function chatQuotaResetTexts\(channel, status = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountBalanceForTotal/
);

assert.ok(resetFunctionMatch, "管理后台中应存在聊天额度重置时间显示方法");

const resetFunctionSource = resetFunctionMatch[0].replace(
  /\r?\n\r?\n      function accountBalanceForTotal$/,
  ""
);
const chatQuotaResetTexts = vm.runInNewContext(
  `(${resetFunctionSource.replace(/^function /, "function ")})`,
  {
    chatModelsForChannel: () => [{ key: "gpt", name: "GPT", enabled: true }],
    chatModelKey: (value) => String(value || "").trim().toLowerCase(),
    confirmedChatQuotaEmpty: (status = {}) => (
      status.status === "quota_empty" && status.quotaConfirmedByUpstream === true
    ),
    formatDateTime: (value) => value
  }
);

const expireFunctionMatch = adminHtml.match(
  /function accountExpireText\(account, channel\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function channelAbilityEnabled/
);

assert.ok(expireFunctionMatch, "管理后台中应存在套餐到期时间显示方法");

const expireFunctionSource = expireFunctionMatch[0].replace(
  /\r?\n\r?\n      function channelAbilityEnabled$/,
  ""
);
const accountExpireText = vm.runInNewContext(
  `(${expireFunctionSource.replace(/^function /, "function ")})`,
  {
    abilityStatus: (account, key) => account?.meta?.abilities?.[key] || {},
    channelAbilityEnabled: (channel, ability) => channel?.settings?.enabledAbilities?.[ability] !== false,
    chatModelsForChannel: () => [{ key: "gpt", name: "GPT", enabled: true, default: true }],
    formatDateTime: (value) => value || "-"
  }
);

const effectiveStatusFunctionMatch = adminHtml.match(
  /function accountEffectiveStatus\(account, channel\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountCheckDisplayStatus/
);

assert.ok(effectiveStatusFunctionMatch, "管理后台中应存在账号状态汇总方法");

const effectiveStatusFunctionSource = effectiveStatusFunctionMatch[0].replace(
  /\r?\n\r?\n      function accountCheckDisplayStatus$/,
  ""
);
const accountEffectiveStatus = vm.runInNewContext(
  `(${effectiveStatusFunctionSource.replace(/^function /, "function ")})`,
  {
    abilityStatus: (account, key) => account?.meta?.abilities?.[key] || {},
    channelAbilityEnabled: (channel, ability) => channel?.settings?.enabledAbilities?.[ability] !== false,
    chatDisplayStatus: (status = {}) => status.status || "unknown"
  }
);

const aggregateStatusFunctionMatch = adminHtml.match(
  /function aggregateChatStatus\(accounts, channel\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountEffectiveStatus/
);

assert.ok(aggregateStatusFunctionMatch, "管理后台中应存在聊天状态汇总方法");

const aggregateStatusFunctionSource = aggregateStatusFunctionMatch[0].replace(
  /\r?\n\r?\n      function accountEffectiveStatus$/,
  ""
);
const aggregateChatStatus = vm.runInNewContext(
  `(${aggregateStatusFunctionSource.replace(/^function /, "function ")})`,
  {
    abilityStatus: (account, key) => account?.meta?.abilities?.[key] || {},
    aggregateChatReferenceUsage,
    chatDisplayStatus: (status = {}) => status.status || "unknown",
    chatModelsForChannel: () => [{ key: "gpt", name: "GPT", enabled: true }],
    confirmedChatQuotaEmpty: (status = {}) => (
      status.status === "quota_empty" && status.quotaConfirmedByUpstream === true
    )
  }
);

function shareAIAccount({ enabled = true, referenceUsage = {} } = {}) {
  return {
    enabled,
    meta: {
      abilities: {
        chatplus: {
          status: "ok",
          meta: { referenceUsage }
        }
      }
    }
  };
}

test("渠道额度会汇总所有启用账号的同一模型", () => {
  const accounts = [
    shareAIAccount({
      referenceUsage: {
        gpt: {
          quota: 220,
          balance: 160,
          quotaResetAt: "2026-07-28T12:00:00+08:00",
          period: "12h"
        }
      }
    }),
    shareAIAccount({
      referenceUsage: {
        gpt: {
          quota: "220",
          balance: "110",
          quotaResetAt: "2026-07-28T18:00:00+08:00",
          period: "12h"
        }
      }
    }),
    shareAIAccount({
      referenceUsage: {
        gpt: {
          quota: 220,
          balance: 200,
          quotaResetAt: "2026-07-28T22:00:00+08:00",
          period: "12h"
        }
      }
    })
  ];

  assert.deepEqual(
    structuredClone(aggregateChatReferenceUsage(accounts, "shareai", ["gpt"])),
    {
      gpt: {
        quota: 660,
        balance: 470,
        used: 190,
        quotaResetAt: "",
        period: "12h"
      }
    }
  );
});

test("停用账号和没有有效额度数据的账号不会被当成零计入", () => {
  const accounts = [
    shareAIAccount({
      referenceUsage: {
        gemini: { quota: 70, balance: 17, period: "24h" }
      }
    }),
    shareAIAccount({
      enabled: false,
      referenceUsage: {
        gemini: { quota: 70, balance: 70, period: "24h" }
      }
    }),
    shareAIAccount({
      referenceUsage: {
        gemini: { quota: " ", balance: " ", period: "24h" }
      }
    })
  ];

  assert.deepEqual(
    structuredClone(aggregateChatReferenceUsage(accounts, "shareai", ["gemini"])),
    {
      gemini: {
        quota: 70,
        balance: 17,
        used: 53,
        quotaResetAt: "",
        period: "24h"
      }
    }
  );
});

test("没有任何有效额度数据时不显示虚假的零额度", () => {
  const accounts = [
    shareAIAccount({
      referenceUsage: {
        gpt: { quota: null, balance: null }
      }
    })
  ];

  assert.deepEqual(
    structuredClone(aggregateChatReferenceUsage(accounts, "shareai", ["gpt"])),
    {}
  );
});

test("渠道汇总中 GPT 套餐过期优先于其他账号可用", () => {
  const available = shareAIAccount({
    referenceUsage: {
      gpt: { quota: 220, balance: 76, expireAt: "2026-08-20T00:00:00+08:00" }
    }
  });
  const expired = shareAIAccount({
    referenceUsage: {
      gpt: { quota: 220, balance: 0, expireAt: "2026-08-10T00:00:00+08:00" }
    }
  });
  expired.meta.abilities.chatplus.status = "subscription_expired";

  const status = aggregateChatStatus([available, expired], { type: "shareai" });

  assert.equal(status.status, "subscription_expired");
  assert.equal(
    aggregateChatReferenceUsage([expired], "shareai", ["gpt"]).gpt.expireAt,
    "2026-08-10T00:00:00+08:00"
  );
});

test("GPT 已明确用完时优先显示准确恢复时间", () => {
  const status = {
    status: "quota_empty",
    quotaConfirmedByUpstream: true,
    quotaModel: "gpt",
    quotaResetAt: "2026-08-03T22:32:05+08:00",
    meta: {
      chatModel: "gpt",
      referenceUsage: {
        gpt: {
          quotaResetAt: "",
          period: "12h"
        }
      }
    }
  };

  assert.deepEqual(
    structuredClone(chatQuotaResetTexts({}, status)),
    ["GPT 2026-08-03T22:32:05+08:00"]
  );
});

test("GPT 恢复后没有准确时间时才显示额度周期", () => {
  const status = {
    status: "ok",
    quotaConfirmedByUpstream: false,
    quotaModel: "",
    quotaResetAt: "",
    meta: {
      chatModel: "gpt",
      referenceUsage: {
        gpt: {
          quotaResetAt: "",
          period: "12h"
        }
      }
    }
  };

  assert.deepEqual(
    structuredClone(chatQuotaResetTexts({}, status)),
    ["GPT 每 12h"]
  );
});

test("套餐到期列优先显示 GPT 自己的到期时间", () => {
  const account = {
    expireAt: "账号到期时间",
    meta: {
      abilities: {
        drawing: { status: "ok", expireAt: "绘图到期时间" },
        chatplus: {
          status: "ok",
          expireAt: "聊天到期时间",
          meta: {
            referenceUsage: {
              gpt: { expireAt: "GPT 到期时间" }
            }
          }
        }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true }, defaultChatModel: "gpt" }
  };

  assert.equal(accountExpireText(account, channel), "GPT 到期时间");
});

test("GPT 套餐已过期时不再显示旧的未来日期", () => {
  const account = {
    expireAt: "旧的账号到期时间",
    meta: {
      abilities: {
        drawing: { status: "ok", expireAt: "旧的绘图到期时间" },
        chatplus: { status: "subscription_expired", expireAt: "旧的聊天到期时间" }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true }, defaultChatModel: "gpt" }
  };

  assert.equal(accountExpireText(account, channel), "已过期");
});

test("GPT 套餐过期时整体状态不能被绘图可用覆盖", () => {
  const account = {
    enabled: true,
    status: "ok",
    meta: {
      abilities: {
        drawing: { status: "ok" },
        chatplus: { status: "subscription_expired" }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true } }
  };

  assert.equal(accountEffectiveStatus(account, channel), "subscription_expired");
});
