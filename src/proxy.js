const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parsePipeProxy(value) {
  const text = String(value || "").trim();
  if (!text.includes("|")) return null;

  const parts = text.split("|").map((part) => part.trim());
  if (parts.length < 4) return null;

  const [host, portText, username, password, expiresAt = ""] = parts;
  const port = Number(portText);
  if (!host || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    host,
    port: String(port),
    username,
    password,
    expiresAt
  };
}

export function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const pipeProxy = parsePipeProxy(text);
  if (pipeProxy) {
    const user = encodeURIComponent(pipeProxy.username);
    const password = encodeURIComponent(pipeProxy.password);
    return `socks5://${user}:${password}@${pipeProxy.host}:${pipeProxy.port}`;
  }

  return URL_SCHEME_RE.test(text) ? text : `http://${text}`;
}
