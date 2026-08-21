import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSource = await readFile(path.join(rootDir, "src", "server.js"), "utf8");
const channelManagerSource = await readFile(path.join(rootDir, "src", "channel-manager.js"), "utf8");

function loadPreviewHelpers() {
  const start = serverSource.indexOf("function messageImageParts");
  const end = serverSource.indexOf("async function readMultipartInput", start);
  assert.ok(start >= 0 && end > start, "对话图片预览辅助逻辑必须存在");

  const context = {
    badRequest(message) {
      const error = new Error(message);
      error.status = 400;
      return error;
    },
    async pushBase64Image(files, value) {
      const source = typeof value === "string" ? value : value?.url;
      if (!String(source || "").startsWith("data:image/")) return false;
      files.push({ previewUrl: `/uploads/previews/test-${files.length + 1}.png` });
      return true;
    }
  };
  vm.runInNewContext(
    `${serverSource.slice(start, end)}\nthis.helpers = { messageImageParts, saveMessageImagePreviews };`,
    context
  );
  return context.helpers;
}

test("请求内容里的图片会保存成后台预览", async () => {
  const { saveMessageImagePreviews } = loadPreviewHelpers();
  const input = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请识别图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: "data:image/webp;base64,BBBB" }
      ]
    }]
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(await saveMessageImagePreviews(input, { maxFiles: 6 }))),
    ["/uploads/previews/test-1.png", "/uploads/previews/test-2.png"]
  );
});

test("请求内容图片与文件上传共同遵守图片数量上限", async () => {
  const { saveMessageImagePreviews } = loadPreviewHelpers();
  const input = {
    messages: [{
      role: "user",
      content: Array.from({ length: 6 }, () => ({
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" }
      }))
    }]
  };

  await assert.rejects(
    saveMessageImagePreviews(input, { maxFiles: 6, existingFileCount: 1 }),
    (error) => error?.status === 400 && error.message === "对话最多只能上传 6 张图片。"
  );
});

test("同步和异步对话都会把预览地址写入任务记录", () => {
  assert.match(
    serverSource,
    /queueChatCompletion\(\{ \.\.\.input, files \}, requestMeta, \{ inputImageUrls \}\)/
  );
  assert.match(
    serverSource,
    /createChatCompletion\(\{ \.\.\.input, files \}, requestMeta, \{ inputImageUrls \}\)/
  );
  assert.match(serverSource, /queueChatCompletion\(input, requestMeta, \{ inputImageUrls \}\)/);
  assert.match(serverSource, /createChatCompletion\(input, requestMeta, \{ inputImageUrls \}\)/);
  assert.match(
    channelManagerSource,
    /inputImageUrls: taskInputPreviewUrls\(input, taskOptions\.inputImageUrls\)/
  );
});
