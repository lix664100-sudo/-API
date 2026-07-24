import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-multi-channel-"));
process.env.DATA_DIR = dataDir;

const { loadConfig, saveConfig } = await import("../src/storage.js");

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
          enabledAbilities: { drawing: true, chatplus: true }
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
  assert.deepEqual(stored.accounts.map((item) => item.channelId).sort(), ["midjourneye", "shareai"]);
});
