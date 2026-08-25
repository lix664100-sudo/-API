import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

const settingsFunctionMatch = adminHtml.match(
  /function quotaProtectionSettings\(value = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function quotaProtectionSettingsKey/
);

assert.ok(settingsFunctionMatch, "管理后台中应存在额度保护设置整理方法");

const settingsFunctionSource = settingsFunctionMatch[0].replace(
  /\r?\n\r?\n      function quotaProtectionSettingsKey$/,
  ""
);
const quotaProtectionSettings = vm.runInNewContext(
  `(${settingsFunctionSource.replace(/^function /, "function ")})`
);

const thresholdFunctionMatch = adminHtml.match(
  /function quotaProtectionThresholdText\(item = \{\}\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function quotaPairText/
);

assert.ok(thresholdFunctionMatch, "管理后台中应存在实际保护线换算方法");

const thresholdFunctionSource = thresholdFunctionMatch[0].replace(
  /\r?\n\r?\n      function quotaPairText$/,
  ""
);
const quotaProtectionThresholdText = vm.runInNewContext(
  `(${thresholdFunctionSource.replace(/^function /, "function ")})`
);

test("后台固定和随机额度设置与服务端规则一致", () => {
  assert.deepEqual(structuredClone(quotaProtectionSettings({
    enabled: true,
    mode: "random",
    randomMinPercent: 20,
    randomMaxPercent: 1
  })), {
    enabled: true,
    mode: "random",
    fixedPercent: 20,
    randomMinPercent: 1,
    randomMaxPercent: 20
  });
});

test("渠道表单包含正式的额度保护设置和范围说明", () => {
  assert.match(adminHtml, /启用额度保护/);
  assert.match(adminHtml, /固定百分比/);
  assert.match(adminHtml, /随机范围最小值/);
  assert.match(adminHtml, /随机范围最大值/);
  assert.match(adminHtml, /每个账号每次额度周期只抽取一次/);
});

test("账号卡片把百分比换算为本周期实际保护线", () => {
  assert.equal(quotaProtectionThresholdText({
    settings: { mode: "fixed", fixedPercent: 20 },
    state: { quota: 220, thresholdPercent: 20 }
  }), "44");
  assert.equal(quotaProtectionThresholdText({
    settings: { mode: "random", randomMinPercent: 1, randomMaxPercent: 20 },
    state: { quota: 70, thresholdPercent: 14 }
  }), "9.8");
  assert.equal(quotaProtectionThresholdText({
    quota: 100,
    settings: { mode: "fixed", fixedPercent: 20 }
  }), "20");
  assert.equal(quotaProtectionThresholdText({
    quota: 100,
    settings: { mode: "random", randomMinPercent: 1, randomMaxPercent: 20 }
  }), "检测后确定");
});

test("账号卡片在剩余额度旁显示保护线", () => {
  assert.match(adminHtml, /quotaTextCell\(\s*accountQuotaText\(row, rowChannel\),\s*accountQuotaProtectionItems\(row, rowChannel\)/);
  assert.match(adminHtml, /`保护线 \$\{threshold\}`/);
  assert.match(adminHtml, /quota-protection-note/);
});

test("触发额度保护后显示具体项目且不重复显示额度不足", () => {
  assert.match(adminHtml, /addReason\(`\$\{item\.label\} 达到保护线 \$\{quotaProtectionThresholdText\(item\)\}`\)/);
  assert.match(adminHtml, /status !== "quota_empty" \|\| !protectionReasonItems\.length/);
  assert.match(adminHtml, /Number\(balance\) > 0/);
});
