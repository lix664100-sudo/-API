import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertInputImageCount, MAX_INPUT_IMAGE_COUNT } from "../src/image-limits.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [serverSource, channelManagerSource, chatplusSource] = await Promise.all([
  readFile(path.join(rootDir, "src", "server.js"), "utf8"),
  readFile(path.join(rootDir, "src", "channel-manager.js"), "utf8"),
  readFile(path.join(rootDir, "src", "channels", "chatplus.js"), "utf8")
]);

test("参考图片允许 6 张，第 7 张会被拒绝", () => {
  assert.equal(MAX_INPUT_IMAGE_COUNT, 6);
  assert.doesNotThrow(() => assertInputImageCount(6));
  assert.throws(
    () => assertInputImageCount(7),
    (error) => error?.status === 400 && error.message === "最多只能上传 6 张图片。"
  );
});

test("网页改图链路统一使用同一个图片上限", () => {
  const serverLimitUses = serverSource.match(/maxFiles: MAX_INPUT_IMAGE_COUNT/g) || [];

  assert.equal(serverLimitUses.length, 5);
  assert.match(channelManagerSource, /assertInputImageCount\(files\.length/);
  assert.match(channelManagerSource, /assertInputImageCount\(\s*chatImageCount\(input\)/);
  assert.match(chatplusSource, /assertInputImageCount\(\s*files\.length/);
  assert.doesNotMatch(serverSource, /maxFiles: [35], savePreview: true/);
  assert.doesNotMatch(channelManagerSource, /assertImageFileCount\(files, 3\)/);
  assert.doesNotMatch(chatplusSource, /对话最多只能上传 5 张图片/);
});
