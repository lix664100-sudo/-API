import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("account table distinguishes effective routing targets from configured weights", () => {
  assert.match(adminHtml, /当前有效目标/);
  assert.match(adminHtml, /当前不参与/);
  assert.match(adminHtml, /比例只统计系统自动分配且已提交给上游的任务/);
});

test("account table shows automatic and explicit submissions separately", () => {
  assert.match(adminHtml, /自动提交/);
  assert.match(adminHtml, /指定账号/);
  assert.match(adminHtml, /不参与自动分流/);
});

test("task records mark explicit account routing", () => {
  assert.match(adminHtml, /taskRoutingMode/);
  assert.match(adminHtml, /h\(Tag, \{ color: "blue" \}, "指定账号"\)/);
});
