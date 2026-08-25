import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("account table compares routing targets with today's actual routing", () => {
  assert.match(adminHtml, /分流情况/);
  assert.match(adminHtml, /每种能力独立统计/);
  assert.match(adminHtml, /目标表示当前可用账号的计划比例/);
  assert.match(adminHtml, /今日无自动分流/);
});

test("account table keeps routing volume separate from productivity", () => {
  assert.match(adminHtml, /自动分流/);
  assert.match(adminHtml, /指定账号/);
  assert.doesNotMatch(adminHtml, /accountTodayUsage/);
  const routingStart = adminHtml.indexOf("function routingComparisonItem");
  const routingEnd = adminHtml.indexOf("function markTaskListInteraction", routingStart);
  assert.ok(routingStart >= 0 && routingEnd > routingStart);
  assert.doesNotMatch(adminHtml.slice(routingStart, routingEnd), /成功/);
});

test("task records mark explicit account routing", () => {
  assert.match(adminHtml, /taskRoutingMode/);
  assert.match(adminHtml, /h\(Tag, \{ color: "blue" \}, "指定账号"\)/);
});
