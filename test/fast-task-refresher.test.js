import assert from "node:assert/strict";
import test from "node:test";
import { createFastTaskRefresher } from "../src/fast-task-refresher.js";

test("快速查询会重试临时错误和等待任务，并在成功后停止", async () => {
  let calls = 0;
  const refresher = createFastTaskRefresher({
    refresh: async (taskId) => {
      calls += 1;
      if (calls === 1) throw new Error("temporary upstream error");
      if (calls === 2) return { id: taskId, status: "waiting_upstream" };
      return { id: taskId, status: "success" };
    },
    shouldContinue: (task) => task?.status === "waiting_upstream",
    initialDelayMs: 1,
    intervalMs: 1,
    maxAttempts: 5,
    concurrency: 1,
    queue: 1
  });

  const first = refresher.schedule("task-fast-refresh");
  const duplicate = refresher.schedule("task-fast-refresh");

  assert.equal(first, duplicate);
  assert.equal(refresher.size, 1);
  const result = await first;
  assert.equal(result.status, "success");
  assert.equal(calls, 3);
  assert.equal(refresher.size, 0);
});

test("快速查询遇到已完成任务时不会继续请求", async () => {
  let calls = 0;
  const refresher = createFastTaskRefresher({
    refresh: async (taskId) => {
      calls += 1;
      return { id: taskId, status: "success" };
    },
    shouldContinue: (task) => task?.status === "waiting_upstream",
    initialDelayMs: 1,
    intervalMs: 1,
    maxAttempts: 5
  });

  const result = await refresher.schedule("task-already-finished");

  assert.equal(result.status, "success");
  assert.equal(calls, 1);
});
