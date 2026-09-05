import { readFile } from "node:fs/promises";
import { getTask } from "../src/storage.js";

const base = "http://127.0.0.1:3210";
const config = JSON.parse(await readFile("./data/config.json", "utf8"));
const apiKey = String(config.apiKey || "");
const account = (config.accounts || []).find((item) => item.channelId === "shareai" && item.enabled !== false);
if (!apiKey || !account?.id) throw new Error("线上配置缺少可用的 ShareAI 账号");
const probes = [
  { key: "A", file: "/tmp/flow-probe-A.jpg", prompt: "将水龙头背景改为简洁浅灰摄影棚，保持产品结构不变" },
  { key: "B", file: "/tmp/flow-probe-B.jpg", prompt: "将水龙头背景改为温暖米色摄影棚，保持产品结构不变" }
];
const startedAt = Date.now();
const maskCar = (value) => { const text = String(value || ""); return text ? (text.length <= 6 ? text.slice(0, 2) + "***" : text.slice(0, 4) + "***" + text.slice(-2)) : ""; };

async function submit(probe) {
  const bytes = await readFile(probe.file);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/jpeg" }), probe.key + ".jpg");
  form.append("prompt", probe.prompt);
  form.append("model", "gpt-image-2");
  form.append("account_id", account.id);
  form.append("channel", "shareai:chatplus");
  const requestAt = Date.now();
  const response = await fetch(base + "/v1/images/edits?wait=0", { method: "POST", headers: { authorization: "Bearer " + apiKey }, body: form });
  const body = await response.json();
  if (!response.ok && response.status !== 202) throw new Error(probe.key + " 提交失败 " + response.status + ": " + (body?.error?.message || body?.message || "未知错误"));
  return { key: probe.key, id: body?.task?.id, requestAt, ackAt: Date.now(), http: response.status };
}

const submissions = await Promise.allSettled(probes.map(submit));
const tasks = submissions.filter((item) => item.status === "fulfilled").map((item) => item.value);
console.log(JSON.stringify({ event: "submitted", elapsedMs: Date.now() - startedAt, tasks: tasks.map((task) => ({ key: task.key, id: task.id, ackMs: task.ackAt - task.requestAt, http: task.http })), errors: submissions.filter((item) => item.status === "rejected").map((item) => String(item.reason?.message || item.reason)) }));
if (!tasks.length) process.exit(2);
const state = new Map(tasks.map((task) => [task.id, { ...task, last: "" }]));
const deadline = Date.now() + 12 * 60 * 1000;
while (Date.now() < deadline) {
  let finished = 0;
  for (const task of state.values()) {
    const response = await fetch(base + "/v1/images/tasks/" + encodeURIComponent(task.id), { headers: { authorization: "Bearer " + apiKey } });
    const body = await response.json();
    const status = body?.task?.status || "http_" + response.status;
    if (status !== task.last) {
      console.log(JSON.stringify({ event: "status", key: task.key, id: task.id, elapsedMs: Date.now() - startedAt, status, externalAssigned: Boolean(body?.task?.externalId), imageCount: Number(body?.task?.imageCount || 0), error: body?.task?.errorMessage || body?.error?.message || "" }));
      task.last = status;
    }
    if (["success", "failed", "cancelled", "interrupted"].includes(String(status).toLowerCase())) { task.final = body.task; finished += 1; }
  }
  if (finished === state.size) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const details = [];
for (const task of state.values()) {
  const stored = await getTask(task.id);
  details.push({ key: task.key, id: task.id, channelId: stored?.channelId || "", channelType: stored?.channelType || "", status: stored?.status || task.last, imageCount: Number(stored?.imageCount || 0), createdAt: stored?.createdAt || null, completedAt: stored?.completedAt || null, submittedAt: stored?.raw?.submittedAt || null, car: maskCar(stored?.raw?.selectedCarId), stages: (stored?.raw?.stageTimings || []).map((stage) => ({ key: stage.key, label: stage.label, status: stage.status, car: maskCar(stage.carId), startedAt: stage.startedAt, finishedAt: stage.finishedAt, durationMs: stage.durationMs, message: stage.message || "" })), error: stored?.errorMessage || "" });
}
console.log(JSON.stringify({ event: "final", elapsedMs: Date.now() - startedAt, tasks: details }));
