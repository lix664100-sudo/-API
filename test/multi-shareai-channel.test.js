import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-multi-channel-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig } = await import("../src/storage.js");
const { DrawingClient } = await import("../src/channels/drawing.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { checkAccount } = await import("../src/channel-manager.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("keeps multiple ShareAI channels and separates accounts by channel", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "midjourneye",
    channels: [
      {
        id: "shareai",
        name: "ShareAI",
        type: "shareai",
        enabled: true,
        priority: 1,
        settings: {
          drawingBaseUrl: "https://drawing.aishare.icu",
          chatBaseUrl: "https://one.aishare.icu",
          enabledAbilities: { drawing: true, chatplus: true },
          geminiDrawingModelId: 3,
          imageSourcePriority: { gpt: "chatplus", gemini: "drawing" }
        }
      },
      {
        id: "midjourneye",
        name: "Midjourneye",
        type: "shareai",
        enabled: true,
        priority: 2,
        settings: {
          chatBaseUrl: "https://claude.midjourneye.com",
          enabledAbilities: { drawing: false, chatplus: true },
          defaultChatModel: "gpt",
          chatModels: [
            { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-5-5-instant", strategy: "image", enabled: true, default: true },
            { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: false }
          ]
        }
      }
    ],
    accounts: [
      {
        id: "old-account",
        channelId: "shareai",
        name: "Old Account",
        username: "same@example.test",
        password: "same-password",
        enabled: true
      },
      {
        id: "new-account",
        channelId: "midjourneye",
        name: "New Account",
        username: "same@example.test",
        password: "same-password",
        enabled: true
      }
    ]
  });

  const stored = await loadConfig();
  assert.equal(stored.defaultChannel, "midjourneye");
  assert.deepEqual(stored.channels.map((item) => item.id), ["shareai", "midjourneye"]);
  assert.equal(stored.channels.find((item) => item.id === "midjourneye")?.settings.enabledAbilities.drawing, false);
  assert.equal(stored.channels.find((item) => item.id === "midjourneye")?.settings.enabledAbilities.chatplus, true);
  assert.deepEqual(
    stored.channels.find((item) => item.id === "shareai")?.settings.imageSourcePriority,
    { gpt: "chatplus", gemini: "drawing" }
  );
  assert.equal(stored.channels.find((item) => item.id === "shareai")?.settings.geminiDrawingModelId, 3);
  assert.deepEqual(stored.accounts.map((item) => item.channelId).sort(), ["midjourneye", "shareai"]);
});

test("pure chat ShareAI channel checks only chat ability", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    channels: [
      {
        id: "pure-chat",
        name: "Pure Chat",
        type: "shareai",
        enabled: true,
        priority: 1,
        settings: {
          chatBaseUrl: "https://claude.midjourneye.com",
          enabledAbilities: { drawing: false, chatplus: true },
          defaultChatModel: "gemini",
          chatModels: [
            { key: "gemini", name: "Gemini", carType: "gemini", model: "", strategy: "thinking", enabled: true, default: true }
          ]
        }
      }
    ],
    accounts: [
      {
        id: "pure-chat-account",
        channelId: "pure-chat",
        name: "Pure Chat Account",
        username: "pure-chat@example.test",
        password: "password",
        enabled: true,
        status: "error",
        message: "绘图站：旧的绘图失败；聊天：聊天账号可用",
        meta: {
          abilities: {
            drawing: { status: "error", message: "旧的绘图失败" },
            chatplus: { status: "ok", quota: 20, balance: 20, message: "聊天账号可用" }
          }
        }
      }
    ]
  });

  let drawingChecks = 0;
  let chatChecks = 0;
  const originalDrawingCheck = DrawingClient.prototype.check;
  const originalChatCheck = ChatplusClient.prototype.check;
  DrawingClient.prototype.check = async () => {
    drawingChecks += 1;
    throw new Error("不应该检测绘图站");
  };
  ChatplusClient.prototype.check = async () => {
    chatChecks += 1;
    return {
      status: "ok",
      quota: 20,
      balance: 20,
      used: 0,
      message: "聊天账号可用",
      meta: { chatModel: "gemini" }
    };
  };

  try {
    const result = await checkAccount("pure-chat-account");
    const stored = await loadConfig();
    const account = stored.accounts.find((item) => item.id === "pure-chat-account");

    assert.equal(result.status, "ok");
    assert.equal(drawingChecks, 0);
    assert.equal(chatChecks, 1);
    assert.equal(account.status, "ok");
    assert.equal(account.meta.abilities.chatplus.status, "ok");
    assert.equal(account.meta.abilities.drawing.status, undefined);
  } finally {
    DrawingClient.prototype.check = originalDrawingCheck;
    ChatplusClient.prototype.check = originalChatCheck;
  }
});
