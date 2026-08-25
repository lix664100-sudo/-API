import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function loadCarFreezeHelpers() {
  const start = adminHtml.indexOf("function abilityStatus");
  const end = adminHtml.indexOf("function quotaProtectionSettings", start);
  assert.ok(start >= 0 && end > start, "账号页面应包含车位冻结显示逻辑");
  const context = {};
  vm.runInNewContext(
    `${adminHtml.slice(start, end)}\nthis.helpers = { accountCarFreezes, carFreezeReason, carTypeName };`,
    context
  );
  return context.helpers;
}

const { accountCarFreezes, carFreezeReason, carTypeName } = loadCarFreezeHelpers();

test("账号页面显示仍在生效的车位冻结及原因", () => {
  const now = Date.parse("2026-08-25T18:06:00+08:00");
  const account = {
    meta: {
      abilities: {
        chatplus: {
          meta: {
            imageCarCooldowns: {
              "chatgpt:busy-car": {
                carId: "busy-car",
                carType: "chatgpt",
                reason: "conversation_busy",
                message: "对话过快或您当前有多个任务执行中，请稍后重试",
                updatedAt: "2026-08-25T18:06:00+08:00",
                cooldownUntil: "2026-08-25T18:06:30+08:00"
              },
              "chatgpt:quota-car": {
                carId: "quota-car",
                carType: "chatgpt",
                reason: "image_quota",
                cooldownUntil: "2026-08-25T19:00:00+08:00"
              }
            }
          }
        }
      }
    }
  };

  const freezes = accountCarFreezes(account, { type: "shareai" }, now);
  assert.deepEqual(Array.from(freezes, (item) => item.carId), ["busy-car", "quota-car"]);
  assert.equal(carFreezeReason(freezes[0]), "上游提示对话过快或已有任务正在处理");
  assert.equal(carFreezeReason(freezes[1]), "该车位生图额度已用完");
  assert.equal(carTypeName(freezes[0].carType), "GPT");
});

test("旧记录中的对话拥挤不会继续误冻 24 小时", () => {
  const now = Date.parse("2026-08-25T18:07:00+08:00");
  const account = {
    meta: {
      chatplusImageCarCooldowns: {
        "chatgpt:legacy-busy-car": {
          carId: "legacy-busy-car",
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

test("账号状态区域直接展示冻结数量、原因和解除时间", () => {
  assert.match(adminHtml, /冻结车位 \$\{carFreezes\.length\}/);
  assert.match(adminHtml, /accountCarFreezeContent\(carFreezes\)/);
  assert.match(adminHtml, /自动解除/);
});
