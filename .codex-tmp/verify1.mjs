import { readFileSync } from "node:fs";
const s = readFileSync("src/channels/chatplus.js", "utf8");
const checks = {
  'timer 3000 (H15a)': s.includes('setTimeout(() => resolve(""), 3000)'),
  'task probe 3000 (H15c)': s.includes("? 2000 : 3000"),
  'stream probe 3000 (H15d)': s.includes("nextStreamStatusProbeAt = Date.now() + 3000"),
  'update wait 3000 (H15e)': s.includes("Math.min(3000, Math.max(1, deadline"),
  'upload cache': s.includes("readChatImageUploadCache(cacheKey)"),
  'contention error': s.includes("ACCOUNT_SESSION_CONTENDED"),
  'adopt branch': s.includes("tryAdoptSharedPortalSession()"),
  'remember': s.includes("rememberSharedPortalSession()"),
  'submit revision': s.includes("client.sessionRevision = session.revision"),
  'recorder passed': s.includes("taskStageRecorder: requestInput.taskStageRecorder")
};
for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("remaining '5000' occurrences:", (s.match(/5000/g) || []).length);
