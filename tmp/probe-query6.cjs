const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });
const row = db.prepare("select payload from tasks where source_task_id = ?").get("batch_draw_17884450136980");
const p = JSON.parse(row.payload);
for (const s of (p.raw && p.raw.stageTimings) || []) {
  console.log([s.label || s.key, s.status, s.startedAt, s.finishedAt || "-", (s.durationMs ?? "") + "ms", s.carId || ""].join(" | "));
}
console.log("slowResultCount", p.raw.slowResultCount, "resultWaitMs", p.raw.resultWaitMs);

const others = db.prepare("select payload from tasks where record_kind='image' order by created_time desc limit 12").all();
console.log("=== OTHER RECENT TASKS stage: 等待上游处理 / 等待结果 ===");
for (const r of others) {
  try {
    const q = JSON.parse(r.payload);
    const st = (q.raw && q.raw.stageTimings) || [];
    const line = st.map(s => (s.label || s.key) + "=" + Math.round((s.durationMs || 0) / 1000) + "s(" + s.status + ")").join(" ");
    console.log(q.status, "|", q.createdAt, "|", line, "| resultWaitMs=", q.raw && q.raw.resultWaitMs, "slow=", q.raw && q.raw.slowResultCount);
  } catch {}
}
