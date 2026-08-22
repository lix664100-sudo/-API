import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-image-admission-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, loadConfig, recordTaskStat, saveConfig, upsertTask } = await import("../src/storage.js");
const {
  assertImageTaskAdmission,
  attachImageAdmissionToRequest,
  getRuntimeStatus,
  reserveImageTaskAdmission
} = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { DrawingClient } = await import("../src/channels/drawing.js");

async function recordSuccessfulImages({
  id,
  accountId,
  accountName,
  channelId,
  channelType = "drawing",
  imageCount = 1,
  taskType = "img2img"
}) {
  const completedAt = new Date().toISOString();
  const task = await upsertTask({
    id,
    status: "success",
    taskType,
    accountId,
    accountName,
    channelId,
    channelName: channelId,
    channelType,
    imageCount,
    imageUrls: Array.from({ length: imageCount }, (_item, index) => `https://images.example.test/${id}-${index}.png`),
    raw: { submitted: true },
    createdAt: completedAt,
    completedAt
  });
  await recordTaskStat(task);
  return task;
}

after(async () => {
  await closeStorage();
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

test("aborted image upload releases its reserved slot before task creation", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "aborted-upload",
      type: "shareai",
      name: "Aborted upload",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        defaultModelId: 1
      }
    }],
    accounts: [{
      id: "aborted-upload-account",
      channelId: "aborted-upload",
      name: "Aborted upload account",
      username: "aborted-upload@example.test",
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

  const request = new EventEmitter();
  request.complete = false;
  request.aborted = false;
  request.destroyed = false;
  const reserved = attachImageAdmissionToRequest(
    await reserveImageTaskAdmission({ channel: "drawing", prompt: "aborted upload" }),
    { raw: request }
  );

  assert.equal((await getRuntimeStatus()).categories.image.running, 1);
  request.aborted = true;
  request.emit("aborted");
  assert.equal((await getRuntimeStatus()).categories.image.running, 0);

  reserved.release();
  assert.equal((await getRuntimeStatus()).categories.image.running, 0);
});

test("completed upload hands its reserved slot to the task until task completion", async () => {
  const request = new EventEmitter();
  request.complete = true;
  request.aborted = false;
  request.destroyed = false;
  const reserved = attachImageAdmissionToRequest(
    await reserveImageTaskAdmission({ channel: "drawing", prompt: "completed upload" }),
    { raw: request }
  );

  reserved.handoff();
  request.aborted = true;
  request.emit("aborted");
  assert.equal((await getRuntimeStatus()).categories.image.running, 1);

  reserved.release();
  assert.equal((await getRuntimeStatus()).categories.image.running, 0);
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

test("drawing check treats one point as insufficient for image generation", async () => {
  const client = new DrawingClient({
    config: {},
    channel: { settings: {} },
    account: {
      username: "drawing-check@example.test",
      password: "test"
    },
    sessionLock: async (work) => work()
  });
  client.ensureLogin = async () => {};
  client.request = async (pathName) => {
    assert.equal(pathName, "/api/v1/profile");
    return { balance: 1, quota_points: 100 };
  };

  const status = await client.check();

  assert.equal(status.status, "quota_empty");
  assert.equal(status.balance, 1);
  assert.equal(status.message, "绘图积分不足");
});

test("image admission skips drawing accounts with one point but keeps two-point accounts", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 1 },
    channels: [{
      id: "shareai",
      type: "shareai",
      name: "ShareAI",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        defaultModelId: 1
      }
    }],
    accounts: [
      {
        id: "drawing-one-point",
        channelId: "shareai",
        name: "Drawing One Point",
        username: "drawing-one-point@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "ok", quota: 100, balance: 1 }
          }
        }
      },
      {
        id: "drawing-two-points",
        channelId: "shareai",
        name: "Drawing Two Points",
        username: "drawing-two-points@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            drawing: { status: "ok", quota: 100, balance: 2 }
          }
        }
      }
    ]
  });

  const admitted = await reserveImageTaskAdmission({
    channel: "drawing",
    prompt: "skip one point account"
  });

  try {
    assert.equal(admitted.target.account.id, "drawing-two-points");
  } finally {
    admitted.release();
  }
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

test("dashboard quota zero blocks image admission before entering a car", async () => {
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
        defaultModelId: 1,
        defaultChatModel: "gemini",
        chatModels: [{ key: "gemini", name: "Gemini", enabled: true, default: true }]
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
            status: "ok",
            quota: null,
            used: null,
            balance: null,
            meta: {
              chatModel: "gemini",
              referenceUsage: {
                gemini: {
                  quota: 70,
                  used: 70,
                  balance: 0,
                  quotaResetAt: "2099-01-02T03:04:05+08:00",
                  period: "24h"
                }
              }
            }
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
    await assert.rejects(
      reserveImageTaskAdmission({
        channel: "chatplus",
        accountId: "chat-usage-empty",
        model: "gemini",
        prompt: "quota test"
      }),
      /额度|恢复|可用/
    );

    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    assert.equal(checkCount, 0);
    assert.equal(chatplus.status, "ok");
    assert.equal(chatplus.meta.referenceUsage.gemini.balance, 0);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("one chat model reaching zero does not block another model", async () => {
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
        defaultModelId: 1,
        defaultChatModel: "gemini",
        chatModels: [
          { key: "gpt", name: "GPT", enabled: true },
          { key: "gemini", name: "Gemini", enabled: true, default: true }
        ]
      }
    }],
    accounts: [{
      id: "chat-model-isolation",
      channelId: "shareai",
      name: "Chat Model Isolation",
      username: "chat-model-isolation@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: {
            status: "quota_empty",
            quotaReason: "chat_usage_limit",
            quotaModel: "gemini",
            quotaConfirmedByUpstream: true,
            quotaResetAt: "2099-01-02T03:04:05+08:00",
            cooldownUntil: "2099-01-02T03:04:05+08:00",
            meta: {
              chatModel: "gemini",
              referenceUsage: {
                gpt: { quota: 220, used: 20, balance: 200, period: "12h" },
                gemini: {
                  quota: 70,
                  used: 70,
                  balance: 0,
                  quotaResetAt: "2099-01-02T03:04:05+08:00",
                  period: "24h"
                }
              }
            }
          }
        }
      }
    }]
  });

  const gptAdmission = await reserveImageTaskAdmission({
    channel: "chatplus",
    accountId: "chat-model-isolation",
    model: "gpt",
    prompt: "gpt remains available"
  });
  try {
    assert.equal(gptAdmission.target.account.id, "chat-model-isolation");
    assert.equal(gptAdmission.modelKey, "gpt");
  } finally {
    gptAdmission.release();
  }

  await assert.rejects(
    reserveImageTaskAdmission({
      channel: "chatplus",
      accountId: "chat-model-isolation",
      model: "gemini",
      prompt: "gemini remains paused"
    }),
    /额度|恢复|可用/
  );
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

test("global source priority is shared by GPT and Gemini across channel priorities", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "auto",
    imageSourcePriority: "chatplus",
    concurrency: { chat: 3, drawingImage: 5, chatImage: 5 },
    channels: [
      {
        id: "priority-one",
        type: "shareai",
        name: "Priority one",
        enabled: true,
        priority: 1,
        settings: {
          drawingBaseUrl: "https://drawing.example.test",
          chatBaseUrl: "https://gpt-chat.example.test",
          enabledAbilities: { drawing: true, chatplus: true },
          defaultModelId: 1,
          defaultChatModel: "gpt",
          chatModels: [
            { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", strategy: "image", enabled: true, default: true },
            { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: false, default: false }
          ]
        }
      },
      {
        id: "priority-two",
        type: "shareai",
        name: "Priority two",
        enabled: true,
        priority: 2,
        settings: {
          chatBaseUrl: "https://gemini-chat.example.test",
          enabledAbilities: { drawing: false, chatplus: true },
          defaultChatModel: "gemini",
          chatModels: [
            { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", strategy: "image", enabled: false, default: false },
            { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: true }
          ]
        }
      }
    ],
    accounts: [
      {
        id: "priority-one-account",
        channelId: "priority-one",
        name: "Priority one account",
        username: "priority-one@example.test",
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
        id: "priority-two-account",
        channelId: "priority-two",
        name: "Priority two account",
        username: "priority-two@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        meta: {
          abilities: {
            chatplus: { status: "ok" }
          }
        }
      }
    ]
  });

  const gpt = await reserveImageTaskAdmission({
    prompt: "gpt should use chat image",
    model: "gpt"
  });
  const gemini = await reserveImageTaskAdmission({
    prompt: "gemini should use lower-priority chat image",
    model: "gemini"
  });
  try {
    assert.equal(gpt.target.channel.type, "chatplus");
    assert.equal(gpt.target.channel.id, "priority-one:chatplus");
    assert.equal(gemini.target.channel.type, "chatplus");
    assert.equal(gemini.target.channel.id, "priority-two:chatplus");
  } finally {
    gpt.release();
    gemini.release();
  }

  await saveConfig({ imageSourcePriority: "drawing" });
  const drawingFirst = await reserveImageTaskAdmission({
    prompt: "gemini should now use drawing",
    model: "gemini"
  });
  try {
    assert.equal(drawingFirst.target.channel.type, "drawing");
    assert.equal(drawingFirst.target.channel.id, "priority-one:drawing");
  } finally {
    drawingFirst.release();
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

test("image admission catches up the account with fewer successful images and preserves explicit account selection", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 2, chatImage: 3 },
    channels: [{
      id: "balanced-admission",
      type: "shareai",
      name: "Balanced Admission",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: true, chatplus: true },
        defaultModelId: 1
      }
    }],
    accounts: ["a", "b"].map((suffix) => ({
      id: `balanced-account-${suffix}`,
      channelId: "balanced-admission",
      name: `Balanced Account ${suffix.toUpperCase()}`,
      username: `balanced-${suffix}@example.test`,
      password: "test",
      enabled: true,
      priority: 1,
      routingWeight: 1,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: { status: "ok" }
        }
      }
    }))
  });

  await recordSuccessfulImages({
    id: "balanced-history-a",
    accountId: "balanced-account-a",
    accountName: "Balanced Account A",
    channelId: "balanced-admission:chatplus",
    channelType: "chatplus",
    imageCount: 5
  });
  await recordSuccessfulImages({
    id: "balanced-history-b",
    accountId: "balanced-account-b",
    accountName: "Balanced Account B",
    channelId: "balanced-admission:chatplus",
    channelType: "chatplus",
    imageCount: 1
  });

  await closeStorage();

  const first = await reserveImageTaskAdmission({
    channel: "chatplus",
    prompt: "catch up after restart"
  });
  assert.equal(first.target.account.id, "balanced-account-b");
  first.release();

  const unsubmittedRetry = await reserveImageTaskAdmission({
    channel: "chatplus",
    prompt: "unsubmitted reservation must not count"
  });
  assert.equal(unsubmittedRetry.target.account.id, "balanced-account-b");
  unsubmittedRetry.release();

  const explicit = await reserveImageTaskAdmission({
    channel: "chatplus",
    accountId: "balanced-account-b",
    prompt: "explicit account"
  });
  try {
    assert.equal(explicit.target.account.id, "balanced-account-b");
  } finally {
    explicit.release();
  }
});

test("simultaneous image admissions spread across accounts before either task finishes", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 3, chatImage: 3 },
    channels: [{
      id: "balanced-concurrent",
      type: "shareai",
      name: "Balanced Concurrent",
      enabled: true,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: true, chatplus: true },
        defaultModelId: 1
      }
    }],
    accounts: ["a", "b"].map((suffix) => ({
      id: `balanced-concurrent-${suffix}`,
      channelId: "balanced-concurrent",
      name: `Balanced Concurrent ${suffix.toUpperCase()}`,
      username: `balanced-concurrent-${suffix}@example.test`,
      password: "test",
      enabled: true,
      priority: 1,
      routingWeight: 1,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: { status: "ok" }
        }
      }
    }))
  });

  const first = await reserveImageTaskAdmission({ channel: "drawing", prompt: "concurrent first" });
  const second = await reserveImageTaskAdmission({ channel: "drawing", prompt: "concurrent second" });
  try {
    assert.deepEqual(
      new Set([first.target.account.id, second.target.account.id]),
      new Set(["balanced-concurrent-a", "balanced-concurrent-b"])
    );
  } finally {
    first.release();
    second.release();
  }
});

test("a cooling account is skipped and catches up after it becomes available", async () => {
  const config = await loadConfig();
  const channel = {
    id: "balanced-recovery",
    type: "shareai",
    name: "Balanced Recovery",
    enabled: true,
    settings: {
      drawingBaseUrl: "https://drawing.example.test",
      chatBaseUrl: "https://chat.example.test",
      enabledAbilities: { drawing: true, chatplus: true },
      defaultModelId: 1
    }
  };
  const accounts = [
    {
      id: "balanced-recovery-a",
      channelId: channel.id,
      name: "Balanced Recovery A",
      username: "balanced-recovery-a@example.test",
      password: "test",
      enabled: true,
      priority: 1,
      routingWeight: 1,
      status: "ok",
      meta: {
        abilities: {
          drawing: {
            status: "cooldown",
            cooldownUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          },
          chatplus: { status: "ok" }
        }
      }
    },
    {
      id: "balanced-recovery-b",
      channelId: channel.id,
      name: "Balanced Recovery B",
      username: "balanced-recovery-b@example.test",
      password: "test",
      enabled: true,
      priority: 1,
      routingWeight: 1,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "ok" },
          chatplus: { status: "ok" }
        }
      }
    }
  ];
  await saveConfig({
    ...config,
    defaultChannel: "drawing",
    concurrency: { chat: 3, drawingImage: 3, chatImage: 3 },
    channels: [channel],
    accounts
  });
  await recordSuccessfulImages({
    id: "balanced-recovery-history-b",
    accountId: "balanced-recovery-b",
    accountName: "Balanced Recovery B",
    channelId: "balanced-recovery:drawing",
    imageCount: 4
  });

  const whileCooling = await reserveImageTaskAdmission({ channel: "drawing", prompt: "skip cooling" });
  assert.equal(whileCooling.target.account.id, "balanced-recovery-b");
  whileCooling.release();

  await saveConfig({
    ...await loadConfig(),
    accounts: accounts.map((account) => account.id === "balanced-recovery-a"
      ? {
          ...account,
          meta: {
            ...account.meta,
            abilities: {
              ...account.meta.abilities,
              drawing: { status: "ok", cooldownUntil: null }
            }
          }
        }
      : account)
  });

  const afterRecovery = await reserveImageTaskAdmission({ channel: "drawing", prompt: "catch up after recovery" });
  try {
    assert.equal(afterRecovery.target.account.id, "balanced-recovery-a");
  } finally {
    afterRecovery.release();
  }
});
