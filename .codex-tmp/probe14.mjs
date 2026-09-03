import { readFileSync } from "node:fs";
const lines = readFileSync("test/account-recovery.test.js", "utf8").split("\n");
for (let i = 240; i < 400; i++) console.log(i + 1, lines[i]);
