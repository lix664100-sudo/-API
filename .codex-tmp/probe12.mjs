import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let i = lines.findIndex(l => l.includes("function isAuthSessionError"));
for (let j = i; j < i + 15; j++) console.log(j + 1, lines[j]);
console.log("---- resetSession ----");
i = lines.findIndex(l => /^\s{2}resetSession\(/.test(l));
for (let j = i; j < i + 22; j++) console.log(j + 1, lines[j]);
