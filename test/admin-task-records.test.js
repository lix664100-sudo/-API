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
