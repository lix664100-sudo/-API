import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("account table compares routing targets with today's actual routing", () => {
  assert.match(adminHtml, /分流概况/);
  assert.match(adminHtml, /每种任务独立统计/);
  assert.match(adminHtml, /目标表示当前计划比例/);
  assert.match(adminHtml, /今日分流/);
  assert.match(adminHtml, /routing-target-marker/);
  assert.match(adminHtml, /今日无自动分流/);
  assert.doesNotMatch(adminHtml, /if \(allUnavailable\)/);
  assert.match(adminHtml, /routing-comparison-item is-unavailable is-compact/);
  assert.match(adminHtml, /今日自动分配 \$\{automatic\} \$\{unit\}/);
});

test("account table keeps routing volume separate from productivity", () => {
  assert.match(adminHtml, /自动分配/);
  assert.match(adminHtml, /指定账号/);
  assert.doesNotMatch(adminHtml, /accountTodayUsage/);
  const routingStart = adminHtml.indexOf("function routingComparisonItem");
  const routingEnd = adminHtml.indexOf("function markTaskListInteraction", routingStart);
  assert.ok(routingStart >= 0 && routingEnd > routingStart);
  assert.doesNotMatch(adminHtml.slice(routingStart, routingEnd), /成功/);
});

test("quota-protected accounts keep exact routing and completion totals visible", () => {
  assert.match(adminHtml, /今日完成/);
  assert.match(adminHtml, /处理任务/);
  assert.match(adminHtml, /成功图片/);
  assert.match(adminHtml, /成功对话/);
  assert.match(adminHtml, /失败任务/);
  assert.match(adminHtml, /按最终结果统计/);
  assert.doesNotMatch(adminHtml, /今日有历史分流记录/);
});

test("task records mark explicit account routing", () => {
  assert.match(adminHtml, /taskRoutingMode/);
  assert.match(adminHtml, /h\(Tag, \{ color: "blue" \}, "指定账号"\)/);
});
