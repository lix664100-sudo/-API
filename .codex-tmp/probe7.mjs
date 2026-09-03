import { readFileSync } from "node:fs";
const s = readFileSync("src/shareai-portal-router.js", "utf8");
const lines = s.split("\n");
console.log("lines:", lines.length);
for (let i = 0; i < lines.length; i++) console.log(i + 1, lines[i]);
