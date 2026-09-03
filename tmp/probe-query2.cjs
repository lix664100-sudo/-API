const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });
console.log("TASK_COLS", JSON.stringify(db.prepare("pragma table_info(tasks)").all().map(c => c.name)));
console.log("TASK_COUNT", JSON.stringify(db.prepare("select count(*) c from tasks").get()));

const rows = db.prepare("select * from tasks where id like ? or id like ? order by rowid desc limit 10")
  .all("%f0509acb%", "%17884450136980%");
console.log("MATCHES", rows.length);
for (const row of rows) {
  for (const [k, v] of Object.entries(row)) {
    const s = String(v ?? "");
    console.log(k + " = " + (s.length > 1200 ? s.slice(0, 1200) + "...[truncated]" : s));
  }
  console.log("----");
}
