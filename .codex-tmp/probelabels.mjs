import { readFileSync } from "node:fs";
const s = readFileSync(".codex-tmp/patch-chatplus.mjs", "utf8");
const labels = [...s.matchAll(/"(H[^"]*)"/g)].map(x => x[1]);
console.log(labels.join("\n"));
console.log("total:", labels.length);
const applies = (s.match(/^apply\(/gm) || []).length;
console.log("apply calls:", applies);
