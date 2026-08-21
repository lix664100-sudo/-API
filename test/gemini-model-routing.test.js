import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-gemini-model-routing-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

const config = await loadConfig();
await saveConfig({
  ...config,
  channels: [{
    id: "shareai-gemini",
    type: "shareai",
    name: "ShareAI Gemini",
    enabled: true,
    settings: {
      chatBaseUrl: "https://chat.example.test",
      enabledAbilities: { drawing: false, chatplus: true },
      defaultChatModel: "gemini",
      chatModels: [{
        key: "gemini",
        name: "Gemini",
        carType: "gemini",
        strategy: "thinking",
        enabled: true,
        default: true
      }]
    }
  }],
  accounts: ["gemini-account-a", "gemini-account-b"].map((id) => ({
    id,
    channelId: "shareai-gemini",
    name: id,
    username: `${id}@example.test`,
    password: "test",
    enabled: true,
    status: "ok",
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    meta: { abilities: { chatplus: { status: "ok" } } }
  }))
});

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("Gemini 账号额度用完后换账号仍保留请求模型和强度", async () => {
  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  const attempts = [];
  ChatplusClient.prototype.createChatCompletion = async function createChatCompletionStub(input) {
    attempts.push({
      accountId: this.account.id,
      model: input.model,
      thinkingLevel: input.thinking_level
    });
    if (attempts.length === 1) {
      const error = new Error("当前 Gemini 账号的使用次数已用完。");
      error.status = 429;
      error.code = "CHAT_USAGE_LIMIT";
      error.quotaEmpty = true;
      error.imageQuotaExhausted = true;
      error.quotaConfirmedByUpstream = true;
      error.quotaReason = "chat_usage_limit";
      error.quotaModel = "gemini";
      throw error;
    }
    return {
      externalId: "gemini-after-account-switch",
      model: input.model,
      content: "换账号成功",
      imageUrls: [],
      raw: {
        upstreamModel: input.model,
        thinkingLevel: input.thinking_level
      }
    };
  };

  try {
    const result = await createChatCompletion({
      model: "gemini-3.1-pro",
      thinking_level: "extended",
      messages: [{ role: "user", content: "额度换账号测试" }]
    });

    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].accountId, attempts[1].accountId);
    assert.deepEqual(attempts.map(({ model, thinkingLevel }) => [model, thinkingLevel]), [
      ["gemini-3.1-pro", "extended"],
      ["gemini-3.1-pro", "extended"]
    ]);
    assert.equal(result.model, "gemini-3.1-pro");
    assert.equal(result.choices[0].message.content, "换账号成功");
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});
