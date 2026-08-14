import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const dataDir = `data/test-proxy-batch-assign-${randomUUID()}`;
process.env.DATA_DIR = dataDir;

const {
  applyAccountProxyAssignments,
  clearAccountProxies,
  closeStorage,
  loadConfig,
  previewAccountProxyAssignments,
  saveAccount,
  saveConfig
} = await import("../src/storage.js");

const proxyA = "proxy-a.example.test|1080|user-a|pass-a|2099-12-31";
const proxyB = "proxy-b.example.test|1080|user-b|pass-b|2099-12-31";
const oldProxy = "old-proxy.example.test|1080|old-user|old-pass|2099-12-31";
const expiredProxy = "expired-proxy.example.test|1080|expired-user|expired-pass|2020-01-01";

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
    account("a-expired", "channel-a", { proxyUrl: expiredProxy }),
    account("a-new", "channel-a"),
    account("a-disabled", "channel-a", { proxyUrl: oldProxy, enabled: false }),
    account("b-same", "channel-b", { proxyUrl: proxyB }),
    account("b-old", "channel-b", { proxyUrl: oldProxy }),
    account("b-expired", "channel-b", { proxyUrl: expiredProxy }),
    account("b-new", "channel-b")
  ]);
});

after(async () => {
  await closeStorage();
  await rm(path.resolve(process.cwd(), dataDir), { recursive: true, force: true });
});

test("可用 IP 分类只分配给当前 IP 未到期的启用账号", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA, proxyA, proxyB],
    targetType: "usable",
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
  assert.deepEqual(channelA.map((row) => row.accountId).sort(), ["a-old", "a-same"]);
  assert.equal(channelB.find((row) => row.accountId === "b-same").proxyUrl, proxyB);
  assert.equal(channelB.find((row) => row.accountId === "b-old").proxyUrl, proxyA);
});

test("到期 IP 分类和无 IP 分类互不影响", async () => {
  const expiredPreview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA],
    targetType: "expired",
    allowReuse: false
  });
  assert.deepEqual(expiredPreview.rows.map((row) => row.accountId).sort(), ["a-expired", "b-expired"]);

  const emptyPreview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA],
    targetType: "empty",
    allowReuse: true
  });
  assert.deepEqual(emptyPreview.rows.map((row) => row.accountId).sort(), ["a-new", "b-new"]);
});

test("每个 IP 只用一次时会避开其他类型账号正在使用的 IP", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA, proxyB],
    targetType: "empty",
    allowReuse: false
  });

  assert.equal(preview.rows.find((row) => row.accountId === "a-new").proxyUrl, proxyB);
  assert.equal(preview.rows.find((row) => row.accountId === "b-new").proxyUrl, proxyA);
  assert.deepEqual(preview.unavailableByChannel.find((channel) => channel.channelId === "channel-a").proxies, [proxyA]);
  assert.deepEqual(preview.unavailableByChannel.find((channel) => channel.channelId === "channel-b").proxies, [proxyB]);
});

test("新 IP 数量不足时，没分到的到期账号保持原样", async () => {
  const expiredProxyTwo = "expired-two.example.test|1080|user|pass|2020-01-01";
  await seedConfig([
    account("expired-1", "channel-a", { proxyUrl: expiredProxy }),
    account("expired-2", "channel-a", { proxyUrl: expiredProxyTwo }),
    account("usable", "channel-a", { proxyUrl: oldProxy }),
    account("empty", "channel-a")
  ]);
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA],
    targetType: "expired",
    allowReuse: false
  });
  const applied = await applyAccountProxyAssignments({
    channelIds: preview.channelIds,
    proxies: preview.proxies,
    targetType: preview.targetType,
    allowReuse: preview.allowReuse,
    snapshot: preview.snapshot,
    assignments: preview.rows.map((row) => ({ accountId: row.accountId, proxyUrl: row.proxyUrl }))
  });

  assert.equal(applied.result.changed, 1);
  assert.equal(applied.result.cleared, 0);
  const stored = await loadConfig();
  const expiredValues = stored.accounts
    .filter((item) => item.id.startsWith("expired-"))
    .map((item) => item.proxyUrl);
  assert.equal(expiredValues.includes(proxyA), true);
  assert.equal(expiredValues.some((value) => [expiredProxy, expiredProxyTwo].includes(value)), true);
  assert.equal(stored.accounts.find((item) => item.id === "usable").proxyUrl, oldProxy);
  assert.equal(stored.accounts.find((item) => item.id === "empty").proxyUrl, "");
});

test("允许重复时会在每个渠道内均匀复用代理", async () => {
  await seedConfig([
    ...Array.from({ length: 5 }, (_, index) => account(`a-${index}`, "channel-a")),
    ...Array.from({ length: 4 }, (_, index) => account(`b-${index}`, "channel-b"))
  ]);

  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a", "channel-b"],
    proxies: [proxyA, proxyB],
    targetType: "empty",
    allowReuse: true
  });

  for (const channelId of ["channel-a", "channel-b"]) {
    const rows = preview.rows.filter((row) => row.channelId === channelId);
    assert.equal(rows.every((row) => row.proxyUrl), true);
    const counts = [proxyA, proxyB].map((proxy) => rows.filter((row) => row.proxyUrl === proxy).length);
    assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true);
  }
});

test("确认后只修改所选分类，其他账号和停用账号保持原样", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA, proxyB],
    targetType: "usable",
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
    targetType: preview.targetType,
    allowReuse: false,
    snapshot: preview.snapshot,
    assignments
  });

  assert.equal(applied.result.assigned, 2);
  assert.equal(applied.result.cleared, 0);
  const stored = await loadConfig();
  assert.equal(stored.accounts.find((item) => item.id === "a-same").proxyUrl, proxyB);
  assert.equal(stored.accounts.find((item) => item.id === "a-old").proxyUrl, proxyA);
  assert.equal(stored.accounts.find((item) => item.id === "a-new").proxyUrl, "");
  assert.equal(stored.accounts.find((item) => item.id === "a-expired").proxyUrl, expiredProxy);
  assert.equal(stored.accounts.find((item) => item.id === "a-disabled").proxyUrl, oldProxy);
  assert.equal(stored.accounts.find((item) => item.id === "a-same").meta.proxyCheck, undefined);
  assert.equal(stored.accounts.find((item) => item.id === "b-same").proxyUrl, proxyB);
});

test("不重复模式出现重复选择时整批拒绝，不会保存一半", async () => {
  const preview = await previewAccountProxyAssignments({
    channelIds: ["channel-a"],
    proxies: [proxyA, proxyB],
    targetType: "usable",
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
      targetType: preview.targetType,
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
    targetType: "usable",
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
      targetType: preview.targetType,
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
    targetType: "usable",
    allowReuse: false
  });
  await Promise.all([
    applyAccountProxyAssignments({
      channelIds: nextPreview.channelIds,
      proxies: nextPreview.proxies,
      targetType: nextPreview.targetType,
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
      targetType: "usable",
      allowReuse: false
    }),
    /第 1 行的代理 IP 格式不正确/
  );
  await assert.rejects(
    previewAccountProxyAssignments({
      channelIds: ["channel-a"],
      proxies: ["expired.example.test|1080|user|pass|2020-01-01"],
      targetType: "usable",
      allowReuse: false
    }),
    /第 1 行的代理 IP 已到期/
  );
});

test("所选渠道可以一次清除全部代理，其他渠道保持原样", async () => {
  const before = await loadConfig();
  const channelAAccounts = before.accounts.filter((account) => account.channelId === "channel-a");
  const cleared = await clearAccountProxies({
    channelIds: ["channel-a"],
    snapshot: channelAAccounts.map((account) => ({
      accountId: account.id,
      channelId: account.channelId,
      proxyUrl: account.proxyUrl,
      enabled: account.enabled !== false
    }))
  });

  assert.equal(cleared.result.cleared, 4);
  const stored = await loadConfig();
  assert.equal(stored.accounts.filter((account) => account.channelId === "channel-a").every((account) => !account.proxyUrl), true);
  assert.equal(stored.accounts.find((account) => account.id === "b-same").proxyUrl, proxyB);
  assert.equal(stored.accounts.find((account) => account.id === "a-same").meta.proxyCheck, undefined);
});
