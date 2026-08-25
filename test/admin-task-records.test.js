import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function loadTaskKindHelpers() {
  const kindSource = adminHtml.match(/function taskRecordKind\(row\) \{[\s\S]*?\r?\n      \}/)?.[0];
  const matchesSource = adminHtml.match(/function taskRecordKindMatches\(row, kind\) \{[\s\S]*?\r?\n      \}/)?.[0];
  assert.ok(kindSource, "taskRecordKind helper should exist");
  assert.ok(matchesSource, "taskRecordKindMatches helper should exist");
  return vm.runInNewContext(`(() => {
    ${kindSource}
    ${matchesSource}
    return { taskRecordKind, taskRecordKindMatches };
  })()`);
}

test("全部记录同时接收生图和对话，并保留单独类型筛选", () => {
  const { taskRecordKindMatches } = loadTaskKindHelpers();
  const image = { taskType: "img2img" };
  const chat = { taskType: "chat" };

  assert.equal(taskRecordKindMatches(image, "all"), true);
  assert.equal(taskRecordKindMatches(chat, "all"), true);
  assert.equal(taskRecordKindMatches(image, "image"), true);
  assert.equal(taskRecordKindMatches(chat, "image"), false);
  assert.equal(taskRecordKindMatches(image, "chat"), false);
  assert.equal(taskRecordKindMatches(chat, "chat"), true);
});

test("任务记录默认打开混合列表，并明确展示全部、生图和对话入口", () => {
  assert.match(adminHtml, /const \[taskKind, setTaskKind\] = useState\("all"\);/);
  assert.match(adminHtml, /key: "all",\s*label: taskRecordTabLabel\("all", "全部记录"/);
  assert.match(adminHtml, /key: "image",\s*label: taskRecordTabLabel\("image", "生图记录"/);
  assert.match(adminHtml, /key: "chat",\s*label: taskRecordTabLabel\("chat", "对话记录"/);
  assert.match(adminHtml, /columns: isAll \? mixedTaskColumns : isChat \? chatTaskColumns : imageTaskColumns/);
});

test("全部记录分别显示今日生图和对话，对话记录也有完整看板", () => {
  assert.match(adminHtml, /\["今日生图任务", taskStatsByKind\.image\.today\.tasks\]/);
  assert.match(adminHtml, /\["今日对话任务", taskStatsByKind\.chat\.today\.tasks\]/);
  assert.match(adminHtml, /const taskDashboardKind = taskKind === "all" \? taskTrendKind : taskKind/);
  assert.match(adminHtml, /const trendTitle = dashboardIsChat \? "每日对话结果" : "每日生图结果"/);
  assert.match(adminHtml, /isAll \? h\(Segmented, \{[\s\S]*?label: "生图"[\s\S]*?label: "对话"/);
  assert.doesNotMatch(adminHtml, /!isChat \? h\("div", \{ className: "task-summary-grid"/);
  assert.doesNotMatch(adminHtml, /!isChat \? h\("div", \{ className: "task-trend"/);
});

test("任务标签复用已加载记录并在后台预取其他类型", () => {
  assert.match(adminHtml, /const taskPageCacheRef = useRef\(new Map\(\)\)/);
  assert.match(adminHtml, /function prefetchOtherTaskKinds\(query\)/);
  assert.match(adminHtml, /function mergeTaskPageCache\(updates\)/);
  assert.match(adminHtml, /mergeTaskPageCache\(updates\);\s*setTasks/);
  assert.match(adminHtml, /\["all", "image", "chat"\]/);
  assert.match(adminHtml, /loadTaskPage\(\{ page: 1, kind, preferCache: true \}\)/);
  assert.match(adminHtml, /if \(Date\.now\(\) - cached\.cachedAt >= 30_000\) refreshCachedTaskPage\(query\)/);
});

test("账号状态没有变化时不会重复刷新整个页面", () => {
  assert.match(adminHtml, /function applyConfig\(nextConfig\)/);
  assert.match(adminHtml, /if \(snapshot === configSnapshotRef\.current\) return false/);
  assert.match(adminHtml, /if \(shouldPauseTaskAutoRefresh\(\)\) return;[\s\S]*?refreshAccountStatus\(\)/);
});
