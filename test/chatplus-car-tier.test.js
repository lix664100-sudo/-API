import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { ChatplusClient, normalizeImageCarCooldown } = await import("../src/channels/chatplus.js");

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
    sessionLock: async (work) => work(),
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

test("Free image limit without a conversation id switches cars and pauses the car for 24 hours", async () => {
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
  const expectedDelay = 24 * 60 * 60 * 1000;
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

test("GPT conversation busy responses briefly freeze the car and switch without a 24 hour lock", async () => {
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

  const startedAt = Date.now();
  try {
    const result = await client.createTextTask({
      prompt: "对话拥挤后自动换车",
      concurrentSubmit: true,
      waitForImages: false
    });

    assert.equal(result.externalId, "conversation-after-busy-car");
    assert.deepEqual(requestedCars, ["busy-conversation-car", "healthy-conversation-car"]);
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0].reason, "conversation_busy");
    const freezeMs = Date.parse(cooldowns[0].cooldownUntil) - startedAt;
    assert.ok(freezeMs >= 20_000 && freezeMs <= 35_000);
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
