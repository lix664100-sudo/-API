import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-image-admission-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { assertImageTaskAdmission, reserveImageTaskAdmission } = await import("../src/channel-manager.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("image admission rejects before upload when every image slot is occupied", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        defaultModelId: 1
      }
    }],
    accounts: [
      {
        id: "account-a",
        channelId: "shareai",
        name: "Account A",
        username: "a@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "ok" },
            chatplus: { status: "ok" }
          }
        }
      },
      {
        id: "account-b",
        channelId: "shareai",
        name: "Account B",
        username: "b@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "ok" },
            chatplus: { status: "ok" }
          }
        }
      }
    ]
  });

  const createdAt = new Date().toISOString();
  for (const task of [
    { id: "drawing-a", accountId: "account-a", channelType: "drawing", externalId: "drawing-upstream-a" },
    { id: "drawing-b", accountId: "account-b", channelType: "drawing", externalId: "drawing-upstream-b" },
    { id: "chatplus-a", accountId: "account-a", channelType: "chatplus", externalId: "chatplus-upstream-a" },
    { id: "chatplus-b", accountId: "account-b", channelType: "chatplus", externalId: "chatplus-upstream-b" }
  ]) {
    await upsertTask({
      ...task,
      status: "waiting_upstream",
      taskType: "img2img",
      raw: { submitted: true },
      createdAt
    });
  }

  await assert.rejects(
    assertImageTaskAdmission({ prompt: "test" }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "CONCURRENCY_LIMIT");
      assert.equal(error.attempts.length, 4);
      return true;
    }
  );
});

test("image admission reservation blocks another request before task creation", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        defaultModelId: 1
      }
    }],
    accounts: [{
      id: "reserved-account",
      channelId: "shareai",
      name: "Reserved Account",
      username: "reserved@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: { status: "ok" }
        }
      }
    }]
  });

  const first = await reserveImageTaskAdmission({ channel: "drawing", prompt: "first" });
  try {
    await assert.rejects(
      reserveImageTaskAdmission({ channel: "drawing", prompt: "second" }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "CONCURRENCY_LIMIT");
        assert.equal(error.attempts.length, 1);
        return true;
      }
    );
  } finally {
    first.release();
  }

  const second = await reserveImageTaskAdmission({ channel: "drawing", prompt: "third" });
  second.release();

  const burst = await Promise.allSettled(
    Array.from({ length: 5 }, (_item, index) =>
      reserveImageTaskAdmission({ channel: "drawing", prompt: `burst-${index}` })
    )
  );
  const admitted = burst.filter((result) => result.status === "fulfilled");
  const rejected = burst.filter((result) => result.status === "rejected");
  try {
    assert.equal(admitted.length, 1);
    assert.equal(rejected.length, 4);
    for (const result of rejected) {
      assert.equal(result.reason.status, 429);
      assert.equal(result.reason.code, "CONCURRENCY_LIMIT");
    }
  } finally {
    for (const result of admitted) {
      result.value.release();
    }
  }
});
