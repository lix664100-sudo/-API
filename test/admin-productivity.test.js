import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

function loadProductivityHelpers() {
  const start = adminHtml.indexOf("function productivityEmptyRow");
  const end = adminHtml.indexOf("function IntradayOutputChart", start);
  assert.ok(start >= 0 && end > start, "账号产值汇总逻辑必须存在");
  const context = {
    numberValue: (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    },
    taskRecordKind: (record) => record?.recordKind || (record?.taskType === "chat" ? "chat" : "image")
  };
  vm.runInNewContext(
    `${adminHtml.slice(start, end)}\nthis.helpers = { productivityDayData, productivityRangeData, productivityRuntimeData, productivityTrendData, productivityAccountCompletion };`,
    context
  );
  return context.helpers;
}

function localValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test("账号卡片同时展示今日完成任务、图片、对话和失败数", () => {
  const { productivityAccountCompletion } = loadProductivityHelpers();
  const result = localValue(productivityAccountCompletion({
    imageTasks: 7,
    successImages: 12,
    imageFailedTasks: 2,
    chatTasks: 5,
    chatSuccessTasks: 4,
    chatFailedTasks: 1
  }));

  assert.deepEqual(result, {
    totalTasks: 12,
    successImages: 12,
    successChats: 4,
    failedTasks: 3
  });
});

test("未分配请求不会成为账号，也不会拉低账号平均产值", () => {
  const { productivityDayData } = loadProductivityHelpers();
  const day = "2026-08-24";
  const accounts = [
    { id: "account-a", name: "账号A", channelId: "channel-a" },
    { id: "account-b", name: "账号B", channelId: "channel-b" }
  ];
  const daily = {
    days: [day],
    records: [
      {
        day,
        recordKind: "image",
        accountId: "account-a",
        accountName: "账号A",
        tasks: 2,
        successTasks: 2,
        failedTasks: 0,
        successImages: 5,
        durationMsTotal: 120000,
        durationSamples: 2
      },
      {
        day,
        recordKind: "chat",
        accountId: "account-a",
        accountName: "账号A",
        tasks: 5,
        successTasks: 4,
        failedTasks: 1,
        durationMsTotal: 40000,
        durationSamples: 4
      },
      {
        day,
        recordKind: "image",
        accountId: "",
        tasks: 222,
        successTasks: 0,
        failedTasks: 222,
        systemRejectedTasks: 0
      },
      {
        day,
        recordKind: "image",
        accountId: "",
        tasks: 0,
        failedTasks: 0,
        systemRejectedTasks: 426
      }
    ]
  };

  const result = localValue(productivityDayData(daily, accounts, day));

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.some((row) => row.id === "unknown"), false);
  assert.equal(result.activeAccounts, 1);
  assert.equal(result.activeImageAccounts, 1);
  assert.equal(result.totalImages, 5);
  assert.equal(result.totalChats, 4);
  assert.equal(result.averageImagesPerAccount, 5);
  assert.equal(result.averageChatsPerAccount, 4);
  assert.equal(result.preAssignmentImageTasks, 648);
  assert.equal(result.preAssignmentTasks, 648);
});

test("选择账号后，生图、对话、趋势和未分配请求使用同一筛选范围", () => {
  const { productivityDayData, productivityTrendData } = loadProductivityHelpers();
  const day = "2026-08-24";
  const accounts = [
    { id: "account-a", name: "账号A", channelId: "channel-a" },
    { id: "account-b", name: "账号B", channelId: "channel-b" }
  ];
  const daily = {
    days: [day],
    records: [
      { day, recordKind: "image", accountId: "account-a", channelId: "channel-a", tasks: 2, successTasks: 2, successImages: 3 },
      { day, recordKind: "chat", accountId: "account-a", channelId: "channel-a", tasks: 4, successTasks: 3, failedTasks: 1 },
      { day, recordKind: "image", accountId: "account-b", channelId: "channel-b", tasks: 1, successTasks: 1, successImages: 7 },
      { day, recordKind: "chat", accountId: "account-b", channelId: "channel-b", tasks: 8, successTasks: 8 },
      { day, recordKind: "image", accountId: "", tasks: 9, failedTasks: 9 }
    ]
  };

  const selected = localValue(productivityDayData(daily, accounts, day, "account-a"));
  const trend = localValue(productivityTrendData(
    daily,
    { days: [] },
    day,
    day,
    "account-a",
    "channel-a",
    accounts
  ));

  assert.equal(selected.rows.length, 1);
  assert.equal(selected.rows[0].id, "account-a");
  assert.equal(selected.totalImages, 3);
  assert.equal(selected.totalChats, 3);
  assert.equal(selected.preAssignmentTasks, 0);
  assert.equal(trend[0].totalImages, 3);
  assert.equal(trend[0].totalChats, 3);
  assert.equal(trend[0].imageSuccessRate, 100);
  assert.equal(trend[0].chatSuccessRate, 75);
});

test("日期范围与渠道筛选会同步影响汇总、趋势和系统并发", () => {
  const { productivityRangeData, productivityRuntimeData, productivityTrendData } = loadProductivityHelpers();
  const startDay = "2026-08-23";
  const endDay = "2026-08-24";
  const accounts = [
    { id: "account-a", name: "账号A", channelId: "channel-a" },
    { id: "account-b", name: "账号B", channelId: "channel-b" }
  ];
  const daily = {
    days: [startDay, endDay],
    records: [
      { day: startDay, recordKind: "image", accountId: "account-a", channelId: "channel-a", tasks: 1, successTasks: 1, successImages: 2 },
      { day: endDay, recordKind: "image", accountId: "account-a", channelId: "channel-a", tasks: 1, successTasks: 1, successImages: 3 },
      { day: endDay, recordKind: "chat", accountId: "account-a", channelId: "channel-a", tasks: 3, successTasks: 2, failedTasks: 1 },
      { day: endDay, recordKind: "image", accountId: "account-b", channelId: "channel-b", tasks: 1, successTasks: 1, successImages: 9 },
      { day: endDay, recordKind: "image", accountId: "", channelId: "channel-a", tasks: 4, failedTasks: 4 }
    ]
  };
  const concurrency = {
    days: [
      { day: startDay, samples: 2, averageRunning: 1, peakRunning: 2, averageConfigured: 10 },
      { day: endDay, samples: 1, averageRunning: 4, peakRunning: 5, averageConfigured: 13 }
    ]
  };

  const range = localValue(productivityRangeData(
    daily,
    accounts,
    startDay,
    endDay,
    "all",
    "channel-a"
  ));
  const trend = localValue(productivityTrendData(
    daily,
    concurrency,
    startDay,
    endDay,
    "all",
    "channel-a",
    accounts
  ));
  const runtime = localValue(productivityRuntimeData(concurrency, startDay, endDay));

  assert.equal(range.rows.length, 1);
  assert.equal(range.rows[0].id, "account-a");
  assert.equal(range.totalImages, 5);
  assert.equal(range.totalChats, 2);
  assert.equal(range.preAssignmentTasks, 4);
  assert.deepEqual(trend.map((row) => row.totalImages), [2, 3]);
  assert.deepEqual(trend.map((row) => row.totalChats), [0, 2]);
  assert.equal(runtime.samples, 3);
  assert.equal(runtime.averageRunning, 2);
  assert.equal(runtime.peakRunning, 5);
  assert.equal(runtime.averageConfigured, 11);
});
