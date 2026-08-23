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

test("账号状态会显示实际保护线和触发原因", () => {
  assert.match(adminHtml, /保护线：\$\{items\.map/);
  assert.match(adminHtml, /绘图额度保护/);
  assert.match(adminHtml, /\$\{item\.label\}额度保护/);
  assert.match(adminHtml, /达到保护线后仅暂停该项额度/);
});
