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

function loadTaskTimingHelpers() {
  const start = adminHtml.indexOf("function taskStageTimings");
  const end = adminHtml.indexOf("function formatTaskStageDuration", start);
  assert.ok(start >= 0 && end > start, "任务耗时辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskStageTimings, taskStageSummary };`, context);
  return context.helpers;
}

function loadTaskIdentityHelpers() {
  const start = adminHtml.indexOf("function taskConversationId");
  const end = adminHtml.indexOf("function taskUpstreamTitle", start);
  assert.ok(start >= 0 && end > start, "任务上游编号辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskConversationId, taskCarId };`, context);
  return context.helpers;
}

function loadTaskRecordHelpers() {
  const start = adminHtml.indexOf("function taskRecordKind");
  const end = adminHtml.indexOf("function taskTypeLabel", start);
  assert.ok(start >= 0 && end > start, "任务分类与摘要辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskRecordKind, compactTaskText, taskTextLengthLabel };`, context);
  return context.helpers;
}

function loadChatTokenUsageHelper() {
  const start = adminHtml.indexOf("function chatTaskTokenUsage");
  const end = adminHtml.indexOf("function chatTaskTokenUsageCell", start);
  assert.ok(start >= 0 && end > start, "对话 TOKEN 展示逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { chatTaskTokenUsage };`, context);
  return context.helpers.chatTaskTokenUsage;
}

function loadTaskFailureHelpers() {
  const start = adminHtml.indexOf("function taskAttempts");
  const end = adminHtml.indexOf("function taskJsonPanel", start);
  assert.ok(start >= 0 && end > start, "任务失败说明辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskErrorText, taskReturnJson, taskSubmissionRouteText };`, context);
  return context.helpers;
}

function localValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test("任务图片对比会合并已保存原图和请求记录里的原图，并自动去重", () => {
  const { taskInputImageUrls, taskOutputImageUrls } = loadTaskPreviewHelpers();
  const embeddedImage = "data:image/png;base64,iVBORw0KGgo=";
  const row = {
    inputImageUrls: [" /uploads/previews/source-1.png ", "", "/uploads/previews/source-1.png", 42],
    requestJson: {
      files: [
        { previewUrl: "/uploads/previews/source-1.png" },
        { previewUrl: "/uploads/previews/source-2.png" },
        null
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "请看图片" },
            { type: "image_url", image_url: { url: embeddedImage } }
          ]
        }
      ]
    },
    imageUrls: ["https://example.test/result-1.png", "https://example.test/result-1.png", ""]
  };

  assert.deepEqual(localValue(taskInputImageUrls(row)), [
    "/uploads/previews/source-1.png",
    "/uploads/previews/source-2.png",
    embeddedImage
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
  assert.match(adminHtml, /\? "对话图片" : "原图与生成结果"/);
  assert.match(adminHtml, /Image\.PreviewGroup/);
  assert.match(adminHtml, /\.task-compare-grid[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(adminHtml, /@media \(max-width: 780px\)[\s\S]*\.task-compare-grid[\s\S]*grid-template-columns: 1fr/);
});

test("生图和对话记录独立展示，表格固定列宽避免长内容撑坏页面", () => {
  assert.match(adminHtml, /taskRecordTabLabel\("image", "生图记录"/);
  assert.match(adminHtml, /taskRecordTabLabel\("chat", "对话记录"/);
  assert.match(adminHtml, /tableLayout: "fixed"/);
  assert.match(adminHtml, /scroll: \{ x: isChat \? 1610 : 1620 \}/);
  assert.match(adminHtml, /\.task-copy-full[\s\S]*max-height: 320px/);
  assert.match(adminHtml, /\.task-copy-preview[\s\S]*-webkit-line-clamp: 5/);
  assert.doesNotMatch(adminHtml, /h\("div", \{ className: "task-response" \}, row\.responseText\)/);
});

test("对话记录显示预计 TOKEN，并忽略旧记录里的占位零值", () => {
  const chatTaskTokenUsage = loadChatTokenUsageHelper();
  const usage = localValue(chatTaskTokenUsage({
    responseJson: {
      usage: {
        prompt_tokens: 18,
        completion_tokens: 7,
        total_tokens: 25,
        estimated: true,
        text_only: true,
        image_count: 1
      }
    }
  }));

  assert.deepEqual(usage, {
    input: 18,
    output: 7,
    total: 25,
    imageCount: 1,
    textOnly: true
  });
  assert.equal(chatTaskTokenUsage({
    responseJson: { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
  }), null);
  assert.match(adminHtml, /title: "预计 TOKEN"/);
  assert.match(adminHtml, /图片 \$\{usage\.imageCount\} 张未计入/);
});

test("对话摘要会隐藏图片数据并限制长度，完整内容仍可展开", () => {
  const { taskRecordKind, compactTaskText, taskTextLengthLabel } = loadTaskRecordHelpers();
  const withImage = `请看图片 data:image/jpeg;base64,${"A".repeat(240)} 并说明内容`;

  assert.equal(taskRecordKind({ taskType: "chat" }), "chat");
  assert.equal(taskRecordKind({ raw: { endpoint: "/v1/chat/completions" } }), "chat");
  assert.equal(taskRecordKind({ taskType: "img2img" }), "image");
  assert.equal(compactTaskText(withImage, 120), "请看图片 [图片] 并说明内容");
  assert.equal(compactTaskText("A".repeat(200), 80).length, 81);
  assert.equal(taskTextLengthLabel("A".repeat(32000)), "3.2 万字");
  assert.match(adminHtml, /查看完整\$\{label\}/);
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

test("任务耗时会合并重复记录并准确计算换车次数", () => {
  const { taskStageSummary } = loadTaskTimingHelpers();
  const row = {
    raw: {
      stageTimings: [
        { id: "enter-a", key: "car_enter", label: "进入车位", carId: "car-a", durationMs: 1500, status: "failed" },
        { id: "enter-b", key: "car_enter", label: "进入车位", carId: "car-b", durationMs: 2500, status: "success" },
        { id: "upload", key: "source_upload", label: "上传原图", durationMs: 8000, status: "success" }
      ]
    },
    responseJson: {
      raw: {
        stageTimings: [
          { id: "upload", key: "source_upload", label: "上传原图", durationMs: 8000, status: "success" }
        ]
      }
    }
  };

  const summary = localValue(taskStageSummary(row));
  assert.equal(summary.carAttempts, 2);
  assert.deepEqual(summary.stages, [
    { key: "car_enter", label: "进入车位", durationMs: 4000, count: 2, failedCount: 1 },
    { key: "source_upload", label: "上传原图", durationMs: 8000, count: 1, failedCount: 0 }
  ]);
  assert.match(adminHtml, /换车 \$\{summary\.carAttempts - 1\} 次/);
  assert.match(adminHtml, /aria-label": "任务耗时明细"/);
});

test("Gemini 只有真实上游编号才显示为上游对话", () => {
  const { taskConversationId } = loadTaskIdentityHelpers();

  assert.equal(taskConversationId({
    channelType: "chatplus",
    modelId: "gemini",
    externalId: "6a881587-cb5e-4f00-9c74-e5ac904bf377"
  }), "");
  assert.equal(taskConversationId({
    channelType: "chatplus",
    modelId: "gemini",
    externalId: "c_f182cceb2592f88e"
  }), "c_f182cceb2592f88e");
  assert.equal(taskConversationId({
    channelType: "chatplus",
    modelId: "gemini",
    externalId: "local-fallback",
    raw: { conversationId: "confirmed-upstream-id" }
  }), "confirmed-upstream-id");
});

test("失败任务会从处理记录中显示实际车位", () => {
  const { taskCarId } = loadTaskIdentityHelpers();
  const row = {
    raw: {
      stageTimings: [
        { id: "upload", key: "source_upload", durationMs: 10 },
        { id: "submit", key: "upstream_generation", carId: "failed-car", durationMs: 20, status: "failed" }
      ]
    }
  };

  assert.equal(taskCarId(row), "failed-car");
});

test("生图失败会明确区分未完整提交和上游未返回图片", () => {
  const { taskErrorText, taskReturnJson, taskSubmissionRouteText } = loadTaskFailureHelpers();
  const notSubmitted = {
    status: "failed",
    taskType: "img2img",
    errorMessage: "旧的模糊错误",
    upstreamText: "{\"message\":\"车队失效，请重新选择\"}",
    responseJson: {
      ok: false,
      message: "提交失败：图片和生图要求未完整提交到上游，停在“上传原图”。具体原因：车队失效，请重新选择",
      failureType: "submission_failed",
      submissionConfirmed: false,
      failureReason: "车队失效，请重新选择",
      upstreamText: "{\"message\":\"车队失效，请重新选择\"}"
    },
    raw: { submitted: false }
  };
  const submitted = {
    status: "failed",
    taskType: "img2img",
    channelName: "聊天生图",
    accountName: "测试账号",
    responseJson: {
      ok: false,
      message: "上游生成失败：图片和生图要求已完整提交，但上游没有返回图片。上游回复：参数不完整",
      failureType: "upstream_no_image",
      submissionConfirmed: true,
      failureReason: "参数不完整",
      upstreamText: "参数不完整"
    },
    raw: { submitted: true }
  };

  assert.match(taskErrorText(notSubmitted), /^提交失败：/);
  assert.equal(taskSubmissionRouteText(notSubmitted), "未提交");
  assert.match(taskErrorText(submitted), /^上游生成失败：/);
  assert.equal(taskSubmissionRouteText(submitted), "聊天生图 · 测试账号");
  assert.match(taskReturnJson(notSubmitted).message, /^提交失败：/);
  assert.equal(taskReturnJson(notSubmitted).upstreamText, "{\"message\":\"车队失效，请重新选择\"}");
});
