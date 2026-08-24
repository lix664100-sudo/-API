import assert from "node:assert/strict";
import test from "node:test";

import {
  isImagePolicyFailureMessage,
  shouldPersistReturnedErrorTask
} from "../src/task-error-policy.js";

test("concurrency rejection without an existing task is not persisted", () => {
  assert.equal(shouldPersistReturnedErrorTask({ code: "CONCURRENCY_LIMIT" }), false);
  assert.equal(shouldPersistReturnedErrorTask({}, { code: "CONCURRENCY_LIMIT" }), false);
  assert.equal(shouldPersistReturnedErrorTask({
    code: "CONCURRENCY_LIMIT",
    task: { id: "task-already-created" }
  }), true);
  assert.equal(shouldPersistReturnedErrorTask({ code: "content_policy" }), true);
});

test("image safety-review messages are recognized", () => {
  assert.equal(isImagePolicyFailureMessage(
    "We're sorry, but the prompt may violate our content policies."
  ), true);
  assert.equal(isImagePolicyFailureMessage("上游渠道内容安全拦截，请修改内容后重试。"), true);
  assert.equal(isImagePolicyFailureMessage("上游网络暂时不可用。"), false);
});
