#!/bin/bash
# 只读排查：用服务配置里的代理实测访问上游的延迟与成功率
cd /tmp/probe
node - <<'EOF'
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("/opt/ikun-aishare-api/data/config.json", "utf8"));
const urls = [];
(function find(o) {
  if (!o || typeof o !== "object") return;
  if (typeof o.proxyUrl === "string" && o.proxyUrl) urls.push(o.proxyUrl);
  for (const v of Object.values(o)) find(v);
})(cfg);
const url = urls.find((u) => u.includes("s23542")) || urls[0] || "";
fs.writeFileSync("/tmp/probe/proxy.txt", url);
EOF
URL=$(cat /tmp/probe/proxy.txt)
if [ -z "$URL" ]; then echo "NO_PROXY_URL_FOUND"; exit 0; fi
HOSTPORT=$(echo "$URL" | sed -E 's#^socks5h?://([^@/]+@)?([^/]+)/?#\2#')
USERPASS=$(echo "$URL" | sed -E 's#^socks5h?://([^@/]+)@.*#\1#')
echo "proxy_host=$HOSTPORT creds_present=$([ -n "$USERPASS" ] && echo yes || echo no)"
for i in 1 2 3 4 5; do
  if [ -n "$USERPASS" ]; then
    curl -s -o /dev/null -w "try$i code=%{http_code} connect=%{time_connect}s total=%{time_total}s\n" --proxy-user "$USERPASS" --socks5-hostname "$HOSTPORT" -m 25 "https://one.aishare.icu/backend-api/me" || echo "try$i CURL_FAILED"
  else
    curl -s -o /dev/null -w "try$i code=%{http_code} total=%{time_total}s\n" --socks5-hostname "$HOSTPORT" -m 25 "https://one.aishare.icu/backend-api/me" || echo "try$i CURL_FAILED"
  fi
done
echo "=== 今天错误日志中该代理相关报错次数 ==="
grep -c 's23542' /home/ubuntu/.pm2/logs/ikun-api-error.log 2>/dev/null
echo "=== 按小时分布 ==="
grep 's23542' /home/ubuntu/.pm2/logs/ikun-api-error.log 2>/dev/null | grep -o '^2026-09-03T[0-9][0-9]' | sort | uniq -c
