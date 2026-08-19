import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-model-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, loadConfig, saveConfig } = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("legacy pinned GPT model is migrated to the upstream default", async () => {
  const config = await loadConfig();
  const saved = await saveConfig({
    ...config,
    channels: [{
      id: "shareai",
      name: "ShareAI",
      type: "shareai",
      enabled: true,
      settings: {
        defaultChatModel: "gpt",
        model: "gpt-5-5-instant",
        chatModels: [{
          key: "gpt",
          name: "GPT",
          carType: "chatgpt",
          model: "gpt-5-5-instant",
          enabled: true,
          default: true
        }]
      }
    }]
  });

  const settings = saved.channels[0].settings;
  assert.equal(settings.chatModels.find((item) => item.key === "gpt").model, "");
  assert.equal(Object.hasOwn(settings, "model"), false);
});
