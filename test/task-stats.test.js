import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeDailyTaskStats } from "../src/storage.js";

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
    successImages: 2
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
