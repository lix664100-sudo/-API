import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Response } from "node-fetch";

import { DrawingClient } from "../src/channels/drawing.js";
import { ChatplusClient } from "../src/channels/chatplus.js";
import {
  parseShareAiPortalUrls,
  reportShareAiPortalFailure,
  resetShareAiPortalRoutingForTests,
  useAvailableShareAiPortal
} from "../src/shareai-portal-router.js";

const directoryHtml = `
  <script>
    const NODES = ['one.aishare.io', 'one.aishare.icu', 'one.likeky.com'];
    const PRIORITY_NODE = 'china.aishare.icu';
    const UNRELATED = 'credentials.example.test';
  </script>
`;

beforeEach(() => {
  resetShareAiPortalRoutingForTests();
});

test("只读取官方线路声明并保持官方优先顺序", () => {
  assert.deepEqual(parseShareAiPortalUrls(directoryHtml), [
    "https://one.aishare.io",
    "https://one.aishare.icu",
    "https://one.likeky.com",
    "https://china.aishare.icu"
  ]);
});

test("当前入口失败后按官方线路自动切换并记住可用入口", async () => {
  let directoryLoads = 0;
  const attempts = [];
  const options = {
    configuredUrls: ["https://configured.example.test"],
    proxyUrl: "http://switch-proxy.example.test:8080",
    directoryUrl: "https://directory-switch.example.test/",
    directoryLoader: async () => {
      directoryLoads += 1;
      return directoryHtml;
    },
    attempt: async (url) => {
      attempts.push(url);
      if (url !== "https://one.likeky.com") throw new Error("连接失败");
      return "logged-in";
    }
  };

  const first = await useAvailableShareAiPortal(options);
  const secondAttempts = [];
  const second = await useAvailableShareAiPortal({
    ...options,
    attempt: async (url) => {
      secondAttempts.push(url);
      return "reused";
    }
  });

  assert.equal(first.url, "https://one.likeky.com");
  assert.equal(first.value, "logged-in");
  assert.deepEqual(attempts, [
    "https://configured.example.test",
    "https://one.aishare.io",
    "https://one.aishare.icu",
    "https://one.likeky.com"
  ]);
  assert.equal(directoryLoads, 1);
  assert.equal(second.url, "https://one.likeky.com");
  assert.deepEqual(secondAttempts, ["https://one.likeky.com"]);
});

test("多个账号同时切换时只读取一次官方线路页", async () => {
  let directoryLoads = 0;
  let releaseDirectory;
  const directoryReady = new Promise((resolve) => {
    releaseDirectory = resolve;
  });
  const directoryLoader = async () => {
    directoryLoads += 1;
    await directoryReady;
    return "const NODES = ['working.example.test'];";
  };
  const login = () => useAvailableShareAiPortal({
    configuredUrls: ["https://broken.example.test"],
    proxyUrl: "http://concurrent-proxy.example.test:8080",
    directoryUrl: "https://directory-concurrent.example.test/",
    directoryLoader,
    attempt: async (url) => {
      if (url === "https://broken.example.test") throw new Error("连接失败");
      return url;
    }
  });

  const first = login();
  const second = login();
  await new Promise((resolve) => setImmediate(resolve));
  releaseDirectory();
  const results = await Promise.all([first, second]);

  assert.equal(directoryLoads, 1);
  assert.deepEqual(results.map((item) => item.url), [
    "https://working.example.test",
    "https://working.example.test"
  ]);
});

test("账号或密码错误时不把同一密码发送到所有线路", async () => {
  let directoryLoads = 0;
  const attempts = [];
  const accountError = new Error("账号或密码错误");
  accountError.portalAccountRejected = true;

  await assert.rejects(
    useAvailableShareAiPortal({
      configuredUrls: ["https://configured.example.test"],
      proxyUrl: "http://account-proxy.example.test:8080",
      directoryUrl: "https://directory-account.example.test/",
      directoryLoader: async () => {
        directoryLoads += 1;
        return directoryHtml;
      },
      attempt: async (url) => {
        attempts.push(url);
        throw accountError;
      }
    }),
    /账号或密码错误/
  );

  assert.equal(directoryLoads, 0);
  assert.deepEqual(attempts, ["https://configured.example.test"]);
});

test("不同代理分别选择自己的可用入口", async () => {
  const firstAttempts = [];
  const secondAttempts = [];
  await useAvailableShareAiPortal({
    configuredUrls: ["https://first.example.test"],
    proxyUrl: "http://first-proxy.example.test:8080",
    attempt: async (url) => {
      firstAttempts.push(url);
      return "first";
    }
  });
  await useAvailableShareAiPortal({
    configuredUrls: ["https://second.example.test"],
    proxyUrl: "http://second-proxy.example.test:8080",
    attempt: async (url) => {
      secondAttempts.push(url);
      return "second";
    }
  });

  assert.deepEqual(firstAttempts, ["https://first.example.test"]);
  assert.deepEqual(secondAttempts, ["https://second.example.test"]);
});

test("已选入口后来断线时会跳过它并重新读取官方线路", async () => {
  const proxyUrl = "http://recover-proxy.example.test:8080";
  const directoryUrl = "https://directory-recover.example.test/";
  const first = await useAvailableShareAiPortal({
    configuredUrls: ["https://first.example.test"],
    proxyUrl,
    directoryUrl,
    attempt: async (url) => url
  });
  reportShareAiPortalFailure({ proxyUrl, url: first.url });
  const attempts = [];
  const recovered = await useAvailableShareAiPortal({
    configuredUrls: ["https://first.example.test"],
    proxyUrl,
    directoryUrl,
    directoryLoader: async () => "const NODES = ['recovered.example.test'];",
    attempt: async (url) => {
      attempts.push(url);
      return url;
    }
  });

  assert.equal(recovered.url, "https://recovered.example.test");
  assert.deepEqual(attempts, ["https://recovered.example.test"]);
});

test("线路冷却期间不会在下一次任务中重复尝试失效入口", async () => {
  const configuredUrls = [
    "https://one.aishare.io",
    "https://one.aishare.icu",
    "https://one.likeky.com"
  ];
  const options = {
    configuredUrls,
    proxyUrl: "http://cooldown-proxy.example.test:8080",
    directoryUrl: "https://directory-cooldown.example.test/",
    directoryLoader: async () => directoryHtml,
    attempt: async () => {
      throw new Error("连接失败");
    }
  };

  await assert.rejects(useAvailableShareAiPortal(options), /没有可用的登录入口/);
  const retryAttempts = [];
  await assert.rejects(
    useAvailableShareAiPortal({
      ...options,
      attempt: async (url) => {
        retryAttempts.push(url);
        throw new Error("连接失败");
      }
    }),
    /没有可用的登录入口/
  );
  assert.deepEqual(retryAttempts, []);
});

test("绘图登录失败后自动切换，后续继续使用已选入口", async () => {
  const loginUrls = [];
  const config = {
    mainBaseUrl: "https://broken.example.test",
    drawingBaseUrl: "https://drawing.example.test",
    shareAiDirectoryUrl: "https://directory-drawing.example.test/"
  };
  const channel = { settings: { baseUrl: "https://drawing.example.test" } };
  const account = {
    username: "user@example.test",
    password: "secret",
    proxyUrl: "http://drawing-proxy.example.test:8080"
  };
  const client = new DrawingClient({
    config,
    channel,
    account,
    sessionLock: async (work) => work(),
    portalDirectoryLoader: async () => "const NODES = ['working.example.test'];",
    proxyAgentFactory: () => ({ destroy() {} }),
    fetchImpl: async (url) => {
      loginUrls.push(url);
      if (url.startsWith("https://broken.example.test/")) throw new Error("连接失败");
      return new Response('{"code":1}', {
        status: 200,
        headers: { "set-cookie": "share-session=portal-session; Path=/; HttpOnly" }
      });
    }
  });
  client.request = async (path, options) => {
    assert.equal(path, "/api/v1/auth/external-sso");
    assert.equal(options.body["share-token"], "portal-session");
    return { access_token: "drawing-token" };
  };

  await client.performLogin({ timeoutMs: 1000 });
  client.updateContext({ config, channel, account, sessionLock: async (work) => work() });

  assert.deepEqual(loginUrls, [
    "https://broken.example.test/frontend-api/login",
    "https://working.example.test/frontend-api/login"
  ]);
  assert.equal(client.mainBaseUrl, "https://working.example.test");
  assert.equal(client.accessToken, "drawing-token");
});

test("GPT 登录自动切换后，并发任务副本沿用同一个入口", async () => {
  const loginUrls = [];
  const config = { shareAiDirectoryUrl: "https://directory-chat.example.test/" };
  const channel = { settings: { baseUrl: "https://broken.example.test" } };
  const account = {
    username: "user@example.test",
    password: "secret",
    proxyUrl: "http://chat-proxy.example.test:8080"
  };
  const client = new ChatplusClient({
    config,
    channel,
    account,
    sessionLock: async (work) => work(),
    portalDirectoryLoader: async () => "const NODES = ['working.example.test'];",
    fetchImpl: async () => {
      const error = new Error("安全连接失败");
      error.code = "ECONNRESET";
      throw error;
    },
    curlRunner: async (args) => {
      const url = args.find((value) => String(value).includes("/frontend-api/login"));
      loginUrls.push(url);
      if (String(url).startsWith("https://broken.example.test/")) throw new Error("连接失败");
      return "HTTP/1.1 200 OK\r\nSet-Cookie: share-session=fresh; Path=/\r\nContent-Type: application/json\r\n\r\n{\"code\":1}";
    }
  });

  await client.performPortalLogin({ timeoutSec: 1 });
  client.updateContext({ config, channel, account, sessionLock: async (work) => work() });
  const copy = client.createSubmitClient({ snapshot: client.sessionSnapshot() });

  assert.deepEqual(loginUrls, [
    "https://broken.example.test/frontend-api/login",
    "https://working.example.test/frontend-api/login"
  ]);
  assert.equal(client.baseUrl, "https://working.example.test");
  assert.equal(client.portalLoggedIn, true);
  assert.equal(copy.baseUrl, "https://working.example.test");
  assert.equal(copy.portalLoggedIn, true);
});

test("GPT 登录虽成功但进入车位断线时会换到另一条线路", async () => {
  const events = [];
  const config = { shareAiDirectoryUrl: "https://directory-car.example.test/" };
  const channel = { settings: { baseUrl: "https://first.example.test" } };
  const account = {
    username: "user@example.test",
    password: "secret",
    proxyUrl: "http://car-proxy.example.test:8080"
  };
  const client = new ChatplusClient({
    config,
    channel,
    account,
    sessionLock: async (work) => work(),
    portalDirectoryLoader: async () => "const NODES = ['working.example.test'];",
    fetchImpl: async () => {
      const error = new Error("安全连接失败");
      error.code = "ECONNRESET";
      throw error;
    },
    curlRunner: async (args) => {
      const url = args.find((value) => /^https:\/\//.test(String(value)));
      events.push(url);
      if (String(url).startsWith("https://first.example.test/auth/loginSession")) {
        const error = new Error("安全连接失败");
        error.code = "CURL_TLS_CONNECT_ERROR";
        error.status = 502;
        throw error;
      }
      if (String(url).includes("/frontend-api/login")) {
        return "HTTP/1.1 200 OK\r\nSet-Cookie: share-session=fresh; Path=/\r\nContent-Type: application/json\r\n\r\n{\"code\":1}";
      }
      if (String(url).includes("/auth/loginSession")) {
        return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"code\":1}";
      }
      return "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>";
    }
  });

  await client.performPortalLogin({ timeoutSec: 1 });
  await client.performEnterCar("car-1", "chatgpt", { timeoutSec: 1 });

  assert.equal(client.baseUrl, "https://working.example.test");
  assert.deepEqual(events, [
    "https://first.example.test/frontend-api/login",
    "https://first.example.test/auth/loginSession?carid=car-1&carType=chatgpt",
    "https://working.example.test/frontend-api/login",
    "https://working.example.test/auth/loginSession?carid=car-1&carType=chatgpt",
    "https://working.example.test/"
  ]);
});
