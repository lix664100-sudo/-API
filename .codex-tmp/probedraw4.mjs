import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/drawing.js", "utf8");
const lines = s.split("\n");
const start = lines.findIndex(l => l.includes("async performLogin"));
for (let i = start; i < Math.min(start + 85, lines.length); i++) console.log(i + 1, lines[i]);
