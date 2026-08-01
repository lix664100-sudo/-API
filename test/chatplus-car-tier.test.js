import test from "node:test";
import assert from "node:assert/strict";

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
    isIQ: false,
    isPro: false,
    isUltra: false,
    isSuper: false,
    isVirtual: false,
    realCarIDs: [],
    ...overrides
  };
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
