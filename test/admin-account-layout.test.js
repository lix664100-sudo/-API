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
const usabilityFunctionMatch = adminHtml.match(
  /function accountUsabilityGroup\(account\) \{[\s\S]*?\r?\n        \}/
);
assert.ok(usabilityFunctionMatch, "管理后台中应存在账号可用性分组方法");
const accountUsabilityGroup = vm.runInNewContext(`(${usabilityFunctionMatch[0]})`, {
  accountAvailabilityInfo: (account) => account
});
const expiryContentFunctionMatch = adminHtml.match(
  /function accountExpiryContent\(row, rowChannel, now = Date\.now\(\)\) \{[\s\S]*?\r?\n        \}\r?\n\r?\n        function accountCardHealth/
);
assert.ok(expiryContentFunctionMatch, "账号卡片应提供套餐到期可视信息");
const accountExpiryContent = vm.runInNewContext(`(${expiryContentFunctionMatch[0]
  .replace(/\r?\n\r?\n        function accountCardHealth$/, "")})`, {
  accountExpireText: (row) => row.expiryText,
  h: (tag, props, children) => ({ tag, props: props || {}, children })
});

test("账号管理使用独立信息块并移除横向宽表", () => {
  assert.match(adminHtml, /function accountGroupSection\(/);
  assert.match(adminHtml, /rows\.map\(accountCard\)/);
  assert.match(adminHtml, /className: "account-groups"/);
  assert.match(adminHtml, /className: `account-card is-\$\{health\.tone\}/);
  assert.match(adminHtml, /accountCardSection\("代理 IP"/);
  assert.match(adminHtml, /accountCardSection\("额度刷新"/);
  assert.match(adminHtml, /accountCardSection\("并发上限"/);
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

test("测试工具允许选择停用账号并带管理员测试标记", () => {
  assert.match(adminHtml, /accountSupportsAbility\(account, "chatplus"\)/);
  assert.match(adminHtml, /accountSupportsImageTest\(account\)/);
  assert.match(adminHtml, /account\.enabled === false \? "（已停用）"/);
  assert.match(adminHtml, /"x-admin-test": "true"/);
});

test("账号卡片仅在有冻结车位时显示一行提醒", () => {
  assert.match(adminHtml, /accountCarFreezeNotice\(row, rowChannel\)/);
  assert.match(adminHtml, /className: "account-car-freeze-summary"/);
  assert.match(adminHtml, /if \(!freezes\.length\) return null;/);
  assert.doesNotMatch(adminHtml, /h\("details", \{ className: "account-freeze-details"/);
});

test("账号卡片在宽屏保持稳定宽度，不因账号少而撑满整行", () => {
  assert.match(adminHtml, /className: `content\$\{activePage === "accounts" \? " is-accounts-page" : ""\}`/);
  assert.match(adminHtml, /\.content\.is-accounts-page \{[\s\S]*?width: calc\(100% - 32px\);[\s\S]*?max-width: none;/);
  assert.match(adminHtml, /\.account-list \{[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(340px, 375px\)\);[\s\S]*?justify-content: start;/);
  assert.match(adminHtml, /\.account-list \{[\s\S]*?gap: 12px;/);
});

test("账号概览按可用、业务暂停、真正异常和停用分层", () => {
  assert.match(adminHtml, /className: "account-card-overview"/);
  assert.match(adminHtml, /function accountCardHealth\(row\)/);
  assert.match(adminHtml, /headline: "可用"/);
  assert.match(adminHtml, /headline: "部分可用"/);
  assert.match(adminHtml, /headline: "部分异常"/);
  assert.match(adminHtml, /headline: "账号异常"/);
  assert.match(adminHtml, /protection: "额度保护"/);
  assert.match(adminHtml, /quota_empty: "额度已用完"/);
  assert.match(adminHtml, /subscription_expired: "套餐到期"/);
  assert.match(adminHtml, /headline: "已停用"/);
  assert.match(adminHtml, /`\$\{label\}线路掉线`/);
  assert.match(adminHtml, /"代理 IP 已到期"/);
  assert.match(adminHtml, /"代理 IP 不可用"/);
  assert.match(adminHtml, /className: `account-card-health is-\$\{health\.tone\}`/);
  assert.match(adminHtml, /return \{ tone: "info", headline: "部分可用"/);
  assert.match(adminHtml, /\.account-card-health\.is-info/);
  assert.match(adminHtml, /\.account-card-health\.is-warning/);
  assert.match(adminHtml, /className: "account-card-recovery"/);
  assert.match(adminHtml, /className: "account-card-recovery-main"/);
  assert.match(adminHtml, /className: "account-card-recovery-exact"/);
  assert.match(adminHtml, /className: "account-card-operations"/);
  assert.doesNotMatch(adminHtml, /"查看分流、并发和套餐"/);
  assert.match(adminHtml, /\.account-card-primary \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(adminHtml, /\.account-identity-name \{[\s\S]*?font-size: 16px;/);
  assert.match(adminHtml, /\.account-card-label \{[\s\S]*?font-size: 12px;/);
});

test("套餐、分流和并发默认可见并提供分流进度", () => {
  assert.match(adminHtml, /accountCardSection\("套餐到期", accountExpiryContent\(/);
  assert.match(adminHtml, /"分流概况"/);
  assert.match(adminHtml, /"今日分流"/);
  assert.match(adminHtml, /h\(Progress, \{/);
  assert.match(adminHtml, /className: "routing-target-marker"/);
  assert.match(adminHtml, /className: "routing-comparison-item is-unavailable is-compact"/);
  assert.match(adminHtml, /不参与分流/);
  assert.match(adminHtml, /accountCardSection\("并发上限"/);
  assert.doesNotMatch(adminHtml, /className: "account-card-details"/);
});

test("套餐到期信息同时显示准确时间和剩余天数", () => {
  const normal = accountExpiryContent(
    { expiryText: "2026-09-17 01:56" },
    {},
    Date.parse("2026-08-26T12:00:00+08:00")
  );
  assert.equal(normal.props.className, "account-expiry is-normal");
  assert.equal(normal.children[0].children, "2026-09-17 01:56");
  assert.equal(normal.children[1].children, "剩余 22 天");

  const expired = accountExpiryContent({ expiryText: "已过期" }, {});
  assert.equal(expired.props.className, "account-expiry is-expired");
  assert.equal(expired.children[1].children, "请及时续期");

  const missing = accountExpiryContent({ expiryText: "-" }, {});
  assert.equal(missing.children[0].children, "未提供");
  assert.equal(missing.children[1].children, "暂未获取到期时间");
});

test("异常账号优先展示，已停用账号排在最后", () => {
  assert.match(adminHtml, /const order = \{ error: 0, business: 1, partial: 2, ok: 3, disabled: 4 \};/);
  assert.match(adminHtml, /\.sort\(\(left, right\) => order\[accountStatusGroup\(left\)\] - order\[accountStatusGroup\(right\)\]\)/);
});

test("账号按不可用、可用和已停用分类，部分可用归入可用账号", () => {
  assert.equal(accountUsabilityGroup({ state: "available" }), "available");
  assert.equal(accountUsabilityGroup({ state: "partial" }), "available");
  assert.equal(accountUsabilityGroup({ state: "partial_error" }), "available");
  assert.equal(accountUsabilityGroup({ state: "quota_empty" }), "unavailable");
  assert.equal(accountUsabilityGroup({ state: "subscription_expired" }), "unavailable");
  assert.equal(accountUsabilityGroup({ state: "disabled" }), "disabled");
  assert.match(adminHtml, /title: "不可用账号"/);
  assert.match(adminHtml, /title: "可用账号"/);
  assert.match(adminHtml, /title: "已停用账号"/);
  assert.match(adminHtml, /collapsible: true/);
  assert.match(adminHtml, /label: "可用账号（含部分可用）", value: "usable"/);
  assert.match(adminHtml, /label: "不可用账号", value: "unavailable"/);
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
  assert.match(adminHtml, /"不可用账号"/);
  assert.match(adminHtml, /\{ label: "额度保护", value: "protection" \}/);
});

test("账号信息块在窄屏改为单列", () => {
  assert.match(adminHtml, /@media \(max-width: 780px\)/);
  assert.match(adminHtml, /\.account-list,\s*\.account-card-primary \{\s*grid-template-columns: 1fr;/);
});
