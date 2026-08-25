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

test("额度保护中的账号会归为不可用并显示简短原因", () => {
  assert.match(adminHtml, /accountQuotaProtectionItems\(account, channel\)\.some/);
  assert.match(adminHtml, /addReason\("额度保护中"\)/);
  assert.doesNotMatch(adminHtml, /保护线：\$\{items\.map/);
});
