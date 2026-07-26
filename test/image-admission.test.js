import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-image-admission-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig, upsertTask } = await import("../src/storage.js");
const { assertImageTaskAdmission, reserveImageTaskAdmission } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

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

test("image admission skips known empty drawing quota before upload", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 1 },
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
        id: "quota-empty-a",
        channelId: "shareai",
        name: "Quota Empty A",
        username: "quota-empty-a@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "quota_empty", message: "quota empty" },
            chatplus: { status: "ok" }
          }
        }
      },
      {
        id: "quota-empty-b",
        channelId: "shareai",
        name: "Quota Empty B",
        username: "quota-empty-b@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "quota_empty", message: "quota empty" },
            chatplus: { status: "ok" }
          }
        }
      }
    ]
  });

  const admitted = await reserveImageTaskAdmission({ prompt: "use chat image" });
  assert.equal(admitted.target.channel.type, "chatplus");
  admitted.release();

  const createdAt = new Date().toISOString();
  for (const task of [
    { id: "chatplus-quota-empty-a", accountId: "quota-empty-a", channelType: "chatplus", externalId: "chatplus-quota-empty-upstream-a" },
    { id: "chatplus-quota-empty-b", accountId: "quota-empty-b", channelType: "chatplus", externalId: "chatplus-quota-empty-upstream-b" }
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
    reserveImageTaskAdmission({ prompt: "reject before upload" }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "CONCURRENCY_LIMIT");
      assert.equal(error.attempts.length, 2);
      assert(error.attempts.every((attempt) => attempt.channelId === "shareai:chatplus"));
      return true;
    }
  );
});

test("image admission refreshes expired drawing quota before upload", async () => {
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
      id: "expired-drawing-admission",
      channelId: "shareai",
      name: "Expired Drawing Admission",
      username: "expired-drawing-admission@example.test",
      password: "test",
      enabled: true,
      status: "quota_empty",
      meta: {
        abilities: {
          drawing: {
            status: "quota_empty",
            quota: 50,
            balance: 0,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            message: "drawing quota empty"
          },
          chatplus: { status: "quota_empty", message: "chat image quota empty" }
        }
      }
    }]
  });

  const originalCheck = DrawingClient.prototype.check;
  let checkCount = 0;
  DrawingClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 50,
      balance: 50,
      quotaResetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      message: "drawing ok"
    };
  };

  try {
    const admitted = await reserveImageTaskAdmission({ channel: "drawing", prompt: "recover drawing quota" });
    admitted.release();

    const stored = await loadConfig();
    const drawing = stored.accounts[0].meta.abilities.drawing;
    assert.equal(checkCount, 1);
    assert.equal(admitted.target.channel.type, "drawing");
    assert.equal(drawing.status, "ok");
    assert.equal(drawing.balance, 50);
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("expired confirmed chat quota allows a real image request without dashboard refresh", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "chatplus",
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
      id: "expired-chat-admission",
      channelId: "shareai",
      name: "Expired Chat Admission",
      username: "expired-chat-admission@example.test",
      password: "test",
      enabled: true,
      status: "quota_empty",
      cooldownUntil: new Date(Date.now() - 1000).toISOString(),
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "drawing quota empty" },
          chatplus: {
            status: "quota_empty",
            quota: 220,
            used: 220,
            balance: 0,
            quotaReason: "chat_usage_limit",
            quotaConfirmedByUpstream: true,
            quotaResetAt: new Date(Date.now() - 1000).toISOString(),
            cooldownUntil: new Date(Date.now() - 1000).toISOString(),
            lastCheckAt: new Date().toISOString(),
            message: "chat usage empty"
          }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 220,
      used: 0,
      balance: 220,
      quotaResetAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      cooldownUntil: null,
      quotaReason: "",
      message: "chat ok",
      meta: { chatUsage: { quota: 220, used: 0, balance: 220, period: "12h" } }
    };
  };

  try {
    const admitted = await reserveImageTaskAdmission({ channel: "chatplus", prompt: "recover chat quota" });
    admitted.release();

    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    assert.equal(checkCount, 0);
    assert.equal(admitted.target.channel.type, "chatplus");
    assert.equal(chatplus.status, "quota_empty");
    assert.equal(chatplus.quotaConfirmedByUpstream, true);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("unconfirmed dashboard quota zero does not block image admission", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "chatplus",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 1 },
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
      id: "chat-usage-empty",
      channelId: "shareai",
      name: "Chat Usage Empty",
      username: "chat-usage-empty@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: {
            status: "quota_empty",
            quota: 220,
            used: 220,
            balance: 0,
            quotaReason: "chat_usage_limit",
            quotaResetAt: "2099-01-02T03:04:05+08:00"
          }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    return {
      status: "ok",
      quota: 220,
      used: 190,
      balance: 30,
      quotaResetAt: "",
      cooldownUntil: null,
      quotaReason: "",
      message: "chat ok",
      meta: { chatUsage: { quota: 220, used: 190, balance: 30, period: "3h" } }
    };
  };

  try {
    const admitted = await reserveImageTaskAdmission({
      channel: "chatplus",
      accountId: "chat-usage-empty",
      prompt: "quota test"
    });
    admitted.release();

    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    assert.equal(checkCount, 0);
    assert.equal(admitted.target.channel.type, "chatplus");
    assert.equal(chatplus.status, "quota_empty");
    assert.equal(chatplus.balance, 0);
    assert.equal(chatplus.quotaConfirmedByUpstream, undefined);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("confirmed chat quota with a future reset blocks image admission", async () => {
  const config = await loadConfig();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await saveConfig({
    ...config,
    defaultChannel: "chatplus",
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
      id: "confirmed-chat-empty",
      channelId: "shareai",
      name: "Confirmed Chat Empty",
      username: "confirmed-chat-empty@example.test",
      password: "test",
      enabled: true,
      status: "quota_empty",
      cooldownUntil: resetAt,
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "drawing quota empty" },
          chatplus: {
            status: "quota_empty",
            quota: null,
            used: null,
            balance: null,
            quotaReason: "chat_usage_limit",
            quotaConfirmedByUpstream: true,
            quotaResetAt: resetAt,
            cooldownUntil: resetAt,
            lastCheckAt: new Date().toISOString(),
            message: "chat usage empty"
          }
        }
      }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  let checkCount = 0;
  ChatplusClient.prototype.check = async () => {
    checkCount += 1;
    throw new Error("明确用完且未到时间时不应该检测");
  };

  try {
    await assert.rejects(
      reserveImageTaskAdmission({
        channel: "chatplus",
        accountId: "confirmed-chat-empty",
        prompt: "quota test"
      }),
      /额度|可用|恢复/
    );
    assert.equal(checkCount, 0);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("GPT and Gemini image admission follow their separate source priorities", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 5, chatImage: 5 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        defaultModelId: 1,
        imageSourcePriority: { gpt: "drawing", gemini: "chatplus" },
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", strategy: "image", enabled: true, default: true },
          { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: false }
        ]
      }
    }],
    accounts: [{
      id: "gemini-admission-account",
      channelId: "shareai",
      name: "Gemini Admission",
      username: "gemini-admission@example.test",
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

  const gpt = await reserveImageTaskAdmission({
    prompt: "gpt should use drawing",
    model: "gpt"
  });
  const gemini = await reserveImageTaskAdmission({
    prompt: "gemini should stay in chat image",
    model: "gemini"
  });
  try {
    assert.equal(gpt.target.channel.type, "drawing");
    assert.equal(gpt.target.channel.id, "shareai:drawing");
    assert.equal(gemini.target.channel.type, "chatplus");
    assert.equal(gemini.target.channel.id, "shareai:chatplus");
  } finally {
    gpt.release();
    gemini.release();
  }
});

test("Nano-Banana image admission uses drawing even when default channel is chat", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "chatplus",
    concurrency: { chat: 3, drawingImage: 5, chatImage: 5 },
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
      id: "nano-banana-admission-account",
      channelId: "shareai",
      name: "Nano Banana Admission",
      username: "nano-banana-admission@example.test",
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

  const admitted = await reserveImageTaskAdmission({
    prompt: "nano banana should stay in drawing",
    model_id: 2
  });
  try {
    assert.equal(admitted.target.channel.type, "drawing");
    assert.equal(admitted.target.channel.id, "shareai:drawing");
  } finally {
    admitted.release();
  }
});

test("Gemini image admission uses drawing when chat image is disabled", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    concurrency: { chat: 3, drawingImage: 5, chatImage: 5 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: true, chatplus: false },
        defaultModelId: 1
      }
    }],
    accounts: [{
      id: "gemini-no-chat-account",
      channelId: "shareai",
      name: "Gemini No Chat",
      username: "gemini-no-chat@example.test",
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

  const admitted = await reserveImageTaskAdmission({
    prompt: "gemini should use drawing",
    model: "gemini"
  });
  try {
    assert.equal(admitted.target.channel.type, "drawing");
    assert.equal(admitted.target.channel.id, "shareai:drawing");
  } finally {
    admitted.release();
  }
});
