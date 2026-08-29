import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminHtml = await readFile(path.join(rootDir, "admin", "index.html"), "utf8");
const serverSource = await readFile(path.join(rootDir, "src", "server.js"), "utf8");

test("API 调用页优先展示常用信息，少用参数默认收起", () => {
  assert.match(adminHtml, /大多数软件只需填写中转 API 地址和 API 密钥/);
  assert.match(adminHtml, /对话与看图/);
  assert.match(adminHtml, /图片修改/);
  assert.match(adminHtml, /const openAIApiBaseUrl = `\$\{publicApiBaseUrl\}\/v1`/);
  assert.match(adminHtml, /更多参数/);
  assert.match(adminHtml, /h\("details", \{ className: "api-more" \}/);
  assert.doesNotMatch(adminHtml, /const apiParamRows = \[/);
  assert.doesNotMatch(adminHtml, /h\("h3", \{ className: "api-doc-title" \}, "参数说明"\)/);
});

test("API 调用页写清 Gemini 模型、强度和自动处理规则", () => {
  for (const text of [
    "gemini-3.5-flash-lite",
    "gemini-3.7-flash",
    "gemini-3.1-pro",
    "standard",
    "extended",
    "模型或思考强度填写无效时",
    "账号次数用完只切换可用账号"
  ]) {
    assert.match(adminHtml, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("后台手动对话测试和普通 API 调用都会锁定指定账号", () => {
  assert.match(adminHtml, /form\.append\("strict_account", "true"\)/);
  assert.match(adminHtml, /strict_account: true/);
  assert.match(adminHtml, /指定后只使用这个账号，不会自动换成其他账号/);
});

test("模型列表公开三个可直接调用的 Gemini 模型", () => {
  for (const model of [
    "gemini-3.5-flash-lite",
    "gemini-3.7-flash",
    "gemini-3.1-pro"
  ]) {
    assert.match(serverSource, new RegExp(`id: "${model}"`));
  }
});
