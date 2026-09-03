const D = require("/opt/ikun-aishare-api/node_modules/better-sqlite3");
const db = D("/tmp/probe/storage.sqlite", { fileMustExist: true });
const r = db.prepare("select count(*) c, max(updated_time) newest, min(updated_time) oldest from chatplus_conversation_updates").get();
console.log("UPDATES", JSON.stringify(r), "newestDate", new Date(r.newest || 0).toISOString());
const per = db.prepare("select conversation_id, count(*) c, max(updated_time) t from chatplus_conversation_updates group by conversation_id order by t desc limit 10").all();
for (const x of per) console.log(x.conversation_id, x.c, new Date(x.t).toISOString());
