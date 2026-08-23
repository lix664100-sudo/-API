import assert from "node:assert/strict";
import test from "node:test";

import {
  applyQuotaProtectionStates,
  nextQuotaProtectionState,
  normalizeQuotaProtectionSettings,
  quotaProtectionBlocked,
  quotaProtectionNearLimit,
  quotaProtectionRecheckDue,
  quotaProtectionStateFor
} from "../src/quota-protection.js";

const fixedSettings = {
  enabled: true,
  mode: "fixed",
  fixedPercent: 20
};

test("额度保护设置会限制为有效百分比并整理随机范围", () => {
  assert.deepEqual(normalizeQuotaProtectionSettings({
    enabled: true,
    mode: "random",
    randomMinPercent: 20,
    randomMaxPercent: 1
  }), {
    enabled: true,
    mode: "random",
    fixedPercent: 20,
    randomMinPercent: 1,
    randomMaxPercent: 20
  });

  assert.deepEqual(normalizeQuotaProtectionSettings({
    enabled: true,
    mode: "fixed",
    fixedPercent: 200
  }), {
    enabled: true,
    mode: "fixed",
    fixedPercent: 99,
    randomMinPercent: 1,
    randomMaxPercent: 20
  });
});

test("固定保护线在剩余额度恰好达到设置值时暂停", () => {
  const state = nextQuotaProtectionState(fixedSettings, {
    quota: 200,
    balance: 40,
    quotaResetAt: "2026-08-24T00:00:00+08:00"
  }, null, {
    now: Date.parse("2026-08-23T12:00:00+08:00")
  });

  assert.equal(state.thresholdPercent, 20);
  assert.equal(state.remainingPercent, 20);
  assert.equal(state.active, true);
  assert.equal(quotaProtectionBlocked(state, fixedSettings), true);
  assert.equal(quotaProtectionNearLimit(state, fixedSettings), true);
});

test("随机保护线在同一额度周期保持不变，刷新后重新抽取", () => {
  let randomCalls = 0;
  const settings = {
    enabled: true,
    mode: "random",
    randomMinPercent: 1,
    randomMaxPercent: 20
  };
  const first = nextQuotaProtectionState(settings, {
    quota: 100,
    balance: 60,
    quotaResetAt: "2026-08-24T00:00:00+08:00"
  }, null, {
    now: Date.parse("2026-08-23T10:00:00+08:00"),
    random: () => {
      randomCalls += 1;
      return 0.6;
    }
  });
  const sameCycle = nextQuotaProtectionState(settings, {
    quota: 100,
    balance: 30,
    quotaResetAt: "2026-08-24T00:00:00+08:00"
  }, first, {
    now: Date.parse("2026-08-23T11:00:00+08:00"),
    random: () => {
      randomCalls += 1;
      return 0;
    }
  });
  const nextCycle = nextQuotaProtectionState(settings, {
    quota: 100,
    balance: 100,
    quotaResetAt: "2026-08-25T00:00:00+08:00"
  }, sameCycle, {
    now: Date.parse("2026-08-24T00:01:00+08:00"),
    random: () => {
      randomCalls += 1;
      return 0.999999;
    }
  });

  assert.equal(first.thresholdPercent, 13);
  assert.equal(sameCycle.thresholdPercent, 13);
  assert.equal(nextCycle.thresholdPercent, 20);
  assert.equal(nextCycle.active, false);
  assert.equal(randomCalls, 2);
});

test("充值后会解除额度保护并为新周期重新抽取", () => {
  const protectedState = nextQuotaProtectionState({
    enabled: true,
    mode: "random",
    randomMinPercent: 1,
    randomMaxPercent: 20
  }, {
    quota: 100,
    balance: 10
  }, null, { random: () => 0.5, now: 1000 });

  const refilled = nextQuotaProtectionState({
    enabled: true,
    mode: "random",
    randomMinPercent: 1,
    randomMaxPercent: 20
  }, {
    quota: 100,
    balance: 80
  }, protectedState, { random: () => 0, now: 2000 });

  assert.equal(protectedState.active, true);
  assert.equal(refilled.thresholdPercent, 1);
  assert.equal(refilled.active, false);
});

test("额度未知时不会误触发新的暂停，已暂停状态会保持到检测成功", () => {
  const unknown = nextQuotaProtectionState(fixedSettings, {
    quota: null,
    balance: null
  }, null, { now: 1000 });
  assert.equal(unknown.known, false);
  assert.equal(unknown.active, false);

  const active = nextQuotaProtectionState(fixedSettings, {
    quota: 100,
    balance: 10
  }, null, { now: 2000 });
  const temporarilyUnknown = nextQuotaProtectionState(fixedSettings, {
    quota: null,
    balance: null
  }, active, { now: 3000 });
  assert.equal(temporarilyUnknown.known, false);
  assert.equal(temporarilyUnknown.active, true);
});

test("不同模型分别保存保护线和暂停状态", () => {
  const status = applyQuotaProtectionStates({
    status: "ok",
    meta: {
      referenceUsage: {
        gpt: { quota: 440, balance: 40, quotaResetAt: "2026-08-24T00:00:00+08:00" },
        gemini: { quota: 100, balance: 80, quotaResetAt: "2026-08-24T00:00:00+08:00" }
      }
    }
  }, {}, fixedSettings, {
    gpt: { quota: 440, balance: 40, quotaResetAt: "2026-08-24T00:00:00+08:00" },
    gemini: { quota: 100, balance: 80, quotaResetAt: "2026-08-24T00:00:00+08:00" }
  }, {
    now: Date.parse("2026-08-23T12:00:00+08:00")
  });

  assert.equal(quotaProtectionStateFor(status, "gpt").active, true);
  assert.equal(quotaProtectionStateFor(status, "gemini").active, false);
  assert.equal(status.status, "ok");
});

test("暂停账号到复查时间后才允许重新检测", () => {
  const now = Date.parse("2026-08-23T12:00:00+08:00");
  const state = nextQuotaProtectionState(fixedSettings, {
    quota: 100,
    balance: 10,
    quotaResetAt: "2026-08-24T00:00:00+08:00"
  }, null, { now });

  assert.equal(quotaProtectionRecheckDue(state, now + 59 * 60 * 1000), false);
  assert.equal(quotaProtectionRecheckDue(state, now + 60 * 60 * 1000), true);
});
