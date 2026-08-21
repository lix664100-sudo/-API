import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-chat-token-usage-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, listTasks, loadConfig, saveConfig } = await import("../src/storage.js");
const { createChatCompletion } = await import("../src/channel-manager.js");
const { ChatplusClient } = await import("../src/channels/chatplus.js");
const { estimateChatTokenUsage } = await import("../src/token-usage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("预计 TOKEN 会统计完整提问、回复，并明确图片未计入", () => {
  const usage = estimateChatTokenUsage({
    messages: [
      { role: "system", content: "请简洁回答。" },
      {
        role: "user",
        content: [
          { type: "text", text: "请说明图片里的商品。" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
        ]
      }
    ]
  }, "这是一瓶饮料。");

  assert.equal(usage.estimated, true);
  assert.equal(usage.tokenizer, "o200k_base");
  assert.equal(usage.text_only, true);
  assert.equal(usage.image_count, 1);
  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

test("对话成功后会把预计 TOKEN 保存到任务记录", async () => {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    defaultChannel: "shareai",
    accounts: [{
      id: "account-token-usage",
      channelId: "shareai",
      name: "TOKEN 记录测试账号",
      username: "token-usage@example.com",
      password: "test",
      enabled: true,
      status: "ok",
      meta: {
        abilities: {
          drawing: { status: "quota_empty", message: "绘图额度不足" },
          chatplus: { status: "ok", message: "聊天账号可用" }
        }
      }
    }]
  });

  const originalCreateChatCompletion = ChatplusClient.prototype.createChatCompletion;
  ChatplusClient.prototype.createChatCompletion = async () => ({
    externalId: "conversation-token-usage",
    model: "gemini",
    content: "这是保存后的测试回复。",
    imageUrls: [],
    raw: {}
  });

  try {
    const response = await createChatCompletion({
      channel: "chatplus",
      messages: [{ role: "user", content: "请回答这个测试问题。" }]
    });
    const stored = (await listTasks()).find((task) => task.id === response.task.id);

    assert.equal(response.usage.estimated, true);
    assert.ok(response.usage.total_tokens > 0);
    assert.deepEqual(response.task.responseJson.usage, response.usage);
    assert.deepEqual(stored.responseJson.usage, response.usage);
  } finally {
    ChatplusClient.prototype.createChatCompletion = originalCreateChatCompletion;
  }
});
