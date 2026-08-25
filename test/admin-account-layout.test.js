import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("账号管理使用独立信息块并移除横向宽表", () => {
  assert.match(adminHtml, /paginatedAccounts\.map\(accountCard\)/);
  assert.match(adminHtml, /className: `account-card is-\$\{health\.tone\}/);
  assert.match(adminHtml, /accountCardSection\("代理 IP"/);
  assert.match(adminHtml, /accountCardSection\("并发"/);
  assert.match(adminHtml, /accountCardSection\("时间信息"/);
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

test("冻结记录默认只展示一条并可按需展开", () => {
  assert.match(adminHtml, /const \[firstFreeze, \.\.\.remainingFreezes\] = freezes/);
  assert.match(adminHtml, /accountCarFreezeLine\(firstFreeze, "preview", true\)/);
  assert.match(adminHtml, /h\("details", \{ className: "account-freeze-details"/);
  assert.match(adminHtml, /`查看全部 \$\{freezes\.length\} 条冻结记录`/);
  assert.match(adminHtml, /\.account-car-freeze\.is-preview \{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
});

test("账号卡片在宽屏自动多列排列并使用完整可用宽度", () => {
  assert.match(adminHtml, /className: `content\$\{activePage === "accounts" \? " is-accounts-page" : ""\}`/);
  assert.match(adminHtml, /\.content\.is-accounts-page \{[\s\S]*?width: calc\(100% - 32px\);[\s\S]*?max-width: none;/);
  assert.match(adminHtml, /\.account-list \{[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(360px, 1fr\)\);/);
});

test("账号概览突出异常状态并默认收起次要信息", () => {
  assert.match(adminHtml, /className: "account-card-overview"/);
  assert.match(adminHtml, /function accountCardHealth\(row, rowChannel\)/);
  assert.match(adminHtml, /"线路掉线，正在自动换线"/);
  assert.match(adminHtml, /"IP 已到期"/);
  assert.match(adminHtml, /"IP 不可用"/);
  assert.match(adminHtml, /className: `account-card-health is-\$\{health\.tone\}`/);
  assert.match(adminHtml, /h\("details", \{ className: "account-card-details"/);
  assert.match(adminHtml, /"查看分流、并发和时间"/);
  assert.match(adminHtml, /\.account-card-primary \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(adminHtml, /\.account-identity-name \{[\s\S]*?font-size: 15px;/);
  assert.match(adminHtml, /\.account-card-label,[\s\S]*?font-size: 12px;/);
});

test("账号信息块在窄屏改为单列", () => {
  assert.match(adminHtml, /@media \(max-width: 780px\)/);
  assert.match(adminHtml, /\.account-list,\s*\.account-card-primary,\s*\.account-card-details-body \{\s*grid-template-columns: 1fr;/);
});
