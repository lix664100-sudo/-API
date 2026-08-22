import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const pattern = new RegExp(
    `function ${name}\\([\\s\\S]*?\\r?\\n      \\}\\r?\\n\\r?\\n      function ${nextName}`
  );
  const match = html.match(pattern);
  assert.ok(match, `找不到 ${name}`);
  return match[0].replace(new RegExp(`\\r?\\n\\r?\\n      function ${nextName}$`), "");
}

const parseCloudlianRegistrationText = vm.runInNewContext(`(() => {
  ${functionSource("validAccountImportProxy", "accountImportProxyLabel")}
  ${functionSource("parseCloudlianRegistrationText", "parseProxyAssignText")}
  return parseCloudlianRegistrationText;
})()`, { URL });

test("批量注册文本按每行的激活码和 IP 解析", () => {
  const parsed = parseCloudlianRegistrationText([
    "CODE-1 1.1.1.1:8080",
    "CODE-2 2.2.2.2|9000|user|pass|2026-12-31",
    "CODE-3"
  ].join("\n"));

  assert.equal(parsed.error, "");
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].activationCode, "CODE-1");
  assert.equal(parsed.rows[0].proxyUrl, "1.1.1.1:8080");
  assert.equal(parsed.rows[2].proxyUrl, "");
  assert.ok(parsed.rows.every((row) => row.status === "valid"), JSON.stringify(parsed.rows));
});

test("批量注册预览会标出重复行和错误 IP", () => {
  const parsed = parseCloudlianRegistrationText([
    "CODE-1",
    "CODE-1",
    "CODE-2 bad::proxy::value"
  ].join("\n"));

  assert.equal(parsed.rows[1].status, "duplicate");
  assert.equal(parsed.rows[2].status, "failed");
  assert.match(parsed.rows[2].message, /注册 IP 格式不正确/);
});

test("管理页面提供批量注册和账号激活续期入口", () => {
  assert.match(html, /批量自动注册/);
  assert.match(html, /激活\/续期/);
  assert.match(html, /\/api\/channels\/\$\{encodeURIComponent\(selectedChannel\.id\)\}\/cloudlian\/register-batch/);
  assert.match(html, /\/api\/accounts\/\$\{encodeURIComponent\(accountToActivate\.id\)\}\/activate/);
});
