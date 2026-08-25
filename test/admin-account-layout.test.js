import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("账号管理使用独立信息块并移除横向宽表", () => {
  assert.match(adminHtml, /paginatedAccounts\.map\(accountCard\)/);
  assert.match(adminHtml, /className: `account-card/);
  assert.match(adminHtml, /accountCardSection\("代理"/);
  assert.match(adminHtml, /accountCardSection\("并发"/);
  assert.match(adminHtml, /accountCardSection\("额度与时间"/);
  assert.doesNotMatch(adminHtml, /scroll: \{ x: 2450 \}/);
  assert.doesNotMatch(adminHtml, /account-table-wrap/);
});

test("账号信息块保留原有管理操作和分页", () => {
  assert.match(adminHtml, /accountActionsContent/);
  assert.match(adminHtml, /\}, "检测"\)/);
  assert.match(adminHtml, /\}, "编辑"\)/);
  assert.match(adminHtml, /\}, "删除"\)/);
  assert.match(adminHtml, /h\(Pagination, \{/);
  assert.match(adminHtml, /pageSizeOptions: \[20, 50, 100\]/);
});

test("账号信息块在窄屏改为单列", () => {
  assert.match(adminHtml, /@media \(max-width: 780px\)/);
  assert.match(adminHtml, /\.account-card-summary,\s*\.account-card-body \{\s*grid-template-columns: 1fr;/);
});
