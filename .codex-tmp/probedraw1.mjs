import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/drawing.js", "utf8");
const lines = s.split("\n");
console.log("total lines:", lines.length);
const crlf = (s.match(/\r\n/g) || []).length;
const lf = (s.match(/(?<!\r)\n/g) || []).length;
console.log("CRLF:", crlf, "bare LF:", lf);
for (let i = 0; i < Math.min(120, lines.length); i++) console.log(i + 1, JSON.stringify(lines[i]).slice(0, 200));
