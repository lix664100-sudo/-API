const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });
const tables = db.prepare("select name from sqlite_master where type='table'").all();
console.log("TABLES", JSON.stringify(tables.map(t => t.name)));

const taskId = "task-f0509acb-1da5-49e7-89be-76cbffb6b148";
for (const name of tables.map(t => t.name)) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
  let cols = [];
  try {
    cols = db.prepare("pragma table_info(" + name + ")").all().map(c => c.name);
  } catch { continue; }
  if (!cols.includes("id")) continue;
  let row = null;
  try {
    row = db.prepare("select * from " + name + " where id = ?").get(taskId);
  } catch { continue; }
  if (!row) continue;
  console.log("FOUND_IN", name);
  for (const [k, v] of Object.entries(row)) {
    const s = String(v ?? "");
    console.log(k + " = " + (s.length > 800 ? s.slice(0, 800) + "...[truncated]" : s));
  }
}
