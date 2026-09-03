import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const lines = s.split("\n");
lines.forEach((l, i) => {
  if (l.includes("reportShareAiPortalFailure") || l.includes("performPortalLogin(")) console.log(i + 1, l.trimEnd());
});
