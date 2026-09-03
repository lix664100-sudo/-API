import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/drawing.js", "utf8");
const lines = s.split("\n");
for (let i = 120; i < Math.min(330, lines.length); i++) console.log(i + 1, JSON.stringify(lines[i]).slice(0, 220));
