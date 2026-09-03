import { readFileSync } from "node:fs";
const s = readFileSync("test/multi-shareai-channel.test.js", "utf8");
console.log(s.slice(0, 5640));
