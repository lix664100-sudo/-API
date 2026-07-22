import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeRuntimeStatSample,
  summarizeDailyRuntimeStats,
  summarizeDailyTaskStats,
  summarizeIntradayTaskStats,
  summarizeRecentTaskStats
} from "../src/storage.js";

test("compact task stats preserve totals while combining repeated records", () => {
  const now = Date.parse("2026-07-22T12:00:00+08:00");
  const records = [
    {
      day: "2026-07-22",
      time: Date.parse("2026-07-22T09:00:00+08:00"),
      status: "success",
      taskType: "img2img",
      accountId: "account-a",
      channelGroup: "drawing",
      tasks: 1,
      successImages: 2
    },
    {
      day: "2026-07-22",
      time: Date.parse("2026-07-22T10:00:00+08:00"),
      status: "success",
      taskType: "img2img",
      accountId: "account-a",
      channelGroup: "drawing",
      tasks: 1,
      successImages: 1
    },
    {
      day: "2026-07-22",
      time: Date.parse("2026-07-22T11:00:00+08:00"),
      status: "failed",
      taskType: "img2img",
      accountId: "account-a",
      channelGroup: "drawing",
      tasks: 1,
      failedTasks: 1
    }
  ];

  const summary = summarizeRecentTaskStats(records, 7, now);
  assert.equal(summary.length, 2);
  assert.deepEqual(summary.find((record) => record.status === "success"), {
    day: "2026-07-22",
    status: "success",
    taskType: "img2img",
    accountId: "account-a",
    accountName: "",
    channelId: "",
    channelName: "",
    channelType: "",
    channelGroup: "drawing",
    tasks: 2,
    successImages: 3,
    failedTasks: 0
  });
  assert.equal(summary.find((record) => record.status === "failed").failedTasks, 1);
});

test("最近生图趋势按北京时间汇总成功和失败，并补齐没有任务的日期", () => {
  const now = Date.parse("2026-07-18T12:00:00+08:00");
  const summary = summarizeDailyTaskStats([
    {
      day: "2026-07-05",
      time: Date.parse("2026-07-05T09:00:00+08:00"),
      status: "success",
      taskType: "text2img",
      tasks: 1,
      successImages: 2,
      durationMs: 90000,
      accountId: "account-a",
      accountName: "账号A",
      channelGroup: "drawing"
    },
    {
      day: "2026-07-05",
      time: Date.parse("2026-07-05T10:00:00+08:00"),
      status: "failed",
      taskType: "text2img",
      tasks: 1,
      failedTasks: 1,
      accountId: "account-a",
      accountName: "账号A",
      channelGroup: "drawing"
    },
    {
      time: Date.parse("2026-07-04T16:30:00Z"),
      status: "success",
      taskType: "img2img",
      tasks: 1,
      successImages: 1,
      durationMs: 120000,
      accountId: "account-b",
      accountName: "账号B",
      channelGroup: "chatplus"
    },
    {
      day: "2026-06-18",
      time: Date.parse("2026-06-18T12:00:00+08:00"),
      status: "failed",
      taskType: "text2img",
      tasks: 1,
      failedTasks: 1,
      accountId: "account-a",
      channelGroup: "drawing"
    },
    {
      day: "2026-07-05",
      time: Date.parse("2026-07-05T11:00:00+08:00"),
      status: "success",
      taskType: "chat",
      tasks: 1,
      successImages: 1,
      accountId: "account-a",
      channelGroup: "chatplus"
    },
    {
      day: "2026-07-05",
      time: Date.parse("2026-07-05T12:00:00+08:00"),
      status: "failed",
      taskType: "chat",
      tasks: 1,
      failedTasks: 1,
      accountId: "account-a",
      channelGroup: "chatplus"
    }
  ], 30, now);

  assert.equal(summary.days.length, 30);
  assert.equal(summary.days.at(-1), "2026-07-18");
  assert.ok(summary.days.includes("2026-07-06"));
  assert.equal(summary.records.length, 2);

  const drawing = summary.records.find((record) => record.accountId === "account-a");
  assert.deepEqual(drawing, {
    day: "2026-07-05",
    accountId: "account-a",
    accountName: "账号A",
    channelGroup: "drawing",
    tasks: 2,
    successTasks: 1,
    failedTasks: 1,
    successImages: 2,
    durationMsTotal: 90000,
    durationSamples: 1,
    averageDurationMs: 90000
  });

  const chatplus = summary.records.find((record) => record.accountId === "account-b");
  assert.equal(chatplus.day, "2026-07-05");
  assert.equal(chatplus.successTasks, 1);
  assert.equal(chatplus.failedTasks, 0);
});

test("趋势范围会限制在服务器保留的天数内", () => {
  const now = Date.parse("2026-07-18T12:00:00+08:00");
  const summary = summarizeDailyTaskStats([], 90, now);

  assert.equal(summary.days.length, 31);
  assert.deepEqual(summary.records, []);
});

test("并发统计会计算每天的平均、峰值和配置上限", () => {
  const now = Date.parse("2026-07-18T12:00:00+08:00");
  let stats = mergeRuntimeStatSample({}, {
    time: Date.parse("2026-07-18T10:00:00+08:00"),
    running: 2,
    configured: 14,
    available: 12
  });
  stats = mergeRuntimeStatSample(stats, {
    time: Date.parse("2026-07-18T10:00:30+08:00"),
    running: 6,
    configured: 14,
    available: 12
  });

  const summary = summarizeDailyRuntimeStats(stats, 7, now);
  const today = summary.days.at(-1);

  assert.deepEqual(today, {
    day: "2026-07-18",
    samples: 2,
    averageRunning: 4,
    peakRunning: 6,
    averageConfigured: 14,
    averageAvailable: 12,
    firstSampleAt: Date.parse("2026-07-18T10:00:00+08:00"),
    lastSampleAt: Date.parse("2026-07-18T10:00:30+08:00")
  });
  assert.deepEqual(summary.days.at(-2), { day: "2026-07-17", samples: 0 });
});

test("分时出图按北京时间每30分钟统计成功图片", () => {
  const day = "2026-07-18";
  const summary = summarizeIntradayTaskStats([
    {
      day,
      time: Date.parse("2026-07-18T09:05:00+08:00"),
      status: "success",
      taskType: "text2img",
      tasks: 1,
      successImages: 2,
      accountId: "account-a"
    },
    {
      day,
      time: Date.parse("2026-07-18T09:29:59+08:00"),
      status: "failed",
      taskType: "img2img",
      tasks: 1,
      failedTasks: 1,
      accountId: "account-a"
    },
    {
      day,
      time: Date.parse("2026-07-18T09:30:00+08:00"),
      status: "success",
      taskType: "img2img",
      tasks: 1,
      successImages: 1,
      accountId: "account-b"
    },
    {
      day,
      time: Date.parse("2026-07-18T09:15:00+08:00"),
      status: "success",
      taskType: "chat",
      tasks: 1,
      successImages: 1,
      accountId: "account-a"
    }
  ], day);

  assert.equal(summary.buckets.length, 48);
  assert.equal(summary.buckets[0].start, "00:00");
  assert.equal(summary.buckets.at(-1).end, "24:00");
  assert.deepEqual(summary.buckets[18], {
    index: 18,
    startMinute: 540,
    start: "09:00",
    end: "09:30",
    tasks: 2,
    successTasks: 1,
    failedTasks: 1,
    successImages: 2,
    accountCount: 1,
    successRate: 50
  });
  assert.equal(summary.buckets[19].successImages, 1);
  assert.equal(summary.totalImages, 3);
  assert.equal(summary.failedTasks, 1);
  assert.deepEqual(summary.peak, { start: "09:00", end: "09:30", successImages: 2 });
});
