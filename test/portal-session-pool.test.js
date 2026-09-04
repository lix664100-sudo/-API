import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Response } from "node-fetch";

import {
  adoptPortalSession,
  clearPortalSessions,
  getPortalSession,
  invalidatePortalSession,
  portalSessionKey,
  savePortalSession,
  shareSessionFromCookies
} from "../src/portal-session-pool.js";
import { ChatplusClient } from "../src/channels/chatplus.js";
import { DrawingClient } from "../src/channels/drawing.js";

beforeEach(() => {
  clearPortalSessions();
});

const CHAT_ACCOUNT = { id: "acc-chat-1", username: "shared@example.test", password: "secret" };
const DRAW_ACCOUNT = { username: "shared@example.test", password: "secret" };

function loginResponse(session) {
  return `HTTP/1.1 200 OK\r\nset-cookie: share-session=${session}; Path=/\r\n\r\n{"code":1}`;
}

function makeChatClient({ account = CHAT_ACCOUNT, session = "SESS-A" } = {}) {
  let loginCalls = 0;
  const client = new ChatplusClient({
    config: {},
    channel: { settings: { baseUrl: "https://one.example.test" } },
    account,
    sessionLock: async (work) => work(),
    curlRunner: async (args) => {
      const url = args.find((value) => /^https?:\/\//i.test(String(value)));
      if (String(url).includes("/frontend-api/login")) {
        loginCalls += 1;
        return loginResponse(session);
      }
      throw new Error(`意外的 curl 请求: ${url}`);
    }
  });
  return { client, countLogins: () => loginCalls };
}

function makeDrawingClient({ account = DRAW_ACCOUNT, fetchImpl }) {
  return new DrawingClient({
    config: {},
    channel: {},
    account,
    sessionLock: async (work) => work(),
    fetchImpl
  });
}

test("共享会话池按账号、密码、代理隔离", () => {
  const base = portalSessionKey({ username: "user@example.test", password: "secret", proxyUrl: "" });
  assert.equal(base, portalSessionKey({ username: " USER@example.test ", password: "secret" }));
  assert.notEqual(base, portalSessionKey({ username: "other@example.test", password: "secret" }));
  assert.notEqual(base, portalSessionKey({ username: "user@example.test", password: "secret2" }));
  assert.notEqual(base, portalSessionKey({ username: "user@example.test", password: "secret", proxyUrl: "http://proxy.test:1080" }));
});

test("超过 30 分钟的共享会话自动过期", () => {
  const key = portalSessionKey({ username: "user@example.test", password: "secret" });
  savePortalSession(key, { baseUrl: "https://one.example.test", cookies: ["share-session=SESS-OLD"], shareSession: "SESS-OLD" });

  assert.ok(getPortalSession(key));
  const future = Date.now() + 31 * 60 * 1000;
  assert.equal(getPortalSession(key, { now: future }), null);
  assert.equal(adoptPortalSession(key, { now: future }), null);
});

test("作废共享会话时不会误删已经更新过的会话", () => {
  const key = portalSessionKey({ username: "user@example.test", password: "secret" });
  savePortalSession(key, { shareSession: "SESS-NEW", cookies: ["share-session=SESS-NEW"] });

  assert.equal(invalidatePortalSession(key, { shareSession: "SESS-OLD" }), false);
  assert.equal(getPortalSession(key)?.shareSession, "SESS-NEW");
  assert.equal(invalidatePortalSession(key, { shareSession: "SESS-NEW" }), true);
  assert.equal(getPortalSession(key), null);
});

test("shareSessionFromCookies 能从登录 Cookie 中取出门户会话", () => {
  assert.equal(shareSessionFromCookies(["other=1", "share-session=SESS-X; Path=/"]), "SESS-X");
  assert.equal(shareSessionFromCookies([]), "");
});

test("第一个聊天客户端登录后把门户会话写入共享池", async () => {
  const { client, countLogins } = makeChatClient({ session: "SESS-A" });

  await client.loginPortal();

  assert.equal(countLogins(), 1);
  assert.equal(client.portalLoggedIn, true);
  const key = client.portalSessionPoolKey();
  const pooled = adoptPortalSession(key);
  assert.equal(pooled.shareSession, "SESS-A");
  assert.equal(pooled.baseUrl, "https://one.example.test");
});

test("同一账号的第二个聊天客户端直接复用共享会话，不再登录", async () => {
  const first = makeChatClient({ session: "SESS-A" });
  await first.client.loginPortal();

  const second = makeChatClient({ session: "SESS-B" });
  await second.client.loginPortal();

  assert.equal(second.countLogins(), 0, "复用共享会话时不应该再走登录接口");
  assert.equal(second.client.portalLoggedIn, true);
  assert.equal(second.client.baseUrl, "https://one.example.test");
  assert.ok(second.client.cookies.includes("share-session=SESS-A"));
  assert.equal(first.countLogins(), 1);
});

test("共享会话失效后下一个客户端重新登录并刷新共享池", async () => {
  const first = makeChatClient({ session: "SESS-A" });
  await first.client.loginPortal();
  first.client.invalidateSharedPortalSession();

  const key = first.client.portalSessionPoolKey();
  assert.equal(adoptPortalSession(key), null);

  const second = makeChatClient({ session: "SESS-B" });
  await second.client.loginPortal();

  assert.equal(second.countLogins(), 1);
  assert.equal(adoptPortalSession(key)?.shareSession, "SESS-B");
});

test("聊天账号被反复挤下线时快速失败，不再无限重试换车", async () => {
  const { client } = makeChatClient();
  let prepareCalls = 0;
  client.prepareChatSession = async () => {
    prepareCalls += 1;
    const error = new Error("您已在其他设备登陆");
    error.authScope = "car";
    throw error;
  };

  await assert.rejects(
    client.sendConversation("你好", {}),
    (error) => {
      assert.equal(error.code, "ACCOUNT_SESSION_CONTENDED");
      assert.equal(error.status, 409);
      assert.equal(error.noRetry, true);
      assert.match(error.message, /连续/);
      return true;
    }
  );
  assert.equal(prepareCalls, 2, "连续两次被挤下线后应该立即停止，而不是继续换车");
});

test("GPT 生图提交时反复被挤下线会停止换车，不误报车位失效", async () => {
  const { client } = makeChatClient();
  let requestCount = 0;
  client.ensureConversationUpdates = async () => null;
  client.prepareChatSession = async (_input, ignoredCarIds) => {
    const carId = `submit-kick-car-${requestCount + 1}`;
    ignoredCarIds.add(carId);
    return {
      route: { key: "gpt", model: "gpt-test" },
      init: { default_model_slug: "gpt-test" },
      selected: { carId, carType: "chatgpt" }
    };
  };
  client.uploadChatImages = async () => [];
  client.http = async () => {
    requestCount += 1;
    return {
      status: 403,
      headers: {},
      body: JSON.stringify({ detail: { message: "您的账号在其他设备登录，请重新登录" } })
    };
  };

  await assert.rejects(
    client.sendConversation("重新登录测试", {
      imageGeneration: true,
      requireConversationId: true
    }),
    (error) => {
      assert.equal(error.code, "ACCOUNT_SESSION_CONTENDED");
      assert.equal(error.status, 409);
      assert.doesNotMatch(error.message, /没有创建对话/);
      return true;
    }
  );
  assert.equal(requestCount, 2, "连续两次明确被挤下线后应停止，不再继续换车");
});

test("相同图片重复上传直接命中缓存，重置会话后重新上传", async () => {
  const { client } = makeChatClient();
  let jsonCalls = 0;
  client.json = async (path) => {
    jsonCalls += 1;
    if (path === "/backend-api/files") return { file_id: "file-1", upload_url: "https://blob.example.test/file-1" };
    return { status: "success" };
  };
  client.http = async () => ({ status: 201, headers: {}, body: "" });
  const file = {
    toBuffer: async () => Buffer.from("fake-image-bytes"),
    mimetype: "image/png",
    filename: "source.png"
  };

  const first = await client.uploadChatImage(file);
  assert.equal(first.attachment.id, "file-1");
  assert.equal(jsonCalls, 2);

  const cached = await client.uploadChatImage(file);
  assert.deepEqual(cached, first);
  assert.equal(jsonCalls, 2, "相同图片第二次上传不应该再请求上游");

  client.resetSession();
  const afterReset = await client.uploadChatImage(file);
  assert.equal(afterReset.attachment.id, "file-1");
  assert.equal(jsonCalls, 4, "重置会话后缓存应失效并重新上传");
});

test("上传初始化返回登录失效错误时按鉴权失败处理", async () => {
  const { client } = makeChatClient({ session: "SESS-A" });
  await client.loginPortal();
  client.json = async () => ({ message: "身份验证失败，请重新登录" });
  const file = {
    toBuffer: async () => Buffer.from("auth-shaped-failure-bytes"),
    mimetype: "image/png",
    filename: "source.png"
  };

  await assert.rejects(
    client.uploadChatImage(file),
    (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /重新登录/);
      return true;
    }
  );
});

test("绘图客户端复用聊天客户端登录出来的门户会话", async () => {
  const chat = makeChatClient({ session: "SESS-X" });
  await chat.client.loginPortal();

  const calls = [];
  const drawing = makeDrawingClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: options?.body });
      if (String(url).includes("/api/v1/auth/external-sso")) {
        return new Response(JSON.stringify({ code: 0, data: { access_token: "tok-adopted" } }), { status: 200 });
      }
      throw new Error(`绘图客户端不应该请求 ${url}`);
    }
  });

  await drawing.ensureLogin();

  assert.equal(drawing.accessToken, "tok-adopted");
  assert.equal(drawing.portalShareSession, "SESS-X");
  assert.equal(calls.length, 1, "复用共享会话时只需要换取绘图令牌，不应再登录门户");
  assert.ok(calls[0].url.endsWith("/api/v1/auth/external-sso"));
  assert.equal(calls[0].body, JSON.stringify({ "share-token": "SESS-X" }));
  assert.equal(chat.countLogins(), 1);
});

test("绘图客户端共享会话失效时作废共享池并重新登录", async () => {
  const key = portalSessionKey({ username: DRAW_ACCOUNT.username, password: DRAW_ACCOUNT.password });
  savePortalSession(key, {
    baseUrl: "https://portal.example.test",
    cookies: ["share-session=SESS-OLD"],
    shareSession: "SESS-OLD"
  });

  let ssoCalls = 0;
  const calls = [];
  const drawing = makeDrawingClient({
    fetchImpl: async (url, options) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/api/v1/auth/external-sso")) {
        ssoCalls += 1;
        if (ssoCalls === 1) {
          return new Response(JSON.stringify({ code: 401, message: "token invalid" }), { status: 401 });
        }
        return new Response(JSON.stringify({ code: 0, data: { access_token: "tok-new" } }), { status: 200 });
      }
      if (target.includes("/frontend-api/login")) {
        return new Response(JSON.stringify({ code: 1 }), {
          status: 200,
          headers: { "set-cookie": "share-session=SESS-NEW; Path=/" }
        });
      }
      throw new Error(`意外请求 ${target}`);
    }
  });

  await drawing.ensureLogin();

  assert.equal(drawing.accessToken, "tok-new");
  assert.equal(drawing.portalShareSession, "SESS-NEW");
  assert.equal(ssoCalls, 2);
  assert.ok(calls.some((url) => url.includes("/frontend-api/login")), "共享会话失效后应重新登录门户");
  assert.equal(adoptPortalSession(key)?.shareSession, "SESS-NEW");
});
