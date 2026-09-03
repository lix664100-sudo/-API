import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let i = lines.findIndex(l => /^\s{2}async json\(/.test(l));
console.log("json() at", i + 1);
for (let j = i; j < i + 30; j++) console.log(j + 1, lines[j]);
console.log("---- fetchHttp ----");
i = lines.findIndex(l => /^\s{2}async fetchHttp\(/.test(l));
for (let j = i; j < i + 45; j++) console.log(j + 1, lines[j]);
