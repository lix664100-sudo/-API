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

const batchRenewalHelpers = vm.runInNewContext(`(() => {
  ${functionSource("chatAccountActivationAvailable", "abilityStatus")}
  ${functionSource("chatModelKey", "chatModelsForChannel")}
  ${functionSource("chatSubscriptionExpired", "accountQuotaResetCell")}
  ${functionSource("batchRenewalStatus", "batchRenewalEligible")}
  ${functionSource("batchRenewalEligible", "parseBatchRenewalCodes")}
  ${functionSource("parseBatchRenewalCodes", "createBatchRenewalPreview")}
  ${functionSource("createBatchRenewalPreview", "parseProxyAssignText")}
  return { batchRenewalEligible, parseBatchRenewalCodes, createBatchRenewalPreview };
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
  assert.match(html, /批量续费/);
  assert.match(html, /\/api\/channels\/\$\{encodeURIComponent\(selectedChannel\.id\)\}\/accounts\/activate-batch/);
});

test("批量续费只随机匹配当前渠道的启用待续费账号", () => {
  const channel = { id: "channel-1", type: "chatplus", settings: { baseUrl: "https://chat.example.com" } };
  const accounts = [
    { id: "expired", channelId: channel.id, enabled: true, status: "subscription_expired" },
    { id: "missing", channelId: channel.id, enabled: true, meta: { abilities: { chatplus: { status: "subscription_missing" } } } },
    { id: "ready", channelId: channel.id, enabled: true, status: "ok" },
    { id: "disabled", channelId: channel.id, enabled: false, status: "subscription_expired" }
  ];
  const eligible = accounts.filter((account) => batchRenewalHelpers.batchRenewalEligible(account, channel));
  assert.deepEqual(eligible.map((account) => account.id), ["expired", "missing"]);

  const preview = batchRenewalHelpers.createBatchRenewalPreview("CODE-1\nCODE-2", eligible, () => 0);
  assert.equal(preview.error, "");
  assert.equal(preview.rows.length, 2);
  assert.equal(new Set(preview.rows.map((row) => row.accountId)).size, 2);
  assert.ok(preview.rows.every((row) => row.status === "valid"));
});

test("批量续费会匹配实际到期但状态尚未更新的账号", () => {
  const channel = { id: "channel-1", type: "chatplus", settings: { baseUrl: "https://chat.example.com" } };
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const accounts = [
    {
      id: "expired-by-time",
      channelId: channel.id,
      enabled: true,
      status: "ok",
      meta: { abilities: { chatplus: { status: "ok", meta: { chatModel: "gemini", referenceUsage: { gemini: { expireAt: past } } } } } }
    },
    {
      id: "future",
      channelId: channel.id,
      enabled: true,
      status: "ok",
      meta: { abilities: { chatplus: { status: "ok", meta: { chatModel: "gemini", referenceUsage: { gemini: { expireAt: future } } } } } }
    },
    { id: "quota-empty", channelId: channel.id, enabled: true, status: "quota_empty" },
    { id: "proxy-failed", channelId: channel.id, enabled: true, status: "ok", meta: { proxyCheck: { status: "failed" } } },
    { id: "disabled-expired", channelId: channel.id, enabled: false, expireAt: past }
  ];

  const eligible = accounts.filter((account) => batchRenewalHelpers.batchRenewalEligible(account, channel));
  assert.deepEqual(eligible.map((account) => account.id), ["expired-by-time"]);
});

test("批量续费预览标出重复激活码和数量多出的项目", () => {
  const duplicate = batchRenewalHelpers.parseBatchRenewalCodes("CODE-1\ncode-1");
  assert.equal(duplicate.rows[1].status, "duplicate");

  const preview = batchRenewalHelpers.createBatchRenewalPreview(
    "CODE-1\nCODE-2",
    [{ id: "expired" }],
    () => 0
  );
  assert.equal(preview.rows[0].accountId, "expired");
  assert.equal(preview.rows[1].status, "failed");
  assert.match(preview.rows[1].message, /没有更多待续费账号/);
});
