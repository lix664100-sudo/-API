const DEFAULT_RECHECK_MS = 60 * 60 * 1000;

function percentage(value, fallback) {
  const number = Math.round(Number(value));
  return Math.min(99, Math.max(1, Number.isFinite(number) ? number : fallback));
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTime(value) {
  const time = Number(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function randomInteger(minimum, maximum, random) {
  const sample = Math.min(0.999999999999, Math.max(0, Number(random()) || 0));
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

export function normalizeQuotaProtectionSettings(value = {}) {
  const first = percentage(value.randomMinPercent, 1);
  const second = percentage(value.randomMaxPercent, 20);
  return {
    enabled: value.enabled === true,
    mode: value.mode === "random" ? "random" : "fixed",
    fixedPercent: percentage(value.fixedPercent, 20),
    randomMinPercent: Math.min(first, second),
    randomMaxPercent: Math.max(first, second)
  };
}

export function quotaProtectionSettingsKey(value = {}) {
  const settings = normalizeQuotaProtectionSettings(value);
  return settings.mode === "random"
    ? `random:${settings.randomMinPercent}:${settings.randomMaxPercent}`
    : `fixed:${settings.fixedPercent}`;
}

function remainingPercent(quota, balance) {
  if (!(quota > 0) || balance === null || balance < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (balance / quota) * 100)) * 10) / 10;
}

function nextCheckTime(resetAt, now, recheckMs) {
  const hourlyCheck = now + recheckMs;
  const resetTime = Date.parse(resetAt || "");
  return isoTime(Number.isFinite(resetTime) && resetTime > now
    ? Math.min(resetTime, hourlyCheck)
    : hourlyCheck);
}

export function nextQuotaProtectionState(value, usage = {}, previousState = null, options = {}) {
  const settings = normalizeQuotaProtectionSettings(value);
  if (!settings.enabled) return null;

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const random = typeof options.random === "function" ? options.random : Math.random;
  const recheckMs = Math.max(60 * 1000, Number(options.recheckMs || DEFAULT_RECHECK_MS));
  const settingsKey = quotaProtectionSettingsKey(settings);
  const previous = previousState && typeof previousState === "object" ? previousState : {};
  const matchingPrevious = previous.settingsKey === settingsKey;
  const quota = finiteNumber(usage.quota);
  const balance = finiteNumber(usage.balance);
  const quotaResetAt = String(usage.quotaResetAt || "").trim();
  const percent = remainingPercent(quota, balance);
  const known = percent !== null;
  const resetChanged = matchingPrevious
    && quotaResetAt
    && previous.quotaResetAt
    && quotaResetAt !== previous.quotaResetAt;
  const refilledAfterPause = matchingPrevious
    && previous.active === true
    && balance !== null
    && finiteNumber(previous.balance) !== null
    && balance > Number(previous.balance);
  const planChanged = matchingPrevious
    && quota !== null
    && finiteNumber(previous.quota) !== null
    && quota !== Number(previous.quota)
    && balance !== null
    && finiteNumber(previous.balance) !== null
    && balance > Number(previous.balance);
  const newCycle = !matchingPrevious || resetChanged || refilledAfterPause || planChanged;
  const thresholdPercent = settings.mode === "fixed"
    ? settings.fixedPercent
    : newCycle
      ? randomInteger(settings.randomMinPercent, settings.randomMaxPercent, random)
      : percentage(previous.thresholdPercent, settings.randomMinPercent);
  const active = known ? percent <= thresholdPercent : matchingPrevious && previous.active === true;
  const activatedAt = active
    ? previous.active === true && matchingPrevious && previous.activatedAt
      ? previous.activatedAt
      : isoTime(now)
    : "";

  return {
    settingsKey,
    mode: settings.mode,
    thresholdPercent,
    known,
    active,
    quota,
    balance,
    remainingPercent: percent,
    quotaResetAt,
    observedAt: isoTime(now),
    activatedAt,
    nextCheckAt: active ? nextCheckTime(quotaResetAt, now, recheckMs) : ""
  };
}

export function applyQuotaProtectionStates(status = {}, previousStatus = {}, value = {}, usages = {}, options = {}) {
  const settings = normalizeQuotaProtectionSettings(value);
  const meta = { ...(status.meta || {}) };
  if (!settings.enabled) {
    delete meta.quotaProtection;
    return { ...status, meta };
  }

  const previousStates = previousStatus.meta?.quotaProtection?.states || {};
  const states = { ...previousStates };
  for (const [key, usage] of Object.entries(usages || {})) {
    states[key] = nextQuotaProtectionState(settings, usage, previousStates[key], options);
  }
  meta.quotaProtection = { states };
  return { ...status, meta };
}

export function quotaProtectionStateFor(status = {}, key = "") {
  const states = status.meta?.quotaProtection?.states;
  if (!states || typeof states !== "object") return null;
  return states[String(key || "").trim().toLowerCase()] || null;
}

export function quotaProtectionBlocked(state, value = {}) {
  const settings = normalizeQuotaProtectionSettings(value);
  return settings.enabled
    && state?.settingsKey === quotaProtectionSettingsKey(settings)
    && state?.active === true;
}

export function quotaProtectionNearLimit(state, value = {}, marginPercent = 5) {
  if (!quotaProtectionBlocked(state, value) && !(state?.known && state?.settingsKey === quotaProtectionSettingsKey(value))) {
    return false;
  }
  const remaining = finiteNumber(state.remainingPercent);
  const threshold = finiteNumber(state.thresholdPercent);
  return remaining !== null
    && threshold !== null
    && remaining <= threshold + Math.max(0, Number(marginPercent) || 0);
}

export function quotaProtectionRecheckDue(state, now = Date.now()) {
  if (state?.active !== true) return false;
  const checkAt = Date.parse(state.nextCheckAt || "");
  return !Number.isFinite(checkAt) || checkAt <= Number(now);
}
