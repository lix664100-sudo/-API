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
    "c_conversation_test",
    ["c_conversation_test", "response-test", "choice-test"],
    null,
    null,
    [[null, content]]
  ];
  return JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(responsePart), null, null]]);
}

function geminiHistoryResponse({ text = "", generatedUrl = "", sourceUrl = "" } = {}) {
  const candidate = Array(13).fill(null);
  candidate[0] = "rc_history_result";
  candidate[1] = [text];
  candidate[12] = Array(8).fill(null);
  candidate[12][7] = [[[null, 1, "generated.jpg", generatedUrl]]];
  const payload = [candidate, [null, 1, "source.jpg", sourceUrl]];
  const batch = JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload), null, null]]);
  return `)]}'\n\n${batch.length}\n${batch}\n`;
}

function fakeImageFile() {
  return {
    filename: "source.png",
    mimetype: "image/png",
    toBuffer: async () => Buffer.from("image-bytes")
  };
}

function geminiModelHeader(request) {
  return JSON.parse(request.options.headers["x-goog-ext-525001261-jspb"]);
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
  assert.equal(result.conversationId, "c_conversation_test");
  assert.match(request.path, /^\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/);
  assert.match(request.path, /bl=boq_assistant-bard-web-server_test/);
  assert.match(request.path, /f\.sid=123456/);
  const decodedBody = decodeURIComponent(request.options.body);
  assert.match(decodedBody, /token-at/);
  assert.match(decodedBody, /请回复测试成功/);
  assert.equal(request.options.headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
});

test("Gemini 回复文字不能覆盖真实上游会话编号", async () => {
  const testClient = client();
  const thought = "**Refine Brush Details** I'm now zeroing in on the product details.";
  const conversationPart = [
    "c_real_conversation",
    ["c_real_conversation", "response-test", "choice-test"],
    null,
    null,
    [[null, "{image}"]]
  ];
  const thoughtPart = [
    null,
    [thought],
    null,
    null,
    [[null, thought]]
  ];
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify([conversationPart, thoughtPart]), null, null]])
  });

  const result = await testClient.sendGeminiConversation(
    "会话编号识别测试",
    { files: [] },
    { key: "gemini", strategy: "thinking", model: "" },
    { carId: "car-test", carType: "gemini" }
  );

  assert.equal(result.conversationId, "c_real_conversation");
});

for (const modelCase of [
  {
    model: "gemini-3.5-flash-lite",
    thinkingLevel: "standard",
    modelHash: "8c46e95b1a07cecc",
    mode: 6,
    nativeThinkingLevel: 1
  },
  {
    model: "gemini-3.7-flash",
    thinkingLevel: "standard",
    modelHash: "56fdd199312815e2",
    mode: 1,
    nativeThinkingLevel: 1
  },
  {
    model: "gemini-3.1-pro",
    thinkingLevel: "extended",
    modelHash: "e6fa609c3fa255c0",
    mode: 3,
    nativeThinkingLevel: 2
  }
]) {
  test(`Gemini 参数会选择 ${modelCase.model} / ${modelCase.thinkingLevel}`, async () => {
    const testClient = client();
    testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
    testClient.uploadGeminiImages = async () => [];
    let request = null;
    testClient.http = async (path, options) => {
      request = { path, options };
      return { status: 200, headers: {}, body: geminiResponse({ text: "模型选择成功" }) };
    };
    const input = {
      model: modelCase.model,
      thinking_level: modelCase.thinkingLevel,
      files: []
    };
    const route = testClient.chatRouteForInput(input);

    const result = await testClient.sendGeminiConversation(
      "模型选择测试",
      input,
      route,
      { carId: "car-test", carType: "gemini" }
    );

    const selector = geminiModelHeader(request);
    assert.equal(route.key, "gemini");
    assert.equal(route.model, modelCase.model);
    assert.equal(route.thinkingLevel, modelCase.thinkingLevel);
    assert.equal(route.geminiParameterFallback, false);
    assert.equal(selector[4], modelCase.modelHash);
    assert.equal(selector[11], modelCase.mode);
    assert.equal(selector[14], modelCase.mode);
    assert.equal(selector[15], modelCase.nativeThinkingLevel);
    assert.equal(result.model, modelCase.model);
    assert.equal(result.upstreamModel, modelCase.model);
  });
}

test("Gemini 生图固定使用 3.1 Pro，普通文字聊天仍使用调用模型", () => {
  const testClient = client();
  const imageRoute = testClient.chatRouteForInput({
    model: "gemini-3.7-flash",
    thinking_level: "standard",
    imageGeneration: true
  });
  const chatRoute = testClient.chatRouteForInput({
    model: "gemini-3.7-flash",
    thinking_level: "standard"
  });

  assert.equal(imageRoute.model, "gemini-3.1-pro");
  assert.equal(imageRoute.geminiRequestedModel, "gemini-3.7-flash");
  assert.equal(chatRoute.model, "gemini-3.7-flash");
});

for (const invalidInput of [
  { model: "gemini-model-written-wrong", thinking_level: "extended" },
  { model: "gemini-3.1-pro", thinking_level: "very-strong" }
]) {
  test("Gemini 模型或强度写错时才改用最快模型", async () => {
    const testClient = client();
    const route = testClient.chatRouteForInput(invalidInput);

    assert.equal(route.key, "gemini");
    assert.equal(route.model, "gemini-3.5-flash-lite");
    assert.equal(route.thinkingLevel, "standard");
    assert.equal(route.geminiParameterFallback, true);
  });
}

for (const effortCase of [
  { input: { reasoning_effort: "low" }, thinkingLevel: "standard" },
  { input: { reasoning_effort: "medium" }, thinkingLevel: "standard" },
  { input: { reasoning_effort: "high" }, thinkingLevel: "extended" },
  { input: { reasoning: { effort: "xhigh" } }, thinkingLevel: "extended" }
]) {
  test(`Gemini 兼容常用 reasoning effort：${effortCase.thinkingLevel}`, () => {
    const testClient = client();
    const route = testClient.chatRouteForInput({
      model: "gemini-3.1-pro",
      ...effortCase.input
    });

    assert.equal(route.model, "gemini-3.1-pro");
    assert.equal(route.thinkingLevel, effortCase.thinkingLevel);
    assert.equal(route.geminiParameterFallback, false);
  });
}

test("Gemini reasoning effort 写错时改用最快模型", () => {
  const testClient = client();
  const route = testClient.chatRouteForInput({
    model: "gemini-3.1-pro",
    reasoning_effort: "very-strong"
  });

  assert.equal(route.model, "gemini-3.5-flash-lite");
  assert.equal(route.thinkingLevel, "standard");
  assert.equal(route.geminiParameterFallback, true);
});

test("Gemini 账户额度用完后不再换车", async () => {
  const testClient = client();
  const selectedCars = [];
  const selectedRoutes = [];
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = `quota-car-${ignoredCarIds.size + 1}`;
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => {
    selectedCars.push(selected.carId);
    selectedRoutes.push([route.model, route.thinkingLevel]);
    const error = new Error("当前 Gemini 账号的使用次数已用完。");
    error.imageQuotaExhausted = true;
    error.quotaConfirmedByUpstream = true;
    error.quotaReason = "chat_usage_limit";
    throw error;
  };

  await assert.rejects(
    testClient.withImageQuotaFallback(
      "额度停用测试",
      {
        model: "gemini-3.1-pro",
        thinking_level: "extended",
        files: []
      },
      async (conversation) => conversation
    ),
    /使用次数已用完/
  );

  assert.deepEqual(selectedCars, ["quota-car-1"]);
  assert.deepEqual(selectedRoutes, [["gemini-3.1-pro", "extended"]]);
});

test("Gemini 所有车都用完时保留聊天次数错误而不是误报图片额度", async () => {
  const testClient = client();
  let attempts = 0;
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = `empty-car-${ignoredCarIds.size + 1}`;
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async () => {
    attempts += 1;
    const error = new Error("当前 Gemini 账号的使用次数已用完。");
    error.status = 429;
    error.code = "CHAT_USAGE_LIMIT";
    error.imageQuotaExhausted = true;
    error.quotaEmpty = true;
    error.quotaConfirmedByUpstream = true;
    error.quotaReason = "chat_usage_limit";
    throw error;
  };

  await assert.rejects(
    () => testClient.withImageQuotaFallback(
      "全部车位额度测试",
      {
        model: "gemini-3.1-pro",
        thinking_level: "extended",
        files: []
      },
      async (conversation) => conversation
    ),
    (error) => error.code === "CHAT_USAGE_LIMIT" && error.quotaReason === "chat_usage_limit"
  );

  assert.equal(attempts, 1);
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
      imageUrl: "http://googleusercontent.com/image_generation_content/0_462 http://googleusercontent.com/image_generation_content/0_463 /gemini/images/gg-dl/generated-image"
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

test("Gemini 会话换节点后会刷新重读，并且只取生成结果", async () => {
  const testClient = client();
  const pageRequests = [];
  const detailRequests = [];
  testClient.http = async (requestPath, options = {}) => {
    if (requestPath.startsWith("/app/ce144bba99281e12?_=")) {
      pageRequests.push(requestPath);
      return { status: 200, headers: {}, body: '"SNlM0e":"history-token"' };
    }
    detailRequests.push({ requestPath, options });
    if (detailRequests.length === 1) {
      return { status: 200, headers: {}, body: JSON.stringify({ error: "need_reload" }) };
    }
    return {
      status: 200,
      headers: {},
      body: geminiHistoryResponse({
        text: "{image}",
        sourceUrl: "/gemini/images/gg/source-image",
        generatedUrl: "/gemini/images/gg/generated-image"
      })
    };
  };

  const detail = await testClient.geminiConversationDetail("c_ce144bba99281e12");
  const imageUrls = await testClient.imageUrlsFrom(detail, { geminiHistory: true });

  assert.equal(pageRequests.length, 2);
  assert.equal(detailRequests.length, 2);
  assert.match(detailRequests[0].requestPath, /^\/_\/BardChatUi\/data\/batchexecute\?/);
  assert.match(detailRequests[0].requestPath, /rpcids=hNvQHb/);
  assert.match(detailRequests[0].requestPath, /source-path=%2Fapp%2Fce144bba99281e12/);
  assert.equal(detailRequests[0].options.method, "POST");
  assert.deepEqual(imageUrls, [
    "https://claude.midjourneye.com/gemini/images/gg/generated-image"
  ]);
});

test("Gemini 先返回处理说明、稍后返回图片时不会提前结束或重复提交", async () => {
  const testClient = client();
  const submitted = [];
  let submissionCount = 0;
  let historyReadCount = 0;
  testClient.withImageQuotaFallback = async (_prompt, _input, work) => {
    submissionCount += 1;
    return work({
      events: [],
      conversationId: "c_delayed_image_result",
      model: "gemini",
      upstreamModel: "gemini-3.1-pro",
      route: { key: "gemini" },
      selected: { carId: "gemini-car", carType: "gemini" },
      submissionConfirmed: true,
      directContent: "**Refine Brush Details** I'm now zeroing in on the product details.",
      imageUrls: []
    });
  };
  testClient.waitForGeminiConversationImages = async () => {
    historyReadCount += 1;
    return ["https://example.test/delayed-generated-image.png"];
  };
  testClient.rememberImageSuccessfulCar = async () => {};

  const result = await testClient.createImageTask({
    prompt: "替换背景并保持产品一致",
    model: "gemini",
    files: [fakeImageFile()],
    onSubmitted: async (value) => submitted.push(value)
  });

  assert.equal(submissionCount, 1);
  assert.equal(submitted.length, 1);
  assert.equal(historyReadCount, 1);
  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://example.test/delayed-generated-image.png"]);
});

test("Gemini 没有立即返回结果时只提交一次并进入等待", async () => {
  const testClient = client();
  const cars = ["source-only-car", "image-car"];
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
    waitForImages: false,
    onSubmitted: async (value) => submitted.push(value)
  });

  assert.deepEqual(selectedCars, ["source-only-car"]);
  assert.equal(submitted.length, 1);
  assert.equal(result.status, "waiting_upstream");
  assert.deepEqual(result.imageUrls, []);
});

test("Gemini 只返回文字时停止当前任务并让该车位冷却", async () => {
  const testClient = client();
  const cars = [
    {
      id: "text-only-car",
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
    },
    {
      id: "image-car",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "ok",
      label: "ok",
      imageRemaining: 10,
      isPro: false,
      isUltra: false,
      isVirtual: false,
      realCarIDs: []
    }
  ];
  const selectedCars = [];
  const submitted = [];
  testClient.fetchCars = async () => cars;
  testClient.enterCar = async () => {};
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

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "只返回图片",
      model: "gemini",
      files: [fakeImageFile()],
      onSubmitted: async (value) => submitted.push(value)
    }),
    (error) => error.code === "upstream_text_response"
  );
  const result = await testClient.createImageTask({
    prompt: "第二个任务",
    model: "gemini",
    files: [fakeImageFile()],
    onSubmitted: async (value) => submitted.push(value)
  });

  assert.deepEqual(selectedCars, ["text-only-car", "image-car"]);
  assert.equal(submitted.length, 2);
  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://example.test/generated-image.png"]);
});

test("Gemini 返回文字失败时只消耗一次提交并保留回复", async () => {
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
      assert.equal(error.message, "我只能提供修改建议，无法生成这张图片。");
      return true;
    }
  );

  assert.equal(selectedCars.length, 1);
  assert.equal(submitted.length, 1);
});

test("图片上游取消时自动换车并标记被取消的车位", async () => {
  const testClient = client();
  const cars = ["cancelled-image-car", "healthy-image-car"];
  const selectedCars = [];
  const cooldowns = [];
  testClient.onImageCarCooldown = async (cooldown) => cooldowns.push(cooldown);
  testClient.sendConversation = async (_prompt, _input, ignoredCarIds) => {
    const carId = cars.find((item) => !ignoredCarIds.has(item));
    assert.ok(carId);
    ignoredCarIds.add(carId);
    selectedCars.push(carId);
    return {
      events: [],
      conversationId: `conversation-${carId}`,
      model: "gpt",
      upstreamModel: "gpt-5-6-thinking",
      route: { key: "gpt", model: "gpt-5-6-thinking", carType: "chatgpt" },
      selected: { carId, carType: "chatgpt" },
      submissionConfirmed: true
    };
  };
  testClient.captureImageTaskRegistration = async () => {};
  testClient.waitForConversationImages = async (_events, conversationId) => {
    if (conversationId === "conversation-cancelled-image-car") {
      const error = new Error("上游已取消任务。");
      error.upstreamExplicitFailure = true;
      error.upstreamStatus = "cancelled";
      throw error;
    }
    return ["https://example.test/healthy-generated-image.png"];
  };
  testClient.rememberImageSuccessfulCar = async () => {};

  const result = await testClient.createTextTask({
    prompt: "只返回图片",
    model: "gpt-image-2"
  });

  assert.deepEqual(selectedCars, cars);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].carId, "cancelled-image-car");
  assert.equal(cooldowns[0].reason, "image_cancelled");
  assert.match(cooldowns[0].message, /上游已取消/);
  assert.equal(result.status, "success");
  assert.deepEqual(result.raw.carAttempts.map((item) => item.carId), ["cancelled-image-car"]);
});

test("Gemini 提交结果无法确认时最多换一个车位重试", async () => {
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
  let selectedCount = 0;
  let submissionCount = 0;
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    selectedCount += 1;
    const carId = `uncertain-car-${selectedCount}`;
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.http = async () => {
    submissionCount += 1;
    const error = new Error("connection reset");
    error.code = "ECONNRESET";
    throw error;
  };

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "只返回图片",
      model: "gemini",
      files: [fakeImageFile()]
    }),
    (error) => error.code === "UPSTREAM_CONVERSATION_NOT_CREATED"
      && error.imageSubmissionAttempted === true
  );

  assert.equal(selectedCount, 2);
  assert.equal(submissionCount, 2);
});

test("Gemini 上游返回 500 后当前任务换车再提交一次", async () => {
  const testClient = client();
  const enteredCars = [];
  let submissionCount = 0;
  testClient.fetchCars = async () => [
    {
      id: "server-500-car",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "ok",
      label: "first",
      imageRemaining: 10,
      imageRemainingKnown: true,
      isIQ: false,
      isPro: false,
      isUltra: false,
      isSuper: false,
      isVirtual: false,
      realCarIDs: []
    },
    {
      id: "healthy-car-after-500",
      status: 1,
      count: 1,
      cooldown: 0,
      desc: "ok",
      label: "second",
      imageRemaining: 9,
      imageRemainingKnown: true,
      isIQ: false,
      isPro: false,
      isUltra: false,
      isSuper: false,
      isVirtual: false,
      realCarIDs: []
    }
  ];
  testClient.enterCar = async (carId, carType) => {
    enteredCars.push(carId);
    testClient.portalLoggedIn = true;
    testClient.carId = carId;
    testClient.carType = carType;
    testClient.cookies = [`car=${carId}`];
    testClient.geminiSession = {
      at: "token-at",
      sid: "123456",
      bl: "boq_assistant-bard-web-server_test",
      pushId: "feeds/test",
      uploadClientPctx: "CgcSBWjK7pYx",
      sourcePath: "/app"
    };
  };
  testClient.uploadGeminiImages = async () => [["uploaded-image", "source.png"]];
  testClient.http = async () => {
    submissionCount += 1;
    if (submissionCount === 1) {
      return {
        status: 500,
        headers: {},
        body: JSON.stringify({ error: "请求失败，请重试" })
      };
    }
    return {
      status: 200,
      headers: {},
      body: geminiResponse({ imageUrl: "/gemini/images/gg-dl/generated-after-switch.png" })
    };
  };

  const result = await testClient.createImageTask({
    prompt: "当前任务换车重试",
    model: "gemini",
    files: [fakeImageFile()]
  });

  assert.equal(submissionCount, 2);
  assert.deepEqual(enteredCars, ["server-500-car", "healthy-car-after-500"]);
  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://claude.midjourneye.com/gemini/images/gg-dl/generated-after-switch.png"]);
  const generationStages = result.raw.stageTimings.filter((stage) => stage.key === "upstream_generation");
  assert.deepEqual(generationStages.map((stage) => [stage.carId, stage.status]), [
    ["server-500-car", "failed"],
    ["healthy-car-after-500", "success"]
  ]);
});

test("Gemini 多个并发任务遇到同一失效车位时只换一次车", async () => {
  const testClient = client();
  const enteredCars = [];
  const cooldowns = [];
  let expiredSubmissions = 0;
  let healthySubmissions = 0;
  let releaseExpiredSubmissions;
  const allExpiredSubmissionsStarted = new Promise((resolve) => {
    releaseExpiredSubmissions = resolve;
  });

  testClient.onImageCarCooldown = async (cooldown) => cooldowns.push(cooldown);
  testClient.loginPortal = async () => {
    testClient.portalLoggedIn = true;
  };
  testClient.fetchCars = async () => [
    {
      id: "shared-expired-car",
      status: 1,
      count: 0,
      cooldown: 0,
      desc: "expired",
      label: "expired",
      imageRemaining: 10,
      imageRemainingKnown: true,
      isIQ: false,
      isPro: false,
      isUltra: false,
      isSuper: false,
      isVirtual: false,
      realCarIDs: []
    },
    {
      id: "shared-healthy-car",
      status: 1,
      count: 1,
      cooldown: 0,
      desc: "healthy",
      label: "healthy",
      imageRemaining: 9,
      imageRemainingKnown: true,
      isIQ: false,
      isPro: false,
      isUltra: false,
      isSuper: false,
      isVirtual: false,
      realCarIDs: []
    }
  ];
  testClient.enterCar = async (carId, carType) => {
    enteredCars.push(carId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    testClient.portalLoggedIn = true;
    testClient.carId = carId;
    testClient.carType = carType;
    testClient.cookies = [`car=${carId}`];
    testClient.geminiSession = {
      at: `token-${carId}`,
      sid: `sid-${carId}`,
      bl: "boq_assistant-bard-web-server_test",
      pushId: "feeds/test",
      uploadClientPctx: "CgcSBWjK7pYx",
      sourcePath: "/app"
    };
  };
  testClient.createSubmitClient = () => testClient;
  testClient.sendGeminiConversation = async (_prompt, input, route, selected) => {
    input.imageSubmissionState.started = true;
    if (selected.carId === "shared-expired-car") {
      expiredSubmissions += 1;
      if (expiredSubmissions === 3) releaseExpiredSubmissions();
      await allExpiredSubmissionsStarted;
      const error = new Error("请求失败，请重试");
      error.status = 500;
      error.upstreamText = error.message;
      throw error;
    }

    healthySubmissions += 1;
    input.imageSubmissionState.confirmed = true;
    return {
      events: [],
      conversationId: `conversation-${healthySubmissions}`,
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      submissionConfirmed: true,
      directContent: "",
      imageUrls: [`https://example.test/generated-${healthySubmissions}.png`]
    };
  };

  const results = await Promise.all([1, 2, 3].map((index) => testClient.createImageTask({
    prompt: `并发换车任务 ${index}`,
    model: "gemini",
    files: [fakeImageFile()],
    concurrentSubmit: true
  })));

  assert.equal(expiredSubmissions, 3);
  assert.equal(healthySubmissions, 3);
  assert.deepEqual(enteredCars, ["shared-expired-car", "shared-healthy-car"]);
  assert.deepEqual(results.map((result) => result.status), ["success", "success", "success"]);
  assert.equal(new Set(results.map((result) => result.externalId)).size, 3);
  assert.equal(cooldowns.every((cooldown) => cooldown.carId === "shared-expired-car"), true);
});

test("Gemini 参考图上传前发现车位失效时会先换车，不会误记为已经提交", async () => {
  const testClient = client();
  const selectedCars = [];
  let generationCount = 0;
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = selectedCars.length ? "healthy-upload-car" : "invalid-upload-car";
    selectedCars.push(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, _input, route, selected) => {
    if (selected.carId === "invalid-upload-car") {
      const error = new Error("Gemini 图片上传前检查失败：500");
      error.status = 500;
      error.body = JSON.stringify({ error: "request_error", message: "车队失效，请重新选择" });
      error.upstreamText = error.body;
      error.noRetry = true;
      throw error;
    }
    generationCount += 1;
    return {
      events: [],
      conversationId: "conversation-after-upload-car-switch",
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      submissionConfirmed: true,
      directContent: "",
      imageUrls: ["https://example.test/generated-after-upload-car-switch.png"]
    };
  };

  const result = await testClient.createImageTask({
    prompt: "上传失败后换车",
    model: "gemini",
    files: [fakeImageFile()]
  });

  assert.deepEqual(selectedCars, ["invalid-upload-car", "healthy-upload-car"]);
  assert.equal(generationCount, 1);
  assert.equal(result.status, "success");
  assert.deepEqual(result.imageUrls, ["https://example.test/generated-after-upload-car-switch.png"]);
});

test("普通对话没有创建对话时会停用当前车位并换一个车位", async () => {
  const testClient = client();
  const selectedCars = [];
  const cooldowns = [];
  testClient.onImageCarCooldown = async (cooldown) => cooldowns.push(cooldown);
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = selectedCars.length ? "healthy-chat-car" : "invalid-chat-car";
    selectedCars.push(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, input, route, selected) => {
    input.imageSubmissionState.started = true;
    if (selected.carId === "invalid-chat-car") {
      const error = new Error("type.googleapis.com/assistant.boq.bard.application.BardErrorInfo");
      error.status = 400;
      error.upstreamText = error.message;
      throw error;
    }
    input.imageSubmissionState.confirmed = true;
    return {
      events: [],
      conversationId: "conversation-after-chat-car-switch",
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      submissionConfirmed: true,
      directContent: "这是测试商品。",
      imageUrls: []
    };
  };

  const result = await testClient.createChatCompletion({
    model: "gemini",
    messages: [{ role: "user", content: "请说明这是什么商品。" }]
  });

  assert.deepEqual(selectedCars, ["invalid-chat-car", "healthy-chat-car"]);
  assert.equal(result.content, "这是测试商品。");
  assert.equal(result.externalId, "conversation-after-chat-car-switch");
  assert.equal(result.raw.selectedCarId, "healthy-chat-car");
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].carId, "invalid-chat-car");
  assert.equal(cooldowns[0].reason, "conversation_not_created");
  assert.ok(Date.parse(cooldowns[0].cooldownUntil) > Date.now() + 23 * 60 * 60 * 1000);
});

test("普通对话会返回各处理阶段的耗时明细", async () => {
  const testClient = client();
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    ignoredCarIds.add("timed-chat-car");
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId: "timed-chat-car", carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, input, route, selected) => {
    await input.taskStageRecorder.record({
      id: "timed-chat-upstream",
      key: "upstream_generation",
      label: "等待上游处理",
      status: "success",
      startedAt: "2026-08-25T00:00:00.000Z",
      finishedAt: "2026-08-25T00:00:01.234Z",
      durationMs: 1234,
      carId: selected.carId,
      carType: selected.carType
    });
    return {
      events: [],
      conversationId: "conversation-with-stage-timings",
      model: "gemini",
      upstreamModel: "gemini",
      route,
      selected,
      submissionConfirmed: true,
      directContent: "耗时已经记录。",
      imageUrls: []
    };
  };

  const result = await testClient.createChatCompletion({
    model: "gemini",
    messages: [{ role: "user", content: "请记录这次对话的耗时。" }]
  });

  assert.deepEqual(result.raw.stageTimings, [{
    id: "timed-chat-upstream",
    key: "upstream_generation",
    label: "等待上游处理",
    status: "success",
    startedAt: "2026-08-25T00:00:00.000Z",
    finishedAt: "2026-08-25T00:00:01.234Z",
    durationMs: 1234,
    carId: "timed-chat-car",
    carType: "gemini"
  }]);
});

test("普通对话开始上游请求时会立即报告当前阶段", async () => {
  const testClient = client();
  const startedStages = [];
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    ignoredCarIds.add("live-stage-car");
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId: "live-stage-car", carType: "gemini" },
      init: {}
    };
  };
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: geminiResponse({ text: "阶段报告成功" })
  });

  const result = await testClient.createChatCompletion({
    model: "gemini",
    messages: [{ role: "user", content: "请报告当前阶段。" }],
    onStageStart: async (stage) => startedStages.push(stage)
  });

  const upstreamStage = startedStages.find((stage) => stage.key === "upstream_generation");
  assert.equal(result.content, "阶段报告成功");
  assert.equal(upstreamStage?.status, "processing");
  assert.equal(upstreamStage?.label, "等待上游处理");
  assert.equal(upstreamStage?.carId, "live-stage-car");
  assert.ok(upstreamStage?.id);
});

test("普通对话开启并发提交时不会被账号内部再次排队", async () => {
  const testClient = client();
  let active = 0;
  let maxActive = 0;
  let releaseActive;
  let reportBothStarted;
  let requestIndex = 0;
  const bothStarted = new Promise((resolve) => { reportBothStarted = resolve; });
  const holdActive = new Promise((resolve) => { releaseActive = resolve; });
  testClient.withImageQuotaFallback = async (_prompt, _input, work) => {
    requestIndex += 1;
    const currentIndex = requestIndex;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 2) reportBothStarted();
    try {
      await holdActive;
      return work({
        events: [],
        conversationId: `conversation-inner-parallel-${currentIndex}`,
        model: "gemini",
        upstreamModel: "gemini-3.1-pro",
        route: { key: "gemini" },
        selected: { carId: "inner-parallel-car", carType: "gemini" },
        directContent: `并发回复 ${currentIndex}`,
        imageUrls: []
      });
    } finally {
      active -= 1;
    }
  };

  const requests = [1, 2].map((index) => testClient.createChatCompletion({
    model: "gemini",
    concurrentSubmit: true,
    messages: [{ role: "user", content: `内部并发 ${index}` }]
  }));
  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 300))
  ]);
  releaseActive();
  const results = await Promise.all(requests);

  assert.equal(overlapped, true);
  assert.equal(maxActive, 2);
  assert.equal(results.length, 2);
});

test("连续两个车位都没有创建对话时任务失败并保存两个车位", async () => {
  const testClient = client();
  const selectedCars = [];
  const cooldowns = [];
  testClient.onImageCarCooldown = async (cooldown) => cooldowns.push(cooldown);
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = `invalid-chat-car-${selectedCars.length + 1}`;
    selectedCars.push(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, input) => {
    input.imageSubmissionState.started = true;
    const error = new Error("type.googleapis.com/assistant.boq.bard.application.BardErrorInfo");
    error.status = 400;
    error.upstreamText = error.message;
    throw error;
  };

  await assert.rejects(
    () => testClient.createChatCompletion({
      model: "gemini",
      messages: [{ role: "user", content: "测试连续失效车位" }]
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_CONVERSATION_NOT_CREATED");
      assert.deepEqual(error.carAttempts.map((item) => item.carId), [
        "invalid-chat-car-1",
        "invalid-chat-car-2"
      ]);
      assert.match(error.message, /连续两个车位都没有创建对话/);
      return true;
    }
  );

  assert.deepEqual(selectedCars, ["invalid-chat-car-1", "invalid-chat-car-2"]);
  assert.deepEqual(cooldowns.map((item) => item.carId), selectedCars);
});

test("Gemini 上游连续返回 500 时当前任务最多提交两次", async () => {
  const testClient = client();
  const selectedCars = [];
  let submissionCount = 0;
  testClient.prepareChatSession = async (input, ignoredCarIds) => {
    const carId = `repeated-500-car-${selectedCars.length + 1}`;
    selectedCars.push(carId);
    ignoredCarIds.add(carId);
    return {
      route: testClient.chatRouteForInput(input),
      selected: { carId, carType: "gemini" },
      init: {}
    };
  };
  testClient.sendGeminiConversation = async (_prompt, input) => {
    input.imageSubmissionState.started = true;
    submissionCount += 1;
    const error = new Error("请求失败，请重试");
    error.status = 500;
    error.upstreamExplicitFailure = true;
    error.upstreamStatus = "failed";
    throw error;
  };

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "连续失败测试",
      model: "gemini",
      files: [fakeImageFile()]
    }),
    (error) => error.code === "UPSTREAM_CONVERSATION_NOT_CREATED"
      && error.status === 502
      && error.imageSubmissionAttempted === true
  );

  assert.equal(submissionCount, 2);
  assert.deepEqual(selectedCars, ["repeated-500-car-1", "repeated-500-car-2"]);
});

test("Gemini 明确触发内容安全限制时不会重复换车", async () => {
  const testClient = client();
  const message = "We're so sorry, but the prompt may violate our content policies. If you think we got it wrong, please retry or edit your prompt.";
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
    directContent: message,
    imageUrls: []
  });

  await assert.rejects(
    () => testClient.createImageTask({
      prompt: "只返回图片",
      model: "gemini",
      files: [fakeImageFile()],
      onSubmitted: async () => {}
    }),
    (error) => error.code === "content_policy"
      && error.upstreamExplicitFailure === true
      && error.message === message
      && error.upstreamText === message
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
    (error) => error.code === "UPSTREAM_CONVERSATION_NOT_CREATED"
      && error.status === 502
      && error.conversationNotCreated === true
  );
});

test("Gemini 返回 BardErrorInfo 且没有对话编号时明确标记车位失效", async () => {
  const testClient = client();
  const state = { started: false };
  const body = JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify([
    null,
    null,
    null,
    null,
    [[null, "type.googleapis.com/assistant.boq.bard.application.BardErrorInfo"]]
  ]), null, null]]);
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({ status: 200, headers: {}, body });

  await assert.rejects(
    () => testClient.sendGeminiConversation(
      "车位失效测试",
      { files: [], imageSubmissionState: state },
      { key: "gemini", strategy: "thinking", model: "" },
      { carId: "expired-car", carType: "gemini" }
    ),
    (error) => {
      assert.equal(error.code, "UPSTREAM_CONVERSATION_NOT_CREATED");
      assert.equal(error.conversationNotCreated, true);
      assert.equal(error.selectedCarId, "expired-car");
      assert.equal(error.upstreamText, body);
      return true;
    }
  );

  assert.equal(state.started, true);
  assert.equal(state.confirmed, undefined);
});

test("Gemini 上游明确返回用量上限时记录账户额度和恢复时间", async () => {
  const testClient = client();
  testClient.geminiSession.bl = "boq_assistant-bard-web-server_test";
  testClient.uploadGeminiImages = async () => [];
  testClient.http = async () => ({
    status: 200,
    headers: {},
    body: geminiResponse({
      error: "Your account's current usage count has reached the limit: used 71, reserved 0, total occupied 71/70, this request needs 1, remaining 0, please try again after 2026-08-23 10:49:52 or purchase a higher usage plan."
    })
  });

  await assert.rejects(
    () => testClient.sendGeminiConversation(
      "额度测试",
      { files: [] },
      { key: "gemini", strategy: "thinking", model: "" },
      { carId: "car-test", carType: "gemini" }
    ),
    (error) => {
      assert.equal(error.imageQuotaExhausted, true);
      assert.equal(error.quotaReason, "chat_usage_limit");
      assert.equal(error.quota, 70);
      assert.equal(error.used, 71);
      assert.equal(error.balance, 0);
      assert.equal(error.quotaResetAt, "2026-08-23T10:49:52+08:00");
      return true;
    }
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
