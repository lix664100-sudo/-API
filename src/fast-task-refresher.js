import { bulkhead, ConstantBackoff, handleAll, retry } from "cockatiel";

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createFastTaskRefresher({
  refresh,
  shouldContinue,
  initialDelayMs = 5000,
  intervalMs = 5000,
  maxAttempts = 36,
  concurrency = 20,
  queue = 500
}) {
  if (typeof refresh !== "function") throw new TypeError("refresh must be a function");
  if (typeof shouldContinue !== "function") throw new TypeError("shouldContinue must be a function");

  const active = new Map();
  const limiter = bulkhead(concurrency, queue);
  const retryPolicy = retry(handleAll.orWhenResult(shouldContinue), {
    maxAttempts,
    backoff: new ConstantBackoff(intervalMs)
  }).dangerouslyUnref();

  return {
    schedule(taskId) {
      const key = String(taskId || "").trim();
      if (!key) return null;
      if (active.has(key)) return active.get(key);

      const current = (async () => {
        await delay(initialDelayMs);
        return retryPolicy.execute(() => limiter.execute(() => refresh(key)));
      })().finally(() => {
        if (active.get(key) === current) active.delete(key);
      });
      active.set(key, current);
      return current;
    },
    has(taskId) {
      return active.has(String(taskId || "").trim());
    },
    get size() {
      return active.size;
    }
  };
}
