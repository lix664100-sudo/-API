import { readFile } from "node:fs/promises";
import { ChatplusClient } from "../src/channels/chatplus.js";

const config = JSON.parse(await readFile("./data/config.json", "utf8"));
const base = (config.channels || []).find((item) => item.id === "shareai");
const account = (config.accounts || []).find((item) => item.channelId === "shareai" && item.enabled !== false);
if (!base || !account) throw new Error("missing config");
const channel = { ...base, id: "shareai:chatplus", type: "chatplus", ability: "chatplus", settings: { ...base.settings, baseUrl: base.settings.chatBaseUrl } };
const context = { config, channel, account, sessionLock: async (work) => work() };
const clients = [new ChatplusClient(context), new ChatplusClient(context)];
const files = ["/tmp/flow-probe-A.jpg", "/tmp/flow-probe-B.jpg"];
const prompts = ["将水龙头背景改为简洁浅灰摄影棚，保持产品结构不变", "将水龙头背景改为温暖米色摄影棚，保持产品结构不变"];
const started = Date.now();
const run = (client, i) => client.createImageTask({
  prompt: prompts[i], files: [files[i]], model: "gpt-image-2", concurrentSubmit: true,
  waitForImages: false, waitTimeoutSec: 30, imageGeneration: true, preferImageCar: true
}).then((r) => ({ i, ok: true, elapsedMs: Date.now() - started, conversationId: Boolean(r.externalId || r.conversationId), selectedCar: Boolean(r.raw?.selectedCarId), error: r.errorMessage || "" }))
  .catch((e) => ({ i, ok: false, elapsedMs: Date.now() - started, error: String(e?.message || e) }));
console.log(JSON.stringify({ event: "independent_clients_started", count: clients.length }));
console.log(JSON.stringify({ event: "results", results: await Promise.all(clients.map(run)) }));
for (const client of clients) {
  try { await client.close?.(); } catch {}
}
