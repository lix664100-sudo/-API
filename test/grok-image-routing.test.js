import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-grok-image-routing-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig } = await import("../src/storage.js");
const {
  createImageTask,
  createTextTask,
  reserveImageTaskAdmission
} = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

const config = await loadConfig();
await saveConfig({
  ...config,
  channels: [{
    id: "shareai-grok",
    type: "shareai",
    name: "ShareAI Grok",
    enabled: true,
    settings: {
      chatBaseUrl: "https://chat.example.test",
      enabledAbilities: { drawing: false, chatplus: true },
      defaultChatModel: "grok",
      chatModels: [
        {
          key: "gpt",
          name: "GPT",
          carType: "chatgpt",
          model: "gpt-test",
          enabled: true,
          default: false
        },
        {
          key: "grok",
          name: "Grok",
          carType: "grok",
          model: "",
          enabled: true,
          default: true
        }
      ]
    }
  }],
  accounts: [{
    id: "grok-account",
    channelId: "shareai-grok",
    name: "Grok account",
    username: "grok@example.test",
    password: "test",
    enabled: true,
    status: "ok",
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    meta: { abilities: { chatplus: { status: "ok" } } }
  }]
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("Grok 图片请求会预留 Grok 账号，不占用 GPT 通道", async () => {
  const reservation = await reserveImageTaskAdmission({
    model: "grok",
    prompt: "生成一张测试图片"
  });
  try {
    assert.equal(reservation.target.account.id, "grok-account");
    assert.equal(reservation.target.channel.type, "chatplus");
    assert.equal(reservation.target.channel.settings.defaultChatModel, "grok");
  } finally {
    reservation.release();
  }
});

test("Grok 文生图和参考图任务始终把 Grok 传给聊天渠道", async () => {
  const originalTextTask = ChatplusClient.prototype.createTextTask;
  const originalImageTask = ChatplusClient.prototype.createImageTask;
  const routedModels = [];
  ChatplusClient.prototype.createTextTask = async function createTextTaskStub(input) {
    routedModels.push({ taskType: "text2img", model: input.model });
    return {
      externalId: "grok-text-upstream",
      status: "success",
      prompt: input.prompt,
      taskType: "text2img",
      modelId: "grok",
      imageCount: 1,
      imageUrls: ["https://assets.grok.com/users/test/generated/text-image"]
    };
  };
  ChatplusClient.prototype.createImageTask = async function createImageTaskStub(input) {
    routedModels.push({ taskType: "img2img", model: input.model });
    return {
      externalId: "grok-edit-upstream",
      status: "success",
      prompt: input.prompt,
      taskType: "img2img",
      modelId: "grok",
      imageCount: 1,
      imageUrls: ["https://assets.grok.com/users/test/generated/edited-image"]
    };
  };

  try {
    const textTask = await createTextTask({
      model: "grok",
      prompt: "生成一张测试图片"
    }, true);
    const imageTask = await createImageTask({
      input: {
        model: "grok",
        prompt: "参考原图生成一张测试图片"
      },
      file: {
        filename: "reference.png",
        mimetype: "image/png"
      },
      wait: true
    });

    assert.equal(textTask.modelId, "grok");
    assert.equal(imageTask.modelId, "grok");
    assert.deepEqual(routedModels, [
      { taskType: "text2img", model: "grok" },
      { taskType: "img2img", model: "grok" }
    ]);
  } finally {
    ChatplusClient.prototype.createTextTask = originalTextTask;
    ChatplusClient.prototype.createImageTask = originalImageTask;
  }
});
