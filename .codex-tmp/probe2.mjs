import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const probe = `  assertConfigured() {
    if (!this.account?.username || !this.account?.password) {
      throw new Error("这个聊天账号还没有填写账号或密码。");
    }
  }`;
console.log("probe has CRLF:", probe.includes("\r\n"));
console.log("probe count:", s.split(probe).length - 1);
