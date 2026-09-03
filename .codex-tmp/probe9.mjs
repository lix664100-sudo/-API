import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let i = lines.findIndex(l => /^\s{2}async sendConversation\(/.test(l));
for (let j = i + 130; j < Math.min(i + 260, lines.length); j++) console.log(j + 1, lines[j]);
