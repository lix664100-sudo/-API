import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const i = s.indexOf("async loginPortal(options = {}) {");
console.log(JSON.stringify(s.slice(i - 200, i + 40)));
