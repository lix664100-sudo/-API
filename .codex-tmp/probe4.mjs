import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
console.log("total lines:", lines.length);
for (let i = 0; i < 40; i++) console.log(i + 1, JSON.stringify(lines[i]).slice(0, 160));
const crlf = (s.match(/\r\n/g) || []).length;
const lf = (s.match(/(?<!\r)\n/g) || []).length;
console.log("CRLF:", crlf, "bare LF:", lf);
console.log("has createHash import:", s.includes("createHash"));
