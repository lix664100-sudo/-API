import { readFile } from "node:fs/promises";
import { ChatplusClient } from "../src/channels/chatplus.js";

const config = JSON.parse(await readFile("./data/config.json", "utf8"));
const requestedAccountId = String(process.env.TEST_ACCOUNT_ID || "").trim();
const account = config.accounts.find((item) => (
  (!requestedAccountId || item.id === requestedAccountId)
  && item.enabled !== false
));
const sourceChannel = config.channels.find((item) => item.id === account?.channelId && item.enabled !== false);
if (!account || !sourceChannel) throw new Error("没有找到可用的 ShareAI 测试账号");

const channel = {
  ...sourceChannel,
  id: `${sourceChannel.id}:chatplus`,
  parentId: sourceChannel.id,
  ability: "chatplus",
  type: "chatplus",
  settings: {
    ...sourceChannel.settings,
    baseUrl: sourceChannel.settings.chatBaseUrl || "https://www.chatplus.cc",
    defaultChatModel: sourceChannel.settings.defaultChatModel || "gpt"
  }
};

function mask(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 3)}***${text.slice(-2)}` : "";
}

const startedAt = Date.now();
const client = new ChatplusClient({ config, channel, account, sessionLock: async (work) => work() });
let enterCount = 0;
const originalEnterCar = client.enterCar.bind(client);
client.enterCar = async (...args) => {
  enterCount += 1;
  return originalEnterCar(...args);
};

const carAttempts = Math.min(5, Math.max(1, Number(process.env.CAR_ATTEMPTS || 1)));
const useIdleCarSwitch = process.env.USE_IDLE_CAR_SWITCH === "1";
async function prepareIdleCarSession() {
  await client.loginPortal();
  const switched = await client.json("/frontend-api/getIdleCar", { method: "GET" });
  if (Number(switched?.code) !== 1) throw new Error(switched?.msg || "一键换车没有分配到可用车位。");
  const page = await client.http("/", { followRedirect: true });
  if (page.status >= 400) throw new Error(`一键换车后进入聊天页面失败：${page.status}`);
  const current = await client.json("/frontend-api/getConfig", { method: "GET" });
  const carId = String(current?.data?.teamId || "").trim();
  if (Number(current?.code) !== 1 || !carId) throw new Error(current?.msg || "一键换车后没有读到新车位编号。");
  client.carId = carId;
  client.carType = "chatgpt";
  const route = client.chatRouteForInput({ model: "gpt", preferImageCar: true });
  const init = await client.loadInit();
  return {
    route,
    selected: { carId, carType: "chatgpt", car: { id: carId } },
    init,
    snapshot: client.sessionSnapshot()
  };
}
const session = useIdleCarSwitch
  ? await prepareIdleCarSession()
  : await client.prepareChatSession({ model: "gpt", preferImageCar: true }, new Set(), carAttempts);
const { selected, snapshot } = session;
const model = session.route.model || session.init?.default_model_slug || client.defaultModel;
console.log(JSON.stringify({
  event: "car_ready",
  elapsedMs: Date.now() - startedAt,
  car: mask(selected.carId),
  carType: selected.carType,
  enterCount
}));

async function submit(key, prompt) {
  const submitClient = client;
  const { body } = submitClient.buildConversationBody(prompt, model);
  const requestAt = Date.now();
  const response = await client.runConversationSubmit(selected, async () => submitClient.http("/backend-api/conversation", {
    method: "POST",
    body,
    headers: { accept: "text/event-stream", referer: `${submitClient.baseUrl}/` }
  }), null, { serializeWork: true });
  const conversationId = String(response.body || "").match(/"conversation_id"\s*:\s*"([^"]+)"/)?.[1] || "";
  if (response.status < 200 || response.status >= 300 || !conversationId) {
    const upstreamMessage = String(response.body || "").replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`${key} 提交失败：${response.status || 0}${conversationId ? "" : "，未取得任务编号"}${upstreamMessage ? `，上游：${upstreamMessage}` : ""}`);
  }
  return { key, conversationId, requestAt, submittedAt: Date.now() };
}

const submissions = await Promise.allSettled([
  submit("A", "请生成一张简洁的蓝色几何图形海报，不要文字。"),
  submit("B", "请生成一张简洁的橙色几何图形海报，不要文字。")
]);
const tasks = submissions.filter((item) => item.status === "fulfilled").map((item) => item.value);
console.log(JSON.stringify({
  event: "submitted",
  elapsedMs: Date.now() - startedAt,
  enterCount,
  sameCar: true,
  tasks: tasks.map((item) => ({ key: item.key, task: mask(item.conversationId), submitMs: item.submittedAt - startedAt })),
  errors: submissions.filter((item) => item.status === "rejected").map((item) => String(item.reason?.message || item.reason))
}));
if (tasks.length !== 2) process.exit(2);

const states = new Map(tasks.map((task) => [task.conversationId, { ...task, last: "" }]));
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  const results = await Promise.all([...states.values()].map(async (task) => {
    const reader = client;
    try {
      return [task.conversationId, await reader.getTask(task.conversationId, {
        imageTask: true,
        carId: selected.carId,
        carType: selected.carType,
        sessionSnapshot: snapshot,
        timeoutSec: 20
      })];
    } catch (error) {
      return [task.conversationId, { status: "read_error", errorMessage: String(error?.message || error) }];
    }
  }));
  let finished = 0;
  for (const [id, result] of results) {
    const task = states.get(id);
    const status = String(result?.status || "unknown");
    if (status !== task.last) {
      console.log(JSON.stringify({
        event: "status",
        key: task.key,
        task: mask(id),
        elapsedMs: Date.now() - startedAt,
        status,
        imageCount: Number(result?.imageCount || 0),
        error: String(result?.errorMessage || "").slice(0, 160)
      }));
      task.last = status;
    }
    if (["success", "failed", "cancelled", "interrupted"].includes(status)) finished += 1;
  }
  if (finished === states.size) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log(JSON.stringify({
  event: "final",
  elapsedMs: Date.now() - startedAt,
  enterCount,
  tasks: [...states.values()].map((item) => ({ key: item.key, task: mask(item.conversationId), status: item.last }))
}));
