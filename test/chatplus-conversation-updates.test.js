import { EventEmitter } from "node:events";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { ChatplusClient } from "../src/channels/chatplus.js";
import {
  chatplusConversationUpdates,
  chatplusConversationUpdateVersion,
  getChatplusConversationConnection,
  recordChatplusConversationUpdate,
  resetChatplusConversationUpdatesForTests,
  waitForChatplusConversationUpdate
} from "../src/chatplus-conversation-updates.js";

afterEach(() => {
  resetChatplusConversationUpdatesForTests();
});

function imageUpdate(conversationId, imageUrl) {
  return {
    type: "conversation-update",
    payload: {
      conversation_id: conversationId,
      update_type: "async-task-update-message",
      update_content: {
        message: {
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ type: "image_url", image_url: imageUrl }]
          },
          status: "finished_successfully"
        }
      }
    }
  };
}

function createFakeWebSocket() {
  return class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.commands = [];
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
      });
    }

    send(value) {
      const entries = JSON.parse(String(value));
      this.commands.push(...entries.map((entry) => entry.command));
      for (const entry of entries) {
        if (entry.command?.type === "connect") {
          queueMicrotask(() => this.receive([{
            id: entry.id,
            reply: { type: "connect", subscriptions: {} }
          }]));
        }
        if (entry.command?.type === "subscribe") {
          const recovering = entry.command.offset !== undefined;
          queueMicrotask(() => this.receive([{
            id: entry.id,
            reply: {
              type: "subscribe",
              topic_id: "conversations",
              recovered: recovering,
              ...(recovering ? {
                catchups: [{
                  type: "message",
                  topic_id: "conversations",
                  offset: "9",
                  payload: imageUpdate(
                    "conversation-catchup",
                    "https://images.example.test/catchup.png"
                  )
                }]
              } : {}),
              last_offset: recovering ? "9" : "7"
            }
          }]));
        }
      }
    }

    receive(value) {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.emit("message", Buffer.from(JSON.stringify(value)));
    }

    drop() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1006);
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1000);
    }

    terminate() {
      this.drop();
    }
  };
}

test("查询同一车位的多个任务会复用已进入的车位会话", async () => {
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://chatplus.example.test" } },
    account: { id: "account-session-reuse", username: "test@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  testClient.portalLoggedIn = true;
  testClient.carId = "car-reuse";
  testClient.carType = "chatgpt";
  testClient.ensureConversationUpdates = async () => null;
  testClient.conversationDetail = async (conversationId) => ({
    conversation_id: conversationId,
    mapping: {}
  });
  testClient.imageGenerationTaskState = async () => null;
  testClient.imageUrlsFrom = async () => [];
  testClient.refreshCompletedConversation = async (_conversationId, detail) => detail;
  testClient.createSubmitClient = () => testClient;
  let enterCount = 0;
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };

  await testClient.getTask("conversation-reuse", { carId: "car-reuse", carType: "chatgpt", imageTask: true });
  await testClient.getTask("conversation-reuse", { carId: "car-reuse", carType: "chatgpt", imageTask: true });

  assert.equal(enterCount, 0);
});

test("查询任务复用提交时会话，不重复排队进入车位", async () => {
  const snapshot = {
    baseUrl: "https://chatplus.example.test",
    cookies: ["session=submitted"],
    portalLoggedIn: true,
    carId: "car-submitted",
    carType: "chatgpt",
    defaultModel: "gpt-image-test",
    geminiSession: {}
  };
  const refreshedSnapshot = { ...snapshot, cookies: ["session=refreshed"] };
  const reader = {
    ensureConversationUpdates: async () => null,
    conversationDetail: async (conversationId) => ({
      conversation_id: conversationId,
      imageUrls: ["https://images.example.test/submitted-session.png"],
      mapping: {}
    }),
    imageUrlsFrom: async (value) => value?.imageUrls || [],
    sessionSnapshot: () => refreshedSnapshot
  };
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: snapshot.baseUrl } },
    account: { id: "account-submitted-session", username: "submitted@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  let lockCount = 0;
  let receivedSnapshot = null;
  const savedSnapshots = [];
  testClient.sessionLock = async (work) => {
    lockCount += 1;
    return work();
  };
  testClient.createSubmitClient = ({ snapshot: value }) => {
    receivedSnapshot = value;
    return reader;
  };
  testClient.performPortalLogin = async () => assert.fail("不应重新登录");
  testClient.performEnterCar = async () => assert.fail("不应重新进入车位");
  testClient.rememberImageSuccessfulCar = async () => {};

  const task = await testClient.getTask("conversation-submitted-session", {
    carId: snapshot.carId,
    carType: snapshot.carType,
    imageTask: true,
    sessionSnapshot: snapshot,
    onSessionSnapshot: (value) => savedSnapshots.push(value)
  });

  assert.equal(task.status, "success");
  assert.equal(lockCount, 0);
  assert.deepEqual(receivedSnapshot, snapshot);
  assert.deepEqual(savedSnapshots, [refreshedSnapshot]);
  assert.equal(JSON.stringify(task).includes("session=refreshed"), false);
});

test("提交时会话失效后自动恢复并重新查询", async () => {
  const snapshot = {
    baseUrl: "https://chatplus.example.test",
    cookies: ["session=expired"],
    portalLoggedIn: true,
    carId: "car-recover-session",
    carType: "chatgpt",
    defaultModel: "gpt-image-test",
    geminiSession: {}
  };
  const recoveredSnapshot = { ...snapshot, cookies: ["session=recovered"] };
  const expiredReader = {
    ensureConversationUpdates: async () => null,
    conversationDetail: async () => {
      const error = new Error("401 session expired");
      error.status = 401;
      throw error;
    },
    sessionSnapshot: () => snapshot
  };
  const recoveredReader = {
    ensureConversationUpdates: async () => null,
    conversationDetail: async (conversationId) => ({
      conversation_id: conversationId,
      imageUrls: ["https://images.example.test/recovered-session.png"],
      mapping: {}
    }),
    imageUrlsFrom: async (value) => value?.imageUrls || [],
    sessionSnapshot: () => recoveredSnapshot
  };
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: snapshot.baseUrl } },
    account: { id: "account-recover-session", username: "recover@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  let lockCount = 0;
  let enterCount = 0;
  let createClientCount = 0;
  const savedSnapshots = [];
  testClient.sessionLock = async (work) => {
    lockCount += 1;
    return work();
  };
  testClient.invalidateSharedPortalSession = () => {};
  testClient.resetSession = () => {
    testClient.portalLoggedIn = false;
    testClient.carId = "";
  };
  testClient.performPortalLogin = async () => {
    testClient.portalLoggedIn = true;
  };
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };
  testClient.createSubmitClient = () => {
    createClientCount += 1;
    return createClientCount === 1 ? expiredReader : recoveredReader;
  };
  testClient.rememberImageSuccessfulCar = async () => {};

  const task = await testClient.getTask("conversation-recover-session", {
    carId: snapshot.carId,
    carType: snapshot.carType,
    imageTask: true,
    sessionSnapshot: snapshot,
    onSessionSnapshot: (value) => savedSnapshots.push(value)
  });

  assert.equal(task.status, "success");
  assert.equal(lockCount, 1);
  assert.equal(enterCount, 1);
  assert.deepEqual(savedSnapshots, [snapshot, recoveredSnapshot]);
});

test("上游返回 302 时自动恢复会话并读回生成图片", async () => {
  const snapshot = {
    baseUrl: "https://chatplus.example.test",
    cookies: ["session=expired"],
    portalLoggedIn: true,
    carId: "car-recover-redirect",
    carType: "chatgpt",
    defaultModel: "gpt-image-test",
    geminiSession: {}
  };
  const recoveredSnapshot = { ...snapshot, cookies: ["session=recovered"] };
  const expiredReader = {
    ensureConversationUpdates: async () => null,
    conversationDetail: async () => {
      const error = new Error("聊天站请求失败：302");
      error.status = 302;
      throw error;
    },
    sessionSnapshot: () => snapshot
  };
  const recoveredReader = {
    ensureConversationUpdates: async () => null,
    conversationDetail: async (conversationId) => ({
      conversation_id: conversationId,
      imageUrls: ["https://images.example.test/recovered-redirect.png"],
      mapping: {}
    }),
    imageUrlsFrom: async (value) => value?.imageUrls || [],
    sessionSnapshot: () => recoveredSnapshot
  };
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: snapshot.baseUrl } },
    account: { id: "account-recover-redirect", username: "redirect@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  let lockCount = 0;
  let enterCount = 0;
  let createClientCount = 0;
  const savedSnapshots = [];
  testClient.sessionLock = async (work) => {
    lockCount += 1;
    return work();
  };
  testClient.invalidateSharedPortalSession = () => {};
  testClient.resetSession = () => {
    testClient.portalLoggedIn = false;
    testClient.carId = "";
  };
  testClient.performPortalLogin = async () => {
    testClient.portalLoggedIn = true;
  };
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };
  testClient.createSubmitClient = () => {
    createClientCount += 1;
    return createClientCount === 1 ? expiredReader : recoveredReader;
  };
  testClient.rememberImageSuccessfulCar = async () => {};

  const task = await testClient.getTask("conversation-recover-redirect", {
    carId: snapshot.carId,
    carType: snapshot.carType,
    imageTask: true,
    sessionSnapshot: snapshot,
    onSessionSnapshot: (value) => savedSnapshots.push(value)
  });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, ["https://images.example.test/recovered-redirect.png"]);
  assert.equal(lockCount, 1);
  assert.equal(enterCount, 1);
  assert.deepEqual(savedSnapshots, [snapshot, recoveredSnapshot]);
});

test("上游会话首次返回空内容时重新登录并读回生成图片", async () => {
  const resultUrl = "https://images.example.test/recovered.png";
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://chatplus.example.test" } },
    account: { id: "account-empty-image", username: "image@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  testClient.portalLoggedIn = true;
  testClient.carId = "car-empty-image";
  testClient.carType = "chatgpt";
  testClient.ensureConversationUpdates = async () => null;
  let detailReads = 0;
  testClient.conversationDetail = async (conversationId) => {
    detailReads += 1;
    return detailReads === 1
      ? null
      : { conversation_id: conversationId, imageUrls: [resultUrl], mapping: {} };
  };
  testClient.imageGenerationTaskState = async () => null;
  testClient.imageUrlsFrom = async (value) => value?.imageUrls || [];
  testClient.refreshCompletedConversation = async (_conversationId, detail) => detail;
  testClient.createSubmitClient = () => testClient;
  let loginCount = 0;
  let enterCount = 0;
  testClient.performPortalLogin = async () => {
    loginCount += 1;
    testClient.portalLoggedIn = true;
  };
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };

  const task = await testClient.getTask("conversation-empty-image", {
    carId: "car-empty-image",
    carType: "chatgpt",
    imageTask: true
  });

  assert.equal(task.status, "success");
  assert.deepEqual(task.imageUrls, [resultUrl]);
  assert.equal(detailReads, 2);
  assert.equal(loginCount, 1);
  assert.equal(enterCount, 1);
});

test("上游会话首次返回空内容时重新登录并读回额度提示", async () => {
  const quotaText = "You've hit the Plus plan limit for image generations requests. You can create more images when the limit resets in 19 hours.";
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://chatplus.example.test" } },
    account: { id: "account-empty-quota", username: "quota@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  testClient.portalLoggedIn = true;
  testClient.carId = "car-empty-quota";
  testClient.carType = "chatgpt";
  testClient.ensureConversationUpdates = async () => null;
  let detailReads = 0;
  testClient.conversationDetail = async (conversationId) => {
    detailReads += 1;
    if (detailReads === 1) return null;
    return {
      conversation_id: conversationId,
      current_node: "assistant-result",
      mapping: {
        "assistant-result": {
          parent: null,
          message: {
            author: { role: "assistant" },
            status: "finished_successfully",
            end_turn: true,
            content: { content_type: "text", parts: [quotaText] }
          }
        }
      }
    };
  };
  testClient.imageGenerationTaskState = async () => null;
  testClient.imageUrlsFrom = async () => [];
  testClient.refreshCompletedConversation = async (_conversationId, detail) => detail;
  testClient.createSubmitClient = () => testClient;
  let loginCount = 0;
  let enterCount = 0;
  testClient.performPortalLogin = async () => {
    loginCount += 1;
    testClient.portalLoggedIn = true;
  };
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };

  const task = await testClient.getTask("conversation-empty-quota", {
    carId: "car-empty-quota",
    carType: "chatgpt",
    imageTask: true
  });

  assert.equal(task.status, "failed");
  assert.equal(task.raw.imageCarQuotaExhausted, true);
  assert.equal(detailReads, 2);
  assert.equal(loginCount, 1);
  assert.equal(enterCount, 1);
});

test("上游会话重新登录后仍为空时只重试一次", async () => {
  const testClient = new ChatplusClient({
    config: { waitTimeoutSec: 30 },
    channel: { id: "shareai:chatplus", type: "chatplus", settings: { baseUrl: "https://chatplus.example.test" } },
    account: { id: "account-still-empty", username: "empty@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
  testClient.portalLoggedIn = true;
  testClient.carId = "car-still-empty";
  testClient.carType = "chatgpt";
  testClient.ensureConversationUpdates = async () => null;
  let detailReads = 0;
  testClient.conversationDetail = async () => {
    detailReads += 1;
    return null;
  };
  testClient.createSubmitClient = () => testClient;
  let loginCount = 0;
  let enterCount = 0;
  testClient.performPortalLogin = async () => {
    loginCount += 1;
    testClient.portalLoggedIn = true;
  };
  testClient.performEnterCar = async () => {
    enterCount += 1;
  };

  await assert.rejects(
    () => testClient.getTask("conversation-still-empty", {
      carId: "car-still-empty",
      carType: "chatgpt",
      imageTask: true
    }),
    (error) => error?.code === "UPSTREAM_TASK_STATE_UNAVAILABLE"
  );
  assert.equal(detailReads, 2);
  assert.equal(loginCount, 1);
  assert.equal(enterCount, 1);
});

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待条件超时");
}

test("实时结果按对话编号隔离，并唤醒对应任务", async () => {
  let firstResolved = false;
  const firstWait = waitForChatplusConversationUpdate("conversation-a", 0, 500)
    .then((version) => {
      firstResolved = true;
      return version;
    });

  const secondVersion = recordChatplusConversationUpdate(
    imageUpdate("conversation-b", "https://images.example.test/b.png")
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(firstResolved, false);
  assert.equal(chatplusConversationUpdateVersion("conversation-a"), 0);
  assert.equal(chatplusConversationUpdateVersion("conversation-b"), secondVersion);

  const firstVersion = recordChatplusConversationUpdate(
    imageUpdate("conversation-a", "https://images.example.test/a.png")
  );
  assert.equal(await firstWait, firstVersion);
  assert.equal(chatplusConversationUpdates("conversation-a").length, 1);
  assert.equal(chatplusConversationUpdates("conversation-b").length, 1);
});

test("相同上游消息不会被重复记录", () => {
  const update = {
    type: "message",
    topic_id: "conversations",
    payload: imageUpdate("conversation-dedupe", "https://images.example.test/result.png")
  };

  const first = recordChatplusConversationUpdate(update, "offset-42");
  const second = recordChatplusConversationUpdate(update, "offset-42");

  assert.equal(second, first);
  assert.equal(chatplusConversationUpdates("conversation-dedupe").length, 1);
});

test("同一账号车位共享连接，断线后从上次位置继续", async () => {
  const FakeWebSocket = createFakeWebSocket();
  const proxyAgent = { destroy() {} };
  const options = {
    key: "account-1::chatgpt::car-1",
    getWebSocketUrl: async () => "wss://one.example.test/ws/user/test",
    cookieHeader: "session=one",
    origin: "https://one.example.test",
    proxyUrl: "http://proxy.example.test:8080",
    WebSocketImpl: FakeWebSocket,
    proxyAgentFactory: () => proxyAgent,
    idleMs: 60_000
  };
  const firstConnection = getChatplusConversationConnection(options);
  const sharedConnection = getChatplusConversationConnection({
    ...options,
    cookieHeader: "session=latest"
  });

  assert.equal(sharedConnection, firstConnection);
  await firstConnection.ensureReady(1000);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].options.headers.cookie, "session=latest");
  assert.equal(FakeWebSocket.instances[0].options.origin, "https://one.example.test");
  assert.equal(FakeWebSocket.instances[0].options.agent, proxyAgent);
  assert.deepEqual(
    FakeWebSocket.instances[0].commands.map((command) => command.type),
    ["connect", "subscribe"]
  );

  FakeWebSocket.instances[0].receive([{
    type: "message",
    topic_id: "conversations",
    offset: "8",
    payload: imageUpdate("conversation-live", "https://images.example.test/live.png")
  }]);
  assert.equal(chatplusConversationUpdates("conversation-live").length, 1);

  FakeWebSocket.instances[0].drop();
  await waitUntil(() => FakeWebSocket.instances.length === 2);
  await firstConnection.ensureReady(1000);
  const reconnectSubscribe = FakeWebSocket.instances[1].commands
    .find((command) => command.type === "subscribe");
  assert.equal(reconnectSubscribe.offset, "8");
  assert.equal(chatplusConversationUpdates("conversation-catchup").length, 1);
});

test("结果通道在提交前启动，但连接慢时不阻塞上游编号", async () => {
  const events = [];
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: {
      id: "shareai:chatplus",
      settings: { baseUrl: "https://one.example.test" }
    },
    account: { id: "account-submit", username: "submit@example.test" },
    sessionLock: async (work) => work()
  });
  client.prepareChatSession = async () => {
    client.carId = "car-submit";
    client.carType = "chatgpt";
    return {
      route: { key: "gpt", model: "gpt-image-test" },
      selected: { carId: "car-submit", carType: "chatgpt", strategy: "image" },
      init: { default_model_slug: "gpt-image-test" },
      revision: 1
    };
  };
  client.ensureConversationUpdates = () => {
    events.push("result-channel");
    return new Promise(() => {});
  };
  client.http = async (pathName) => {
    assert.equal(pathName, "/backend-api/conversation");
    events.push("submit");
    return {
      status: 200,
      headers: {},
      body: "data: {\"conversation_id\":\"conversation-submit\",\"task_id\":\"upstream-task-submit\"}\n\ndata: [DONE]\n\n"
    };
  };
  client.rememberReusableChatSession = () => {};

  const result = await Promise.race([
    client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("提交被结果通道阻塞")),
      2500
    ))
  ]);

  assert.equal(result.conversationId, "conversation-submit");
  assert.equal(result.upstreamTaskId, "upstream-task-submit");
  assert.deepEqual(events, ["result-channel", "submit"]);
});
