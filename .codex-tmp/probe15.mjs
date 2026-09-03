import { readFileSync } from "node:fs";
const lines = readFileSync("test/shareai-portal-router.test.js", "utf8").split("\n");
for (let i = 250; i < 360; i++) console.log(i + 1, lines[i]);
