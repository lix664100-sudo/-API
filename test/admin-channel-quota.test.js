import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");
const fixedNow = Date.parse("2026-08-23T00:00:00+08:00");

const remainingTimeFunctionMatch = adminHtml.match(
  /function formatRemainingTime\(value, now = Date\.now\(\)\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function formatClock/
);

assert.ok(remainingTimeFunctionMatch, "管理后台中应存在额度剩余时间显示方法");

const remainingTimeFunctionSource = remainingTimeFunctionMatch[0].replace(
  /\r?\n\r?\n      function formatClock$/,
  ""
);
const formatRemainingTime = vm.runInNewContext(
  `(${remainingTimeFunctionSource.replace(/^function /, "function ")})`
);
const confirmedQuotaFunctionMatch = adminHtml.match(
  /function confirmedChatQuotaEmpty\(status = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function chatSubscriptionExpired/
);

assert.ok(confirmedQuotaFunctionMatch, "管理后台中应存在聊天零额度判断方法");

const confirmedQuotaFunctionSource = confirmedQuotaFunctionMatch[0].replace(
  /\r?\n\r?\n      function chatSubscriptionExpired$/,
  ""
);
const confirmedChatQuotaEmpty = vm.runInNewContext(
  `(${confirmedQuotaFunctionSource.replace(/^function /, "function ")})`,
  {
    chatModelKey: (value) => String(value || "").trim().toLowerCase()
  }
);

const quotaTextFunctionMatch = adminHtml.match(
  /function chatQuotaText\(account, channel, status = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function chatQuotaResetTexts/
);

assert.ok(quotaTextFunctionMatch, "管理后台中应存在聊天额度显示方法");

const quotaTextFunctionSource = quotaTextFunctionMatch[0].replace(
  /\r?\n\r?\n      function chatQuotaResetTexts$/,
  ""
);
const chatQuotaText = vm.runInNewContext(
  `(${quotaTextFunctionSource.replace(/^function /, "function ")})`,
  {
    checkedChatModelName: () => "GPT",
    chatSubscriptionExpired: () => false,
    chatModelsForChannel: () => [
      { key: "gpt", name: "GPT", enabled: true },
      { key: "gemini", name: "Gemini", enabled: true }
    ],
    confirmedChatQuotaEmpty,
    valueText: (value) => String(value)
  }
);

const drawingDisplayStatusFunctionMatch = adminHtml.match(
  /function drawingDisplayStatus\(status = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function aggregateChatStatus/
);

assert.ok(drawingDisplayStatusFunctionMatch, "管理后台中应存在绘图额度状态显示方法");

const drawingDisplayStatusFunctionSource = drawingDisplayStatusFunctionMatch[0].replace(
  /\r?\n\r?\n      function aggregateChatStatus$/,
  ""
);
const drawingDisplayStatus = vm.runInNewContext(
  `(${drawingDisplayStatusFunctionSource.replace(/^function /, "function ")})`
);

const functionMatch = adminHtml.match(
  /function aggregateChatReferenceUsage\(accounts, channelType, modelKeys\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function chatQuotaText/
);

assert.ok(functionMatch, "管理后台中应存在聊天额度汇总方法");

const functionSource = functionMatch[0].replace(/\r?\n\r?\n      function chatQuotaText$/, "");
const aggregateChatReferenceUsage = vm.runInNewContext(
  `(${functionSource.replace(/^function /, "function ")})`
);

const resetFunctionMatch = adminHtml.match(
  /function chatQuotaResetTexts\(channel, status = \{\}, now = Date\.now\(\)\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountBalanceForTotal/
);

assert.ok(resetFunctionMatch, "管理后台中应存在聊天额度剩余时间显示方法");

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
    formatRemainingTime
  }
);

const accountResetFunctionMatch = adminHtml.match(
  /function accountQuotaResetText\(account, channel, now = Date\.now\(\)\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountExpireText/
);

assert.ok(accountResetFunctionMatch, "管理后台中应存在账号额度剩余时间显示方法");

const accountResetFunctionSource = accountResetFunctionMatch[0].replace(
  /\r?\n\r?\n      function accountExpireText$/,
  ""
);
const accountQuotaResetText = vm.runInNewContext(
  `(${accountResetFunctionSource.replace(/^function /, "function ")})`,
  {
    abilityStatus: (account, key) => account?.meta?.abilities?.[key] || {},
    channelAbilityEnabled: (channel, ability) => channel?.settings?.enabledAbilities?.[ability] !== false,
    chatQuotaResetTexts,
    formatRemainingTime
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
    chatDisplayStatus: (status = {}) => status.status || "unknown",
    drawingDisplayStatus
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

test("后台明确显示当前模型剩余为零时账号状态显示额度不足", () => {
  assert.equal(confirmedChatQuotaEmpty({
    status: "ok",
    meta: {
      chatModel: "gemini",
      referenceUsage: {
        gemini: { quota: 70, used: 70, balance: 0 }
      }
    }
  }), true);
  assert.equal(confirmedChatQuotaEmpty({
    status: "ok",
    meta: {
      chatModel: "gpt",
      referenceUsage: {
        gpt: { quota: 220, used: 20, balance: 200 },
        gemini: { quota: 70, used: 70, balance: 0 }
      }
    }
  }), false);
});

test("一个模型为零时仍显示零和另一个模型的可用额度", () => {
  assert.equal(chatQuotaText(null, {}, {
    status: "quota_empty",
    quotaReason: "chat_usage_limit",
    quotaModel: "gemini",
    quotaConfirmedByUpstream: true,
    meta: {
      chatModel: "gemini",
      referenceUsage: {
        gpt: { quota: 220, used: 20, balance: 200 },
        gemini: { quota: 70, used: 70, balance: 0 }
      }
    }
  }), "GPT 剩余 200/220｜Gemini 剩余 0/70");
});

test("聊天状态可用但没有额度数据时显示额度未获取", () => {
  assert.equal(chatQuotaText(null, {}, {
    status: "ok",
    meta: { chatModel: "gpt", referenceUsage: {} }
  }), "GPT 额度未获取");
});

test("绘图余额小于两点时不能显示可用", () => {
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 0 }), "quota_empty");
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 1 }), "quota_empty");
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 2 }), "ok");
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

test("额度重置时间覆盖未来、临近和已到时间", () => {
  assert.equal(formatRemainingTime("2026-08-23T10:49:30+08:00", fixedNow), "10小时49分后重置");
  assert.equal(formatRemainingTime("2026-08-24T02:03:00+08:00", fixedNow), "1天2小时3分后重置");
  assert.equal(formatRemainingTime("2026-08-23T00:00:59+08:00", fixedNow), "不到1分钟后重置");
  assert.equal(formatRemainingTime("2026-08-22T23:59:59+08:00", fixedNow), "正在刷新额度…");
  assert.equal(formatRemainingTime("错误时间", fixedNow), "");
});

test("GPT 已明确用完时优先显示准确倒计时", () => {
  const status = {
    status: "quota_empty",
    quotaConfirmedByUpstream: true,
    quotaModel: "gpt",
    quotaResetAt: "2026-08-23T02:30:00+08:00",
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
    structuredClone(chatQuotaResetTexts({}, status, fixedNow)),
    ["GPT 2小时30分后重置"]
  );
});

test("共享账号的绘图和聊天重置时间都显示倒计时", () => {
  const account = {
    meta: {
      abilities: {
        drawing: { quotaResetAt: "2026-08-23T00:30:00+08:00" },
        chatplus: {
          status: "ok",
          meta: {
            referenceUsage: {
              gpt: { quotaResetAt: "2026-08-23T01:15:00+08:00" }
            }
          }
        }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true } }
  };

  assert.equal(
    accountQuotaResetText(account, channel, fixedNow),
    "绘图 30分钟后重置｜GPT 1小时15分后重置"
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
    structuredClone(chatQuotaResetTexts({}, status, fixedNow)),
    ["GPT 每12小时重置（正在确认准确时间）"]
  );
});

test("账号表格使用额度重置时间列名", () => {
  assert.match(adminHtml, /title: "额度重置时间"/);
  assert.match(adminHtml, /accountQuotaResetCell\(/);
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

test("绘图余额不足时整体状态不能显示可用", () => {
  const account = {
    enabled: true,
    status: "ok",
    meta: {
      abilities: {
        drawing: { status: "ok", balance: 1 },
        chatplus: { status: "quota_empty", quotaConfirmedByUpstream: true }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: false } }
  };

  assert.equal(accountEffectiveStatus(account, channel), "quota_empty");
});
