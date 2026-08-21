import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { ChatplusClient } = await import("../src/channels/chatplus.js");

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
    isUltra: false,
    isSuper: false,
    isVirtual: false,
    realCarIDs: [],
    ...overrides
  };
}

function clientForGpt(options = {}) {
  return new ChatplusClient({
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
    sessionLock: async (work) => work(),
    onProCarsUnavailable: options.onProCarsUnavailable,
    onImageCarCooldown: options.onImageCarCooldown
  });
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

test("Plus image limit switches to the best remaining image car without saving a permanent PRO restriction", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      response.write("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"You've hit the Plus plan limit for image generation requests.\"]}}}\n\n");
      const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 5000);
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
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  const startedAt = Date.now();
  try {
    const result = await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });

    assert.equal(result.conversationId, "conversation-regular");
    assert.deepEqual(selectedCars, ["plus-limit-car", "pro-car"]);
    assert.equal(requestCount, 2);
    assert.equal(restrictionSaved, 0);
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Free image limit switches cars and records the complete upstream recovery time", async () => {
  const cooldowns = [];
  const enteredCars = [];
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
  assert.deepEqual(enteredCars, ["free-limit-car", "free-limit-fallback"]);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].carId, "free-limit-car");
  const expectedDelay = (17 * 60 + 34) * 60 * 1000;
  const actualDelay = Date.parse(cooldowns[0].cooldownUntil) - startedAt;
  assert.ok(Math.abs(actualDelay - expectedDelay) < 2000);
});

test("an image limit discovered while waiting switches the current task to another car", async () => {
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
  client.imageUrlsFrom = async (value) => (
    JSON.stringify(value).includes("conversation-late-fallback")
      ? ["https://example.test/generated-after-late-switch.png"]
      : []
  );

  const result = await client.createTextTask({
    prompt: "等待后换车",
    waitForImages: true
  });

  assert.deepEqual(enteredCars, ["late-limit-car", "late-limit-fallback"]);
  assert.deepEqual(result.imageUrls, ["https://example.test/generated-after-late-switch.png"]);
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

test("saved plan mismatch restriction continues to skip PRO cars", async () => {
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

  assert.equal(selected.carId, "regular-car");
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

test("image car becomes eligible again after the upstream recovery hint", async () => {
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
  client.loadInit = async () => ({ default_model_slug: "gpt-image-test" });
  client.uploadChatImages = async () => [];

  try {
    await client.sendConversation("生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });
    await new Promise((resolve) => setTimeout(resolve, 240));
    await client.sendConversation("再次生成图片", {
      imageGeneration: true,
      requireConversationId: true
    });

    assert.deepEqual(selectedCars, ["recovering-car", "fallback-car", "recovering-car"]);
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
  client.loginPortal = async () => {};
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
    assert.deepEqual(keys, ["car_enter", "car_init", "source_upload", "upstream_generation"]);
    assert.deepEqual(reported.map((stage) => stage.id), result.raw.stageTimings.map((stage) => stage.id));
    assert.equal(result.raw.stageTimings[0].carId, "timed-car");
    assert.equal(result.status, "waiting_upstream");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a successful concurrent submission refreshes the reusable login session", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": "session=fresh; Path=/"
    });
    response.end("data: {\"conversation_id\":\"conversation-fresh-session\"}\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = clientForGpt({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accountId: "account-fresh-session"
  });
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

  try {
    await client.createTextTask({
      prompt: "刷新登录状态",
      concurrentSubmit: true,
      waitForImages: false
    });
    const reused = await client.prepareReusableChatSession({ preferImageCar: true }, new Set(), 1);

    assert.equal(carListReads, 1);
    assert.equal(carEntries, 1);
    assert.equal(reused.snapshot.cookies.includes("session=fresh"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
