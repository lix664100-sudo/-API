import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
console.log("file has CRLF:", s.includes("\r\n"));
const msg = "这个聊天账号还没有填写账号或密码";
console.log("msg count:", s.split(msg).length - 1);
const i = s.indexOf(msg);
console.log(JSON.stringify(s.slice(i - 150, i + 60)));
