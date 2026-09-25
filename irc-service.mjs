import { createConnection, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const PROTOCOL_VERSION = 1;
const PROTOCOL_PREFIX = "PI_TEAM_ROOM/1";
const NETWORK_MODE = process.env.PI_TEAM_ROOM_NETWORK || "0";
const STATE_PATH = process.env.PI_TEAM_ROOM_STATE || join(process.env.HOME || ".", ".pi", "team-room", "state.json");
const IRC_HOST = process.env.PI_TEAM_ROOM_IRC_HOST || "";
const IRC_TLS = process.env.PI_TEAM_ROOM_IRC_TLS === "1";
const IRC_PORT = Number(process.env.PI_TEAM_ROOM_IRC_PORT) || (IRC_TLS ? 6697 : 6667);
const IRC_CHANNEL = normalizeChannel(process.env.PI_TEAM_ROOM_IRC_CHANNEL || "#pi-team-room");
const IRC_FOCUS_PREFIX = normalizeChannelPrefix(process.env.PI_TEAM_ROOM_IRC_FOCUS_PREFIX || "#pi-focus-");
const IRC_SERVER_PASSWORD = process.env.PI_TEAM_ROOM_IRC_SERVER_PASSWORD || "";
const IRC_TLS_REJECT_UNAUTHORIZED = process.env.PI_TEAM_ROOM_IRC_TLS_REJECT_UNAUTHORIZED !== "0";
const IRC_RECONNECT_MS = Number(process.env.PI_TEAM_ROOM_IRC_RECONNECT_MS) || 1_000;
const IRC_NODE_GRACE_MS = Number(process.env.PI_TEAM_ROOM_IRC_NODE_GRACE_MS) || 120_000;
const INSTANCE_LOCK_PATH = `${STATE_PATH}.irc-service.lock`;
const INSTANCE_LOCK_TOKEN = `${process.pid}:${randomUUID()}`;
const IRC_USER = sanitizeUser(process.env.PI_TEAM_ROOM_IRC_USER || process.env.PI_TEAM_ROOM_NODE_NAME || hostname());
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 5_000;
const MAX_UPDATES = 100;
const MAX_JOURNAL = 500;
const STALE_SESSION_MS = 30 * 60_000;
const POLL_MS = Number(process.env.PI_TEAM_ROOM_IRC_POLL_MS) || 250;
const MAX_IRC_PAYLOAD = 240;

if (NETWORK_MODE !== "irc") process.exit(0);
if (!IRC_HOST) {
  console.error("pi-team-room IRC backend: set PI_TEAM_ROOM_IRC_HOST");
  process.exit(1);
}

async function acquireInstanceLock() {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(INSTANCE_LOCK_PATH, `${INSTANCE_LOCK_TOKEN}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let pid;
      try {
        pid = Number((await readFile(INSTANCE_LOCK_PATH, "utf8")).split(":", 1)[0]);
      } catch {
        pid = undefined;
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch (processError) {
          if (processError?.code === "EPERM") return false;
          if (processError?.code !== "ESRCH") throw processError;
        }
      }
      await unlink(INSTANCE_LOCK_PATH).catch(() => undefined);
    }
  }
  return false;
}

function releaseInstanceLock() {
  try {
    if (readFileSync(INSTANCE_LOCK_PATH, "utf8").trim() === INSTANCE_LOCK_TOKEN) unlinkSync(INSTANCE_LOCK_PATH);
  } catch {
    // The lock may already have been removed after an unclean shutdown.
  }
}

if (!(await acquireInstanceLock())) process.exit(0);
process.once("exit", releaseInstanceLock);

function normalizeChannel(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "#pi-team-room";
  return trimmed.startsWith("#") || trimmed.startsWith("&") ? trimmed : `#${trimmed}`;
}

function normalizeChannelPrefix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "#pi-focus-";
  return trimmed.startsWith("#") || trimmed.startsWith("&") ? trimmed : `#${trimmed}`;
}

function sanitizeUser(value) {
  return String(value || "pi-team-room").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 50) || "pi-team-room";
}

function sanitizeNick(value) {
  return sanitizeUser(value).slice(0, 30) || "pi-team-room";
}

function now() {
  return new Date().toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function later(a, b) {
  return timestamp(a) >= timestamp(b) ? a : b;
}

function emptyState() {
  return { version: 1, sessions: [], messages: [], updates: [], journal: [] };
}

function validState(value) {
  return !!value && typeof value === "object" && value.version === 1 && Array.isArray(value.sessions) &&
    Array.isArray(value.messages) && Array.isArray(value.updates) && Array.isArray(value.journal);
}

function cleanState(value) {
  if (!validState(value)) return emptyState();
  return {
    version: 1,
    sessions: value.sessions.filter((item) => item && typeof item.id === "string").slice(-MAX_SESSIONS),
    messages: value.messages.filter((item) => item && typeof item.id === "string").slice(-MAX_MESSAGES),
    updates: value.updates.filter((item) => item && typeof item.id === "string").slice(-MAX_UPDATES),
    journal: value.journal.filter((item) => item && typeof item.id === "string").slice(-MAX_JOURNAL),
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
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, STATE_PATH);
}

async function withState(fn) {
  const lockPath = `${STATE_PATH}.lock`;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      try {
        const state = await loadState();
        const result = await fn(state);
        await saveState(state);
        return result;
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 5));
    }
  }
  const state = await loadState();
  const result = await fn(state);
  await saveState(state);
  return result;
}

function mergeRecord(left, right) {
  const leftTime = timestamp(left?.updatedAt || left?.createdAt);
  const rightTime = timestamp(right?.updatedAt || right?.createdAt);
  const merged = rightTime > leftTime ? { ...left, ...right } : { ...right, ...left };
  if (left?.readAt || right?.readAt) merged.readAt = later(left?.readAt, right?.readAt);
  if (left?.deliveredAt || right?.deliveredAt) merged.deliveredAt = later(left?.deliveredAt, right?.deliveredAt);
  return merged;
}

function mergeById(left, right, limit) {
  const records = new Map();
  for (const item of left) records.set(item.id, item);
  for (const item of right) records.set(item.id, records.has(item.id) ? mergeRecord(records.get(item.id), item) : item);
  return [...records.values()]
    .sort((a, b) => timestamp(a.createdAt || a.updatedAt) - timestamp(b.createdAt || b.updatedAt))
    .slice(-limit);
}

function mergeSessions(left, right) {
  return mergeById(left, right, MAX_SESSIONS);
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

function recordSignature(record) {
  return JSON.stringify(record);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function focusChannel(focus) {
  const slug = String(focus || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${IRC_FOCUS_PREFIX}${slug}` : undefined;
}

function activeSession(session) {
  return session.connected !== false && timestamp(session.lastSeenAt) >= Date.now() - STALE_SESSION_MS;
}

function parseIrcLine(line) {
  let rest = line;
  let prefix;
  if (rest.startsWith(":")) {
    const separator = rest.indexOf(" ");
    if (separator < 0) return undefined;
    prefix = rest.slice(1, separator);
    rest = rest.slice(separator + 1);
  }
  const parts = [];
  while (rest) {
    if (rest.startsWith(":")) {
      parts.push(rest.slice(1));
      break;
    }
    const separator = rest.indexOf(" ");
    if (separator < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, separator));
    rest = rest.slice(separator + 1).replace(/^ +/, "");
  }
  return { prefix, command: parts.shift()?.toUpperCase(), params: parts };
}

function nickFromPrefix(prefix) {
  return String(prefix || "").split("!", 1)[0];
}

function endpointNickFromNode(node) {
  return sanitizeNick(process.env.PI_TEAM_ROOM_IRC_NICK || `${node.name}-team`);
}

const nodePath = join(dirname(STATE_PATH), `.${basename(STATE_PATH)}.irc-node.json`);
let node;
try {
  node = JSON.parse(await readFile(nodePath, "utf8"));
} catch {
  node = { id: randomUUID(), name: process.env.PI_TEAM_ROOM_NODE_NAME || hostname() };
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(nodePath, `${JSON.stringify(node, null, 2)}\n`, { mode: 0o600 });
}

let nick = endpointNickFromNode(node);
let socket;
let stopping = false;
let ready = false;
let input = "";
let reconnectTimer;
let reconnectResolve;
let pollTimer;
let leaseTimer;
let noSessionsSince;
let pollInFlight = false;
let published = new Map();
let joinedChannels = new Set();
const sessionRoutes = new Map();
const snapshotChunks = new Map();

function sendRaw(command) {
  if (!socket || socket.destroyed) return;
  const line = `${command}\r\n`;
  if (Buffer.byteLength(line, "utf8") <= 510) socket.write(line);
}

function sendPrivmsg(target, text) {
  const line = `PRIVMSG ${target} :${text}`;
  if (Buffer.byteLength(`${line}\r\n`, "utf8") > 510) return;
  sendRaw(line);
}

function sendProtocol(target, value) {
  const payload = encode({ v: PROTOCOL_VERSION, origin: node.id, ...value });
  if (payload.length <= MAX_IRC_PAYLOAD) {
    sendPrivmsg(target, `${PROTOCOL_PREFIX} ${payload}`);
    return;
  }
  const id = randomUUID();
  const total = Math.ceil(payload.length / 120);
  for (let index = 0; index < total; index++) {
    const chunk = payload.slice(index * 120, (index + 1) * 120);
    sendPrivmsg(target, `${PROTOCOL_PREFIX} ${encode({ v: PROTOCOL_VERSION, origin: node.id, kind: "chunk", id, index, total, data: chunk })}`);
  }
}

function joinChannel(channel) {
  if (!ready || joinedChannels.has(channel)) return;
  joinedChannels.add(channel);
  sendRaw(`JOIN ${channel}`);
}

function partChannel(channel) {
  if (!ready || channel === IRC_CHANNEL || !joinedChannels.has(channel)) return;
  joinedChannels.delete(channel);
  sendRaw(`PART ${channel}`);
}

function channelsForState(state) {
  return new Set(state.sessions.filter(activeSession).map((session) => focusChannel(session.focus)).filter(Boolean));
}

function syncFocusChannels(state) {
  if (!ready) return;
  const desired = channelsForState(state);
  for (const channel of desired) joinChannel(channel);
  for (const channel of [...joinedChannels]) {
    if (channel !== IRC_CHANNEL && !desired.has(channel)) partChannel(channel);
  }
}

function markPublished(state) {
  for (const [type, records] of Object.entries({
    session: state.sessions,
    message: state.messages,
    update: state.updates,
    journal: state.journal,
  })) {
    for (const record of records) published.set(`${type}:${record.id}`, recordSignature(record));
  }
}

function localSessionEvent(record) {
  return { kind: "record", recordType: "session", record, nodeId: node.id, nick };
}

function sendRecord(recordType, record) {
  const event = recordType === "session" ? localSessionEvent(record) : { kind: "record", recordType, record };
  if (recordType === "message" && record.toSessionId) {
    const route = sessionRoutes.get(record.toSessionId);
    if (route && route.nodeId !== node.id) {
      sendProtocol(route.nick, event);
      return;
    }
  }
  sendProtocol(IRC_CHANNEL, event);
  if (recordType === "session") {
    const channel = focusChannel(record.focus);
    if (channel) sendProtocol(channel, event);
  }
}

async function claimUnownedActiveSessions() {
  let state = await loadState();
  const unowned = state.sessions.filter((session) => activeSession(session) && !session.ircNodeId);
  if (unowned.length === 0) return state;
  const unownedIds = new Set(unowned.map((session) => session.id));
  await withState((current) => {
    current.sessions = current.sessions.map((session) =>
      unownedIds.has(session.id) && !session.ircNodeId ? { ...session, ircNodeId: node.id } : session);
  });
  state = await loadState();
  return state;
}

async function announceSessions() {
  const state = await claimUnownedActiveSessions();
  syncFocusChannels(state);
  for (const session of state.sessions.filter(activeSession)) {
    if (session.ircNodeId !== node.id) continue;
    sendRecord("session", session);
    sessionRoutes.set(session.id, { nodeId: node.id, nick });
    published.set(`session:${session.id}`, recordSignature(session));
  }
}

async function publishLocalChanges() {
  const state = await claimUnownedActiveSessions();
  syncFocusChannels(state);
  const groups = [
    ["session", state.sessions],
    ["message", state.messages],
    ["update", state.updates],
    ["journal", state.journal],
  ];
  for (const [recordType, records] of groups) {
    for (const record of records) {
      const key = `${recordType}:${record.id}`;
      const signature = recordSignature(record);
      if (published.get(key) === signature) continue;
      if (recordType === "session" && record.ircNodeId !== node.id) {
        published.set(key, signature);
        continue;
      }
      sendRecord(recordType, record);
      published.set(key, signature);
    }
  }
}

async function mergeRemoteState(remote, sourceNick, origin) {
  const incoming = cleanState(remote);
  await withState((state) => {
    const merged = mergeStates(state, incoming);
    state.sessions = merged.sessions;
    state.messages = merged.messages;
    state.updates = merged.updates;
    state.journal = merged.journal;
  });
  markPublished(incoming);
  for (const session of incoming.sessions) {
    if (session.ircNodeId === origin) sessionRoutes.set(session.id, { nodeId: origin, nick: sourceNick });
  }
  syncFocusChannels(incoming);
}

async function applyRecord(recordType, record, origin) {
  if (!record || typeof record.id !== "string") return;
  const incoming = recordType === "session" && origin ? { ...record, ircNodeId: origin } : record;
  await withState((state) => {
    const groups = { session: "sessions", message: "messages", update: "updates", journal: "journal" };
    const field = groups[recordType];
    if (!field) return;
    const records = state[field];
    const index = records.findIndex((item) => item.id === incoming.id);
    if (index >= 0) {
      records[index] = mergeRecord(records[index], incoming);
      if (recordType === "session" && origin) records[index].ircNodeId = origin;
    } else records.push(incoming);
    state[field] = records.slice(-({ sessions: MAX_SESSIONS, messages: MAX_MESSAGES, updates: MAX_UPDATES, journal: MAX_JOURNAL }[field]));
  });
  published.set(`${recordType}:${incoming.id}`, recordSignature(incoming));
  syncFocusChannels(await loadState());
}

async function sendSnapshot(target) {
  sendProtocol(target, { kind: "snapshot", state: await loadState() });
}

async function receiveProtocol(target, sourceNick, value) {
  if (!value || value.v !== PROTOCOL_VERSION || value.origin === node.id) return;
  if (value.kind === "chunk") {
    const key = `${sourceNick}:${value.id}`;
    const chunks = snapshotChunks.get(key) || { total: value.total, data: [] };
    chunks.data[value.index] = value.data;
    snapshotChunks.set(key, chunks);
    if (chunks.data.filter(Boolean).length !== chunks.total) return;
    snapshotChunks.delete(key);
    await receiveProtocol(target, sourceNick, decode(chunks.data.join("")));
    return;
  }
  if (value.kind === "hello") {
    if (value.nodeId && value.nick) sessionRoutes.set(`node:${value.nodeId}`, { nodeId: value.nodeId, nick: value.nick });
    sendProtocol(sourceNick, { kind: "request" });
    return;
  }
  if (value.kind === "request") {
    await sendSnapshot(sourceNick);
    return;
  }
  if (value.kind === "snapshot") {
    await mergeRemoteState(value.state, sourceNick, value.origin);
    return;
  }
  if (value.kind === "record") {
    if (value.recordType === "session" && value.record?.id) {
      sessionRoutes.set(value.record.id, { nodeId: value.origin, nick: sourceNick });
    }
    const state = await loadState();
    if (value.recordType === "message" && value.record?.toSessionId && !state.sessions.some((item) => item.id === value.record.toSessionId)) return;
    await applyRecord(value.recordType, value.record, value.origin);
  }
}

async function handleProtocol(target, sourceNick, text) {
  const marker = `${PROTOCOL_PREFIX} `;
  if (!text.startsWith(marker)) return;
  try {
    await receiveProtocol(target, sourceNick, decode(text.slice(marker.length)));
  } catch {
    // Ignore malformed messages from the IRC network; state remains local.
  }
}

function handleLine(line) {
  const parsed = parseIrcLine(line);
  if (!parsed) return;
  if (parsed.command === "PING") {
    sendRaw(`PONG :${parsed.params.at(-1) || "pi-team-room"}`);
    return;
  }
  if (parsed.command === "001") {
    ready = true;
    joinChannel(IRC_CHANNEL);
    void announceSessions().then(() => {
      sendProtocol(IRC_CHANNEL, { kind: "hello", nodeId: node.id, nick });
      sendProtocol(IRC_CHANNEL, { kind: "request" });
    }).catch(() => undefined);
    return;
  }
  if (parsed.command === "433") {
    nick = sanitizeNick(`${endpointNickFromNode(node)}-${Math.floor(Math.random() * 999)}`);
    sendRaw(`NICK ${nick}`);
    return;
  }
  if (parsed.command === "PRIVMSG") {
    const target = parsed.params[0];
    const sourceNick = nickFromPrefix(parsed.prefix);
    void handleProtocol(target, sourceNick, parsed.params[1] || "");
  }
}

function connectOnce() {
  return new Promise((resolve) => {
    ready = false;
    joinedChannels = new Set();
    input = "";
    const options = { host: IRC_HOST, port: IRC_PORT };
    if (IRC_TLS) {
      options.rejectUnauthorized = IRC_TLS_REJECT_UNAUTHORIZED;
      if (!isIP(IRC_HOST)) options.servername = IRC_HOST;
      socket = tlsConnect(options);
    } else {
      socket = createConnection(options);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (IRC_SERVER_PASSWORD) sendRaw(`PASS ${IRC_SERVER_PASSWORD}`);
      sendRaw(`NICK ${nick}`);
      sendRaw(`USER ${IRC_USER} 0 * :Pi Team Room`);
    });
    socket.on("data", (chunk) => {
      input += chunk;
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, newline).replace(/\r$/, "");
        input = input.slice(newline + 1);
        handleLine(line);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      ready = false;
      socket = undefined;
      resolve();
    });
  });
}

async function checkNodeLease() {
  const state = await loadState();
  if (state.sessions.some(activeSession)) {
    noSessionsSince = undefined;
    return;
  }
  noSessionsSince ||= Date.now();
  if (Date.now() - noSessionsSince >= IRC_NODE_GRACE_MS) stop();
}

async function run() {
  const initialState = await loadState();
  markPublished(initialState);
  pollTimer = setInterval(() => { if (!pollInFlight) { pollInFlight = true; void publishLocalChanges().finally(() => { pollInFlight = false; }); } }, POLL_MS);
  leaseTimer = setInterval(() => { void checkNodeLease().catch(() => undefined); }, 15_000);
  pollTimer.unref?.();
  leaseTimer.unref?.();
  while (!stopping) {
    await connectOnce();
    if (!stopping) await new Promise((resolve) => {
      reconnectResolve = resolve;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        reconnectResolve = undefined;
        resolve();
      }, IRC_RECONNECT_MS);
    });
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(pollTimer);
  clearInterval(leaseTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectResolve?.();
  reconnectResolve = undefined;
  socket?.destroy();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await run();
