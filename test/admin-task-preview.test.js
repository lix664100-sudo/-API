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

function loadAttemptReasonHelper() {
  const start = adminHtml.indexOf("function compactErrorText");
  const end = adminHtml.indexOf("function taskAttemptTargetText", start);
  assert.ok(start >= 0 && end > start, "任务尝试原因辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helper = cleanAttemptReason;`, context);
  return context.helper;
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
  const start = adminHtml.indexOf("function trimUrl");
  const end = adminHtml.indexOf("function taskUpstreamTitle", start);
  assert.ok(start >= 0 && end > start, "任务上游编号辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskConversationId, taskConversationUrl, taskUpstreamTaskId, taskCarId };`, context);
  return context.helpers;
}

function loadTaskIdHelpers() {
  const start = adminHtml.indexOf("function taskSourceId");
  const end = adminHtml.indexOf("function taskSearchHaystack", start);
  assert.ok(start >= 0 && end > start, "任务编号辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskSourceId, taskIdentityItems };`, context);
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

function loadTaskModelHelper() {
  const start = adminHtml.indexOf("function taskModelCode");
  const end = adminHtml.indexOf("function channelName", start);
  assert.ok(start >= 0 && end > start, "任务模型展示逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { taskModelInfo };`, context);
  return context.helpers.taskModelInfo;
}

function loadTaskFailureHelpers() {
  const start = adminHtml.indexOf("function taskAttempts");
  const end = adminHtml.indexOf("function taskJsonPanel", start);
  assert.ok(start >= 0 && end > start, "任务失败说明辅助逻辑必须存在");

  const context = {};
  vm.runInNewContext(`${adminHtml.slice(start, end)}\nthis.helpers = { isConcurrencyLimitedTask, isSafetyReviewTask, taskPresentationStatus, taskErrorText, taskReturnJson, taskSubmissionRouteText };`, context);
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

test("安全审核任务显示原图，并明确区分请求图片和实际结果", () => {
  assert.match(serverSource, /\.\.\.taskFilePreviewUrls\(context\.files\)/);
  assert.match(adminHtml, /安全审核未生成图片/);
  assert.match(adminHtml, /`请求 \$\{requestedCount\} 张 · 结果 \$\{resultCount\} 张`/);
  assert.match(adminHtml, /task-thumb task-thumb-empty/);
});

test("对话记录始终显示本地任务ID，并单独显示调用方任务ID", () => {
  const { taskIdentityItems } = loadTaskIdHelpers();

  assert.deepEqual(localValue(taskIdentityItems({ id: "task-local-001" })), [
    ["本地任务ID", "task-local-001"]
  ]);
  assert.deepEqual(localValue(taskIdentityItems({
    id: "task-local-002",
    sourceTaskId: "erp-order-88"
  })), [
    ["本地任务ID", "task-local-002"],
    ["调用方任务ID", "erp-order-88"]
  ]);
  assert.match(adminHtml, /\["本地任务ID", detail\.taskId\]/);
  assert.match(adminHtml, /\["调用方任务ID", detail\.sourceTaskId\]/);
});

test("任务缩略图打开原图与生成结果弹窗，并支持多图放大和窄屏排列", () => {
  assert.match(adminHtml, /"aria-label": isChat \? "查看对话图片" : "查看原图和生成结果"/);
  assert.match(adminHtml, /\? "对话图片" : "原图与生成结果"/);
  assert.match(adminHtml, /Image\.PreviewGroup/);
  assert.match(adminHtml, /\.task-compare-grid[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(adminHtml, /@media \(max-width: 780px\)[\s\S]*\.task-compare-grid[\s\S]*grid-template-columns: 1fr/);
});

test("全部、生图和对话记录均可在一屏查看，耗时靠前且窄屏自动精简次要列", () => {
  assert.match(adminHtml, /taskRecordTabLabel\("all", "全部记录"/);
  assert.match(adminHtml, /taskRecordTabLabel\("image", "生图记录"/);
  assert.match(adminHtml, /taskRecordTabLabel\("chat", "对话记录"/);
  assert.match(adminHtml, /tableLayout: "fixed"/);
  assert.match(adminHtml, /size: "small"/);
  assert.doesNotMatch(adminHtml, /scroll: \{ x: isAll \?/);
  assert.match(adminHtml, /title: "状态 \/ 耗时"[\s\S]*?taskStatusSummaryCell\(row\)/);
  assert.match(adminHtml, /title: "模型 \/ 渠道"[\s\S]*?responsive: \["lg"\]/);
  assert.match(adminHtml, /title: "预计 TOKEN"[\s\S]*?responsive: \["md"\]/);
  assert.match(adminHtml, /\.task-copy-full[\s\S]*max-height: 320px/);
  assert.match(adminHtml, /\.task-copy-preview[\s\S]*-webkit-line-clamp: 3/);
  assert.match(adminHtml, /\.task-copy-preview\.is-answer[\s\S]*-webkit-line-clamp: 2/);
  assert.doesNotMatch(adminHtml, /h\("div", \{ className: "task-response" \}, row\.responseText\)/);
});

test("任务记录分别显示调用模型和实际使用模型", () => {
  const taskModelInfo = loadTaskModelHelper();

  assert.deepEqual(localValue(taskModelInfo({
    channelType: "chatplus",
    modelId: "gemini",
    raw: {
      requestedModel: "gemini",
      upstreamModel: "gemini-3.1-pro"
    }
  })), {
    requested: "gemini",
    actual: "gemini-3.1-pro"
  });
  assert.deepEqual(localValue(taskModelInfo({
    channelType: "drawing",
    modelId: 2,
    raw: { requestedModel: "nano-banana" }
  })), {
    requested: "nano-banana",
    actual: "nano-banana-pro"
  });
  assert.deepEqual(localValue(taskModelInfo({
    channelType: "chatplus",
    modelId: "gemini"
  })), {
    requested: "gemini",
    actual: "未记录"
  });
  assert.deepEqual(localValue(taskModelInfo({
    status: "failed",
    modelId: "gpt",
    requestJson: { model: "gpt" },
    raw: { returnedError: true }
  })), {
    requested: "gpt",
    actual: "未调用"
  });
  assert.match(adminHtml, /\["调用模型", info\.requested\]/);
  assert.match(adminHtml, /\["实际模型", info\.actual\]/);
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

test("对话摘要会隐藏图片数据并限制长度，完整内容按需查看", () => {
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

test("任务列表只加载轻量摘要，完整记录和 JSON 点击后再读取", () => {
  assert.match(adminHtml, /pageSize: "30"/);
  assert.match(adminHtml, /api\(`\/api\/tasks\/\$\{encodeURIComponent\(row\.id\)\}`/);
  assert.match(adminHtml, /"查看完整记录"/);
  assert.match(adminHtml, /options\.detail \? taskJsonGrid\(row\) : null/);
  assert.match(adminHtml, /open \? h\("div", \{ className: "task-json-grid"/);
  assert.match(adminHtml, /图片内容已省略/);
  assert.doesNotMatch(adminHtml, /setTasks\(\[\]\);\s*setTaskTotal\(0\)/);
});

test("全部记录请求生图和对话混合排列", () => {
  assert.match(adminHtml, /if \(normalized\.kind === "all"\) params\.set\("mixKinds", "1"\)/);
  assert.match(serverSource, /mixKinds: request\.query\?\.mixKinds/);
});

test("处理中任务自动刷新只合并更新结果，不再重复下载整页", () => {
  assert.match(serverSource, /task: taskListItem\(result\.data\)/);
  assert.match(adminHtml, /mergeRefreshedTasks\(results\)/);
  assert.match(adminHtml, /if \(taskStatusFilter !== "all"\)/);
});

test("两个改图入口都会保存原图预览，并纳入现有图片清理目录", () => {
  const previewEnabledReads = serverSource.match(/readImageInput\(request, \{\s*maxFiles: MAX_INPUT_IMAGE_COUNT,\s*savePreview: true,\s*beforeImageRead: reserveBeforeImageRead\s*\}\)/g) || [];

  assert.equal(previewEnabledReads.length, 2);
  assert.match(serverSource, /const previewDir = resultImageDir;/);
  assert.match(serverSource, /const legacyPreviewDir = path\.join\(rootDir, "outputs", "previews"\);/);
  assert.match(serverSource, /return readFile\(path\.join\(legacyPreviewDir, filename\)\);/);
  assert.match(serverSource, /const filename = `preview-\$\{Date\.now\(\)\}-\$\{randomUUID\(\)\}/);
  assert.match(serverSource, /filename\.startsWith\("preview-"\)/);
});

test("两个改图入口都会在读取图片前占住并发名额", () => {
  for (const route of ["/api/draw/edit", "/v1/images/edits"]) {
    const routeStart = serverSource.indexOf(`app.post("${route}"`);
    const routeEnd = serverSource.indexOf("\n});", routeStart);
    const routeSource = serverSource.slice(routeStart, routeEnd);
    const readAt = routeSource.indexOf("readImageInput(request");
    const preserveInputAt = routeSource.indexOf("partialInput");
    const reserveAt = routeSource.indexOf("reserveImageRequestAdmission(request, requestMeta, partialInput)");

    assert.ok(routeStart >= 0 && routeEnd > routeStart, `${route} 必须存在`);
    assert.ok(preserveInputAt >= 0 && preserveInputAt < reserveAt, `${route} 必须先保存已经收到的模型和任务说明`);
    assert.ok(reserveAt >= 0 && reserveAt < readAt, `${route} 必须先准备并发检查再读取图片`);
    assert.match(routeSource, /beforeImageRead: reserveBeforeImageRead/);
  }
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

test("对话记录显示对话类型，提交渠道不再误写成聊天生图", () => {
  const { taskSubmissionRouteText } = loadTaskRouteHelpers();
  const chatRow = {
    taskType: "chat",
    externalId: "conversation-chat",
    channelName: "谷歌 https://claude.midjourneye.com//聊天生图",
    accountName: "测试账号"
  };
  const imageRow = {
    ...chatRow,
    taskType: "text2img"
  };

  assert.equal(taskSubmissionRouteText(chatRow), "谷歌 https://claude.midjourneye.com/对话 · 测试账号");
  assert.equal(taskSubmissionRouteText(imageRow), "谷歌 https://claude.midjourneye.com/聊天生图 · 测试账号");
  assert.match(adminHtml, /const label = isChat \? "对话" : taskTypeLabel/);
  assert.match(adminHtml, /function taskStatusSummaryCell\(row\)[\s\S]*?taskRecordTypeTag\(row\)/);
  assert.match(adminHtml, /const chatTaskColumns = \[[\s\S]*?title: "状态 \/ 耗时"[\s\S]*?taskStatusSummaryCell\(row\)/);
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
  const { taskConversationId, taskConversationUrl, taskUpstreamTaskId } = loadTaskIdentityHelpers();

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
    raw: { chatModel: "gemini", conversationId: "c_confirmed_upstream_id" }
  }), "c_confirmed_upstream_id");
  assert.equal(taskConversationId({
    channelType: "chatplus",
    modelId: "gemini",
    raw: {
      chatModel: "gemini",
      conversationId: "**Refine Brush Details** I'm now zeroing in on the product details."
    }
  }), "");
  assert.equal(taskConversationUrl({
    channelId: "google:chatplus",
    channelType: "chatplus",
    modelId: "gemini",
    raw: { chatModel: "gemini", conversationId: "c_ce144bba99281e12" }
  }, {
    channels: [{
      id: "google",
      type: "shareai",
      settings: { chatBaseUrl: "https://cloudlian.cn/" }
    }]
  }), "https://cloudlian.cn/app/ce144bba99281e12");
  assert.equal(taskConversationId({
    channelType: "drawing",
    modelId: "gemini",
    raw: { conversationId: "125461" }
  }), "");
  assert.equal(taskUpstreamTaskId({
    channelType: "drawing",
    modelId: "gemini",
    raw: { conversationId: "125461" }
  }), "125461");
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

test("并发已满使用独立的黄色状态，不再显示为任务失败", () => {
  const { isConcurrencyLimitedTask, taskPresentationStatus, taskErrorText } = loadTaskFailureHelpers();
  const concurrencyLimited = {
    status: "failed",
    taskType: "img2img",
    errorMessage: "并发上限：账号正在处理中",
    responseJson: {
      code: "CONCURRENCY_LIMIT",
      attempts: [{ busy: true, message: "这个账号还有任务正在处理中" }]
    },
    raw: { submitted: false }
  };
  const noUsableAccount = {
    status: "failed",
    taskType: "img2img",
    errorMessage: "当前没有可用的生图账号，请先检测账号状态或等待额度恢复。",
    responseJson: { code: "NO_USABLE_ACCOUNT" },
    raw: { returnedError: true }
  };
  const quotaExhausted = {
    status: "failed",
    taskType: "img2img",
    errorMessage: "任务失败：可用账号额度不足或暂不可用。",
    responseJson: {
      code: "QUOTA_EXHAUSTED",
      attempts: [{ quotaEmpty: true, message: "绘图额度不足。" }]
    },
    raw: { returnedError: true }
  };
  const realFailure = {
    status: "failed",
    taskType: "img2img",
    errorMessage: "上游生成失败",
    responseJson: { code: "UPSTREAM_NO_IMAGE" },
    raw: { submitted: true }
  };

  assert.equal(isConcurrencyLimitedTask(concurrencyLimited), true);
  assert.equal(taskPresentationStatus(concurrencyLimited), "concurrency_limited");
  assert.match(taskErrorText(concurrencyLimited), /^并发已满：/);
  assert.equal(isConcurrencyLimitedTask(noUsableAccount), true);
  assert.equal(taskPresentationStatus(noUsableAccount), "concurrency_limited");
  assert.equal(taskErrorText(noUsableAccount), "并发已满：当前没有可用账号，请检测账号状态或等待额度恢复。");
  assert.equal(isConcurrencyLimitedTask(quotaExhausted), true);
  assert.equal(taskPresentationStatus(quotaExhausted), "concurrency_limited");
  assert.equal(taskErrorText(quotaExhausted), "并发已满：当前可用账号额度不足，请检测账号额度或等待恢复。");
  assert.equal(isConcurrencyLimitedTask(realFailure), false);
  assert.equal(taskPresentationStatus(realFailure), "failed");
  assert.match(adminHtml, /concurrency_limited: \["warning", "并发已满"\]/);
  assert.match(adminHtml, /task-concurrency-card/);
});

test("上游内容审核使用独立的安全审核状态", () => {
  const { isSafetyReviewTask, taskPresentationStatus } = loadTaskFailureHelpers();
  const reviewed = {
    status: "failed",
    listStatus: "safety_review",
    responseJson: { code: "content_policy" },
    raw: { submitted: true }
  };

  assert.equal(isSafetyReviewTask(reviewed), true);
  assert.equal(taskPresentationStatus(reviewed), "safety_review");
  assert.match(adminHtml, /safety_review: \["warning", "安全审核"\]/);
  assert.match(adminHtml, /\{ label: "安全审核", value: "safety_review" \}/);
});

test("共享车位失效不会再显示为聊天账号掉线", () => {
  const { taskErrorText } = loadTaskFailureHelpers();
  const currentTask = {
    status: "failed",
    taskType: "img2img",
    responseJson: {
      code: "CHAT_CAR_POOL_UNAVAILABLE",
      message: "上游共享车位暂时不可用，任务未能提交。请稍后重试。",
      attempts: [{ carPoolUnavailable: true, message: "用户认证失败，请重新登录" }]
    }
  };
  const legacyTask = {
    status: "failed",
    taskType: "img2img",
    channelName: "聊天生图",
    errorMessage: "自动换车失败：GPT 自动找车失败：用户认证失败，请重新登录"
  };

  assert.equal(taskErrorText(currentTask), "上游共享车位暂时不可用，任务未能提交。请稍后重试。");
  assert.equal(taskErrorText(legacyTask), "上游共享车位暂时不可用，任务未能提交。请稍后重试。");
  assert.doesNotMatch(taskErrorText(legacyTask), /掉线/);
});

test("账号忙碌时保留真正占用账号的任务信息", () => {
  const cleanAttemptReason = loadAttemptReasonHelper();
  const detailed = "李想的聊天生图任务正在处理中。占用任务：task-running-001（等待上游，11:36）。请稍后再试。";

  assert.equal(cleanAttemptReason(detailed), detailed);
  assert.equal(
    cleanAttemptReason("这个账号还有任务正在处理中"),
    "这个账号还有任务正在处理，请稍后再试。"
  );
});

test("并发面板明确显示对话满载排队，并展示排队记录和数量", () => {
  assert.match(adminHtml, /queued: \["processing", "排队中"\]/);
  assert.match(adminHtml, /\{ label: "排队中", value: "queued" \}/);
  assert.match(adminHtml, /对话满载排队/);
  assert.match(adminHtml, /`排队 \$\{queued\}`/);
  assert.match(adminHtml, /等待空闲名额/);
  assert.doesNotMatch(adminHtml, /满载立即拒绝/);
});
