import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
// find http( method
let i = lines.findIndex(l => /^\s{2}async http\(/.test(l));
console.log("http() at line", i + 1);
for (let j = i; j < Math.min(i + 90, lines.length); j++) console.log(j + 1, lines[j]);
