import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

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
        chatModels: [
          {
            key: "gpt",
            name: "GPT",
            carType: "chatgpt",
            model: "gpt-5-5-instant",
            strategy: "balanced",
            carTier: "auto",
            enabled: true,
            default: false
          },
          {
            key: "gemini",
            name: "Gemini",
            carType: "gemini",
            strategy: "thinking",
            carTier: "auto",
            enabled: true,
            default: true
          }
        ]
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

function fakeImageFile() {
  return {
    filename: "source.png",
    mimetype: "image/png",
    toBuffer: async () => Buffer.from("image-bytes")
  };
}

test("Gemini 进页时会顺手拿到镜像站上传参数", async () => {
  const testClient = client();
  testClient.portalLoggedIn = true;
  testClient.json = async () => ({ code: 1 });
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: `
      "SNlM0e":"token-at"
      "FdrFJe":"123456"
      "qKIAYe":"feeds/test"
      "Ylro7b":"CgcSBWjK7pYx"
      boq_assistant-bard-web-server_test
    `
  });

  await testClient.enterCar("car-test", "gemini");

  assert.equal(testClient.geminiSession.at, "token-at");
  assert.equal(testClient.geminiSession.sid, "123456");
  assert.equal(testClient.geminiSession.pushId, "feeds/test");
  assert.equal(testClient.geminiSession.uploadClientPctx, "CgcSBWjK7pYx");
  assert.equal(testClient.geminiSession.bl, "boq_assistant-bard-web-server_test");
});

test("Gemini 文字请求会提交网页协议并返回文字", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    uploadClientPctx: "CgcSBWjK7pYx",
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

test("GPT 图生图模型不会因为渠道默认值而转到 Gemini", async () => {
  const testClient = client();

  const route = testClient.chatRouteForInput({
    model_id: 1,
    preferImageCar: true
  });

  assert.equal(route.key, "gpt");
  assert.equal(route.carType, "chatgpt");
  assert.equal(route.strategy, "image");
});

test("显式选择 Gemini 时不会被 model_id 改成 GPT", async () => {
  const testClient = client();

  const route = testClient.chatRouteForInput({
    model: "gemini",
    model_id: 1,
    preferImageCar: true
  });

  assert.equal(route.key, "gemini");
  assert.equal(route.carType, "gemini");
});

test("Gemini 生图优先选择还有生图额度的车位", async () => {
  const testClient = client();
  testClient.fetchCars = async () => [
    {
      id: "idle-without-images",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "ok",
      label: "ok",
      imageRemaining: 0,
      isPro: true,
      isUltra: false,
      isVirtual: false,
      realCarIDs: []
    },
    {
      id: "busy-with-images",
      status: 1,
      count: 2,
      cooldown: 0,
      desc: "ok",
      label: "ok",
      imageRemaining: 10,
      isPro: true,
      isUltra: false,
      isVirtual: false,
      realCarIDs: []
    }
  ];
  testClient.enterCar = async () => {};

  const result = await testClient.prepareChatSession({
    model: "gemini",
    preferImageCar: true
  });

  assert.equal(result.route.strategy, "thinking");
  assert.equal(result.route.selectionStrategy, "image");
  assert.equal(result.selected.carId, "busy-with-images");
  assert.equal(result.selected.strategy, "image");
});

test("GPT 图片模型明确走 GPT 图片车位", async () => {
  const testClient = client();

  const route = testClient.chatRouteForInput({
    model: "gpt-image-2",
    preferImageCar: true
  });

  assert.equal(route.key, "gpt");
  assert.equal(route.carType, "chatgpt");
  assert.equal(route.strategy, "image");
});

test("GPT 自动换车只会继续找 GPT 车队", async () => {
  const testClient = client();
  const carTypes = [];
  testClient.fetchCars = async (carType) => {
    carTypes.push(carType);
    return [{
      id: "same-gpt-car",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "ok",
      label: "ok",
      imageRemaining: 20,
      isPro: false,
      isUltra: false,
      isVirtual: false,
      realCarIDs: []
    }];
  };
  testClient.enterCar = async () => {
    throw new Error("身份验证失败");
  };

  await assert.rejects(() => testClient.prepareChatSession({ model: "gpt" }, new Set(), 2));

  assert.deepEqual(carTypes, ["chatgpt", "chatgpt"]);
});

test("Gemini 失败时不会改找 GPT 车队", async () => {
  const testClient = client();
  const carTypes = [];
  testClient.fetchCars = async (carType) => {
    carTypes.push(carType);
    return [{
      id: "gemini-car",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "ok",
      label: "ok",
      imageRemaining: 0,
      isPro: false,
      isUltra: false,
      isVirtual: false,
      realCarIDs: []
    }];
  };
  testClient.enterCar = async () => {
    const error = new Error("Gemini 上游失败");
    error.status = 502;
    throw error;
  };

  await assert.rejects(
    () => testClient.prepareChatSession({ model: "gemini" }, new Set(), 2),
    (error) => error.noRetry === true
  );

  assert.deepEqual(carTypes, ["gemini"]);
});

test("Gemini 返回图片时直接算成功，不再走 GPT 详情接口", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    uploadClientPctx: "CgcSBWjK7pYx",
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
      imageUrl: "http://googleusercontent.com/image_generation_content/421 http://googleusercontent.com/image_generation_content/404 /gemini/images/gg-dl/generated-image"
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

test("Gemini 结果不能把上传原图识别成生成图", async () => {
  const testClient = client();
  const events = [JSON.parse(geminiResponse({
    imageUrl: "https://claude.midjourneye.com/gemini/images/gg/uploaded-source"
  }))];

  assert.deepEqual(await testClient.imageUrlsFrom(events, { gemini: true }), []);
});

test("Gemini 同时返回原图和生成图时只保留生成图", async () => {
  const testClient = client();
  const events = [JSON.parse(geminiResponse({
    imageUrl: "https://claude.midjourneye.com/gemini/images/gg/uploaded-source https://claude.midjourneye.com/gemini/images/gg-dl/generated-image"
  }))];

  assert.deepEqual(await testClient.imageUrlsFrom(events, { gemini: true }), [
    "https://claude.midjourneye.com/gemini/images/gg-dl/generated-image"
  ]);
});

test("Gemini 没有生成图也没有文字时会自动换车", async () => {
  const testClient = client();
  const cars = ["source-only-car", "image-car"];
  const selectedCars = [];
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = cars.find((item) => !ignoredCarIds.has(item));
    assert.ok(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => {
    selectedCars.push(selected.carId);
    return {
      events: [],
      conversationId: `conversation-${selected.carId}`,
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      directContent: "",
      imageUrls: selected.carId === "image-car" ? ["https://example.test/generated-image.png"] : []
    };
  };

  const result = await testClient.createImageTask({
    prompt: "只返回图片",
    model: "gemini",
    files: [fakeImageFile()],
    onSubmitted: async () => {}
  });

  assert.deepEqual(selectedCars, ["source-only-car", "image-car"]);
  assert.deepEqual(result.imageUrls, ["https://example.test/generated-image.png"]);
});

test("Gemini 生图只返回文字时会自动换车并继续出图", async () => {
  const testClient = client();
  const cars = ["text-only-car", "image-car"];
  const selectedCars = [];
  const submitted = [];
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = cars.find((item) => !ignoredCarIds.has(item));
    assert.ok(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => {
    selectedCars.push(selected.carId);
    const hasImage = selected.carId === "image-car";
    return {
      events: [],
      conversationId: `conversation-${selected.carId}`,
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      directContent: hasImage ? "已完成" : "我只能提供修改建议，无法生成这张图片。",
      imageUrls: hasImage ? ["https://example.test/generated-image.png"] : []
    };
  };

  const result = await testClient.createImageTask({
    prompt: "只返回图片",
    model: "gemini",
    files: [fakeImageFile()],
    onSubmitted: async (value) => {
      submitted.push(value);
    }
  });

  assert.deepEqual(selectedCars, ["text-only-car", "image-car"]);
  assert.equal(submitted.length, 2);
  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://example.test/generated-image.png"]);
});

test("Gemini 连续五个车位只返回文字时失败并保留最后回复", async () => {
  const testClient = client();
  const selectedCars = [];
  const submitted = [];
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = `text-only-car-${ignoredCarIds.size + 1}`;
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => {
    selectedCars.push(selected.carId);
    return {
      events: [],
      conversationId: `conversation-${selected.carId}`,
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      directContent: "我只能提供修改建议，无法生成这张图片。",
      imageUrls: []
    };
  };

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "只返回图片",
      model: "gemini",
      files: [fakeImageFile()],
      onSubmitted: async (value) => {
        submitted.push(value);
      }
    }),
    (error) => {
      assert.equal(error.code, "upstream_text_response");
      assert.equal(error.upstreamExplicitFailure, true);
      assert.equal(error.upstreamText, "我只能提供修改建议，无法生成这张图片。");
      assert.match(error.message, /已自动尝试 5 个 Gemini 生图车位/);
      return true;
    }
  );

  assert.equal(selectedCars.length, 5);
  assert.equal(new Set(selectedCars).size, 5);
  assert.equal(submitted.length, 5);
});

test("Gemini 明确触发内容安全限制时不会重复换车", async () => {
  const testClient = client();
  let attempts = 0;
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    attempts += 1;
    const carId = `policy-car-${attempts}`;
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => ({
    events: [],
    conversationId: `conversation-${selected.carId}`,
    model: "gemini",
    upstreamModel: "gemini",
    route,
    selected,
    directContent: "This request may violate our content policy for image generation.",
    imageUrls: []
  });

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "只返回图片",
      model: "gemini",
      files: [fakeImageFile()],
      onSubmitted: async () => {}
    }),
    (error) => error.code === "content_policy" && error.upstreamExplicitFailure === true
  );

  assert.equal(attempts, 1);
});

test("图片生成频率限制不会被误判成内容违规", async () => {
  const testClient = client();
  const rateLimitMessage = "当前图片生成频率达到限制，请等待约2分钟后重试，目前无法生成图片。";
  const events = [{
    author: { role: "assistant" },
    content: {
      content_type: "text",
      parts: [rateLimitMessage]
    }
  }];

  await assert.rejects(
    () => testClient.waitForConversationImages(events, "conversation-rate-limit", 5),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limit");
      assert.notEqual(error.code, "content_policy");
      return true;
    }
  );
});

test("Gemini 图片下载会保留登录状态和原始二进制内容", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x80]);
  let receivedCookie = "";
  const server = createServer((request, response) => {
    receivedCookie = String(request.headers.cookie || "");
    response.writeHead(200, { "content-type": "image/png" });
    response.end(imageBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const testClient = client();
  testClient.baseUrl = `http://127.0.0.1:${address.port}`;
  testClient.portalLoggedIn = true;
  testClient.carId = "car-test";
  testClient.carType = "gemini";
  testClient.cookies = ["session=test-session"];

  try {
    const result = await testClient.downloadResultImage("/gemini/images/test", {
      carId: "car-test",
      carType: "gemini",
      timeoutMs: 5000
    });
    assert.deepEqual(result.buffer, imageBytes);
    assert.equal(result.contentType, "image/png");
    assert.equal(receivedCookie, "session=test-session");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("private file metadata follows the authenticated image URL", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, cookie: String(request.headers.cookie || "") });
    if (request.url === "/backend-api/files/file_test/download") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ download_url: "/backend-api/estuary/content" }));
      return;
    }
    if (request.url === "/backend-api/estuary/content") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(imageBytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const testClient = client();
  testClient.baseUrl = `http://127.0.0.1:${address.port}`;
  testClient.portalLoggedIn = true;
  testClient.carId = "car-test";
  testClient.carType = "chatgpt";
  testClient.cookies = ["session=test-session"];

  try {
    const result = await testClient.downloadResultImage("/backend-api/files/file_test/download", {
      carId: "car-test",
      carType: "chatgpt",
      timeoutMs: 5000
    });
    assert.deepEqual(result.buffer, imageBytes);
    assert.equal(result.contentType, "image/png");
    assert.deepEqual(requests.map((item) => item.url), [
      "/backend-api/files/file_test/download",
      "/backend-api/estuary/content"
    ]);
    assert.ok(requests.every((item) => item.cookie === "session=test-session"));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
test("Gemini 传图会改走镜像站自己的上传链路", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    uploadClientPctx: "CgcSBWjK7pYx",
    sourcePath: "/app"
  };
  const calls = [];
  testClient.http = async (path, options = {}) => {
    calls.push({ path, options });
    if (String(path).startsWith("/_/BardChatUi/data/batchexecute?")) {
      return { status: 200, headers: {}, body: "ok" };
    }
    if (path === "/gemini/push/upload/") {
      return {
        status: 200,
        headers: {
          "x-goog-upload-url": [
            "https://claude.midjourneye.com/gemini/push/upload?upload_id=test&upload_protocol=resumable"
          ]
        },
        body: ""
      };
    }
    if (String(path).startsWith("https://claude.midjourneye.com/gemini/push/upload?upload_id=test")) {
      return {
        status: 200,
        headers: {},
        body: "/contrib_service/ttl_1d/uploaded-image"
      };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const [identifier, filename] = await testClient.uploadGeminiImage(fakeImageFile());

  assert.equal(identifier, "/contrib_service/ttl_1d/uploaded-image");
  assert.equal(filename, "source.png");
  assert.equal(calls.length, 3);
  assert.match(calls[0].path, /^\/_\/BardChatUi\/data\/batchexecute\?/);
  assert.match(calls[0].path, /rpcids=ESY5D/);
  assert.match(calls[0].path, /source-path=%2Fapp/);
  assert.match(calls[0].path, /bl=boq_assistant-bard-web-server_test/);
  assert.match(calls[0].path, /f\.sid=123456/);
  const preflightBody = decodeURIComponent(calls[0].options.body);
  assert.match(preflightBody, /ESY5D/);
  assert.match(preflightBody, /bard_activity_enabled/);
  assert.match(preflightBody, /token-at/);
  assert.equal(calls[1].path, "/gemini/push/upload/");
  assert.equal(calls[1].options.headers["push-id"], "feeds/test");
  assert.equal(calls[1].options.headers["x-client-pctx"], "CgcSBWjK7pYx");
  assert.equal(calls[1].options.headers["x-goog-upload-command"], "start");
  assert.equal(calls[1].options.headers["x-tenant-id"], "bard-storage");
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.equal(
    calls[2].path,
    "https://claude.midjourneye.com/gemini/push/upload?upload_id=test&upload_protocol=resumable"
  );
  assert.equal(calls[2].options.headers["x-client-pctx"], "CgcSBWjK7pYx");
  assert.equal(calls[2].options.headers["x-goog-upload-command"], "upload, finalize");
  assert.equal(calls[2].options.headers["x-goog-upload-offset"], "0");
  assert.equal(calls[2].options.headers["content-type"], undefined);
});

test("Gemini 传图上传失败会直接停掉，不再继续重试", async () => {
  const testClient = client();
  testClient.geminiSession = {
    at: "token-at",
    sid: "123456",
    bl: "boq_assistant-bard-web-server_test",
    pushId: "feeds/test",
    uploadClientPctx: "CgcSBWjK7pYx",
    sourcePath: "/app"
  };
  testClient.http = async (path) => {
    if (String(path).startsWith("/_/BardChatUi/data/batchexecute?")) {
      return { status: 200, headers: {}, body: "ok" };
    }
    if (path === "/gemini/push/upload/") {
      return { status: 502, headers: {}, body: "upload failed" };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  await assert.rejects(
    () => testClient.uploadGeminiImage(fakeImageFile()),
    (error) => error.noRetry === true && error.status === 502
  );
});
