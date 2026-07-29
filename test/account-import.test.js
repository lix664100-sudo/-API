import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = `data/test-account-import-${randomUUID()}`;
process.env.DATA_DIR = dataDir;

const {
  closeStorage,
  importAccounts,
  loadConfig,
  saveAccount
} = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(path.resolve(process.cwd(), dataDir), { recursive: true, force: true });
});

test("批量导入会使用当前渠道默认设置并一次保存", async () => {
  const imported = await importAccounts({
    channelId: "shareai",
    accounts: [
      {
        name: "账号 A",
        username: "a@example.com",
        password: "password-a",
        proxyUrl: "s123762.ips5.vip|9125|3856070|a47b734a5|2026-08-10"
      },
      {
        name: "账号 B",
        username: "b@example.com",
        password: "password-b",
        proxyUrl: ""
      }
    ]
  });

  assert.deepEqual(imported.result, { total: 2, imported: 2, skipped: 0 });
  const stored = await loadConfig();
  const accounts = stored.accounts.filter((account) => account.channelId === "shareai");
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].routingWeight, 1);
  assert.equal(accounts[0].enabled, true);
  assert.equal(accounts[0].status, "unknown");
  assert.deepEqual(accounts[0].concurrency, stored.concurrency);
});

test("同一渠道已有账号和同批重复账号会被跳过", async () => {
  const imported = await importAccounts({
    channelId: "shareai",
    accounts: [
      { name: "重复 A", username: " A@EXAMPLE.COM ", password: "new-password" },
      { name: "账号 C", username: "c@example.com", password: "password-c" },
      { name: "重复 C", username: "C@example.com", password: "password-c-2" }
    ]
  });

  assert.deepEqual(imported.result, { total: 3, imported: 1, skipped: 2 });
  const stored = await loadConfig();
  assert.equal(stored.accounts.filter((account) => account.channelId === "shareai").length, 3);
  assert.equal(stored.accounts.find((account) => account.username === "a@example.com").password, "password-a");
});

test("错误数据会整批拒绝且不会写入一半", async () => {
  const before = await loadConfig();
  await assert.rejects(
    importAccounts({
      channelId: "shareai",
      accounts: [
        { name: "账号 D", username: "d@example.com", password: "password-d" },
        { name: "账号 E", username: "", password: "password-e" }
      ]
    }),
    /第 3 行缺少登录账号/
  );
  const afterConfig = await loadConfig();
  assert.equal(afterConfig.accounts.length, before.accounts.length);
  assert.equal(afterConfig.accounts.some((account) => account.username === "d@example.com"), false);
});

test("代理格式和单次数量会在保存前校验", async () => {
  await assert.rejects(
    importAccounts({
      channelId: "shareai",
      accounts: [{ name: "账号 F", username: "f@example.com", password: "password-f", proxyUrl: "host|bad-port|user|pass" }]
    }),
    /代理 IP 格式不正确/
  );
  await assert.rejects(
    importAccounts({
      channelId: "shareai",
      accounts: Array.from({ length: 501 }, (_, index) => ({
        name: `账号 ${index}`,
        username: `limit-${index}@example.com`,
        password: "password"
      }))
    }),
    /每次最多导入 500 个账号/
  );
});

test("批量导入和单个新增同时发生时不会互相覆盖", async () => {
  await Promise.all([
    importAccounts({
      channelId: "shareai",
      accounts: [{ name: "批量账号", username: "batch@example.com", password: "batch-password" }]
    }),
    saveAccount({
      channelId: "shareai",
      name: "单个账号",
      username: "single@example.com",
      password: "single-password"
    })
  ]);

  const stored = await loadConfig();
  assert.equal(stored.accounts.some((account) => account.username === "batch@example.com"), true);
  assert.equal(stored.accounts.some((account) => account.username === "single@example.com"), true);
});
