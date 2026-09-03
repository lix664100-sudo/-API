import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let i = lines.findIndex(l => /^\s{2}async sendConversation\(/.test(l));
console.log("sendConversation at line", i + 1);
for (let j = i; j < Math.min(i + 130, lines.length); j++) console.log(j + 1, lines[j]);
