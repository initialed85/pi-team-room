import { createServer } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 1;
const SERVICE_TYPE = "pi-team-room";
const STATE_PATH = process.env.PI_TEAM_ROOM_STATE || join(process.env.HOME || ".", ".pi", "team-room", "state.json");
const PORT = Number(process.env.PI_TEAM_ROOM_PORT) || 43_321;
const BIND = process.env.PI_TEAM_ROOM_BIND || "0.0.0.0";
const SHARED_SECRET = process.env.PI_TEAM_ROOM_SHARED_SECRET || "";
const SYNC_MS = Number(process.env.PI_TEAM_ROOM_SYNC_MS) || 5_000;
const LEASE_GRACE_MS = Number(process.env.PI_TEAM_ROOM_NODE_GRACE_MS) || 120_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STALE_SESSION_MS = 90_000;
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 5_000;
const MAX_UPDATES = 100;
const MAX_JOURNAL = 500;
const NETWORK_ENABLED = process.env.PI_TEAM_ROOM_NETWORK === "1";
const MDNS_ENABLED = process.env.PI_TEAM_ROOM_MDNS !== "0";

if (!NETWORK_ENABLED) process.exit(0);
if (!SHARED_SECRET) {
  console.error("pi-team-room network service: refusing to start without PI_TEAM_ROOM_SHARED_SECRET");
  process.exit(1);
}

const nodePath = join(dirname(STATE_PATH), "node.json");
const staticPeers = (process.env.PI_TEAM_ROOM_PEERS || "")
  .split(",")
  .map((value) => normalizeEndpoint(value))
  .filter(Boolean);
const node = await loadOrCreateNode();
const discoveredPeers = new Map();
let server;
let bonjour;
let browser;
let published;
let syncTimer;
let leaseTimer;
let syncing = false;
let noSessionsSince;
let stopping = false;

function emptyState() {
  return { version: 1, sessions: [], messages: [], updates: [], journal: [] };
}

function validState(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return candidate.version === 1 && Array.isArray(candidate.sessions) && Array.isArray(candidate.messages) &&
    Array.isArray(candidate.updates) && Array.isArray(candidate.journal);
}

function cleanState(value) {
  if (!validState(value)) return emptyState();
  return {
    version: 1,
    sessions: value.sessions.filter((item) => item && typeof item === "object" && typeof item.id === "string").slice(-MAX_SESSIONS),
    messages: value.messages.filter((item) => item && typeof item === "object" && typeof item.id === "string").slice(-MAX_MESSAGES),
    updates: value.updates.filter((item) => item && typeof item === "object" && typeof item.id === "string").slice(-MAX_UPDATES),
    journal: value.journal.filter((item) => item && typeof item === "object" && typeof item.id === "string").slice(-MAX_JOURNAL),
  };
}

async function loadState() {
  try {
    return cleanState(JSON.parse(await readFile(STATE_PATH, "utf8")));
  } catch {
    return emptyState();
  }
}

async function saveState(state) {
  const path = STATE_PATH;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function withState(fn) {
  const path = STATE_PATH;
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      try {
        return await fn(await loadState());
      } finally {
        await unlink(lock).catch(() => undefined);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 5));
    }
  }
  // Match the extension's best-effort behavior if a crashed process left a lock.
  return fn(await loadState());
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function later(a, b) {
  return timestamp(a) >= timestamp(b) ? a : b;
}

function mergeRecords(left, right) {
  const leftTime = timestamp(left.updatedAt || left.createdAt);
  const rightTime = timestamp(right.updatedAt || right.createdAt);
  const merged = { ...(rightTime > leftTime ? left : right), ...(rightTime > leftTime ? right : left) };
  if (left.readAt || right.readAt) merged.readAt = later(left.readAt, right.readAt);
  if (left.deliveredAt || right.deliveredAt) merged.deliveredAt = later(left.deliveredAt, right.deliveredAt);
  return merged;
}

function mergeById(left, right, limit) {
  const records = new Map();
  for (const item of left) records.set(item.id, item);
  for (const item of right) records.set(item.id, records.has(item.id) ? mergeRecords(records.get(item.id), item) : item);
  return [...records.values()]
    .sort((a, b) => timestamp(a.createdAt || a.updatedAt) - timestamp(b.createdAt || b.updatedAt))
    .slice(-limit);
}

function mergeSessions(left, right) {
  const records = new Map();
  for (const item of left) records.set(item.id, item);
  for (const item of right) {
    records.set(item.id, records.has(item.id) ? mergeRecords(records.get(item.id), item) : item);
  }
  return [...records.values()]
    .sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt))
    .slice(-MAX_SESSIONS);
}

function mergeStates(left, right) {
  return {
    version: 1,
    sessions: mergeSessions(left.sessions, right.sessions),
    messages: mergeById(left.messages, right.messages, MAX_MESSAGES),
    updates: mergeById(left.updates, right.updates, MAX_UPDATES),
    journal: mergeById(left.journal, right.journal, MAX_JOURNAL),
  };
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadOrCreateNode() {
  try {
    const value = JSON.parse(await readFile(nodePath, "utf8"));
    if (value && typeof value.id === "string") return value;
  } catch {
    // First start or an old/incomplete node file.
  }
  const value = { id: randomUUID(), name: process.env.PI_TEAM_ROOM_NODE_NAME || hostname(), createdAt: new Date().toISOString() };
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(nodePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
}

function normalizeEndpoint(value) {
  if (!value) return undefined;
  try {
    const raw = value.trim();
    if (!raw) return undefined;
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!url.port) url.port = String(PORT);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function advertiseAddress() {
  const configured = process.env.PI_TEAM_ROOM_ADVERTISE_HOST?.trim();
  if (configured) return configured;
  const candidates = [];
  for (const [name, values] of Object.entries(networkInterfaces())) {
    for (const value of values || []) {
      if (!value.internal && value.family === "IPv4") candidates.push({ name, address: value.address });
    }
  }
  const preferred = candidates.find((item) => /^(en|eth|wl|wlan|wifi)/i.test(item.name));
  return (preferred || candidates[0])?.address;
}

function endpointFromService(service) {
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  const hinted = typeof service.txt?.addr === "string" ? service.txt.addr : undefined;
  const address = hinted || addresses.find((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) || service.host;
  return normalizeEndpoint(`${address}:${service.port}`);
}

function authMatches(request) {
  const value = request.headers.authorization || "";
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return false;
  const provided = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(SHARED_SECRET);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION });
      return;
    }
    if (!authMatches(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.url === "/v1/info" && request.method === "GET") {
      sendJson(response, 200, { protocol: PROTOCOL_VERSION, nodeId: node.id, name: node.name });
      return;
    }
    if (request.url === "/v1/state" && request.method === "GET") {
      sendJson(response, 200, await loadState());
      return;
    }
    if (request.url === "/v1/state" && request.method === "POST") {
      const payload = await requestBody(request);
      if (!validState(payload)) {
        sendJson(response, 400, { error: "invalid state" });
        return;
      }
      const incoming = cleanState(payload);
      const merged = await withState(async (local) => {
        const result = mergeStates(local, incoming);
        if (!sameState(local, result)) await saveState(result);
        return result;
      });
      sendJson(response, 200, { ok: true, state: merged });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") process.exit(0);
  console.error("pi-team-room network service:", error);
  process.exit(1);
});

function peerEndpoints() {
  return [...new Set([...staticPeers, ...discoveredPeers.values()])];
}

async function fetchJson(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    ...options,
    signal: AbortSignal.timeout(2_000),
    headers: { authorization: `Bearer ${SHARED_SECRET}`, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`peer returned HTTP ${response.status}`);
  return response.json();
}

async function syncPeer(endpoint) {
  const remote = cleanState(await fetchJson(`${endpoint}/v1/state`));
  const merged = await withState(async (local) => {
    const result = mergeStates(local, remote);
    if (!sameState(local, result)) await saveState(result);
    return result;
  });
  await fetchJson(`${endpoint}/v1/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(merged) });
}

async function syncAll() {
  if (syncing || stopping) return;
  syncing = true;
  try {
    for (const endpoint of peerEndpoints()) {
      try {
        await syncPeer(endpoint);
      } catch {
        // Peers can be asleep or temporarily unreachable; discovery retries later.
      }
    }
  } finally {
    syncing = false;
  }
}

async function checkLease() {
  if (stopping) return;
  const state = await loadState();
  const cutoff = Date.now() - STALE_SESSION_MS;
  const active = state.sessions.some((session) => session.connected !== false && timestamp(session.lastSeenAt) >= cutoff);
  if (active) {
    noSessionsSince = undefined;
    return;
  }
  noSessionsSince ||= Date.now();
  if (Date.now() - noSessionsSince >= LEASE_GRACE_MS) stop();
}

async function startMdns() {
  if (!MDNS_ENABLED) return;
  try {
    const module = await import("bonjour-service");
    const Bonjour = module.Bonjour || module.default;
    const mdnsInterface = process.env.PI_TEAM_ROOM_MDNS_INTERFACE?.trim();
    bonjour = new Bonjour(mdnsInterface ? { interface: mdnsInterface } : {}, (error) => console.error("pi-team-room mDNS:", error));
    const address = advertiseAddress();
    published = bonjour.publish({
      name: `Pi Team Room — ${node.name}`,
      type: SERVICE_TYPE,
      port: PORT,
      txt: { v: String(PROTOCOL_VERSION), node: node.id, ...(address ? { addr: address } : {}) },
      disableIPv6: true,
    });
    browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
      if (service.txt?.node === node.id) return;
      const endpoint = endpointFromService(service);
      if (endpoint) discoveredPeers.set(service.fqdn || service.name || endpoint, endpoint);
    });
    browser.on("down", (service) => discoveredPeers.delete(service.fqdn || service.name));
  } catch (error) {
    console.error("pi-team-room: mDNS unavailable; static peers still work:", error instanceof Error ? error.message : String(error));
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(syncTimer);
  clearInterval(leaseTimer);
  try { browser?.stop(); } catch { /* best effort */ }
  try { published?.stop(); } catch { /* best effort */ }
  try { bonjour?.destroy(); } catch { /* best effort */ }
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

server.listen(PORT, BIND, async () => {
  await startMdns();
  await syncAll();
  syncTimer = setInterval(() => void syncAll(), SYNC_MS);
  leaseTimer = setInterval(() => void checkLease(), 15_000);
  syncTimer.unref?.();
  leaseTimer.unref?.();
});
