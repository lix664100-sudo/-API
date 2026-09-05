import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { ChatplusClient, normalizeImageCarCooldown } = await import("../src/channels/chatplus.js");
const { recordChatplusConversationUpdate } = await import("../src/chatplus-conversation-updates.js");

function car(overrides = {}) {
  return {
    id: overrides.id || "car",
    status: 1,
    count: 0,
    cooldown: 0,
    desc: overrides.desc || "ok",
    label: overrides.label || "ok",
    imageRemaining: 0,
    imageRemainingKnown: Object.hasOwn(overrides, "imageRemaining"),
    isIQ: false,
    isPro: false,
    isPlus: false,
    isUltra: false,
    isSuper: false,
    isVirtual: false,
    realCarIDs: [],
    ...overrides
  };
}

function serialSessionLock() {
  let tail = Promise.resolve();
  return (work) => {
    const current = tail.catch(() => {}).then(work);
    tail = current;
    return current;
  };
}

function clientForGpt(options = {}) {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: {
      id: "shareai:chatplus",
      ability: "chatplus",
      settings: {
        baseUrl: options.baseUrl || "https://claude.midjourneye.com",
        defaultChatModel: "gpt",
        chatModels: [{
          key: "gpt",
          name: "GPT",
          carType: "chatgpt",
          strategy: "image",
          carTier: "auto",
          enabled: true,
          default: true
        }]
      }
    },
    account: {
      id: options.accountId || "account-gpt",
      username: options.username || "gpt@example.test",
      password: "test",
      ...(options.account || {})
    },
    sessionLock: options.sessionLock || (async (work) => work()),
    onProCarsUnavailable: options.onProCarsUnavailable,
    onProCarsAvailable: options.onProCarsAvailable,
    onImageCarCooldown: options.onImageCarCooldown
  });
  client.ensureConversationUpdates = async () => null;
  return client;
}

function clientForGemini(chatModel = {}) {
  return new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: {
      id: "shareai:chatplus",
      settings: {
        baseUrl: "https://claude.midjourneye.com",
        defaultChatModel: "gemini",
        chatModels: [{
          key: "gemini",
          name: "Gemini",
          carType: "gemini",
          model: "",
          strategy: "thinking",
          carTier: "auto",
          enabled: true,
          default: true,
          ...chatModel
        }]
      }
    },
    account: { id: "account-pro", username: "pro@example.test", password: "test" },
    sessionLock: async (work) => work()
  });
}

test("legacy conversation busy freezes are shortened to 30 seconds", () => {
  const normalized = normalizeImageCarCooldown({
    carId: "legacy-busy-car",
    reason: "conversation_not_created",
    message: "对话过快或您当前有多个任务执行中，请稍后重试",
    updatedAt: "2026-08-25T10:00:00.000Z",
    cooldownUntil: "2026-08-26T10:00:00.000Z"
  });

  assert.equal(normalized.cooldownUntil, "2026-08-25T10:00:30.000Z");
});

test("chatplus auto car tier skips Ultra cars", async () => {
  const client = clientForGemini();
  client.fetchCars = async () => [
    car({ id: "ultra-car", label: "Ultra", isIQ: true, isUltra: true }),
    car({ id: "pro-car", label: "PRO", isIQ: true, isPro: true })
  ];

  const selected = await client.selectCar({
    key: "gemini",
    name: "Gemini",
    carType: "gemini",
    strategy: "thinking",
    carTier: "auto"
  });

  assert.equal(selected.carId, "pro-car");
  assert.equal(selected.carTier, "pro");
});

test("chatplus image routing downranks a car after repeated slow results", async () => {
  const client = clientForGpt({ accountId: "account-slow-image-car" });
  client.fetchCars = async () => [
    car({ id: "slow-image-car", imageRemaining: 10 }),
    car({ id: "fast-image-car", imageRemaining: 10 })
  ];

  client.rememberImageSlowCar({ carId: "slow-image-car", carType: "chatgpt" }, 61 * 1000);
  client.rememberImageSlowCar({ carId: "slow-image-car", carType: "chatgpt" }, 62 * 1000);

  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "image",
    carTier: "auto"
  });

  assert.equal(selected.carId, "fast-image-car");
});

test("chatplus plus car tier only selects PLUS cars", async () => {
  const client = clientForGemini({ strategy: "speed", carTier: "plus" });
  client.loginPortal = async () => {};
  client.json = async () => ({
    code: 1,
    data: {
      list: [
        { carID: "ultra-car", label: "Ultra", isUltra: true },
        { carID: "pro-car", label: "PRO", isPro: true },
        { carID: "plus-car", label: "PLUS" },
        { carID: "regular-car", label: "Free" }
      ]
    }
  });

  const selected = await client.selectCar({
    key: "gemini",
    name: "Gemini",
    carType: "gemini",
    strategy: "speed",
    carTier: "plus"
  });

  assert.equal(selected.carId, "plus-car");
  assert.equal(selected.carTier, "plus");
});

test("chatplus retries another car when upstream rejects an Ultra-only car", async () => {
  const client = clientForGemini({ strategy: "speed", carTier: "any" });
  const entered = [];
  client.fetchCars = async () => [
    car({ id: "ultra-car", label: "Ultra", isUltra: true, count: 0 }),
    car({ id: "pro-car", label: "PRO", isPro: true, count: 10 })
  ];
  client.enterCar = async (carId) => {
    entered.push(carId);
    if (carId === "ultra-car") {
      throw new Error("您不是Ultra用户，请升级后使用该车。");
    }
    client.portalLoggedIn = true;
  };

  const session = await client.prepareChatSession({}, new Set(), 2);

  assert.deepEqual(entered, ["ultra-car", "pro-car"]);
  assert.equal(session.selected.carId, "pro-car");
});

test("GPT 自动换车改用网页的一键换车", async () => {
  const client = clientForGpt({ accountId: "account-idle-car-switch" });
  const entered = [];
  let idleSwitches = 0;
  let submissions = 0;

  client.fetchCars = async () => [car({ id: "first-car", imageRemaining: 10 })];
  client.enterCar = async (carId, carType) => {
    entered.push({ carId, carType });
    client.carId = carId;
    client.carType = carType;
    client.portalLoggedIn = true;
  };
  client.performIdleChatCarSwitch = async () => {
    idleSwitches += 1;
    client.carId = "idle-car";
    client.carType = "chatgpt";
    return {
      carId: "idle-car",
      carType: "chatgpt",
      car: car({ id: "idle-car", imageRemaining: 10 }),
      candidateCount: 1,
      strategy: "idle_server",
      carTier: "auto"
    };
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.buildConversationBody = () => ({ body: {}, messageId: "idle-switch-message" });
  client.runConversationSubmit = async (_selected, work) => work();
  client.http = async (pathName) => {
    assert.equal(pathName, "/backend-api/conversation");
    submissions += 1;
    if (submissions === 1) return { status: 502, headers: {}, body: "first car unavailable" };
    return {
      status: 200,
      headers: {},
      body: 'data: {"conversation_id":"conversation-after-idle-switch"}\n\ndata: [DONE]\n\n'
    };
  };

  const result = await client.sendConversation("自动换车", {}, new Set());

  assert.deepEqual(entered, [{ carId: "first-car", carType: "chatgpt" }]);
  assert.equal(idleSwitches, 1);
  assert.equal(submissions, 2);
  assert.equal(result.selected.carId, "idle-car");
});

test("GPT 聊天生图确认车位失效后改用网页的一键换车", async () => {
  const client = clientForGpt({ accountId: "account-image-idle-car-switch" });
  client.createSubmitClient = () => client;
  const entered = [];
  let carListReads = 0;
  let idleSwitches = 0;
  let submissions = 0;

  client.fetchCars = async () => {
    carListReads += 1;
    return [car({ id: "first-image-car", imageRemaining: 10 })];
  };
  client.enterCar = async (carId, carType) => {
    entered.push({ carId, carType });
    client.carId = carId;
    client.carType = carType;
    client.portalLoggedIn = true;
  };
  client.performIdleChatCarSwitch = async () => {
    idleSwitches += 1;
    client.carId = "idle-image-car";
    client.carType = "chatgpt";
    return {
      carId: "idle-image-car",
      carType: "chatgpt",
      car: car({ id: "idle-image-car", imageRemaining: 10 }),
      candidateCount: 1,
      strategy: "idle_server",
      carTier: "auto"
    };
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.captureImageTaskRegistration = async () => null;
  client.buildConversationBody = () => ({ body: {}, messageId: "image-idle-switch-message" });
  client.runConversationSubmit = async (_selected, work) => work();
  client.http = async (pathName) => {
    assert.equal(pathName, "/backend-api/conversation");
    submissions += 1;
    if (submissions === 1) {
      return {
        status: 404,
        headers: {},
        body: JSON.stringify({ detail: { message: "聊天记录已删除，请点击【换车继续聊】" } })
      };
    }
    return {
      status: 200,
      headers: {},
      body: 'data: {"conversation_id":"conversation-after-image-idle-switch"}\n\ndata: [DONE]\n\n'
    };
  };

  const result = await client.createImageTask({
    prompt: "确认失效后换车",
    files: [{ filename: "source.png" }],
    concurrentSubmit: true,
    waitForImages: false
  });

  assert.deepEqual(entered, [{ carId: "first-image-car", carType: "chatgpt" }]);
  assert.equal(carListReads, 1);
  assert.equal(idleSwitches, 1);
  assert.equal(submissions, 2);
  assert.equal(result.raw.selectedCarId, "idle-image-car");
});

test("chatplus switches ordinary accounts from PRO cars to a regular car", async () => {
  const client = clientForGemini({ strategy: "speed", carTier: "auto" });
  const entered = [];
  client.fetchCars = async () => [
    car({ id: "pro-car-a", label: "PRO-3", isPro: true, count: 0 }),
    car({ id: "pro-car-b", label: "PRO-5", isPro: true, count: 1 }),
    car({ id: "regular-car", label: "PLUS", isPro: false, count: 50 })
  ];
  client.enterCar = async (carId) => {
    entered.push(carId);
    if (carId.startsWith("pro-car")) {
      throw new Error("您不是Pro用户，请升级后使用该车。");
    }
    client.portalLoggedIn = true;
  };

  const firstSession = await client.prepareChatSession({}, new Set(), 2);
  assert.deepEqual(entered, ["pro-car-a", "regular-car"]);
  assert.equal(firstSession.selected.carId, "regular-car");

  entered.length = 0;
  const nextSession = await client.prepareChatSession({}, new Set(), 1);
  assert.deepEqual(entered, ["regular-car"]);
  assert.equal(nextSession.selected.carId, "regular-car");
});

test("Plus image limit uses one-click car switching without saving a permanent PRO restriction", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      response.write("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the Plus plan limit for image generation requests.\"]}}}\n\n");
      const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 50);
      request.on("close", () => clearTimeout(timer));
      return;
    }
    response.end("data: {\"conversation_id\":\"conversation-regular\"}\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const selectedCars = [];
  let restrictionSaved = 0;
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-plus-stream",
    username: "plus@example.test",
    onProCarsUnavailable: async () => {
      restrictionSaved += 1;
    }
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "plus-limit-car", label: "PLUS", imageRemaining: 100 }),
    car({ id: "pro-car", label: "PRO", isPro: true, imageRemaining: 90 }),
    car({ id: "regular-car", label: "PLUS", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    selectedCars.push(carId);
  };
  client.performIdleChatCarSwitch = async () => {
    selectedCars.push("idle-limit-car");
    return {
      carId: "idle-limit-car",
      carType: "chatgpt",
      car: car({ id: "idle-limit-car", imageRemaining: 1 }),
      candidateCount: 1,
      strategy: "idle_server",
      carTier: "auto"
    };
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    const result = await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });

    assert.equal(result.conversationId, "conversation-regular");
    assert.deepEqual(selectedCars, ["plus-limit-car", "idle-limit-car"]);
    assert.equal(requestCount, 2);
    assert.equal(restrictionSaved, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("conversation id received before an image limit is kept as a confirmed submission", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"conversation_id\":\"conversation-before-limit\"}\n\n");
    setTimeout(() => response.end("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the Free plan limit for image generations requests.\"]}}}\n\ndata: [DONE]\n\n"), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-conversation-before-limit"
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [car({ id: "limit-after-submit-car", imageRemaining: 10 })];
  client.enterCar = async () => {};
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    const result = await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });
    assert.equal(result.conversationId, "conversation-before-limit");
    assert.equal(result.submissionConfirmed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("image limit arriving before conversation id does not abort the submission", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the Free plan limit for image generations requests.\"]}}}\n\n");
    setTimeout(() => response.end("data: {\"conversation_id\":\"conversation-after-limit\"}\n\ndata: [DONE]\n\n"), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-conversation-after-limit"
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [car({ id: "limit-before-submit-car", imageRemaining: 10 })];
  client.enterCar = async () => {};
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    const result = await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });
    assert.equal(result.conversationId, "conversation-after-limit");
    assert.equal(result.submissionConfirmed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("conversation id received only from realtime updates is claimed by its message id", async () => {
  const client = clientForGpt({ accountId: "account-realtime-conversation-id" });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [car({ id: "realtime-conversation-car", imageRemaining: 10 })];
  client.enterCar = async () => {};
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.ensureConversationUpdates = async () => ({});
  client.buildConversationBody = () => ({
    messageId: "request-message-for-realtime-conversation",
    body: { action: "next" }
  });
  client.http = async () => {
    setTimeout(() => recordChatplusConversationUpdate({
      conversation_id: "conversation-from-realtime-only",
      update_type: "add-messages",
      update_content: {
        messages: [{
          id: "tool-message",
          metadata: { parent_id: "request-message-for-realtime-conversation" }
        }]
      }
    }), 20);
    return {
      status: 200,
      headers: {},
      body: "data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the image generation limit. You can create more images after 2026-09-03 21:55:57.\"]}}}\n\ndata: [DONE]\n\n"
    };
  };

  const result = await client.sendConversation("生成图片", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(result.conversationId, "conversation-from-realtime-only");
  assert.equal(result.submissionConfirmed, true);
});

test("Free image limit without a conversation id switches cars and pauses the car for 24 hours", async () => {
  const cooldowns = [];
  const enteredCars = [];
  let idleSwitches = 0;
  let requestCount = 0;
  const client = clientForGpt({
    accountId: "account-free-image-limit",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "free-limit-car", imageRemaining: 100 }),
    car({ id: "free-limit-fallback", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    enteredCars.push(carId);
  };
  client.performIdleChatCarSwitch = async () => {
    idleSwitches += 1;
    return {
      carId: "free-limit-fallback",
      carType: "chatgpt",
      car: car({ id: "free-limit-fallback", imageRemaining: 1 }),
      candidateCount: 1,
      strategy: "idle_server",
      carTier: "auto"
    };
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.http = async () => {
    requestCount += 1;
    return {
      status: 200,
      headers: {},
      body: requestCount === 1
        ? "data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the Free plan limit for image generations requests. You can create more images when the limit resets in 17 hours and 34 minutes.\"]}}}\n\ndata: [DONE]\n\n"
        : "data: {\"conversation_id\":\"conversation-free-fallback\"}\n\ndata: [DONE]\n\n"
    };
  };

  const startedAt = Date.now();
  const result = await client.sendConversation("生成图片", {
    imageGeneration: true,
    requireConversationId: true
  });

  assert.equal(result.conversationId, "conversation-free-fallback");
  assert.deepEqual(enteredCars, ["free-limit-car"]);
  assert.equal(idleSwitches, 1);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].carId, "free-limit-car");
  const expectedDelay = 24 * 60 * 60 * 1000;
  const actualDelay = Date.parse(cooldowns[0].cooldownUntil) - startedAt;
  assert.ok(Math.abs(actualDelay - expectedDelay) < 7000);
});

test("an image limit discovered after submission keeps waiting on the same car", async () => {
  const enteredCars = [];
  let requestCount = 0;
  const client = clientForGpt({ accountId: "account-late-image-limit" });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "late-limit-car", imageRemaining: 100 }),
    car({ id: "late-limit-fallback", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    enteredCars.push(carId);
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.createSubmitClient = () => client;
  client.http = async () => {
    requestCount += 1;
    return {
      status: 200,
      headers: {},
      body: requestCount === 1
        ? "data: {\"conversation_id\":\"conversation-late-limit\"}\n\ndata: [DONE]\n\n"
        : "data: {\"conversation_id\":\"conversation-late-fallback\"}\n\ndata: [DONE]\n\n"
    };
  };
  client.conversationDetail = async () => ({
    messages: [
      {
        author: { role: "assistant" },
        content: {
          parts: [JSON.stringify({
            prompt: "一段比额度提示更长的图片参数内容，用来模拟上游先返回绘图参数、稍后再返回额度不足的真实情况。".repeat(4),
            size: "1024x1365",
            n: 1,
            referenced_image_ids: ["file_test"]
          })]
        }
      },
      {
        author: { role: "assistant" },
        content: {
          parts: ["You've hit the Free plan limit for image generations requests. You can create more images when the limit resets in 2 hours and 15 minutes."]
        }
      }
    ]
  });
  const resultUrl = "https://example.test/generated-after-late-limit.png";
  client.imageUrlsFrom = async (value) => (
    JSON.stringify(value).includes(resultUrl)
      ? [resultUrl]
      : []
  );
  setTimeout(() => recordChatplusConversationUpdate({
    conversation_id: "conversation-late-limit",
    update_type: "add-messages",
    update_content: {
      messages: [{
        author: { role: "tool" },
        content: { parts: [{ type: "image_url", image_url: resultUrl }] },
        status: "finished_successfully"
      }]
    }
  }), 20);

  const result = await client.createTextTask({
    prompt: "等待后换车",
    waitForImages: true
  });

  assert.deepEqual(enteredCars, ["late-limit-car"]);
  assert.deepEqual(result.imageUrls, [resultUrl]);
});

test("a temporary image restriction with a recovery time freezes the car and switches cars", async () => {
  const cooldowns = [];
  const enteredCars = [];
  let requestCount = 0;
  const client = clientForGpt({
    accountId: "account-temporary-image-restriction",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "temporarily-restricted-car", imageRemaining: 100 }),
    car({ id: "temporary-restriction-fallback", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    enteredCars.push(carId);
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.createSubmitClient = () => client;
  client.http = async () => {
    requestCount += 1;
    return {
      status: 200,
      headers: {},
      body: requestCount === 1
        ? ["data: {\"conversation_id\":\"conversation-temporary-restriction\"}", "", "data: [DONE]", ""].join("\n")
        : ["data: {\"conversation_id\":\"conversation-temporary-fallback\"}", "", "data: [DONE]", ""].join("\n")
    };
  };
  const resultUrl = "https://example.test/generated-after-temporary-restriction.png";
  client.conversationDetail = async (conversationId) => ({
    messages: [{
      author: { role: "assistant" },
      content: {
        parts: [conversationId === "conversation-temporary-restriction"
          ? "功能将受限至 15:57。回答质量可能会降低。"
          : resultUrl]
      }
    }]
  });
  client.imageUrlsFrom = async (value) => (
    JSON.stringify(value).includes(resultUrl) ? [resultUrl] : []
  );

  const result = await client.createTextTask({
    prompt: "临时受限后换车",
    waitForImages: true
  });

  assert.deepEqual(enteredCars, ["temporarily-restricted-car", "temporary-restriction-fallback"]);
  assert.deepEqual(result.imageUrls, [resultUrl]);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].carId, "temporarily-restricted-car");
  assert.equal(cooldowns[0].reason, "image_temporary_restriction");
  assert.equal(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(cooldowns[0].cooldownUntil)), "15:57");
});

test("a content policy refusal does not freeze a car or switch cars", async () => {
  const cooldowns = [];
  const enteredCars = [];
  const client = clientForGpt({
    accountId: "account-policy-no-car-switch",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "policy-refusal-car", imageRemaining: 100 }),
    car({ id: "policy-refusal-fallback", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    enteredCars.push(carId);
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];
  client.createSubmitClient = () => client;
  client.http = async () => ({
    status: 200,
    headers: {},
    body: ["data: {\"conversation_id\":\"conversation-policy-refusal\"}", "", "data: [DONE]", ""].join("\n")
  });
  client.conversationDetail = async () => ({
    messages: [{
      author: { role: "assistant" },
      content: { parts: ["We're sorry, but this image request may violate our content policies."] }
    }]
  });
  client.imageUrlsFrom = async () => [];

  await assert.rejects(
    () => client.createTextTask({ prompt: "内容安全失败不换车", waitForImages: true }),
    /content policies/i
  );

  assert.deepEqual(enteredCars, ["policy-refusal-car"]);
  assert.deepEqual(cooldowns, []);
});

test("saved image car cooldowns are restored after a client restart", async () => {
  const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const client = clientForGpt({
    accountId: "account-restored-image-cooldown",
    account: {
      meta: {
        abilities: {
          chatplus: {
            meta: {
              imageCarCooldowns: {
                "chatgpt:persisted-limit-car": {
                  carId: "persisted-limit-car",
                  carType: "chatgpt",
                  cooldownUntil
                }
              }
            }
          }
        }
      }
    }
  });
  client.fetchCars = async () => [
    car({ id: "persisted-limit-car", imageRemaining: 100 }),
    car({ id: "restored-fallback-car", imageRemaining: 1 })
  ];

  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "image",
    carTier: "auto"
  });

  assert.equal(selected.carId, "restored-fallback-car");
});

test("repeated car authentication failures use 1h, 6h, then 24h cooldowns and reset after success", async () => {
  const cooldowns = [];
  const selected = { carId: "auth-backoff-car", carType: "chatgpt" };
  const client = clientForGpt({
    accountId: "account-auth-backoff",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  const authError = new Error("用户认证失败，请重新登录");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = Date.now();
    await client.rememberAuthFailedCar(selected, authError);
    const durationMs = Date.parse(cooldowns.at(-1).cooldownUntil) - startedAt;
    const expectedMs = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000][attempt];
    assert.ok(durationMs >= expectedMs - 1000 && durationMs <= expectedMs + 1000);
    assert.equal(cooldowns.at(-1).failureCount, attempt + 1);
  }

  await client.rememberImageSuccessfulCar(selected);
  await client.rememberAuthFailedCar(selected, authError);
  assert.equal(cooldowns.at(-1).failureCount, 1);
});

test("saved authentication failure count continues its backoff after restart", async () => {
  const cooldowns = [];
  const carId = "persisted-auth-backoff-car";
  const client = clientForGpt({
    accountId: "account-restored-auth-backoff",
    account: {
      meta: {
        abilities: {
          chatplus: {
            meta: {
              imageCarCooldowns: {
                [`chatgpt:${carId}`]: {
                  carId,
                  carType: "chatgpt",
                  cooldownUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                  failureCount: 2
                }
              }
            }
          }
        }
      }
    },
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });

  const startedAt = Date.now();
  await client.rememberAuthFailedCar(
    { carId, carType: "chatgpt" },
    new Error("用户认证失败，请重新登录")
  );

  assert.equal(cooldowns[0].failureCount, 3);
  const durationMs = Date.parse(cooldowns[0].cooldownUntil) - startedAt;
  assert.ok(durationMs >= 24 * 60 * 60 * 1000 - 1000);
});

test("legacy permanent PRO restriction is retried after the update", async () => {
  const client = new ChatplusClient({
    config: { waitTimeoutSec: 300 },
    channel: { id: "shareai:chatplus", ability: "chatplus", settings: {} },
    account: {
      id: "account-saved-plus",
      username: "saved-plus@example.test",
      password: "test",
      meta: {
        abilities: {
          chatplus: {
            meta: {
              proCarsUnavailable: true,
              proCarsUnavailableReason: "plan_mismatch"
            }
          }
        }
      }
    },
    sessionLock: async (work) => work()
  });
  client.fetchCars = async () => [
    car({ id: "pro-car", label: "PRO", isPro: true, count: 0 }),
    car({ id: "regular-car", label: "PLUS", count: 20 })
  ];

  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "speed",
    carTier: "auto"
  });

  assert.equal(selected.carId, "pro-car");
});

test("active PRO restriction still uses a regular car for normal tasks", async () => {
  const client = clientForGpt({
    accountId: "account-active-plus-restriction",
    account: {
      meta: {
        abilities: {
          chatplus: {
            meta: {
              proCarsUnavailable: true,
              proCarsUnavailableReason: "plan_mismatch",
              proCarsUnavailableUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
          }
        }
      }
    }
  });
  client.fetchCars = async () => [
    car({ id: "pro-car", label: "PRO", isPro: true, count: 0 }),
    car({ id: "regular-car", label: "PLUS", count: 20 })
  ];

  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "speed",
    carTier: "auto"
  });

  assert.equal(selected.carId, "regular-car");
});

test("manual account check retries PRO immediately and clears the old restriction after success", async () => {
  let cleared = 0;
  const entered = [];
  const client = clientForGpt({
    accountId: "account-upgraded-to-pro",
    account: {
      meta: {
        abilities: {
          chatplus: {
            meta: {
              proCarsUnavailable: true,
              proCarsUnavailableReason: "plan_mismatch",
              proCarsUnavailableUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
          }
        }
      }
    },
    onProCarsAvailable: async () => {
      cleared += 1;
    }
  });
  client.loadAccountUsages = async () => ({
    gpt: { quota: 220, balance: 195, expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
  });
  client.fetchCars = async () => [
    car({ id: "pro-car", label: "PRO", isPro: true, count: 0 }),
    car({ id: "regular-car", label: "PLUS", count: 20 })
  ];
  client.enterCar = async (carId) => {
    entered.push(carId);
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-test" });

  const status = await client.check();

  assert.equal(status.status, "ok");
  assert.deepEqual(entered, ["pro-car"]);
  assert.equal(cleared, 1);
  assert.equal(client.proCarsUnavailableUntil, 0);
});

test("manual account check falls back to a regular car after a fresh PRO rejection", async () => {
  let restricted = 0;
  const entered = [];
  const client = clientForGpt({
    accountId: "account-new-plus-mismatch",
    onProCarsUnavailable: async () => {
      restricted += 1;
    }
  });
  client.loadAccountUsages = async () => ({
    gpt: { quota: 220, balance: 195, expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
  });
  client.fetchCars = async () => [
    car({ id: "pro-car", label: "PRO", isPro: true, count: 0 }),
    car({ id: "regular-car", label: "PLUS", count: 20 })
  ];
  client.enterCar = async (carId) => {
    entered.push(carId);
    if (carId === "pro-car") throw new Error("您不是Pro用户，请升级后使用该车。");
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-test" });

  const status = await client.check();

  assert.equal(status.status, "ok");
  assert.deepEqual(entered, ["pro-car", "regular-car"]);
  assert.equal(restricted, 1);
  assert.equal(status.meta.proCarRestriction.active, true);
});

test("legacy image-limit restriction is rechecked instead of permanently skipping PRO cars", async () => {
  const client = clientForGpt({
    accountId: "account-legacy-image-limit",
    account: {
      meta: {
        abilities: {
          chatplus: {
            meta: { proCarsUnavailable: true }
          }
        }
      }
    }
  });
  client.fetchCars = async () => [
    car({ id: "pro-car", label: "PRO", isPro: true, imageRemaining: 10 }),
    car({ id: "regular-car", label: "PLUS", imageRemaining: 1 })
  ];

  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "image",
    carTier: "auto"
  });

  assert.equal(selected.carId, "pro-car");
});

test("a car without a conversation id stays paused even after a shorter upstream recovery hint", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      response.end("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"Image generation quota reached. The limit resets in 0.003 minutes.\"]}}}\n\ndata: [DONE]\n\n");
      return;
    }
    response.end(`data: {"conversation_id":"conversation-${requestCount}"}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const selectedCars = [];
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-quota-recovery"
  });
  client.portalLoggedIn = true;
  client.fetchCars = async () => [
    car({ id: "recovering-car", imageRemaining: 100 }),
    car({ id: "fallback-car", imageRemaining: 1 })
  ];
  client.enterCar = async (carId) => {
    selectedCars.push(carId);
  };
  client.performIdleChatCarSwitch = async () => {
    selectedCars.push("fallback-car");
    return {
      carId: "fallback-car",
      carType: "chatgpt",
      car: car({ id: "fallback-car", imageRemaining: 1 }),
      candidateCount: 1,
      strategy: "idle_server",
      carTier: "auto"
    };
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    const firstTask = await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });
    const completedUrl = "https://example.test/fallback-completed.png";
    client.imageGenerationTaskState = async () => null;
    client.loginPortal = async () => {};
    client.conversationDetail = async (conversationId) => ({
      conversation_id: conversationId,
      current_node: "completed-image",
      mapping: {
        "completed-image": {
          message: {
            author: { role: "tool" },
            content: { parts: [{ type: "image_url", image_url: completedUrl }] }
          }
        }
      }
    });
    client.refreshCompletedConversation = async (_conversationId, detail) => detail;
    const completed = await client.getTask(firstTask.conversationId, { imageTask: true });
    assert.equal(completed.status, "success");
    await new Promise((resolve) => setTimeout(resolve, 240));
    await client.sendConversation("再次生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });

    assert.deepEqual(selectedCars, ["recovering-car", "fallback-car", "fallback-car"]);
    assert.equal(requestCount, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a healthy reusable image car is kept for the next task", async () => {
  const client = clientForGpt({ accountId: "account-reuse-car" });
  let carListReads = 0;
  let enters = 0;
  client.fetchCars = async () => {
    carListReads += 1;
    return [
      car({ id: "healthy-car", imageRemaining: 10 }),
      car({ id: "other-car", imageRemaining: 9 })
    ];
  };
  client.enterCar = async () => {
    enters += 1;
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });

  const first = await client.prepareReusableChatSession({ preferImageCar: true }, new Set(), 1);
  const second = await client.prepareReusableChatSession({ preferImageCar: true }, new Set(), 1);

  assert.equal(first.selected.carId, "healthy-car");
  assert.equal(second.selected.carId, "healthy-car");
  assert.equal(carListReads, 1);
  assert.equal(enters, 1);
});

test("a car that recently produced an image is preferred when switching", async () => {
  const client = clientForGpt({ accountId: "account-recent-image-success" });
  client.portalLoggedIn = true;
  client.performEnterCar = async () => {};
  client.createSubmitClient = () => client;
  client.conversationDetail = async () => ({ id: "finished-image" });
  client.imageUrlsFrom = async () => ["https://example.test/generated.png"];
  client.fetchCars = async () => [
    car({ id: "lower-queue-car", count: 0, imageRemaining: 10 }),
    car({ id: "recent-success-car", count: 30, imageRemaining: 10 })
  ];

  await client.getTask("finished-image", {
    carId: "recent-success-car",
    carType: "chatgpt"
  });
  const selected = await client.selectCar({
    key: "gpt",
    name: "GPT",
    carType: "chatgpt",
    strategy: "image",
    carTier: "auto"
  });

  assert.equal(selected.carId, "recent-success-car");
});

test("image tasks record each processing stage and car attempt", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {\"conversation_id\":\"conversation-timing\"}\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-stage-timing"
  });
  const reported = [];
  client.portalLoggedIn = true;
  client.fetchCars = async () => [car({ id: "timed-car", imageRemaining: 10 })];
  client.enterCar = async () => {};
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    const result = await client.createImageTask({
      prompt: "记录耗时",
      files: [{ filename: "source.png" }],
      waitForImages: false,
      onStage: async (stage) => reported.push(stage)
    });

    const keys = result.raw.stageTimings.map((stage) => stage.key);
    assert.deepEqual(keys, ["car_enter", "car_init", "car_submit_queue", "source_upload", "upstream_generation"]);
    assert.deepEqual(reported.map((stage) => stage.id), result.raw.stageTimings.map((stage) => stage.id));
    assert.equal(result.raw.stageTimings[0].carId, "timed-car");
    assert.equal(result.status, "waiting_upstream");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("聊天生图成功或遇到 IP 限制后都继续复用原车位", async () => {
  let conversationIndex = 0;
  const server = createServer((_request, response) => {
    conversationIndex += 1;
    if (conversationIndex === 2) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { message: "您的账号在其他设备登录，请重新登录" } }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": "session=fresh; Path=/"
    });
    response.end(`data: {"conversation_id":"conversation-fresh-session-${conversationIndex}"}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-fresh-session"
  });
  client.createSubmitClient = () => client;
  let carListReads = 0;
  let carEntries = 0;
  client.fetchCars = async () => {
    carListReads += 1;
    return [car({ id: "fresh-session-car", imageRemaining: 10 })];
  };
  client.enterCar = async (carId, carType) => {
    carEntries += 1;
    client.portalLoggedIn = true;
    client.carId = carId;
    client.carType = carType;
    client.cookies = ["session=initial"];
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.captureImageTaskRegistration = async () => null;
  client.waitForConversationImages = async (_events, conversationId) => [
    `https://example.test/${conversationId}.png`
  ];

  try {
    const first = await client.createTextTask({
      prompt: "第一次生图",
      concurrentSubmit: true,
      waitForImages: true
    });
    await assert.rejects(
      client.createTextTask({
        prompt: "IP 限制时不换车",
        concurrentSubmit: true,
        waitForImages: true
      }),
      (error) => error.code === "CHAT_IMAGE_IP_RESTRICTED"
    );
    const third = await client.createTextTask({
      prompt: "第三次继续复用",
      concurrentSubmit: true,
      waitForImages: true
    });

    assert.equal(first.raw.selectedCarId, "fresh-session-car");
    assert.equal(third.raw.selectedCarId, "fresh-session-car");
    assert.equal(carListReads, 1);
    assert.equal(carEntries, 1);
    assert.ok(third.raw.stageTimings.some((stage) => stage.key === "session_reuse"));
    assert.equal(third.raw.stageTimings.some((stage) => stage.key === "car_enter"), false);
    assert.equal(client.cookies.includes("session=fresh"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("concurrent GPT tasks stagger their starts but overlap on the same car", async () => {
  const client = clientForGpt({ accountId: "account-staggered-submit" });
  const selected = { carId: "shared-submit-car", carType: "chatgpt" };
  const startedAt = [];
  let active = 0;
  let maxActive = 0;
  let releaseActive;
  let reportAllStarted;
  const holdActive = new Promise((resolve) => { releaseActive = resolve; });
  const allStarted = new Promise((resolve) => { reportAllStarted = resolve; });

  const submissions = [1, 2, 3].map(() => client.runConversationSubmit(selected, async () => {
    startedAt.push(Date.now());
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 3) reportAllStarted();
    await holdActive;
    active -= 1;
  }));

  const overlapped = await Promise.race([
    allStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5500))
  ]);
  releaseActive();
  await Promise.all(submissions);

  assert.equal(overlapped, true);
  assert.equal(maxActive, 3);
  assert.ok(startedAt[1] - startedAt[0] >= 1900);
  assert.ok(startedAt[2] - startedAt[1] >= 1900);
});

test("同一 GPT 账号首单等图时不会挡住第二单提交", async () => {
  const client = clientForGpt({ accountId: "account-image-submit-lock" });
  client.createSubmitClient = () => client;
  let sessionIndex = 0;
  let submissionIndex = 0;
  let releaseFirstResult;
  let reportFirstResultWait;
  let reportSecondSubmitted;
  const stages = [];
  const firstResultWait = new Promise((resolve) => { reportFirstResultWait = resolve; });
  const holdFirstResult = new Promise((resolve) => { releaseFirstResult = resolve; });
  const secondSubmitted = new Promise((resolve) => { reportSecondSubmitted = resolve; });

  client.prepareReusableChatSession = async () => {
    const current = ++sessionIndex;
    stages.push(`prepare-${current}`);
    return {
      route: { key: "gpt", model: "gpt-image-test", carType: "chatgpt" },
      init: { default_model_slug: "gpt-image-test" },
      selected: { carId: `submission-lock-car-${current}`, carType: "chatgpt" },
      revision: client.sessionRevision,
      snapshot: client.sessionSnapshot()
    };
  };
  client.uploadChatImages = async () => {
    stages.push(`upload-${sessionIndex}`);
    return [];
  };
  client.buildConversationBody = () => ({ body: {}, messageId: `submission-lock-message-${sessionIndex}` });
  client.http = async (pathName) => {
    assert.equal(pathName, "/backend-api/conversation");
    const current = ++submissionIndex;
    stages.push(`submit-${current}`);
    if (current === 2) reportSecondSubmitted();
    return {
      status: 200,
      headers: {},
      body: `data: {"conversation_id":"submission-lock-conversation-${current}"}\n\ndata: [DONE]\n\n`
    };
  };
  client.waitForConversationImages = async (_events, conversationId) => {
    stages.push(`wait-${conversationId}`);
    if (conversationId.endsWith("-1")) {
      reportFirstResultWait();
      await holdFirstResult;
    }
    return [`https://example.test/${conversationId}.png`];
  };

  const first = client.createImageTask({
    prompt: "第一张图",
    files: [{ filename: "first.png" }],
    concurrentSubmit: true,
    waitForImages: true
  });
  await firstResultWait;

  const second = client.createImageTask({
    prompt: "第二张图",
    files: [{ filename: "second.png" }],
    concurrentSubmit: true,
    waitForImages: true
  });
  const submittedWhileFirstWaits = await Promise.race([
    secondSubmitted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500))
  ]);

  assert.equal(submittedWhileFirstWaits, true);
  assert.deepEqual(stages.slice(0, 6), [
    "prepare-1",
    "upload-1",
    "submit-1",
    "wait-submission-lock-conversation-1",
    "prepare-2",
    "upload-2"
  ]);

  releaseFirstResult();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "success");
  assert.equal(secondResult.status, "success");
});

test("同一账号的并发聊天生图分配不同车位", async () => {
  const selectedCars = [];
  let conversationIndex = 0;
  let carEntries = 0;
  const server = createServer((request, response) => {
    const selectedCar = String(request.headers.cookie || "").match(/car=([^;]+)/)?.[1] || "unknown";
    if (request.method === "POST" && request.url === "/backend-api/conversation") {
      selectedCars.push(selectedCar);
      conversationIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: {"conversation_id":"conversation-${selectedCar}-${conversationIndex}"}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-distinct-active-cars",
    sessionLock: serialSessionLock()
  });
  client.fetchCars = async () => [
    car({ id: "active-car-one", imageRemaining: 10, count: 0 }),
    car({ id: "active-car-two", imageRemaining: 10, count: 1 })
  ];
  client.enterCar = async (carId, carType) => {
    carEntries += 1;
    client.portalLoggedIn = true;
    client.carId = carId;
    client.carType = carType;
    client.cookies = [`car=${carId}`];
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.captureImageTaskRegistration = async () => null;

  try {
    const results = await Promise.all([
      client.createTextTask({
        prompt: "first active image",
        concurrentSubmit: true,
        waitForImages: false
      }),
      client.createTextTask({
        prompt: "second active image",
        concurrentSubmit: true,
        waitForImages: false
      })
    ]);

    assert.deepEqual(selectedCars, ["active-car-one", "active-car-two"]);
    assert.deepEqual(results.map((result) => result.raw.selectedCarId), ["active-car-one", "active-car-two"]);
    assert.equal(carEntries, 2);

    await assert.rejects(
      client.createTextTask({
        prompt: "no third active image car",
        concurrentSubmit: true,
        waitForImages: false
      }),
      /当前可用生图车位都在处理任务/
    );
    assert.equal(carEntries, 2);

    const firstResult = results.find((result) => result.raw.selectedCarId === "active-car-one");
    const completedUrl = "https://example.test/completed-active-car-one.png";
    client.imageGenerationTaskState = async () => null;
    client.conversationDetail = async (conversationId) => ({
      conversation_id: conversationId,
      current_node: "completed-image",
      mapping: {
        "completed-image": {
          message: {
            author: { role: "tool" },
            status: "finished_successfully",
            content: {
              content_type: "multimodal_text",
              parts: [{ type: "image_url", image_url: completedUrl }]
            }
          }
        }
      }
    });
    client.refreshCompletedConversation = async (_conversationId, detail) => detail;
    const completed = await client.getTask(firstResult.externalId, { imageTask: true });
    assert.equal(completed.status, "success");

    const thirdResult = await client.createTextTask({
      prompt: "reuse the completed car",
      concurrentSubmit: true,
      waitForImages: false
    });
    assert.equal(thirdResult.raw.selectedCarId, "active-car-one");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("聊天生图遇到伪登录冲突时保留车位并立即失败", async (t) => {
  for (const upstreamMessage of [
    "您的账号在其他设备登录，请重新登录",
    "认证失败，请重新登陆"
  ]) {
    await t.test(upstreamMessage, async () => {
      const client = clientForGpt({ accountId: `account-image-session-conflict-${upstreamMessage.length}` });
      client.createSubmitClient = () => client;
      client.portalLoggedIn = true;
      client.cookies = ["stale=session"];
      let prepareCount = 0;
      const preparedStates = [];
      client.prepareReusableChatSession = async () => {
        prepareCount += 1;
        preparedStates.push({
          portalLoggedIn: client.portalLoggedIn,
          cookies: [...client.cookies]
        });
        client.portalLoggedIn = true;
        client.cookies = [`fresh=session-${prepareCount}`];
        const carId = prepareCount === 1 ? "conflict-car-a" : "healthy-car-b";
        return {
          route: { key: "gpt", model: "gpt-image-test", carType: "chatgpt" },
          init: { default_model_slug: "gpt-image-test" },
          selected: { carId, carType: "chatgpt" },
          revision: client.sessionRevision,
          snapshot: client.sessionSnapshot()
        };
      };
      client.uploadChatImages = async () => [];
      client.buildConversationBody = () => ({ body: {}, messageId: "conflict-message" });
      client.captureImageTaskRegistration = async () => null;
      let submitCount = 0;
      client.http = async () => {
        submitCount += 1;
        if (submitCount === 1) {
          return {
            status: 403,
            headers: {},
            body: upstreamMessage
          };
        }
        return {
          status: 200,
          headers: {},
          body: 'data: {"conversation_id":"conversation-after-session-recovery"}\n\ndata: [DONE]\n\n'
        };
      };

      await assert.rejects(
        client.createImageTask({
          prompt: "登录冲突测试",
          files: [{ filename: "source.png" }],
          concurrentSubmit: true,
          waitForImages: false
        }),
        (error) => {
          assert.equal(error.code, "CHAT_IMAGE_IP_RESTRICTED");
          assert.equal(error.ipRestricted, true);
          assert.equal(error.selectedCarId, "conflict-car-a");
          assert.match(error.message, /保留原车位/);
          return true;
        }
      );

      assert.equal(prepareCount, 1);
      assert.equal(submitCount, 1);
      assert.deepEqual(preparedStates, [{ portalLoggedIn: true, cookies: ["stale=session"] }]);
      assert.equal(client.sessionRevision, 0);
    });
  }
});

test("聊天生图遇到普通 403 时不冻结也不换车", async () => {
  const cooldowns = [];
  const client = clientForGpt({
    accountId: "account-repeated-image-session-conflict",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  client.createSubmitClient = () => client;
  let prepareCount = 0;
  client.prepareReusableChatSession = async () => {
    prepareCount += 1;
    return {
      route: { key: "gpt", model: "gpt-image-test", carType: "chatgpt" },
      init: { default_model_slug: "gpt-image-test" },
      selected: { carId: `conflict-car-${prepareCount}`, carType: "chatgpt" },
      revision: client.sessionRevision,
      snapshot: client.sessionSnapshot()
    };
  };
  client.uploadChatImages = async () => [];
  client.buildConversationBody = () => ({ body: {}, messageId: "conflict-message" });
  client.http = async () => ({
    status: 403,
    headers: {},
    body: "上游拒绝访问"
  });

  await assert.rejects(
    client.createImageTask({
      prompt: "普通 403 测试",
      files: [{ filename: "source.png" }],
      concurrentSubmit: true,
      waitForImages: false
    }),
    (error) => {
      assert.equal(error.code, "CHAT_IMAGE_IP_RESTRICTED");
      assert.equal(error.ipRestricted, true);
      return true;
    }
  );

  assert.equal(prepareCount, 1);
  assert.equal(client.sessionRevision, 0);
  assert.deepEqual(cooldowns, []);
});

test("GPT 聊天生图提示对话过快时保留当前车位并立即失败", async () => {
  const cooldowns = [];
  const requestedCars = [];
  const server = createServer((request, response) => {
    const selectedCar = String(request.headers.cookie || "").match(/car=([^;]+)/)?.[1] || "";
    if (request.method === "POST" && request.url === "/backend-api/conversation") {
      requestedCars.push(selectedCar);
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (selectedCar === "busy-conversation-car") {
      response.end("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"对话过快或您当前有多个任务执行中，请稍后重试\"]}}}\n\ndata: [DONE]\n\n");
      return;
    }
    response.end("data: {\"conversation_id\":\"conversation-after-busy-car\"}\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-conversation-busy",
    onImageCarCooldown: async (cooldown) => cooldowns.push(cooldown)
  });
  client.fetchCars = async () => [
    car({ id: "busy-conversation-car", imageRemaining: 10, count: 0 }),
    car({ id: "healthy-conversation-car", imageRemaining: 9, count: 1 })
  ];
  client.enterCar = async (carId, carType) => {
    client.portalLoggedIn = true;
    client.carId = carId;
    client.carType = carType;
    client.cookies = [`car=${carId}`];
  };
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });

  try {
    await assert.rejects(
      client.createTextTask({
        prompt: "对话过快不换车",
        concurrentSubmit: true,
        waitForImages: false
      }),
      (error) => {
        assert.equal(error.code, "CHAT_IMAGE_IP_RESTRICTED");
        assert.equal(error.ipRestricted, true);
        assert.equal(error.selectedCarId, "busy-conversation-car");
        return true;
      }
    );

    assert.deepEqual(requestedCars, ["busy-conversation-car"]);
    assert.deepEqual(cooldowns, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("all exhausted image cars pause the account until the earliest reset", async () => {
  const client = clientForGpt();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let attemptCount = 0;
  client.sendConversation = async () => {
    attemptCount += 1;
    return {
      selected: { carId: `quota-car-${attemptCount}`, carType: "chatgpt" },
      route: { key: "gpt", model: "gpt-image-test" },
      upstreamModel: "gpt-image-test"
    };
  };
  client.rememberImageFailedCar = async () => {};

  await assert.rejects(
    () => client.withImageQuotaFallback("account quota exhausted", { imageGeneration: true }, async () => {
      const error = new Error("current car image quota exhausted");
      error.imageCarQuotaExhausted = true;
      error.quotaResetAt = resetAt;
      error.upstreamText = "image generation limit";
      error.status = 429;
      throw error;
    }),
    (error) => {
      assert.equal(attemptCount, 5);
      assert.equal(error.imageQuotaExhausted, true);
      assert.equal(error.quotaEmpty, true);
      assert.equal(error.quotaReason, "image_quota");
      assert.equal(error.quotaConfirmedByUpstream, true);
      assert.equal(error.quotaResetAt, resetAt);
      assert.equal(error.cooldownUntil, resetAt);
      assert.equal(error.imageSubmissionAttempted, true);
      assert.equal(error.imageSubmissionConfirmed, false);
      return true;
    }
  );
});

test("an in-flight task keeps its original car when the next task switches cars", async () => {
  const client = clientForGemini();
  client.fetchCars = async () => [
    car({ id: "car-a", count: 0, imageRemaining: 10 }),
    car({ id: "car-b", count: 1, imageRemaining: 9 })
  ];
  client.enterCar = async (carId, carType) => {
    client.portalLoggedIn = true;
    client.carId = carId;
    client.carType = carType;
    client.cookies = [`car=${carId}`];
  };

  const taskASession = await client.prepareReusableChatSession({ preferImageCar: true }, new Set(), 1);
  const taskAClient = client.createSubmitClient(taskASession);
  client.rememberImageFailedCar(taskASession.selected);
  const taskBSession = await client.prepareReusableChatSession({ preferImageCar: true }, new Set(), 1);
  const taskBClient = client.createSubmitClient(taskBSession);

  assert.equal(taskAClient.carId, "car-a");
  assert.deepEqual(taskAClient.cookies, ["car=car-a"]);
  assert.equal(taskBClient.carId, "car-b");
  assert.deepEqual(taskBClient.cookies, ["car=car-b"]);
});
