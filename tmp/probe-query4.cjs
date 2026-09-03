const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });

console.log("UPD_COLS", JSON.stringify(db.prepare("pragma table_info(chatplus_conversation_updates)").all().map(c => c.name)));
const conv = "6a99815e-7d24-83e9-ae53-0e1051df4cd1";
let rows = [];
try {
  rows = db.prepare("select * from chatplus_conversation_updates where conversation_id = ? or id like ? limit 5").all(conv, "%" + conv.slice(0, 8) + "%");
} catch (e) {
  try {
    rows = db.prepare("select * from chatplus_conversation_updates limit 3").all();
  } catch {}
}
console.log("UPD_ROWS", rows.length);
for (const r of rows) {
  for (const [k, v] of Object.entries(r)) {
    const s = String(v ?? "");
    console.log(k + " = " + (s.length > 300 ? s.slice(0, 300) + "...[truncated]" : s));
  }
  console.log("---");
}

const recent = db.prepare(`
select id, status, created_at, completed_at,
  cast((julianday(coalesce(completed_at, updated_at)) - julianday(created_at)) * 86400 as integer) as dur_sec
from tasks
where record_kind = 'image'
order by created_time desc limit 60`).all();
console.log("RECENT_TASKS (newest first):");
for (const r of recent) {
  console.log([r.status, r.dur_sec + "s", r.created_at, r.completed_at || "-", r.id.slice(0, 18)].join(" | "));
}

const buckets = db.prepare(`
select
  sum(case when d < 30 then 1 else 0 end) as under30,
  sum(case when d >= 30 and d < 60 then 1 else 0 end) as s30_60,
  sum(case when d >= 60 and d < 120 then 1 else 0 end) as s60_120,
  sum(case when d >= 120 and d < 300 then 1 else 0 end) as s120_300,
  sum(case when d >= 300 then 1 else 0 end) as over300,
  count(*) as total
from (
  select cast((julianday(completed_at) - julianday(created_at)) * 86400 as integer) as d
  from tasks
  where record_kind = 'image' and status = 'success' and completed_at is not null
  and created_time > (select max(created_time) from tasks) - 24*3600*1000
)`).get();
console.log("DURATION_BUCKETS_24H", JSON.stringify(buckets));
