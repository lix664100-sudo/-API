const fs = require("fs");
const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });
const row = db.prepare("select payload from tasks where source_task_id = ?").get("batch_draw_17884450136980");
const p = JSON.parse(row.payload);
const pick = {};
for (const k of Object.keys(p)) {
  if (k === "prompt" || k === "searchText") continue;
  pick[k] = p[k];
}
fs.writeFileSync("/tmp/probe/payload.json", JSON.stringify(pick, null, 2));
console.log("KEYS", Object.keys(p).join(","));
console.log("status", p.status);
console.log("createdAt", p.createdAt, "updatedAt", p.updatedAt, "completedAt", p.completedAt);
console.log("stageTiming", JSON.stringify(p.stageTiming || p.timings || p.timing || null));
console.log("errorHistory", JSON.stringify(p.errorHistory || p.errors || null));
console.log("upstreamTaskId", p.upstreamTaskId, "conversationId", p.conversationId || p.externalId);
