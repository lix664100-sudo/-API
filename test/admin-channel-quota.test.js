import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");
const fixedNow = Date.parse("2026-08-23T00:00:00+08:00");

const quotaPairFunctionMatch = adminHtml.match(
  /function quotaPairText\(quota, balance\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function quotaTextCell/
);

assert.ok(quotaPairFunctionMatch, "管理后台中应存在统一额度显示方法");

const quotaPairFunctionSource = quotaPairFunctionMatch[0].replace(
  /\r?\n\r?\n      function quotaTextCell$/,
  ""
);
const quotaPairText = vm.runInNewContext(
  `(${quotaPairFunctionSource.replace(/^function /, "function ")})`,
  { valueText: (value) => String(value) }
);

const remainingTimeFunctionMatch = adminHtml.match(
  /function formatRemainingTime\(value, now = Date\.now\(\)\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function quotaResetTimeText/
);

assert.ok(remainingTimeFunctionMatch, "管理后台中应存在额度剩余时间显示方法");

const remainingTimeFunctionSource = remainingTimeFunctionMatch[0].replace(
  /\r?\n\r?\n      function quotaResetTimeText$/,
  ""
);
const formatRemainingTime = vm.runInNewContext(
  `(${remainingTimeFunctionSource.replace(/^function /, "function ")})`
);
const resetTimeTextFunctionMatch = adminHtml.match(
  /function quotaResetTimeText\(value, status = \{\}, now = Date\.now\(\), options = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function formatClock/
);

assert.ok(resetTimeTextFunctionMatch, "管理后台中应存在额度刷新状态显示方法");

const resetTimeTextFunctionSource = resetTimeTextFunctionMatch[0].replace(
  /\r?\n\r?\n      function formatClock$/,
  ""
);
const quotaResetTimeText = vm.runInNewContext(
  `(${resetTimeTextFunctionSource.replace(/^function /, "function ")})`,
  {
    chatModelKey: (value) => String(value || "").trim().toLowerCase(),
    formatRemainingTime
  }
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
    chatModelKey: (value) => String(value || "").trim().toLowerCase(),
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
    chatSubscriptionExpired: (status = {}) => status.status === "subscription_expired",
    quotaResetTimeText
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
    quotaResetTimeText
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

const channelStatusFunctionMatch = adminHtml.match(
  /function getChannelStatus\(channel, relatedAccounts\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function chatDisplayStatus/
);

assert.ok(channelStatusFunctionMatch, "管理后台中应存在渠道状态汇总方法");

const channelStatusFunctionSource = channelStatusFunctionMatch[0].replace(
  /\r?\n\r?\n      function chatDisplayStatus$/,
  ""
);
const getChannelStatus = vm.runInNewContext(
  `(${channelStatusFunctionSource.replace(/^function /, "function ")})`,
  { accountEffectiveStatus }
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

test("额度数字统一按剩余额度除以总额度显示", () => {
  assert.equal(quotaPairText(100, 0), "0/100");
  assert.equal(quotaPairText(70, 1), "1/70");
});

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

test("上游已确认额度用完时忽略过期的正数余额", () => {
  const exhausted = shareAIAccount({
    referenceUsage: {
      gemini: { quota: 70, used: 1, balance: 69, period: "24h" }
    }
  });
  Object.assign(exhausted.meta.abilities.chatplus, {
    status: "quota_empty",
    quotaReason: "chat_usage_limit",
    quotaModel: "gemini",
    quotaConfirmedByUpstream: true
  });

  assert.deepEqual(
    structuredClone(aggregateChatReferenceUsage([exhausted], "shareai", ["gemini"])),
    {
      gemini: {
        quota: 70,
        balance: 0,
        used: 70,
        quotaResetAt: "",
        period: "24h"
      }
    }
  );
  assert.equal(chatQuotaText(null, {}, exhausted.meta.abilities.chatplus), "Gemini 0/70");
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
  }), "GPT 200/220｜Gemini 0/70");
});

test("聊天状态可用但没有额度数据时显示额度未获取", () => {
  assert.equal(chatQuotaText(null, {}, {
    status: "ok",
    meta: { chatModel: "gpt", referenceUsage: {} }
  }), "GPT 额度未获取");
});

test("未订阅套餐显示为未订阅而不是暂不可用", () => {
  const status = {
    status: "subscription_missing",
    quotaModel: "gpt",
    meta: { chatModel: "gpt", referenceUsage: {} }
  };

  assert.equal(chatQuotaText(null, {}, status), "GPT 未订阅");
  assert.deepEqual(chatQuotaResetTexts({}, status, fixedNow), ["GPT 未订阅"]);
  assert.match(adminHtml, /subscription_missing:\s*\["default",\s*"未订阅"\]/);
  assert.match(adminHtml, /\{ label: "未订阅", value: "subscription_missing" \}/);
});

test("绘图余额小于两点时不能显示可用", () => {
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 0 }), "quota_empty");
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 1 }), "quota_empty");
  assert.equal(drawingDisplayStatus({ status: "ok", balance: 2 }), "ok");
});

test("渠道汇总中仍有 GPT 账号可用时优先显示可用", () => {
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

  assert.equal(status.status, "ok");
  assert.deepEqual(structuredClone(status.meta.referenceUsage.gpt), {
    quota: 220,
    balance: 76,
    used: 144,
    quotaResetAt: "",
    period: "",
    expireAt: "2026-08-20T00:00:00+08:00"
  });
  assert.equal(
    aggregateChatReferenceUsage([expired], "shareai", ["gpt"]).gpt.expireAt,
    "2026-08-10T00:00:00+08:00"
  );
});

test("渠道里仍有可用账号时不会被另一个过期账号覆盖", () => {
  const available = {
    enabled: true,
    meta: {
      abilities: {
        drawing: { status: "quota_empty", balance: 0 },
        chatplus: { status: "ok" }
      }
    }
  };
  const expired = {
    enabled: true,
    meta: {
      abilities: {
        drawing: { status: "quota_empty", balance: 0 },
        chatplus: { status: "subscription_expired" }
      }
    }
  };
  const channel = {
    enabled: true,
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true } }
  };

  assert.equal(getChannelStatus(channel, [available, expired]), "ok");
});

test("额度重置时间覆盖未来、临近和已到时间", () => {
  assert.equal(formatRemainingTime("2026-08-23T10:49:30+08:00", fixedNow), "10小时49分后重置");
  assert.equal(formatRemainingTime("2026-08-24T02:03:00+08:00", fixedNow), "1天2小时3分后重置");
  assert.equal(formatRemainingTime("2026-08-23T00:00:59+08:00", fixedNow), "不到1分钟后重置");
  assert.equal(formatRemainingTime("2026-08-22T23:59:59+08:00", fixedNow), "");
  assert.equal(formatRemainingTime("错误时间", fixedNow), "");
});

test("只有真实刷新请求进行中才显示正在刷新", () => {
  assert.equal(
    quotaResetTimeText("2026-08-22T23:59:59+08:00", {}, fixedNow),
    "等待自动核验"
  );
  assert.equal(
    quotaResetTimeText("", {
      meta: { quotaRefresh: { status: "refreshing", startedAt: "2026-08-22T23:59:30+08:00" } }
    }, fixedNow),
    "正在刷新额度…"
  );
  assert.equal(
    quotaResetTimeText("", {
      meta: { quotaRefresh: { status: "failed" } }
    }, fixedNow),
    "检测失败，稍后重试"
  );
  assert.equal(
    quotaResetTimeText("2026-08-23T02:30:00+08:00", {}, fixedNow, { estimated: true }),
    "预计 2小时30分后重置"
  );
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
    ["GPT 每12小时重置（具体时间待确认）"]
  );
});

test("账号额度时间会显示核验失败和套餐过期", () => {
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: false } }
  };
  const failed = {
    meta: {
      abilities: {
        drawing: {
          status: "ok",
          quotaResetAt: "2026-08-22T23:59:59+08:00",
          meta: { quotaRefresh: { status: "failed" } }
        }
      }
    }
  };
  assert.equal(accountQuotaResetText(failed, channel, fixedNow), "绘图 检测失败，稍后重试");

  const expired = {
    meta: {
      abilities: {
        drawing: { status: "subscription_expired" }
      }
    }
  };
  assert.equal(accountQuotaResetText(expired, channel, fixedNow), "绘图 套餐已过期");
});

test("账号信息块显示额度重置时间", () => {
  assert.match(adminHtml, /accountCardField\("额度重置"/);
  assert.match(adminHtml, /accountQuotaResetCell\(/);
  assert.match(adminHtml, /h\(Tag, \{/);
  assert.match(adminHtml, /className: `quota-reset-tag/);
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

test("未订阅套餐时到期栏显示未订阅", () => {
  const account = {
    expireAt: "旧的账号到期时间",
    meta: {
      abilities: {
        drawing: { status: "ok", expireAt: "旧的绘图到期时间" },
        chatplus: { status: "subscription_missing", expireAt: "" }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true }, defaultChatModel: "gpt" }
  };

  assert.equal(accountExpireText(account, channel), "未订阅");
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

test("未订阅套餐时整体状态不能被绘图可用覆盖", () => {
  const account = {
    enabled: true,
    status: "ok",
    meta: {
      abilities: {
        drawing: { status: "ok" },
        chatplus: { status: "subscription_missing" }
      }
    }
  };
  const channel = {
    type: "shareai",
    settings: { enabledAbilities: { drawing: true, chatplus: true } }
  };

  assert.equal(accountEffectiveStatus(account, channel), "subscription_missing");
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
