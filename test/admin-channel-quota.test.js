import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");
const functionMatch = adminHtml.match(
  /function aggregateChatReferenceUsage\(accounts, channelType, modelKeys\) \{[\s\S]*?\n      \}\n\n      function chatQuotaText/
);

assert.ok(functionMatch, "管理后台中应存在聊天额度汇总方法");

const functionSource = functionMatch[0].replace(/\n\n      function chatQuotaText$/, "");
const aggregateChatReferenceUsage = vm.runInNewContext(
  `(${functionSource.replace(/^function /, "function ")})`
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
