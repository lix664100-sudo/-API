import assert from "node:assert/strict";
import test from "node:test";

import {
  chatCompletionSseBody,
  openAIErrorPayload
} from "../src/openai-compat.js";

test("OpenAI 兼容错误同时保留旧字段和标准 error 字段", () => {
  const payload = openAIErrorPayload({
    status: 429,
    message: "当前账号次数已用完。",
    code: "CHAT_USAGE_LIMIT",
    legacy: { sourceTaskId: "source-001" }
  });

  assert.deepEqual(payload.error, {
    message: "当前账号次数已用完。",
    type: "rate_limit_error",
    param: null,
    code: "CHAT_USAGE_LIMIT"
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.message, "当前账号次数已用完。");
  assert.equal(payload.sourceTaskId, "source-001");
});

test("OpenAI 流式回复使用 chat.completion.chunk 并以 DONE 结束", () => {
  const body = chatCompletionSseBody({
    id: "chatcmpl-test",
    created: 123,
    model: "gemini-3.1-pro",
    choices: [{ message: { content: "测试成功" } }]
  });
  const events = body.trim().split("\n\n");

  assert.equal(events.at(-1), "data: [DONE]");
  const first = JSON.parse(events[0].slice("data: ".length));
  const last = JSON.parse(events[1].slice("data: ".length));
  assert.equal(first.object, "chat.completion.chunk");
  assert.deepEqual(first.choices[0].delta, { role: "assistant", content: "测试成功" });
  assert.equal(first.choices[0].finish_reason, null);
  assert.deepEqual(last.choices[0].delta, {});
  assert.equal(last.choices[0].finish_reason, "stop");
});
