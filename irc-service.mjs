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
const IRC_SYNC_CHANNEL = normalizeChannel(process.env.PI_TEAM_ROOM_IRC_SYNC_CHANNEL || `${IRC_CHANNEL}-sync-v2`);
const IRC_FOCUS_PREFIX = normalizeChannelPrefix(process.env.PI_TEAM_ROOM_IRC_FOCUS_PREFIX || "#pi-focus-");
const IRC_SERVER_PASSWORD = process.env.PI_TEAM_ROOM_IRC_SERVER_PASSWORD || "";
const IRC_TLS_REJECT_UNAUTHORIZED = process.env.PI_TEAM_ROOM_IRC_TLS_REJECT_UNAUTHORIZED !== "0";
const IRC_RECONNECT_MS = Number(process.env.PI_TEAM_ROOM_IRC_RECONNECT_MS) || 1_000;
const IRC_NODE_GRACE_MS = Number(process.env.PI_TEAM_ROOM_IRC_NODE_GRACE_MS) || 120_000;
const LOCAL_SESSION_ID = process.env.PI_TEAM_ROOM_SESSION_ID || "";
const INSTANCE_LOCK_PATH = `${STATE_PATH}.irc-service.${sanitizeUser(LOCAL_SESSION_ID || "missing-session")}.lock`;
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
if (!LOCAL_SESSION_ID) {
  console.error("pi-team-room IRC backend: set PI_TEAM_ROOM_SESSION_ID");
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
  const sanitized = String(value || "pi-team-room").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 30) || "pi-team-room";
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `pi-${sanitized}`.slice(0, 30);
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

function endpointNickFromNode(node, session) {
  const suffix = LOCAL_SESSION_ID.replace(/[^A-Za-z0-9]/g, "").slice(-6) || "agent";
  const configuredNick = process.env.PI_TEAM_ROOM_IRC_NICK;
  if (configuredNick) return sanitizeNick(`${sanitizeUser(configuredNick).slice(0, 23)}-${suffix}`);
  const nickPart = (value) => displayPart(value).replace(/\./g, "-").slice(0, 7).replace(/[-_]+$/g, "") || "agent";
  const host = nickPart(node.name);
  const agent = nickPart(process.env.PI_TEAM_ROOM_AGENT_NAME || session?.name || "agent");
  const task = nickPart(String(session?.branch || basename(String(session?.project || "work"))).split("/").at(-1));
  return sanitizeNick(`${host}-${agent}-${task}-${suffix}`);
}

const nodePath = join(dirname(STATE_PATH), `.${basename(STATE_PATH)}.irc-node.json`);

async function loadNode() {
  const lockPath = `${nodePath}.lock`;
  await mkdir(dirname(nodePath), { recursive: true });
  let locked = false;
  for (let attempt = 0; attempt < 100 && !locked; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      locked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lockPid;
      try { lockPid = Number((await readFile(lockPath, "utf8")).trim()); } catch { lockPid = undefined; }
      if (Number.isInteger(lockPid) && lockPid > 0) {
        try { process.kill(lockPid, 0); } catch (processError) {
          if (processError?.code === "ESRCH") await unlink(lockPath).catch(() => undefined);
          else if (processError?.code !== "EPERM") throw processError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!locked) throw new Error("could not acquire the host IRC identity lock");
  try {
    let node;
    try { node = JSON.parse(await readFile(nodePath, "utf8")); } catch { node = undefined; }
    if (!node || typeof node.id !== "string") node = { id: randomUUID(), name: hostname() };
    const configuredNodeName = process.env.PI_TEAM_ROOM_NODE_NAME?.trim();
    if (configuredNodeName) node.name = configuredNodeName;
    else if (typeof node.name !== "string" || !node.name.trim()) node.name = hostname();
    const temp = `${nodePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(node, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, nodePath);
    return node;
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

const node = await loadNode();

const initialState = await loadState();
const localSession = initialState.sessions.find((session) => session.id === LOCAL_SESSION_ID);
if (!localSession) {
  console.error("pi-team-room IRC backend: session is missing from PI_TEAM_ROOM_STATE");
  process.exit(1);
}
let nick = endpointNickFromNode(node, localSession);
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
const sessionRoutes = new Map(initialState.sessions.filter((session) => session.ircNodeId && session.ircNick)
  .map((session) => [session.id, { nodeId: session.ircNodeId, nick: session.ircNick }]));
const snapshotChunks = new Map();
const readableSessionSignatures = new Map();

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

function sendPublicText(target, text) {
  const prefix = `PRIVMSG ${target} :`;
  let content = [...String(text || "").replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ")];
  while (content.length > 0 && Buffer.byteLength(`${prefix}${content.join("")}\r\n`, "utf8") > 510) content.pop();
  if (content.length > 0) sendRaw(`${prefix}${content.join("")}`);
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
  if (!ready || channel === IRC_CHANNEL || channel === IRC_SYNC_CHANNEL || !joinedChannels.has(channel)) return;
  joinedChannels.delete(channel);
  sendRaw(`PART ${channel}`);
}

function channelsForState(state) {
  return new Set(state.sessions.filter((session) => session.id === LOCAL_SESSION_ID && activeSession(session))
    .map((session) => focusChannel(session.focus)).filter(Boolean));
}

function syncFocusChannels(state) {
  if (!ready) return;
  const desired = channelsForState(state);
  for (const channel of desired) joinChannel(channel);
  for (const channel of [...joinedChannels]) {
    if (channel !== IRC_CHANNEL && channel !== IRC_SYNC_CHANNEL && !desired.has(channel)) partChannel(channel);
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

function displayPart(value) {
  return String(value || "unknown").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function sessionLabel(record) {
  const project = displayPart(basename(String(record.project || record.cwd || "project")));
  const branch = record.branch ? `@${displayPart(String(record.branch).split("/").at(-1))}` : "";
  return `${displayPart(node.name)}-${displayPart(record.name)}-${project}${branch}-${record.id.slice(0, 6)}`;
}

function updateLabel(record) {
  const project = displayPart(basename(String(record.project || "project")));
  return `${displayPart(node.name)}-${displayPart(record.sessionName)}-${project}-${String(record.sessionId || "session").slice(0, 6)}`;
}

async function updateLocalNickname(session) {
  const nextNick = endpointNickFromNode(node, session);
  if (nextNick === nick) return;
  nick = nextNick;
  session.ircNick = nick;
  sessionRoutes.set(session.id, { nodeId: node.id, nick });
  await withState((state) => {
    state.sessions = state.sessions.map((item) => item.id === LOCAL_SESSION_ID ? { ...item, ircNick: nick } : item);
  });
  sendRaw(`NICK ${nick}`);
}

function publishReadableSession(record) {
  const focus = String(record.focus || record.checkpoint?.text || "").trim().replace(/\s+/g, " ");
  const state = record.connected === false ? "left" : "active";
  const signature = JSON.stringify([record.name, record.project, record.branch, focus, state]);
  if (readableSessionSignatures.get(record.id) === signature) return;
  readableSessionSignatures.set(record.id, signature);
  const summary = `${sessionLabel(record)} ${state}: ${focus || "no focus recorded"}`;
  sendPublicText(IRC_CHANNEL, `[focus] ${summary}`);
  const channel = focusChannel(record.focus);
  if (channel) sendPublicText(channel, summary);
}

function sendRecord(recordType, record) {
  const event = recordType === "session" ? localSessionEvent(record) : { kind: "record", recordType, record };
  if (recordType === "message" && record.toSessionId) {
    const route = sessionRoutes.get(record.toSessionId);
    if (route?.nodeId === node.id) return;
    if (route) {
      sendProtocol(route.nick, event);
      return;
    }
  }
  sendProtocol(IRC_SYNC_CHANNEL, event);
  if (recordType === "session") publishReadableSession(record);
  if (recordType === "update" && !String(record.sessionId || "").startsWith("irc:")) {
    sendPublicText(IRC_CHANNEL, `[update] ${updateLabel(record)}: ${record.text}`);
  }
}

async function claimUnownedActiveSessions() {
  let state = await loadState();
  const localSession = state.sessions.find((session) => session.id === LOCAL_SESSION_ID);
  if (!localSession || !activeSession(localSession) || (localSession.ircNodeId === node.id && localSession.ircNick === nick)) return state;
  await withState((current) => {
    current.sessions = current.sessions.map((session) =>
      session.id === LOCAL_SESSION_ID ? { ...session, ircNodeId: node.id, ircNick: nick } : session);
  });
  state = await loadState();
  return state;
}

async function announceSessions() {
  const state = await claimUnownedActiveSessions();
  syncFocusChannels(state);
  const session = state.sessions.find((item) => item.id === LOCAL_SESSION_ID && activeSession(item));
  if (session && session.ircNodeId === node.id) {
    sendRecord("session", session);
    sessionRoutes.set(session.id, { nodeId: node.id, nick });
    published.set(`session:${session.id}`, recordSignature(session));
  }
}

function belongsToLocalSession(recordType, record) {
  if (recordType === "session") return record.id === LOCAL_SESSION_ID;
  if (recordType === "message") return record.fromSessionId === LOCAL_SESSION_ID;
  return record.sessionId === LOCAL_SESSION_ID;
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
      if (!belongsToLocalSession(recordType, record)) continue;
      if (recordType === "session") await updateLocalNickname(record);
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
    if (session.ircNodeId === origin) sessionRoutes.set(session.id, { nodeId: origin, nick: session.ircNick || sourceNick });
  }
  syncFocusChannels(incoming);
}

async function applyRecord(recordType, record, origin, sourceNick) {
  if (!record || typeof record.id !== "string") return;
  const incoming = recordType === "session" && origin ? { ...record, ircNodeId: origin, ircNick: sourceNick } : record;
  await withState((state) => {
    const groups = { session: "sessions", message: "messages", update: "updates", journal: "journal" };
    const field = groups[recordType];
    if (!field) return;
    const records = state[field];
    const index = records.findIndex((item) => item.id === incoming.id);
    if (index >= 0) {
      records[index] = mergeRecord(records[index], incoming);
      if (recordType === "session" && origin) {
        records[index].ircNodeId = origin;
        records[index].ircNick = sourceNick;
      }
    } else records.push(incoming);
    state[field] = records.slice(-({ sessions: MAX_SESSIONS, messages: MAX_MESSAGES, updates: MAX_UPDATES, journal: MAX_JOURNAL }[field]));
  });
  published.set(`${recordType}:${incoming.id}`, recordSignature(incoming));
  syncFocusChannels(await loadState());
}

async function sendSnapshot(target) {
  sendProtocol(target, { kind: "snapshot", state: await loadState() });
}

async function claimSnapshotAction(action, peerId) {
  const path = `${STATE_PATH}.irc-snapshot-${action}-${sanitizeUser(peerId)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${Date.now()}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let claimedAt;
      try { claimedAt = Number((await readFile(path, "utf8")).trim()); } catch { claimedAt = 0; }
      if (Date.now() - claimedAt < 60_000) return false;
      await unlink(path).catch(() => undefined);
    }
  }
  return false;
}

async function receiveProtocol(target, sourceNick, value) {
  if (!value || value.v !== PROTOCOL_VERSION) return;
  if (value.origin === node.id) {
    if (value.kind === "record" && value.recordType === "session" && value.record?.id) {
      sessionRoutes.set(value.record.id, { nodeId: node.id, nick: sourceNick });
    }
    return;
  }
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
    if (value.nodeId && await claimSnapshotAction("request", value.nodeId)) {
      sendProtocol(sourceNick, { kind: "request" });
    }
    return;
  }
  if (value.kind === "request") {
    if (await claimSnapshotAction("response", value.origin)) await sendSnapshot(sourceNick);
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
    await applyRecord(value.recordType, value.record, value.origin, sourceNick);
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
    joinChannel(IRC_SYNC_CHANNEL);
    void announceSessions().then(() => {
      sendProtocol(IRC_SYNC_CHANNEL, { kind: "hello", nodeId: node.id, nick });
    }).catch(() => undefined);
    return;
  }
  if (parsed.command === "433") {
    nick = sanitizeNick(`${endpointNickFromNode(node, localSession).slice(0, 25)}-${Math.floor(Math.random() * 999)}`);
    sessionRoutes.set(LOCAL_SESSION_ID, { nodeId: node.id, nick });
    void withState((state) => {
      state.sessions = state.sessions.map((session) => session.id === LOCAL_SESSION_ID ? { ...session, ircNick: nick } : session);
    }).catch(() => undefined);
    sendRaw(`NICK ${nick}`);
    return;
  }
  if (parsed.command === "PRIVMSG") {
    const target = parsed.params[0];
    if ((target?.startsWith("#") || target?.startsWith("&")) && target.toLowerCase() !== IRC_SYNC_CHANNEL.toLowerCase()) return;
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
  if (state.sessions.some((session) => session.id === LOCAL_SESSION_ID && activeSession(session))) {
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
