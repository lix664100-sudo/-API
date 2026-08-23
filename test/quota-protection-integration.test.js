import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-quota-protection-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, loadConfig, saveConfig } = await import("../src/storage.js");
const { DrawingClient } = await import("../src/channels/drawing.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { assertImageTaskAdmission, checkAccount, createTextTask } = await import("../src/channel-manager.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("达到保护线后停止分配，额度恢复后自动放行", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    channels: [{
      id: "shareai",
      name: "ShareAI账号",
      type: "shareai",
      enabled: true,
      priority: 1,
      settings: {
        drawingBaseUrl: "https://drawing.example.test",
        enabledAbilities: { drawing: true, chatplus: false },
        defaultModelId: 1,
        quotaProtection: {
          enabled: true,
          mode: "fixed",
          fixedPercent: 20
        }
      }
    }],
    accounts: [{
      id: "protected-account",
      channelId: "shareai",
      name: "额度保护测试账号",
      username: "quota-protection@example.test",
      password: "password",
      enabled: true,
      concurrency: { chat: 1, drawingImage: 2, chatImage: 1 }
    }]
  });

  let balance = 20;
  const originalCheck = DrawingClient.prototype.check;
  DrawingClient.prototype.check = async () => ({
    status: "ok",
    quota: 100,
    balance,
    quotaResetAt: "2026-08-24T00:00:00+08:00",
    message: "绘图账号可用"
  });

  try {
    await checkAccount("protected-account");
    let stored = await loadConfig();
    let state = stored.accounts[0].meta.abilities.drawing.meta.quotaProtection.states.drawing;
    assert.equal(state.thresholdPercent, 20);
    assert.equal(state.active, true);

    await assert.rejects(
      () => assertImageTaskAdmission({ channel: "shareai", model: "1" }),
      (error) => error.code === "QUOTA_PROTECTION" && /剩余 20%/.test(error.message)
    );

    balance = 80;
    await checkAccount("protected-account");
    stored = await loadConfig();
    state = stored.accounts[0].meta.abilities.drawing.meta.quotaProtection.states.drawing;
    assert.equal(state.active, false);
    await assertImageTaskAdmission({ channel: "shareai", model: "1" });
  } finally {
    DrawingClient.prototype.check = originalCheck;
  }
});

test("聊天模型分别执行额度保护，不影响同账号的其他模型", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    channels: [{
      id: "shareai",
      name: "ShareAI账号",
      type: "shareai",
      enabled: true,
      priority: 1,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", carType: "chatgpt", enabled: true, default: true },
          { key: "gemini", name: "Gemini", carType: "gemini", enabled: true, default: false }
        ],
        quotaProtection: {
          enabled: true,
          mode: "fixed",
          fixedPercent: 20
        }
      }
    }],
    accounts: [{
      id: "protected-chat-account",
      channelId: "shareai",
      name: "聊天额度保护测试账号",
      username: "chat-quota-protection@example.test",
      password: "password",
      enabled: true,
      concurrency: { chat: 1, drawingImage: 1, chatImage: 1 }
    }]
  });

  const originalCheck = ChatplusClient.prototype.check;
  ChatplusClient.prototype.check = async () => ({
    status: "ok",
    quota: null,
    balance: null,
    message: "聊天账号可用",
    meta: {
      chatModel: "gpt",
      referenceUsage: {
        gpt: { quota: 100, balance: 20, used: 80, quotaResetAt: "2026-08-24T00:00:00+08:00" },
        gemini: { quota: 100, balance: 80, used: 20, quotaResetAt: "2026-08-24T00:00:00+08:00" }
      }
    }
  });

  try {
    await checkAccount("protected-chat-account");
    const stored = await loadConfig();
    const states = stored.accounts[0].meta.abilities.chatplus.meta.quotaProtection.states;
    assert.equal(states.gpt.active, true);
    assert.equal(states.gemini.active, false);

    await assert.rejects(
      () => assertImageTaskAdmission({ channel: "shareai", model: "gpt" }),
      (error) => error.code === "QUOTA_PROTECTION"
    );
    await assertImageTaskAdmission({ channel: "shareai", model: "gemini" });
  } finally {
    ChatplusClient.prototype.check = originalCheck;
  }
});

test("聊天任务接近保护线时逐次核对并在触线后停止", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    channels: [{
      id: "shareai",
      name: "ShareAI账号",
      type: "shareai",
      enabled: true,
      priority: 1,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", carType: "chatgpt", enabled: true, default: true }
        ],
        quotaProtection: {
          enabled: true,
          mode: "fixed",
          fixedPercent: 20
        }
      }
    }],
    accounts: [{
      id: "near-limit-chat-account",
      channelId: "shareai",
      name: "临近保护线测试账号",
      username: "near-limit@example.test",
      password: "password",
      enabled: true,
      concurrency: { chat: 1, drawingImage: 1, chatImage: 2 }
    }]
  });

  let upstreamBalance = 22;
  let submitCount = 0;
  const originalCheck = ChatplusClient.prototype.check;
  const originalCreateTextTask = ChatplusClient.prototype.createTextTask;
  ChatplusClient.prototype.check = async () => ({
    status: "ok",
    quota: null,
    balance: null,
    message: "聊天账号可用",
    meta: {
      chatModel: "gpt",
      referenceUsage: {
        gpt: {
          quota: 100,
          balance: upstreamBalance,
          used: 100 - upstreamBalance,
          quotaResetAt: "2026-08-24T00:00:00+08:00"
        }
      }
    }
  });
  ChatplusClient.prototype.createTextTask = async (input) => {
    submitCount += 1;
    upstreamBalance -= 1;
    return {
      externalId: `protected-chat-task-${submitCount}`,
      status: "success",
      taskType: "text2img",
      prompt: input.prompt,
      modelId: "gpt",
      ratio: "1:1",
      imageCount: 1,
      imageUrls: ["https://example.com/result.png"],
      raw: {}
    };
  };

  try {
    await checkAccount("near-limit-chat-account");
    await createTextTask({ channel: "shareai", model: "gpt", prompt: "保护线测试一" }, true);
    await createTextTask({ channel: "shareai", model: "gpt", prompt: "保护线测试二" }, true);

    const stored = await loadConfig();
    const chatplus = stored.accounts[0].meta.abilities.chatplus;
    const state = chatplus.meta.quotaProtection.states.gpt;
    assert.equal(state.balance, 20);
    assert.equal(state.active, true);
    assert.equal(chatplus.meta.referenceUsage.gpt.balance, 21);
    assert.equal(submitCount, 2);

    await assert.rejects(
      () => createTextTask({ channel: "shareai", model: "gpt", prompt: "保护线测试三" }, true),
      (error) => error.code === "QUOTA_PROTECTION"
    );
    assert.equal(submitCount, 2);
  } finally {
    ChatplusClient.prototype.check = originalCheck;
    ChatplusClient.prototype.createTextTask = originalCreateTextTask;
  }
});
