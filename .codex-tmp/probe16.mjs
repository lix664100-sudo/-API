import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
let i = lines.findIndex(l => /^\s{2}async performEnterCar\(/.test(l));
console.log("performEnterCar at", i + 1);
for (let j = i; j < i + 60; j++) console.log(j + 1, lines[j]);
