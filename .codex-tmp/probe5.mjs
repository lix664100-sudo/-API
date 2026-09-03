import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let start = lines.findIndex(l => l.includes("async performPortalLogin"));
console.log("performPortalLogin at line", start + 1);
for (let i = start; i < Math.min(start + 75, lines.length); i++) console.log(i + 1, lines[i]);
