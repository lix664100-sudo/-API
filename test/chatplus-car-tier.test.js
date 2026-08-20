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
    onProCarsUnavailable: options.onProCarsUnavailable
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
