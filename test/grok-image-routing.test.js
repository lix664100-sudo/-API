import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-grok-image-routing-"));
process.env.DATA_DIR = dataDir;

const {
  createImageTask,
  createTextTask,
  queueImageTask,
  queueTextTask,
  reserveImageTaskAdmission
} = await import("../src/channel-manager.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function assertUnsupportedGrokImage(error) {
  assert.equal(error.status, 400);
  assert.equal(error.code, "GROK_IMAGE_GENERATION_UNSUPPORTED");
  assert.equal(error.message, "Grok 暂不支持图片生成，请改用 GPT 或 Gemini。");
  return true;
}

const grokTextInput = {
  model: "grok",
  prompt: "生成一张测试图片"
};

const grokImageInput = {
  input: {
    model: "grok",
    prompt: "参考原图生成一张测试图片"
  },
  file: {
    filename: "reference.png",
    mimetype: "image/png"
  }
};

test("Grok 图片请求不会占用 GPT 的任务名额", async () => {
  await assert.rejects(
    reserveImageTaskAdmission(grokTextInput),
    assertUnsupportedGrokImage
  );
});

test("Grok 文生图请求不会被静默改成 GPT", async () => {
  await assert.rejects(
    queueTextTask(grokTextInput),
    assertUnsupportedGrokImage
  );
  await assert.rejects(
    createTextTask(grokTextInput, true),
    assertUnsupportedGrokImage
  );
});

test("Grok 参考图请求不会被静默改成 GPT", async () => {
  await assert.rejects(
    queueImageTask(grokImageInput),
    assertUnsupportedGrokImage
  );
  await assert.rejects(
    createImageTask({ ...grokImageInput, wait: true }),
    assertUnsupportedGrokImage
  );
});
