import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("账号总览不展示车位冻结，也不把冻结当成账号异常", () => {
  assert.doesNotMatch(adminHtml, /accountCarFreezes/);
  assert.doesNotMatch(adminHtml, /accountCarFreezeContent/);
  assert.doesNotMatch(adminHtml, /冻结车位|部分车位暂时冻结/);
  assert.doesNotMatch(adminHtml, /status === "ok" && !drawingAccountIsCooling/);
});
