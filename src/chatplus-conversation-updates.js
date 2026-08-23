import { createHash } from "node:crypto";
import WebSocket from "ws";
import { ProxyAgent } from "proxy-agent";

const CONVERSATIONS_TOPIC = "conversations";
const UPDATE_TTL_MS = 60 * 60 * 1000;
const CONNECTION_IDLE_MS = 35 * 60 * 1000;
const MAX_CONVERSATION_UPDATES = 16;
const MAX_CACHED_CONVERSATIONS = 250;
const MAX_SOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;

const connections = new Map();
const conversationUpdates = new Map();
const conversationWaiters = new Map();
const conversationUpdateListeners = new Set();
let updateVersion = 0;

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizedConversationUpdate(value) {
  const decoded = parseJson(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;

  if (decoded.type === "conversation-update") {
    return normalizedConversationUpdate(decoded.payload);
  }
  if (decoded.type === "message" && decoded.topic_id === CONVERSATIONS_TOPIC) {
    return normalizedConversationUpdate(decoded.payload);
  }
  const nested = decoded.payload;
  if (
    nested
    && typeof nested === "object"
    && !Array.isArray(nested)
    && nested.type === "conversation-update"
  ) {
    return normalizedConversationUpdate(nested.payload);
  }

  const conversationId = String(decoded.conversation_id || decoded.conversationId || "").trim();
  if (!conversationId) return null;
  return { conversationId, payload: decoded };
}

function updateFingerprint(payload, offset = "") {
  if (offset) return `offset:${offset}`;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function pruneConversationUpdates(now = Date.now()) {
  for (const [conversationId, entry] of conversationUpdates) {
    if (now - entry.updatedAt > UPDATE_TTL_MS) conversationUpdates.delete(conversationId);
  }
  if (conversationUpdates.size <= MAX_CACHED_CONVERSATIONS) return;
  const expired = [...conversationUpdates.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, conversationUpdates.size - MAX_CACHED_CONVERSATIONS);
  for (const [conversationId] of expired) conversationUpdates.delete(conversationId);
}

function notifyConversationWaiters(conversationId, version) {
  const waiters = conversationWaiters.get(conversationId);
  if (!waiters) return;
  for (const waiter of [...waiters]) {
    if (version <= waiter.afterVersion) continue;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(version);
  }
  if (!waiters.size) conversationWaiters.delete(conversationId);
}

function notifyConversationUpdateListeners(update) {
  for (const listener of conversationUpdateListeners) {
    try {
      Promise.resolve(listener(update)).catch(() => {});
    } catch {
      // A storage listener must never interrupt the live result connection.
    }
  }
}

export function subscribeChatplusConversationUpdates(listener) {
  if (typeof listener !== "function") throw new TypeError("listener must be a function");
  conversationUpdateListeners.add(listener);
  return () => conversationUpdateListeners.delete(listener);
}

export function recordChatplusConversationUpdate(value, offset = "") {
  const normalized = normalizedConversationUpdate(value);
  if (!normalized) return null;
  pruneConversationUpdates();

  const { conversationId, payload } = normalized;
  const fingerprint = updateFingerprint(payload, String(offset || ""));
  const current = conversationUpdates.get(conversationId) || {
    updates: [],
    fingerprints: new Set(),
    version: 0,
    updatedAt: 0
  };
  if (current.fingerprints.has(fingerprint)) return current.version;

  current.fingerprints.add(fingerprint);
  current.updates.push(payload);
  while (current.updates.length > MAX_CONVERSATION_UPDATES) current.updates.shift();
  while (current.fingerprints.size > MAX_CONVERSATION_UPDATES) {
    current.fingerprints.delete(current.fingerprints.values().next().value);
  }
  current.version = ++updateVersion;
  current.updatedAt = Date.now();
  conversationUpdates.set(conversationId, current);
  notifyConversationUpdateListeners({ conversationId, payload, fingerprint, updatedAt: current.updatedAt });
  notifyConversationWaiters(conversationId, current.version);
  return current.version;
}

export function chatplusConversationUpdates(conversationId) {
  pruneConversationUpdates();
  const entry = conversationUpdates.get(String(conversationId || "").trim());
  return entry ? [...entry.updates] : [];
}

export function chatplusConversationUpdateVersion(conversationId) {
  pruneConversationUpdates();
  return conversationUpdates.get(String(conversationId || "").trim())?.version || 0;
}

export function waitForChatplusConversationUpdate(conversationId, afterVersion = 0, timeoutMs = 5000) {
  const id = String(conversationId || "").trim();
  if (!id) return Promise.resolve(0);
  const current = chatplusConversationUpdateVersion(id);
  if (current > afterVersion) return Promise.resolve(current);

  return new Promise((resolve) => {
    const waiters = conversationWaiters.get(id) || new Set();
    const waiter = {
      afterVersion,
      resolve,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      if (!waiters.size) conversationWaiters.delete(id);
      resolve(chatplusConversationUpdateVersion(id));
    }, Math.max(1, Number(timeoutMs || 0)));
    waiter.timer.unref?.();
    waiters.add(waiter);
    conversationWaiters.set(id, waiters);
  });
}

class ChatplusConversationConnection {
  constructor(options) {
    this.key = options.key;
    this.getWebSocketUrl = options.getWebSocketUrl;
    this.cookieHeader = String(options.cookieHeader || "");
    this.origin = String(options.origin || "");
    this.proxyUrl = String(options.proxyUrl || "");
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.proxyAgentFactory = options.proxyAgentFactory
      || ((proxyUrl) => new ProxyAgent({ getProxyForUrl: () => proxyUrl }));
    this.idleMs = Math.max(1000, Number(options.idleMs || CONNECTION_IDLE_MS));
    this.onClose = options.onClose;
    this.socket = null;
    this.proxyAgent = null;
    this.ready = false;
    this.closed = false;
    this.opening = false;
    this.offset = null;
    this.nextRequestId = 1;
    this.connectRequestId = 0;
    this.subscribeRequestId = 0;
    this.reconnectAttempt = 0;
    this.readyWaiters = new Set();
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.idleTimer = null;
    this.lastUsedAt = Date.now();
    this.touch();
  }

  updateOptions(options) {
    if (typeof options.getWebSocketUrl === "function") this.getWebSocketUrl = options.getWebSocketUrl;
    this.cookieHeader = String(options.cookieHeader || this.cookieHeader || "");
    this.origin = String(options.origin || this.origin || "");
    if (Object.hasOwn(options, "proxyUrl")) this.proxyUrl = String(options.proxyUrl || "");
  }

  touch() {
    this.lastUsedAt = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastUsedAt >= this.idleMs) this.close();
      else this.touch();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  ensureReady(timeoutMs = 20_000) {
    this.touch();
    if (this.ready) return Promise.resolve(this);
    this.open();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        const error = new Error("上游结果通道连接超时。");
        error.code = "CHATPLUS_RESULT_CHANNEL_TIMEOUT";
        reject(error);
      }, Math.max(1000, Number(timeoutMs || 0)));
      waiter.timer.unref?.();
      this.readyWaiters.add(waiter);
      if (this.ready) this.resolveReadyWaiters();
    });
  }

  resolveReadyWaiters() {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this);
    }
    this.readyWaiters.clear();
  }

  rejectReadyWaiters(error) {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  async open() {
    if (this.closed || this.opening || this.socket) return;
    this.opening = true;
    try {
      const socketUrl = await this.getWebSocketUrl();
      if (this.closed) return;
      this.proxyAgent = this.proxyUrl ? this.proxyAgentFactory(this.proxyUrl) : null;
      const socket = new this.WebSocketImpl(socketUrl, {
        agent: this.proxyAgent || undefined,
        origin: this.origin || undefined,
        handshakeTimeout: 20_000,
        maxPayload: MAX_SOCKET_PAYLOAD_BYTES,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          ...(this.cookieHeader ? { cookie: this.cookieHeader } : {})
        }
      });
      this.socket = socket;
      socket.on("open", () => this.handleOpen());
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", () => this.handleDisconnect());
      socket.on("error", () => socket.terminate?.());
    } catch {
      this.proxyAgent?.destroy?.();
      this.proxyAgent = null;
      this.scheduleReconnect();
    } finally {
      this.opening = false;
    }
  }

  sendCommand(command) {
    if (!this.socket || this.socket.readyState !== (this.WebSocketImpl.OPEN ?? 1)) return 0;
    const id = this.nextRequestId++;
    this.socket.send(JSON.stringify([{ id, command }]));
    return id;
  }

  handleOpen() {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (!this.ready) this.socket?.terminate?.();
    }, 20_000);
    this.handshakeTimer.unref?.();
    this.connectRequestId = this.sendCommand({
      type: "connect",
      presence: { type: "presence", state: "foreground" }
    });
  }

  subscribe() {
    const command = { type: "subscribe", topic_id: CONVERSATIONS_TOPIC };
    if (this.offset !== null && this.offset !== "") command.offset = this.offset;
    this.subscribeRequestId = this.sendCommand(command);
  }

  handleMessage(data) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }
    if (!Array.isArray(decoded)) {
      recordChatplusConversationUpdate(decoded);
      return;
    }

    for (const entry of decoded) {
      if (entry?.type === "message") {
        recordChatplusConversationUpdate(entry, entry.offset);
        if (entry.offset !== null && entry.offset !== undefined && entry.offset !== "") {
          this.offset = entry.offset;
        }
        continue;
      }
      if (!entry?.reply || !entry.id) continue;
      if (entry.id === this.connectRequestId && entry.reply.type === "connect") {
        this.subscribe();
        continue;
      }
      if (entry.id !== this.subscribeRequestId || entry.reply.type !== "subscribe") continue;
      const catchups = Array.isArray(entry.reply.catchups)
        ? entry.reply.catchups
        : Array.isArray(entry.reply.recovered)
          ? entry.reply.recovered
          : [];
      if (entry.reply.recovered) {
        for (const catchup of catchups) {
          recordChatplusConversationUpdate(catchup, catchup?.offset);
          if (catchup?.offset !== null && catchup?.offset !== undefined && catchup?.offset !== "") {
            this.offset = catchup.offset;
          }
        }
      }
      const replyOffset = entry.reply.last_offset ?? entry.reply.offset;
      if (replyOffset !== null && replyOffset !== undefined) {
        this.offset = replyOffset;
      }
      this.reconnectAttempt = 0;
      this.ready = true;
      clearTimeout(this.handshakeTimer);
      this.resolveReadyWaiters();
    }
  }

  handleDisconnect() {
    if (this.socket) {
      this.socket.removeAllListeners?.();
      this.socket = null;
    }
    this.proxyAgent?.destroy?.();
    this.proxyAgent = null;
    this.ready = false;
    clearTimeout(this.handshakeTimer);
    if (!this.closed) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.socket?.close?.(1000);
    this.socket?.removeAllListeners?.();
    this.socket = null;
    this.proxyAgent?.destroy?.();
    this.proxyAgent = null;
    const error = new Error("上游结果通道已关闭。");
    error.code = "CHATPLUS_RESULT_CHANNEL_CLOSED";
    this.rejectReadyWaiters(error);
    this.onClose?.(this);
  }
}

export function getChatplusConversationConnection(options) {
  const key = String(options?.key || "").trim();
  if (!key) throw new Error("缺少上游结果通道编号。");
  const current = connections.get(key);
  if (current && !current.closed) {
    current.updateOptions(options);
    current.touch();
    return current;
  }
  const connection = new ChatplusConversationConnection({
    ...options,
    key,
    onClose: (closed) => {
      if (connections.get(key) === closed) connections.delete(key);
      options.onClose?.(closed);
    }
  });
  connections.set(key, connection);
  return connection;
}

export function resetChatplusConversationUpdatesForTests() {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  conversationUpdates.clear();
  for (const waiters of conversationWaiters.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(0);
    }
  }
  conversationWaiters.clear();
  updateVersion = 0;
}
