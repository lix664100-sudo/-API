import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");
const summaryFunctionMatch = adminHtml.match(
  /function summarizeAccountCapabilities\(capabilities = \[\]\) \{[\s\S]*?\r?\n      \}\r?\n\r?\n      function accountCapabilityReason/
);
assert.ok(summaryFunctionMatch, "管理后台中应存在按项目汇总账号状态的方法");
const summarizeAccountCapabilities = vm.runInNewContext(`(${summaryFunctionMatch[0]
  .replace(/\r?\n\r?\n      function accountCapabilityReason$/, "")})`);

test("账号管理使用独立信息块并移除横向宽表", () => {
  assert.match(adminHtml, /paginatedAccounts\.map\(accountCard\)/);
  assert.match(adminHtml, /className: `account-card is-\$\{health\.tone\}/);
  assert.match(adminHtml, /accountCardSection\("代理 IP"/);
  assert.match(adminHtml, /accountCardSection\("额度刷新"/);
  assert.match(adminHtml, /accountCardSection\("并发"/);
  assert.match(adminHtml, /accountCardSection\("套餐到期"/);
  assert.doesNotMatch(adminHtml, /scroll: \{ x: 2450 \}/);
  assert.doesNotMatch(adminHtml, /account-table-wrap/);
});

test("账号信息块保留原有管理操作和分页", () => {
  assert.match(adminHtml, /accountActionsContent/);
  assert.match(adminHtml, /\}, "检测"\)/);
  assert.match(adminHtml, /label: "编辑账号"/);
  assert.match(adminHtml, /label: "删除账号"/);
  assert.match(adminHtml, /label: "激活或续期"/);
  assert.match(adminHtml, /label: "解除绘图冷却"/);
  assert.match(adminHtml, /h\(Dropdown, \{/);
  assert.match(adminHtml, /"aria-label": "更多账号操作"/);
  assert.match(adminHtml, /content: "删除后无法恢复，请确认不再需要这个账号。"/);
  assert.match(adminHtml, /h\(Pagination, \{/);
  assert.match(adminHtml, /pageSizeOptions: \[20, 50, 100\]/);
});

test("账号卡片不展示车位冻结提示", () => {
  assert.doesNotMatch(adminHtml, /accountCarFreezeContent/);
  assert.doesNotMatch(adminHtml, /冻结车位|部分车位暂时冻结/);
  assert.doesNotMatch(adminHtml, /\.account-car-freeze/);
});

test("账号卡片在宽屏自动多列排列并使用完整可用宽度", () => {
  assert.match(adminHtml, /className: `content\$\{activePage === "accounts" \? " is-accounts-page" : ""\}`/);
  assert.match(adminHtml, /\.content\.is-accounts-page \{[\s\S]*?width: calc\(100% - 32px\);[\s\S]*?max-width: none;/);
  assert.match(adminHtml, /\.account-list \{[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(360px, 1fr\)\);/);
});

test("账号概览按可用、业务暂停、真正异常和停用分层", () => {
  assert.match(adminHtml, /className: "account-card-overview"/);
  assert.match(adminHtml, /function accountCardHealth\(row\)/);
  assert.match(adminHtml, /headline: "可用"/);
  assert.match(adminHtml, /headline: "部分可用"/);
  assert.match(adminHtml, /headline: "部分异常"/);
  assert.match(adminHtml, /headline: "账号异常"/);
  assert.match(adminHtml, /protection: "额度保护"/);
  assert.match(adminHtml, /quota_empty: "额度用完"/);
  assert.match(adminHtml, /subscription_expired: "套餐到期"/);
  assert.match(adminHtml, /headline: "已停用"/);
  assert.match(adminHtml, /`\$\{label\}线路掉线`/);
  assert.match(adminHtml, /"代理 IP 已到期"/);
  assert.match(adminHtml, /"代理 IP 不可用"/);
  assert.match(adminHtml, /className: `account-card-health is-\$\{health\.tone\}`/);
  assert.match(adminHtml, /\.account-card-health\.is-warning/);
  assert.match(adminHtml, /h\("details", \{ className: "account-card-details"/);
  assert.match(adminHtml, /"查看分流、并发和套餐"/);
  assert.match(adminHtml, /\.account-card-primary \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(adminHtml, /\.account-identity-name \{[\s\S]*?font-size: 15px;/);
  assert.match(adminHtml, /\.account-card-label \{[\s\S]*?font-size: 12px;/);
});

test("异常账号排在待恢复、部分可用、停用和可用账号前面", () => {
  assert.match(adminHtml, /const order = \{ error: 0, business: 1, partial: 2, disabled: 3, ok: 4 \};/);
  assert.match(adminHtml, /\.sort\(\(left, right\) => order\[accountStatusGroup\(left\)\] - order\[accountStatusGroup\(right\)\]\)/);
});

test("只有部分项目达到保护线时账号仍为部分可用", () => {
  assert.deepEqual(structuredClone(summarizeAccountCapabilities([
    { status: "protection" },
    { status: "ok" }
  ])), { state: "partial", group: "partial" });
  assert.deepEqual(structuredClone(summarizeAccountCapabilities([
    { status: "protection" },
    { status: "protection" }
  ])), { state: "protection", group: "business" });
  assert.deepEqual(structuredClone(summarizeAccountCapabilities([
    { status: "disconnected" },
    { status: "ok" }
  ])), { state: "partial_error", group: "error" });
});

test("渠道概览分别统计绘图和聊天能力", () => {
  assert.match(adminHtml, /drawingOkCount:/);
  assert.match(adminHtml, /chatOkCount:/);
  assert.match(adminHtml, /"绘图可用"/);
  assert.match(adminHtml, /"聊天可用"/);
  assert.match(adminHtml, /"待恢复"/);
  assert.match(adminHtml, /\{ label: "额度保护", value: "protection" \}/);
});

test("账号信息块在窄屏改为单列", () => {
  assert.match(adminHtml, /@media \(max-width: 780px\)/);
  assert.match(adminHtml, /\.account-list,\s*\.account-card-primary,\s*\.account-card-details-body \{\s*grid-template-columns: 1fr;/);
});
