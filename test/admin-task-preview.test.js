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

function loadTaskRouteHelpers() {
  const start = adminHtml.indexOf("function compactErrorText");
  const end = adminHtml.indexOf("function cleanAttemptReason", start);
  assert.ok(start >= 0 && end > start, "任务渠道流向辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskSubmissionRouteText, taskGenerationRouteText };`, context);
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
  const previewEnabledReads = serverSource.match(/readImageInput\(request, \{ maxFiles: MAX_INPUT_IMAGE_COUNT, savePreview: true \}\)/g) || [];

  assert.equal(previewEnabledReads.length, 2);
  assert.match(serverSource, /const previewDir = resultImageDir;/);
  assert.match(serverSource, /const legacyPreviewDir = path\.join\(rootDir, "outputs", "previews"\);/);
  assert.match(serverSource, /return readFile\(path\.join\(legacyPreviewDir, filename\)\);/);
  assert.match(serverSource, /const filename = `preview-\$\{Date\.now\(\)\}-\$\{randomUUID\(\)\}/);
  assert.match(serverSource, /filename\.startsWith\("preview-"\)/);
});

test("任务渠道按首次提交和全部成功渠道显示，并自动去重", () => {
  const { taskSubmissionRouteText, taskGenerationRouteText } = loadTaskRouteHelpers();
  const row = {
    taskType: "img2img",
    submissionChannels: [
      { channelId: "a", channelName: "渠道A", accountId: "1", accountName: "账号A" },
      { channelId: "b", channelName: "渠道B", accountId: "2", accountName: "账号B" }
    ],
    generationChannels: [
      { channelId: "a", channelName: "渠道A", accountId: "1", accountName: "账号A" },
      { channelId: "b", channelName: "渠道B", accountId: "2", accountName: "账号B" },
      { channelId: "b", channelName: "渠道B", accountId: "2", accountName: "账号B" },
      { channelId: "c", channelName: "渠道C" }
    ]
  };

  assert.equal(taskSubmissionRouteText(row), "渠道A · 账号A");
  assert.equal(taskGenerationRouteText(row), "渠道A · 账号A / 渠道B · 账号B / 渠道C");
  assert.match(adminHtml, /"提交："/);
  assert.match(adminHtml, /"生成："/);
});

test("旧任务和未提交任务也有明确的渠道状态", () => {
  const { taskSubmissionRouteText, taskGenerationRouteText } = loadTaskRouteHelpers();
  const legacy = {
    externalId: "conversation-old",
    status: "success",
    taskType: "img2img",
    imageCount: 1,
    channelId: "shareai:chatplus",
    channelName: "ShareAI账号//聊天生图",
    accountId: "account-old",
    accountName: "旧账号"
  };

  assert.equal(taskSubmissionRouteText(legacy), "ShareAI账号/聊天生图 · 旧账号");
  assert.equal(taskGenerationRouteText(legacy), "ShareAI账号/聊天生图 · 旧账号");
  assert.equal(taskSubmissionRouteText({ taskType: "img2img" }), "未提交");
  assert.equal(taskGenerationRouteText({ taskType: "img2img", status: "failed" }), "未成功");
  assert.equal(taskGenerationRouteText({ taskType: "chat", status: "success" }), "不适用");
});
