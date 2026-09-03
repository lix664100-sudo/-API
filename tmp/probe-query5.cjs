const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });

const rows = db.prepare(`
select payload from tasks
where record_kind = 'image'
order by created_time desc limit 200`).all();

const items = [];
for (const r of rows) {
  try {
    const p = JSON.parse(r.payload);
    const created = Date.parse(p.createdAt || "");
    const done = Date.parse(p.completedAt || p.updatedAt || "");
    if (!Number.isFinite(created) || !Number.isFinite(done)) continue;
    items.push({ status: p.status, dur: Math.round((done - created) / 1000), at: p.createdAt });
  } catch {}
}
const buckets = { under30: 0, s30_60: 0, s60_120: 0, s120_300: 0, over300: 0 };
for (const it of items) {
  if (it.status !== "success") continue;
  if (it.dur < 30) buckets.under30 += 1;
  else if (it.dur < 60) buckets.s30_60 += 1;
  else if (it.dur < 120) buckets.s60_120 += 1;
  else if (it.dur < 300) buckets.s120_300 += 1;
  else buckets.over300 += 1;
}
console.log("SUCCESS_DURATION_BUCKETS(recent200)", JSON.stringify(buckets));

const recent = items.slice(0, 40);
for (const it of recent) {
  console.log([it.status, it.dur + "s", it.at].join(" | "));
}

const stuck = db.prepare("select payload from tasks where source_task_id = ?").get("batch_draw_17884450136980");
const sp = JSON.parse(stuck.payload);
console.log("STUCK_RAW_KEYS", JSON.stringify(Object.keys(sp.raw || {})));
const raw = sp.raw || {};
for (const [k, v] of Object.entries(raw)) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  console.log("raw." + k + " = " + (s.length > 400 ? s.slice(0, 400) + "...[truncated]" : s));
}
