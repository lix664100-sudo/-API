import { readFileSync } from "node:fs";
const lines = readFileSync("test/shareai-portal-router.test.js", "utf8").split("\n");
for (let i = 0; i < 30; i++) console.log(i + 1, lines[i]);
console.log("...");
for (let i = 195; i < 250; i++) console.log(i + 1, lines[i]);
