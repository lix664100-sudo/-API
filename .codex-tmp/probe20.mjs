import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
console.log("---- around 3008 ----");
for (let j = 2996; j < 3014; j++) console.log(j + 1, lines[j]);
console.log("---- around 3637-3650 (loadAccountUsages catch) ----");
for (let j = 3626; j < 3658; j++) console.log(j + 1, lines[j]);
console.log("---- around 5418 ----");
for (let j = 5405; j < 5428; j++) console.log(j + 1, lines[j]);
