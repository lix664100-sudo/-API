import test from "node:test";
import assert from "node:assert/strict";

const { ChatplusClient } = await import("../src/channels/chatplus.js");

function client() {
  return new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: {
      id: "midjourneye",
      type: "shareai",
      settings: {
        baseUrl: "https://claude.midjourneye.com",
        defaultChatModel: "gemini",
        chatModels: [{
          key: "gemini",
          name: "Gemini",
          carType: "gemini",
          strategy: "thinking",
          carTier: "auto",
          enabled: true,
          default: true
        }]
      }
    },
    account: { id: "gemini-test", username: "test@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
}

function geminiResponse({ text = "", imageUrl = "", error = "" } = {}) {
  const content = [text, imageUrl, error].filter(Boolean).join(" ");
  const responsePart = [
    "conversation-test",
    ["conversation-test", "response-test", "choice-test"],
    null,
    null,
    [[null, content]]
  ];
  return JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(responsePart), null, null]]);
}

test("Gemini 文字请求会提交网页协议并返回文字", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    sourcePath: "/app"
  };
  testClient.uploadGeminiImages = async () => [];
  let request = null;
  testClient.http = async (path, options) => {
    request = { path, options };
    return { status: 200, headers: {}, body: geminiResponse({ text: "Gemini 返回成功" }) };
  };

  const result = await testClient.sendGeminiConversation(
    "请回复测试成功",
    { files: [] },
    { key: "gemini", strategy: "thinking", model: "" },
    { carId: "car-test", carType: "gemini" }
  );

  assert.equal(result.directContent, "Gemini 返回成功");
  assert.equal(result.conversationId, "conversation-test");
  assert.match(request.path, /^\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/);
  assert.match(request.path, /bl=boq_assistant-bard-web-server_test/);
  assert.match(request.path, /f\.sid=123456/);
  const decodedBody = decodeURIComponent(request.options.body);
  assert.match(decodedBody, /token-at/);
  assert.match(decodedBody, /请回复测试成功/);
  assert.equal(request.options.headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
});

test("Gemini 返回图片时直接算成功，不再走 GPT 详情接口", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    sourcePath: "/app"
  };
  testClient.uploadGeminiImages = async () => [["uploaded-image", "source.png"]];
  testClient.prepareChatSession = async () => ({
    route: { key: "gemini", strategy: "thinking", model: "" },
    selected: { carId: "car-test", carType: "gemini" },
    init: {}
  });
  testClient.http = async (_path, _options) => ({
    status: 200,
    headers: {},
    body: geminiResponse({
      text: "已完成",
      imageUrl: "/gemini/images/gg-dl/generated-image"
    })
  });

  let waitCalled = false;
  const result = await testClient.createTextTask({
    prompt: "生成测试图片",
    model: "gemini",
    waitForImages: false,
    onSubmitted: async () => {},
    waitForConversationImages: async () => {
      waitCalled = true;
      return [];
    }
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://claude.midjourneye.com/gemini/images/gg-dl/generated-image"]);
  assert.equal(waitCalled, false);
});

test("Gemini 没有返回文字或图片时不能误判成功", async () => {
  const testClient = client();
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(["empty"]), null, null]])
  });

  await assert.rejects(
    () => testClient.sendGeminiConversation(
      "空结果测试",
      { files: [] },
      { key: "gemini", strategy: "thinking", model: "" },
      { carId: "car-test", carType: "gemini" }
    ),
    (error) => error.code === "INVALID_UPSTREAM_RESPONSE" && error.status === 502
  );
});

test("Gemini 上游明确返回用量上限时标记为额度不足", async () => {
  const testClient = client();
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: geminiResponse({ error: "usage count has reached the limit" })
  });

  await assert.rejects(
    () => testClient.sendGeminiConversation(
      "额度测试",
      { files: [] },
      { key: "gemini", strategy: "thinking", model: "" },
      { carId: "car-test", carType: "gemini" }
    ),
    (error) => error.imageQuotaExhausted === true && error.quotaReason === "chat_usage_limit"
  );
});
