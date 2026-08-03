import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const dataDir = `data/test-proxy-batch-assign-${randomUUID()}`;
process.env.DATA_DIR = dataDir;

const {
  applyAccountProxyAssignments,
  closeStorage,
  loadConfig,
  previewAccountProxyAssignments,
  saveAccount,
  saveConfig
} = await import("../src/storage.js");

const proxyA = "proxy-a.example.test|1080|user-a|pass-a|2099-12-31";
const proxyB = "proxy-b.example.test|1080|user-b|pass-b|2099-12-31";
const oldProxy = "old-proxy.example.test|1080|old-user|old-pass|2099-12-31";

function account(id, channelId, options = {}) {
  return {
    id,
    channelId,
    name: options.name || id,
    username: `${id}@example.test`,
    password: "password",
    proxyUrl: options.proxyUrl || "",
    enabled: options.enabled !== false,
    status: "ok",
    meta: options.proxyUrl
      ? { proxyCheck: { status: "ok", realIp: "203.0.113.10" } }
      : {}
  };
}

async function seedConfig(accounts) {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "channel-a",
    channels: [
      { id: "channel-a", name: "渠道 A", type: "shareai", enabled: true, priority: 1, settings: {} },
      { id: "channel-b", name: "渠道 B", type: "shareai", enabled: true, priority: 2, settings: {} }
    ],
    accounts
  });
}

beforeEach(async () => {
  await seedConfig([
    account("a-same", "channel-a", { proxyUrl: proxyA }),
    account("a-old", "channel-a", { proxyUrl: oldProxy }),
    account("a-new", "channel-a"),
    account("a-disabled", "channel-a", { proxyUrl: oldProxy, enabled: false }),
    account("b-same", "channel-b", { proxyUrl: proxyB }),
    account("b-old", "channel-b", { proxyUrl: oldProxy }),
    account("b-new", "channel-b")
  ]);
});

after(async () => {
  await closeStorage();
  await rm(path.resolve(process.cwd(), dataDir), { recursive: true, force: true });
});

test("不重复时每个渠道独立使用代理，并优先原账号和以前用过代理的账号", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA, proxyA, proxyB],
    allowReuse: false
  });

  assert.equal(preview.proxies.length, 2);
  assert.equal(preview.duplicateCount, 1);

  const channelA = preview.rows.filter((row) => row.channelId === "channel-a");
  const channelB = preview.rows.filter((row) => row.channelId === "channel-b");
  assert.equal(channelA.filter((row) => row.proxyUrl).length, 2);
  assert.equal(channelB.filter((row) => row.proxyUrl).length, 2);
  assert.equal(new Set(channelA.map((row) => row.proxyUrl).filter(Boolean)).size, 2);
  assert.equal(new Set(channelB.map((row) => row.proxyUrl).filter(Boolean)).size, 2);
  assert.equal(channelA.find((row) => row.accountId === "a-same").proxyUrl, proxyA);
  assert.equal(channelA.find((row) => row.accountId === "a-old").proxyUrl, proxyB);
  assert.equal(channelA.find((row) => row.accountId === "a-new").proxyUrl, "");
  assert.equal(channelA.find((row) => row.accountId === "a-disabled").proxyUrl, "");
  assert.equal(channelB.find((row) => row.accountId === "b-same").proxyUrl, proxyB);
  assert.equal(channelB.find((row) => row.accountId === "b-old").proxyUrl, proxyA);
});

test("允许重复时会在每个渠道内均匀复用代理", async () => {
  await seedConfig([
    ...Array.from({ length: 5 }, (_, index) => account(`a-${index}`, "channel-a")),
    ...Array.from({ length: 4 }, (_, index) => account(`b-${index}`, "channel-b"))
  ]);

  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA, proxyB],
    allowReuse: true
  });

  for (const channelId of ["channel-a", "channel-b"]) {
    const rows = preview.rows.filter((row) => row.channelId === channelId);
    assert.equal(rows.every((row) => row.proxyUrl), true);
    const counts = [proxyA, proxyB].map((proxy) => rows.filter((row) => row.proxyUrl === proxy).length);
    assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true);
  }
});

test("确认后按预览结果一次保存，未分配账号和停用账号都会清空", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA, proxyB],
    allowReuse: false
  });
  const assignments = preview.rows.map((row) => ({
    accountId: row.accountId,
    proxyUrl: row.accountId === "a-same"
      ? proxyB
      : row.accountId === "a-old"
        ? proxyA
        : ""
  }));

  const applied = await applyAccountProxyAssignments({
    channelIds: preview.channelIds,
    proxies: preview.proxies,
    allowReuse: false,
    snapshot: preview.snapshot,
    assignments
  });

  assert.equal(applied.result.assigned, 2);
  assert.equal(applied.result.cleared, 1);
  const stored = await loadConfig();
  assert.equal(stored.accounts.find((item) => item.id === "a-same").proxyUrl, proxyB);
  assert.equal(stored.accounts.find((item) => item.id === "a-old").proxyUrl, proxyA);
  assert.equal(stored.accounts.find((item) => item.id === "a-new").proxyUrl, "");
  assert.equal(stored.accounts.find((item) => item.id === "a-disabled").proxyUrl, "");
  assert.equal(stored.accounts.find((item) => item.id === "a-same").meta.proxyCheck, undefined);
  assert.equal(stored.accounts.find((item) => item.id === "b-same").proxyUrl, proxyB);
});

test("不重复模式出现重复选择时整批拒绝，不会保存一半", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA, proxyB],
    allowReuse: false
  });
  const before = await loadConfig();
  const assignments = preview.rows.map((row, index) => ({
    accountId: row.accountId,
    proxyUrl: index < 2 ? proxyA : ""
  }));

  await assert.rejects(
    applyAccountProxyAssignments({
      channelIds: preview.channelIds,
      proxies: preview.proxies,
      allowReuse: false,
      snapshot: preview.snapshot,
      assignments
    }),
    /同一渠道不能重复使用同一个代理/
  );
  const stored = await loadConfig();
  assert.deepEqual(
    stored.accounts.map((item) => [item.id, item.proxyUrl]),
    before.accounts.map((item) => [item.id, item.proxyUrl])
  );
});

test("预览后账号代理发生变化会要求重新预览，并保留同时新增的账号", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA],
    allowReuse: false
  });
  await saveAccount({
    ...((await loadConfig()).accounts.find((item) => item.id === "a-old")),
    proxyUrl: proxyB
  });

  await assert.rejects(
    applyAccountProxyAssignments({
      channelIds: preview.channelIds,
      proxies: preview.proxies,
      allowReuse: false,
      snapshot: preview.snapshot,
      assignments: preview.rows.map((row) => ({ accountId: row.accountId, proxyUrl: row.proxyUrl }))
    }),
    /账号或代理状态已经变化，请重新预览/
  );
  assert.equal((await loadConfig()).accounts.find((item) => item.id === "a-old").proxyUrl, proxyB);

  const nextPreview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA],
    allowReuse: false
  });
  await Promise.all([
    applyAccountProxyAssignments({
      channelIds: nextPreview.channelIds,
      proxies: nextPreview.proxies,
      allowReuse: false,
      snapshot: nextPreview.snapshot,
      assignments: nextPreview.rows.map((row) => ({ accountId: row.accountId, proxyUrl: row.proxyUrl }))
    }),
    saveAccount({
      id: "a-added",
      channelId: "channel-a",
      name: "后来新增的账号",
      username: "a-added@example.test",
      password: "password"
    })
  ]);
  assert.equal((await loadConfig()).accounts.some((item) => item.id === "a-added"), true);
});

test("格式错误或已到期的代理在预览前就会被拒绝", async () => {
  await assert.rejects(
    previewAccountProxyAssignments({
      channelIds: ["channel-a"],
      proxies: ["host|bad-port|user|pass"],
      allowReuse: false
    }),
    /第 1 行的代理 IP 格式不正确/
  );
  await assert.rejects(
    previewAccountProxyAssignments({
      channelIds: ["channel-a"],
      proxies: ["expired.example.test|1080|user|pass|2020-01-01"],
      allowReuse: false
    }),
    /第 1 行的代理 IP 已到期/
  );
});
