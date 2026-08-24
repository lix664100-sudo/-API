import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "shareai-task-list-page-"));
process.env.DATA_DIR = dataDir;

const { closeStorage, getTask, listTaskPage, upsertTask } = await import("../src/storage.js");

after(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

test("task pages return the newest matching records without returning the full history", async () => {
  const now = Date.now();
  const tasks = [
    {
      id: "task-old-drawing",
      sourceTaskId: "batch_draw_old_001",
      status: "failed",
      taskType: "text2img",
      channelType: "drawing",
      channelId: "channel-shareai:drawing",
      accountId: "account-a",
      errorMessage: "upstream concurrency limit",
      createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "task-middle-chat",
      sourceTaskId: "batch_draw_middle_002",
      status: "success",
      taskType: "chat",
      channelType: "chatplus",
      channelId: "channel-google:chatplus",
      accountId: "account-b",
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "task-new-drawing",
      sourceTaskId: "batch_draw_new_003",
      status: "processing",
      taskType: "img2img",
      channelType: "drawing",
      channelId: "channel-shareai:drawing",
      accountId: "account-a",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString()
    },
    {
      id: "task-concurrency-limited",
      sourceTaskId: "batch_draw_busy_004",
      status: "failed",
      taskType: "img2img",
      channelType: "drawing",
      channelId: "channel-shareai:drawing",
      accountId: "account-a",
      errorMessage: "并发上限：账号正在处理中",
      responseJson: { code: "CONCURRENCY_LIMIT" },
      raw: { submitted: false },
      createdAt: new Date(now - 30 * 60 * 1000).toISOString()
    }
  ];
  for (const task of tasks) await upsertTask(task);

  const firstPage = await listTaskPage({ page: 1, pageSize: 2 });
  assert.equal(firstPage.total, 4);
  assert.equal(firstPage.allTotal, 4);
  assert.deepEqual(firstPage.kindTotals, { image: 3, chat: 1 });
  assert.equal(firstPage.pageCount, 2);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.items.map((task) => task.id), ["task-concurrency-limited", "task-new-drawing"]);

  const secondPage = await listTaskPage({ page: 2, pageSize: 2 });
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(secondPage.items.map((task) => task.id), ["task-middle-chat", "task-old-drawing"]);

  const filtered = await listTaskPage({
    keyword: "batch_draw_old",
    accountId: "account-a",
    sourceChannelId: "channel-shareai",
    channel: "drawing",
    status: "failed"
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, "task-old-drawing");

  const concurrencyLimited = await listTaskPage({ status: "concurrency_limited" });
  assert.equal(concurrencyLimited.total, 1);
  assert.equal(concurrencyLimited.items[0].id, "task-concurrency-limited");

  const errorSearch = await listTaskPage({ keyword: "concurrency limit" });
  assert.equal(errorSearch.total, 2);
  assert.deepEqual(errorSearch.items.map((task) => task.id), ["task-concurrency-limited", "task-old-drawing"]);

  const sourceChannel = await listTaskPage({ sourceChannelId: "channel-google" });
  assert.equal(sourceChannel.total, 1);
  assert.equal(sourceChannel.items[0].id, "task-middle-chat");

  const imageTasks = await listTaskPage({ kind: "image" });
  assert.equal(imageTasks.total, 3);
  assert.deepEqual(imageTasks.items.map((task) => task.id), ["task-concurrency-limited", "task-new-drawing", "task-old-drawing"]);

  const chatTasks = await listTaskPage({ kind: "chat" });
  assert.equal(chatTasks.total, 1);
  assert.deepEqual(chatTasks.items.map((task) => task.id), ["task-middle-chat"]);
});

test("content-policy failures have a separate safety-review status", async () => {
  const now = Date.now();
  await upsertTask({
    id: "task-safety-review-code",
    status: "failed",
    taskType: "img2img",
    responseJson: {
      code: "content_policy",
      message: "The prompt may violate our content policies."
    },
    raw: { submitted: true },
    createdAt: new Date(now).toISOString()
  });
  await upsertTask({
    id: "task-safety-review-message",
    status: "failed",
    taskType: "img2img",
    errorMessage: "上游生成失败：The prompt may violate our content policies.",
    raw: { submitted: true },
    createdAt: new Date(now - 1).toISOString()
  });

  const reviewed = await listTaskPage({ status: "safety_review" });

  assert.equal(reviewed.total, 2);
  assert.deepEqual(
    reviewed.items.map((task) => [task.id, task.listStatus]),
    [
      ["task-safety-review-code", "safety_review"],
      ["task-safety-review-message", "safety_review"]
    ]
  );
});

test("task list keeps the marker for a request rejected before an upstream call", async () => {
  await upsertTask({
    id: "task-returned-before-call",
    status: "failed",
    taskType: "img2img",
    modelId: "gpt",
    requestJson: { model: "gpt" },
    responseJson: {
      status: 503,
      code: "NO_USABLE_ACCOUNT",
      message: "当前没有可用的生图账号，请先检测账号状态或等待额度恢复。"
    },
    raw: { returnedError: true },
    createdAt: new Date().toISOString()
  });

  const page = await listTaskPage({
    keyword: "task-returned-before-call",
    status: "concurrency_limited"
  });
  const failures = await listTaskPage({
    keyword: "task-returned-before-call",
    status: "failed"
  });

  assert.equal(page.total, 1);
  assert.equal(page.items[0].listStatus, "concurrency_limited");
  assert.equal(page.items[0].requestJson.model, "gpt");
  assert.equal(page.items[0].raw.returnedError, true);
  assert.equal(failures.total, 0);
});

test("historical quota rejections are moved out of the failure filter", async () => {
  const taskId = "task-historical-quota-rejection";
  await upsertTask({
    id: taskId,
    status: "failed",
    taskType: "img2img",
    errorMessage: "任务失败：可用账号额度不足或暂不可用。",
    attempts: [{ quotaEmpty: true, message: "绘图额度不足。" }],
    responseJson: {
      code: "QUOTA_EXHAUSTED",
      attempts: [{ quotaEmpty: true, message: "绘图额度不足。" }]
    },
    raw: { returnedError: true },
    createdAt: new Date().toISOString()
  });
  await closeStorage();

  const database = new Database(path.join(dataDir, "storage.sqlite"));
  database.prepare("UPDATE tasks SET list_status = 'failed' WHERE id = ?").run(taskId);
  database.prepare("DELETE FROM storage_meta WHERE key = ?").run("task_list_concurrency_limited_v2");
  database.close();

  const concurrencyLimited = await listTaskPage({
    keyword: taskId,
    status: "concurrency_limited"
  });
  const failures = await listTaskPage({ keyword: taskId, status: "failed" });

  assert.equal(concurrencyLimited.total, 1);
  assert.equal(concurrencyLimited.items[0].listStatus, "concurrency_limited");
  assert.equal(failures.total, 0);
});

test("task pages return lightweight summaries and load large details only on demand", async () => {
  const imageData = `data:image/png;base64,${"A".repeat(180_000)}`;
  const previewUrl = "/uploads/previews/task-large-chat.png";
  const longReply = `完整回复-${"回复内容".repeat(2000)}`;
  await upsertTask({
    id: "task-large-chat",
    sourceTaskId: "large_chat_001",
    status: "success",
    taskType: "chat",
    modelId: "gemini",
    channelType: "chatplus",
    channelId: "channel-google:chatplus",
    accountId: "account-large",
    prompt: `请分析这张图片 ${imageData}`,
    responseText: longReply,
    requestJson: {
      model: "gemini-3.1-pro",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "帮我查找蓝色商品" },
          { type: "image_url", image_url: { url: imageData } }
        ]
      }]
    },
    responseJson: {
      upstreamModel: "gemini-3.1-pro",
      usage: { estimated: true, prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      raw: { fullPayload: "B".repeat(120_000) }
    },
    inputImageUrls: [previewUrl],
    createdAt: new Date().toISOString()
  });

  const page = await listTaskPage({ accountId: "account-large", kind: "chat", pageSize: 30 });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].requestJson.model, "gemini-3.1-pro");
  assert.equal(page.items[0].responseJson.upstreamModel, "gemini-3.1-pro");
  assert.equal(page.items[0].detail.inputImageCount, 1);
  assert.equal(page.items[0].prompt.includes("data:image"), false);
  assert.ok(page.items[0].prompt.length <= 1200);
  assert.ok(page.items[0].responseText.length <= 1200);
  assert.ok(JSON.stringify(page.items[0]).length < 10_000);

  const searched = await listTaskPage({ keyword: "蓝色商品", kind: "chat" });
  assert.equal(searched.items.some((task) => task.id === "task-large-chat"), true);

  const detail = await getTask("task-large-chat");
  assert.equal(detail.requestJson.messages[0].content[1].image_url.url, "[图片内容已省略]");
  assert.deepEqual(detail.inputImageUrls, [previewUrl]);
  assert.equal(JSON.stringify(detail).includes(imageData), false);
  assert.equal(detail.responseText, longReply);
});

test("updating one task does not load unrelated task payloads", async () => {
  await upsertTask({
    id: "task-direct-update",
    status: "processing",
    taskType: "chat",
    createdAt: new Date().toISOString()
  });
  await closeStorage();

  const database = new Database(path.join(dataDir, "storage.sqlite"));
  database.prepare(`
    INSERT INTO tasks (
      id, source_task_id, created_at, created_time, status,
      account_id, channel_id, channel_group, record_kind, list_status, search_text, payload
    ) VALUES (?, '', ?, ?, 'success', '', '', 'chatplus', 'chat', 'success', 'malformed history', ?)
  `).run("task-malformed-history", new Date().toISOString(), Date.now() - 1, "{not-json");
  database.close();

  const stored = await upsertTask({
    id: "task-direct-update",
    status: "success",
    responseText: "done"
  });

  assert.equal(stored.status, "success");
  assert.equal((await getTask("task-direct-update")).responseText, "done");
});
