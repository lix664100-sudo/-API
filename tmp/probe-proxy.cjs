const { createRequire } = require("module");
const req = createRequire("/opt/ikun-aishare-api/");
const { ProxyAgent } = req("proxy-agent");
const https = require("https");
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync("/opt/ikun-aishare-api/data/config.json", "utf8"));

function findProxyEntries(o, out) {
  if (!o || typeof o !== "object") return out;
  if (typeof o.proxyUrl === "string" && o.proxyUrl.trim()) {
    out.push({ proxyUrl: o.proxyUrl, proxyCheck: o.proxyCheck || null, name: o.name || o.id || "" });
  }
  for (const v of Object.values(o)) findProxyEntries(v, out);
  return out;
}
const entries = findProxyEntries(cfg, []);
console.log("=== config 中的代理及其最近检测记录 ===");
for (const e of entries) {
  const check = e.proxyCheck || {};
  console.log([
    "label=" + (check.proxyLabel || "?"),
    "ok=" + check.ok,
    "latencyMs=" + check.latencyMs,
    "checkedAt=" + check.checkedAt,
    "message=" + (check.message || ""),
    "expiresAt=" + check.expiresAt
  ].join(" "));
}

const target = entries.find((e) => String(e.proxyUrl).includes("s23542")) || entries[0];
if (!target) { console.log("NO_PROXY_CONFIGURED"); process.exit(0); }

function parsePipe(text) {
  const parts = String(text).split("|").map((s) => s.trim());
  if (parts.length < 4) return null;
  return { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
}
const p = parsePipe(target.proxyUrl);
const proxyUrl = p
  ? `socks5://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`
  : target.proxyUrl;
console.log("=== 实测代理: " + (p ? p.host + ":" + p.port : proxyUrl) + " ===");

function attempt(label, useProxy, url) {
  return new Promise((resolve) => {
    const agent = useProxy ? new ProxyAgent({ getProxyForUrl: () => proxyUrl }) : undefined;
    const started = Date.now();
    let connected = 0;
    const r = https.request(url, {
      agent,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" }
    }, (res) => {
      const ttfb = Date.now() - started;
      let bytes = 0;
      res.on("data", (c) => { bytes += c.length; });
      res.on("end", () => {
        agent?.destroy?.();
        resolve({ label, ok: true, status: res.statusCode, connectMs: connected, ttfbMs: ttfb, totalMs: Date.now() - started, bytes });
      });
    });
    r.setTimeout(20000, () => r.destroy(new Error("20s_timeout")));
    r.on("socket", (s) => { s.on("connect", () => { connected = Date.now() - started; }); });
    r.on("error", (e) => {
      agent?.destroy?.();
      resolve({ label, ok: false, error: e.code || e.message, afterMs: Date.now() - started });
    });
    r.end();
  });
}

(async () => {
  const url = "https://one.aishare.icu/backend-api/me";
  for (let i = 1; i <= 6; i += 1) {
    const r = await attempt("proxy#" + i, true, url);
    console.log(JSON.stringify(r));
  }
  for (let i = 1; i <= 2; i += 1) {
    const r = await attempt("direct#" + i, false, url);
    console.log(JSON.stringify(r));
  }
  process.exit(0);
})();
