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
      200
    ))
  ]);

  assert.equal(result.conversationId, "conversation-submit");
  assert.equal(result.upstreamTaskId, "upstream-task-submit");
  assert.deepEqual(events, ["result-channel", "submit"]);
});
