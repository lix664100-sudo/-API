import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-model-concurrency-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, loadConfig, saveConfig } = await import("../src/storage.js");
const { getRuntimeStatus, reserveImageTaskAdmission } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");

after(async () => {
  await closeStorage();
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
          { key: "grok", name: "Grok", carType: "grok", model: "", enabled: true, default: false },
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

test("runtime capacity only counts accounts whose channel enables the model", async () => {
  const config = await loadConfig();
  const modelRoutes = (enabledKey) => [
    { key: "gpt", name: "GPT", carType: "chatgpt", model: "gpt-test", enabled: enabledKey === "gpt", default: enabledKey === "gpt" },
    { key: "grok", name: "Grok", carType: "grok", model: "", enabled: false, default: false },
    { key: "gemini", name: "Gemini", carType: "gemini", model: "", enabled: enabledKey === "gemini", default: enabledKey === "gemini" }
  ];
  await saveConfig({
    ...config,
    concurrency: { chat: 1, drawingImage: 1, chatImage: 1 },
    channels: [
      {
        id: "gpt-channel",
        type: "shareai",
        name: "GPT channel",
        enabled: true,
        settings: {
          drawingBaseUrl: "https://drawing.example.test",
          chatBaseUrl: "https://gpt.example.test",
          enabledAbilities: { drawing: true, chatplus: true },
          defaultChatModel: "gpt",
          chatModels: modelRoutes("gpt")
        }
      },
      {
        id: "gemini-channel",
        type: "shareai",
        name: "Gemini channel",
        enabled: true,
        settings: {
          chatBaseUrl: "https://gemini.example.test",
          enabledAbilities: { drawing: false, chatplus: true },
          defaultChatModel: "gemini",
          chatModels: modelRoutes("gemini")
        }
      }
    ],
    accounts: [
      ...Array.from({ length: 3 }, (_item, index) => ({
        id: `gpt-account-${index + 1}`,
        channelId: "gpt-channel",
        name: `GPT account ${index + 1}`,
        username: `gpt-${index + 1}@example.test`,
        password: "test",
        enabled: true,
        status: "ok",
        concurrency: { chat: 3, drawingImage: 2, chatImage: 3 },
        meta: { abilities: { drawing: { status: "ok" }, chatplus: { status: "ok" } } }
      })),
      {
        id: "gemini-account",
        channelId: "gemini-channel",
        name: "Gemini account",
        username: "gemini@example.test",
        password: "test",
        enabled: true,
        status: "ok",
        concurrency: { chat: 3, drawingImage: 2, chatImage: 3 },
        meta: { abilities: { chatplus: { status: "ok" } } }
      }
    ]
  });

  const runtime = await getRuntimeStatus();
  assert.equal(runtime.concurrency.drawingImage, 6);
  assert.equal(runtime.models.gpt.categories.image.configured, 9);
  assert.equal(runtime.models.gpt.categories.chat.configured, 3);
  assert.equal(runtime.models.gemini.categories.image.configured, 7);
  assert.equal(runtime.models.gemini.categories.chat.configured, 1);

  const gemini = await reserveImageTaskAdmission({
    channel: "gemini-channel",
    model: "gemini",
    prompt: "gemini"
  });
  try {
    assert.equal(gemini.target.account.id, "gemini-account");
  } finally {
    gemini.release();
  }
});

test("GPT and Gemini share one ChatPlus account image slot", async () => {
  const config = await loadConfig();
  await saveConfig(modelConfig(config));

  const gpt = await reserveImageTaskAdmission({ model: "gpt", prompt: "gpt" });
  try {
    const runtime = await getRuntimeStatus();
    assert.equal(runtime.models.gpt.categories.image.running, 1);
    assert.equal(runtime.models.gemini.categories.image.running, 0);
    assert.equal(runtime.categories.image.running, 1);

    await assert.rejects(
      reserveImageTaskAdmission({ model: "gemini", prompt: "gemini" }),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
  } finally {
    gpt.release();
  }
});

test("Grok shares the ChatPlus account image slot", async () => {
  const config = await loadConfig();
  await saveConfig(modelConfig(config));

  const gpt = await reserveImageTaskAdmission({ model: "gpt", prompt: "gpt" });
  try {
    const runtime = await getRuntimeStatus();
    assert.equal(runtime.models.gpt.categories.image.running, 1);
    assert.equal(runtime.models.grok.categories.image.running, 0);
    assert.equal(runtime.models.grok.categories.image.configured, 1);

    await assert.rejects(
      reserveImageTaskAdmission({ model: "grok", prompt: "grok" }),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
  } finally {
    gpt.release();
  }
});

test("drawing image usage reduces the available image concurrency for both GPT and Gemini", async () => {
  const config = await loadConfig();
  const next = modelConfig(config);
  next.imageSourcePriority = "drawing";
  next.channels[0].settings.enabledAbilities = { drawing: true, chatplus: true };
  next.channels[0].settings.chatModels.push({
    key: "grok",
    name: "Grok",
    carType: "grok",
    model: "",
    enabled: true,
    default: false
  });
  next.accounts[0].concurrency = { chat: 1, drawingImage: 2, chatImage: 1 };
  next.accounts[0].meta.abilities.drawing = { status: "ok" };
  await saveConfig(next);

  const gpt = await reserveImageTaskAdmission({ model: "gpt", prompt: "drawing gpt" });
  try {
    const runtime = await getRuntimeStatus();
    assert.equal(gpt.target.channel.type, "drawing");
    assert.equal(runtime.models.gpt.categories.image.running, 1);
    assert.equal(runtime.models.gemini.categories.image.running, 0);
    assert.equal(runtime.models.gpt.categories.image.idle, 2);
    assert.equal(runtime.models.gemini.categories.image.idle, 2);
    assert.equal(runtime.models.grok.categories.image.configured, 1);
    assert.equal(runtime.models.grok.categories.image.idle, 1);
  } finally {
    gpt.release();
  }
});

test("account image concurrency is fixed to one shared slot", async () => {
  const config = await loadConfig();
  const next = modelConfig(config);
  next.accounts[0].concurrency = { chat: 2, drawingImage: 2, chatImage: 2 };
  await saveConfig(next);

  const first = await reserveImageTaskAdmission({ model: "gpt", prompt: "first" });
  try {
    await assert.rejects(
      reserveImageTaskAdmission({ model: "gpt", prompt: "second" }),
      (error) => error.status === 429 && error.code === "CONCURRENCY_LIMIT"
    );
  } finally {
    first.release();
  }
});

test("Chatplus account serializes GPT and Gemini work", async () => {
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
  assert.equal(peak, 1);

  active = 0;
  peak = 0;
  await Promise.all([run("gpt"), run("gpt")]);
  assert.equal(peak, 1);
});
