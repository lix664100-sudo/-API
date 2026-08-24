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
    `${adminHtml.slice(start, end)}\nthis.helpers = { productivityDayData, productivityTrendData };`,
    context
  );
  return context.helpers;
}

function localValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test("未分配请求不会成为账号，也不会拉低账号平均产值", () => {
  const { productivityDayData } = loadProductivityHelpers();
  const day = "2026-08-24";
  const accounts = [
    { id: "account-a", name: "账号A" },
    { id: "account-b", name: "账号B" }
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
    { id: "account-a", name: "账号A" },
    { id: "account-b", name: "账号B" }
  ];
  const daily = {
    days: [day],
    records: [
      { day, recordKind: "image", accountId: "account-a", tasks: 2, successTasks: 2, successImages: 3 },
      { day, recordKind: "chat", accountId: "account-a", tasks: 4, successTasks: 3, failedTasks: 1 },
      { day, recordKind: "image", accountId: "account-b", tasks: 1, successTasks: 1, successImages: 7 },
      { day, recordKind: "chat", accountId: "account-b", tasks: 8, successTasks: 8 },
      { day, recordKind: "image", accountId: "", tasks: 9, failedTasks: 9 }
    ]
  };

  const selected = localValue(productivityDayData(daily, accounts, day, "account-a"));
  const trend = localValue(productivityTrendData(daily, { days: [] }, 7, "account-a"));

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
