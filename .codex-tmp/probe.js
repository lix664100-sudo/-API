const s = require("fs").readFileSync("src/channels/chatplus.js", "utf8");
const crlf = s.includes("\r\n");
console.log("file has CRLF:", crlf);
const msg = "这个聊天账号还没有填写账号或密码";
const i = s.indexOf(msg);
console.log("msg count:", s.split(msg).length - 1);
console.log(JSON.stringify(s.slice(i - 150, i + 60)));
