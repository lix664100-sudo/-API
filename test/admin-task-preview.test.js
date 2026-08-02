import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminHtml = await readFile(path.join(rootDir, "admin", "index.html"), "utf8");
const serverSource = await readFile(path.join(rootDir, "src", "server.js"), "utf8");

function loadTaskPreviewHelpers() {
  const start = adminHtml.indexOf("function uniqueImageUrls");
  const end = adminHtml.indexOf("function taskTypeLabel", start);
  assert.ok(start >= 0 && end > start, "任务图片辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { uniqueImageUrls, taskInputImageUrls, taskOutputImageUrls };`, context);
  return context.helpers;
}

function localValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test("任务图片对比会合并已保存原图和请求记录里的原图，并自动去重", () => {
  const { taskInputImageUrls, taskOutputImageUrls } = loadTaskPreviewHelpers();
  const row = {
    inputImageUrls: [" /uploads/previews/source-1.png ", "", "/uploads/previews/source-1.png", 42],
    requestJson: {
      files: [
        { previewUrl: "/uploads/previews/source-1.png" },
        { previewUrl: "/uploads/previews/source-2.png" },
        null
      ]
    },
    imageUrls: ["https://example.test/result-1.png", "https://example.test/result-1.png", ""]
  };

  assert.deepEqual(localValue(taskInputImageUrls(row)), [
    "/uploads/previews/source-1.png",
    "/uploads/previews/source-2.png"
  ]);
  assert.deepEqual(localValue(taskOutputImageUrls(row)), ["https://example.test/result-1.png"]);
});

test("历史任务没有原图时返回空列表，界面显示明确提示", () => {
  const { taskInputImageUrls } = loadTaskPreviewHelpers();

  assert.deepEqual(localValue(taskInputImageUrls({ imageUrls: ["https://example.test/result.png"] })), []);
  assert.match(adminHtml, /该任务未保存原图/);
  assert.match(adminHtml, /暂无生成结果/);
});

test("任务缩略图打开原图与生成结果弹窗，并支持多图放大和窄屏排列", () => {
  assert.match(adminHtml, /aria-label": "查看原图和生成结果"/);
  assert.match(adminHtml, /title: "原图与生成结果"/);
  assert.match(adminHtml, /Image\.PreviewGroup/);
  assert.match(adminHtml, /\.task-compare-grid[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(adminHtml, /@media \(max-width: 780px\)[\s\S]*\.task-compare-grid[\s\S]*grid-template-columns: 1fr/);
});

test("两个改图入口都会保存原图预览，并纳入现有图片清理目录", () => {
  const previewEnabledReads = serverSource.match(/readImageInput\(request, \{ maxFiles: 3, savePreview: true \}\)/g) || [];

  assert.equal(previewEnabledReads.length, 2);
  assert.match(serverSource, /const previewDir = resultImageDir;/);
  assert.match(serverSource, /const legacyPreviewDir = path\.join\(rootDir, "outputs", "previews"\);/);
  assert.match(serverSource, /return readFile\(path\.join\(legacyPreviewDir, filename\)\);/);
  assert.match(serverSource, /const filename = `preview-\$\{Date\.now\(\)\}-\$\{randomUUID\(\)\}/);
  assert.match(serverSource, /filename\.startsWith\("preview-"\)/);
});
