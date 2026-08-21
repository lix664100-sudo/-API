import assert from "node:assert/strict";
import test from "node:test";

import { DrawingClient } from "../src/channels/drawing.js";

function client() {
  return new DrawingClient({
    config: { defaultRatio: "1:1", defaultImageCount: 1 },
    channel: {
      id: "drawing-test",
      type: "drawing",
      settings: { baseUrl: "https://drawing.example.test" }
    },
    account: { id: "drawing-account", username: "test", password: "test" },
    sessionLock: async (work) => work()
  });
}

test("独立绘图渠道没有返回任务编号时不能算提交成功", async () => {
  const testClient = client();
  testClient.request = async () => ({ status: "processing", message: "accepted without task" });

  await assert.rejects(
    () => testClient.createTextTask({ prompt: "测试任务编号" }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_TASK_NOT_CREATED");
      assert.equal(error.status, 502);
      assert.match(error.message, /没有创建任务/);
      assert.match(error.upstreamText, /accepted without task/);
      return true;
    }
  );
});

test("独立绘图渠道拿到任务编号后才算提交成功", async () => {
  const testClient = client();
  testClient.request = async () => ({ id: "drawing-task-1", status: "processing" });

  const result = await testClient.createImageTask({
    prompt: "测试任务编号",
    source_upload_ids: [1]
  });

  assert.equal(result.externalId, "drawing-task-1");
  assert.equal(result.status, "processing");
});
