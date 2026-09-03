import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function loadCarFreezeHelpers() {
  const start = adminHtml.indexOf("function abilityStatus");
  const end = adminHtml.indexOf("function quotaProtectionSettings", start);
  assert.ok(start >= 0 && end > start, "账号页面应包含车位冻结显示逻辑");
  const context = {
    formatDateTime: (value) => new Date(value).toISOString()
  };
  vm.runInNewContext(
    `${adminHtml.slice(start, end)}\nthis.helpers = { accountCarFreezes, carFreezeReason, carTypeName, carFreezeRecoveryText };`,
    context
  );
  return context.helpers;
}

const { accountCarFreezes, carFreezeReason, carTypeName, carFreezeRecoveryText } = loadCarFreezeHelpers();

test("账号页面只保留仍在生效的冻结车位并按恢复时间排序", () => {
  const now = Date.parse("2026-08-25T18:06:00+08:00");
  const account = {
    meta: {
      abilities: {
        chatplus: {
          meta: {
            imageCarCooldowns: {
              "chatgpt:later": {
                carId: "later",
                carType: "chatgpt",
                reason: "image_quota",
                cooldownUntil: "2026-08-25T19:00:00+08:00"
              },
              "gemini:first": {
                carId: "first",
                carType: "gemini",
                reason: "image_failure",
                cooldownUntil: "2026-08-25T18:20:00+08:00"
              },
              "chatgpt:expired": {
                carId: "expired",
                carType: "chatgpt",
                cooldownUntil: "2026-08-25T18:05:00+08:00"
              }
            }
          }
        }
      }
    }
  };

  const freezes = accountCarFreezes(account, { type: "shareai" }, now);
  assert.deepEqual(Array.from(freezes, (item) => item.carId), ["first", "later"]);
  assert.equal(carFreezeReason(freezes[0]), "该车位生图失败，等待自动复查");
  assert.equal(carTypeName(freezes[0].carType), "Gemini");
  assert.equal(carFreezeRecoveryText(freezes[0].cooldownUntil, now), "14 分钟后恢复");
});

test("账号页面明确显示上游取消的生图车位", () => {
  assert.equal(
    carFreezeReason({ reason: "image_cancelled" }),
    "上游取消了图片任务，等待自动复查"
  );
});

test("旧记录中的短暂繁忙不会误显示为长时间冻结", () => {
  const now = Date.parse("2026-08-25T18:07:00+08:00");
  const account = {
    meta: {
      chatplusImageCarCooldowns: {
        "chatgpt:legacy-busy": {
          carId: "legacy-busy",
          carType: "chatgpt",
          reason: "conversation_not_created",
          message: "对话过快或您当前有多个任务执行中，请稍后重试",
          updatedAt: "2026-08-25T18:06:00+08:00",
          cooldownUntil: "2026-08-26T18:06:00+08:00"
        }
      }
    }
  };

  assert.equal(accountCarFreezes(account, { type: "chatplus" }, now).length, 0);
});

test("冻结车位只显示一行提醒，详情使用提示浮层", () => {
  assert.match(adminHtml, /function accountCarFreezeNotice\(row, rowChannel\)/);
  assert.match(adminHtml, /if \(!freezes\.length\) return null;/);
  assert.match(adminHtml, /`\$\{freezes\.length\} 个车位冻结`/);
  assert.match(adminHtml, /`· 最早 \$\{recoveryText\}`/);
  assert.match(adminHtml, /title: "冻结车位详情"/);
  assert.match(adminHtml, /trigger: \["hover", "click"\]/);
  assert.doesNotMatch(adminHtml, /account-freeze-details|查看全部 .* 条冻结记录/);
});

test("车位冻结不会被当成整个账号异常", () => {
  const healthStart = adminHtml.indexOf("function accountCardHealth(row)");
  const healthEnd = adminHtml.indexOf("function accountCardHealthContent", healthStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.doesNotMatch(adminHtml.slice(healthStart, healthEnd), /accountCarFreezes/);
});
