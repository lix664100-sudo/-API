import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire('/opt/ikun-aishare-api/package.json');
const Database = require('better-sqlite3');
const env = {};
for (const line of fs.readFileSync('/opt/ikun-aishare-api/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const base = 'http://127.0.0.1:3210';
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD })
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const ids = ['task-5df86144-822a-4b5e-899e-d77c8e9cfec4', 'task-32a17ee8-783f-4ca3-838f-d44d6e01fa35', 'task-c9c825c1-c056-45ae-8606-89a1515a3150'];
for (const id of ids) {
  const res = await fetch(base + '/api/tasks/' + id + '/refresh', { method: 'POST', headers: { cookie } });
  const j = await res.json().catch(() => null);
  const d = j && j.data;
  const raw = d && d.raw ? d.raw : {};
  console.log('== ' + id.slice(5, 13) + ' status=' + (d && d.status) + ' imgs=' + ((d && d.imageUrls || []).length));
  console.log('   checkStatus=' + raw.lastUpstreamCheckStatus + ' errCount=' + raw.refreshErrorCount + ' errMsg=' + String(raw.refreshErrorMessage || '').slice(0, 80) + ' unchanged=' + raw.unchangedUpstreamChecks + ' eventCount=' + raw.eventCount + ' conv=' + raw.conversationId);
  await new Promise(r => setTimeout(r, 8000));
}
