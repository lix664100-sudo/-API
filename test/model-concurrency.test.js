import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-model-concurrency-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig } = await import("../src/storage.js");
const { getRuntimeStatus, reserveImageTaskAdmission } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function modelConfig(baseConfig) {
  return {
    ...baseConfig,
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    channels: [{
      id: "shareai-models",
      type: "shareai",
      name: "ShareAI models",
      enabled: true,
      settings: {
        chatBaseUrl: "https://chat.example.test",
        enabledAbilities: { drawing: false, chatplus: true },
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", enabled: true, default: true },
          { key: "gemini", name: "Gemini", carType: "gemini", model: "", enabled: true, default: false }
        ]
      }
    }],
    accounts: [{
      id: "model-account",
      channelId: "shareai-models",
      name: "Model account",
      username: "model@example.test",
      password: "test",
      enabled: true,
      status: "ok",
      meta: { abilities: { chatplus: { status: "ok" } } }
    }]
  };
}

test("GPT and Gemini use separate image concurrency slots", async () => {
  const config = await loadConfig();
  await saveConfig(modelConfig(config));

  const gpt = await reserveImageTaskAdmission({ model: "gpt", prompt: "gpt" });
  const gemini = await reserveImageTaskAdmission({ model: "gemini", prompt: "gemini" });
  try {
    const runtime = await getRuntimeStatus();
    assert.equal(runtime.models.gpt.categories.image.running, 1);
    assert.equal(runtime.models.gemini.categories.image.running, 1);
    assert.equal(runtime.categories.image.running, 2);

    await assert.rejects(
      reserveImageTaskAdmission({ model: "gpt", prompt: "second gpt" }),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
  } finally {
    gpt.release();
    gemini.release();
  }
});

test("Chatplus account queues GPT and Gemini independently", async () => {
  const client = new ChatplusClient({
    config: {},
    channel: {
      type: "chatplus",
      settings: {
        defaultChatModel: "gpt",
        chatModels: [
          { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", enabled: true, default: true },
          { key: "gemini", name: "Gemini", carType: "gemini", model: "", enabled: true, default: false }
        ]
      }
    },
    account: { id: "model-account", username: "model@example.test" }
  });

  let active = 0;
  let peak = 0;
  const run = (model) => client.runTaskWork({ model }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });

  await Promise.all([run("gpt"), run("gemini")]);
  assert.equal(peak, 2);

  active = 0;
  peak = 0;
  await Promise.all([run("gpt"), run("gpt")]);
  assert.equal(peak, 1);
});
