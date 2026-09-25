import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const servicePath = join(root, "irc-service.mjs");
const dir = await mkdtemp(join(tmpdir(), "pi-team-room-irc-"));
const leftPath = join(dir, "left.json");
const rightPath = join(dir, "right.json");
const clients = new Set();
const nicks = new Map();
const joins = [];
const parts = [];
const messages = [];

function splitLine(line) {
  const result = [];
  let rest = line;
  while (rest) {
    if (rest.startsWith(":")) {
      result.push(rest.slice(1));
      break;
    }
    const index = rest.indexOf(" ");
    if (index < 0) { result.push(rest); break; }
    result.push(rest.slice(0, index));
    rest = rest.slice(index + 1).replace(/^ +/, "");
  }
  return result;
}

function session(id, name, focus) {
  const timestamp = new Date().toISOString();
  return { id, name, cwd: `/tmp/${name}`, project: `/tmp/${name}`, branch: "main", focus,
    status: "idle", connected: true, startedAt: timestamp, updatedAt: timestamp,
    lastSeenAt: timestamp, recentPaths: [] };
}

function state(id, name, focus) {
  return { version: 1, sessions: [session(id, name, focus)], messages: [], updates: [], journal: [] };
}

async function writeState(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readState(path) { return JSON.parse(await readFile(path, "utf8")); }

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const server = createServer((socket) => {
  const client = { socket, nick: undefined, channels: new Set(), buffer: "", welcomed: false };
  clients.add(client);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    client.buffer += chunk;
    let index;
    while ((index = client.buffer.indexOf("\n")) >= 0) {
      const line = client.buffer.slice(0, index).replace(/\r$/, "");
      client.buffer = client.buffer.slice(index + 1);
      const tokens = splitLine(line);
      const command = tokens.shift()?.toUpperCase();
      if (command === "NICK") {
        client.nick = tokens[0];
        nicks.set(client.nick, client);
      } else if (command === "USER" && client.nick && !client.welcomed) {
        client.welcomed = true;
        socket.write(`:mock 001 ${client.nick} :welcome\r\n`);
      } else if (command === "PONG") {
        // no-op
      } else if (command === "JOIN") {
        const channel = tokens[0];
        client.channels.add(channel);
        joins.push({ nick: client.nick, channel });
        socket.write(`:${client.nick}!room@mock JOIN :${channel}\r\n`);
      } else if (command === "PART") {
        const channel = tokens[0];
        client.channels.delete(channel);
        parts.push({ nick: client.nick, channel });
        socket.write(`:${client.nick}!room@mock PART ${channel}\r\n`);
      } else if (command === "PRIVMSG") {
        const target = tokens[0];
        const text = tokens[1] || "";
        messages.push({ from: client.nick, target, text });
        const recipients = target.startsWith("#")
          ? [...clients].filter((peer) => peer.channels.has(target))
          : [nicks.get(target)].filter(Boolean);
        for (const recipient of recipients) recipient.socket.write(`:${client.nick}!room@mock PRIVMSG ${target} :${text}\r\n`);
      }
    }
  });
  socket.on("close", () => clients.delete(client));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const children = [];

function broadcast(channel, text) {
  for (const client of clients) {
    if (client.channels.has(channel)) client.socket.write(`:legacy!user@mock PRIVMSG ${channel} :${text}\r\n`);
  }
}

function start(statePath, sessionId, hostName) {
  const child = spawn(process.execPath, [servicePath], {
    env: { ...process.env, PI_TEAM_ROOM_NETWORK: "irc", PI_TEAM_ROOM_STATE: statePath, PI_TEAM_ROOM_SESSION_ID: sessionId,
      PI_TEAM_ROOM_NODE_NAME: hostName, PI_TEAM_ROOM_IRC_HOST: "127.0.0.1", PI_TEAM_ROOM_IRC_PORT: String(port),
      PI_TEAM_ROOM_IRC_CHANNEL: "#pi-test", PI_TEAM_ROOM_IRC_SYNC_CHANNEL: "#pi-test-sync-v2", PI_TEAM_ROOM_IRC_FOCUS_PREFIX: "#pi-focus-",
      PI_TEAM_ROOM_IRC_POLL_MS: "40", PI_TEAM_ROOM_IRC_RECONNECT_MS: "40", PI_TEAM_ROOM_IRC_TLS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => console.error(`IRC ${sessionId}: ${chunk}`));
  children.push(child);
  return child;
}

try {
  let left = state("left-session", "left", "builds");
  left.sessions.push(session("local-session-charlie", "local", "planning"));
  const right = state("right-session", "right", "reviews");
  const leftNick = "host-te-left-left-ession";
  const localNick = "host-te-local-local-harlie";
  const rightNick = "other-h-right-right-ession";
  await writeState(leftPath, left);
  await writeState(rightPath, right);
  start(leftPath, "left-session", "host-test");
  await waitFor("first per-agent IRC client", () => joins.some((item) => item.nick === leftNick && item.channel === "#pi-test"));
  const duplicateBridge = start(leftPath, "left-session", "host-test");
  await waitFor("duplicate per-session bridge exits", () => duplicateBridge.exitCode !== null);
  start(leftPath, "local-session-charlie", "host-test");
  await waitFor("second same-host agent IRC client", () => joins.some((item) => item.nick === localNick && item.channel === "#pi-test"));
  assert.equal(new Set([...clients].map((item) => item.nick)).size, clients.size,
    "each local agent session gets its own IRC nick");
  assert.ok([...clients].every((item) => item.nick.length <= 30), "generated session nicks fit IRC's length limit");
  start(rightPath, "right-session", "other-host");

  await waitFor("both IRC clients and initial focus channel", () =>
    joins.some((item) => item.nick === leftNick && item.channel === "#pi-test") &&
    joins.some((item) => item.nick === leftNick && item.channel === "#pi-test-sync-v2") &&
    joins.some((item) => item.nick === localNick && item.channel === "#pi-test") &&
    joins.some((item) => item.nick === localNick && item.channel === "#pi-test-sync-v2") &&
    joins.some((item) => item.nick === rightNick && item.channel === "#pi-test") &&
    joins.some((item) => item.nick === rightNick && item.channel === "#pi-test-sync-v2") &&
    joins.some((item) => item.channel === "#pi-focus-builds") &&
    joins.some((item) => item.channel === "#pi-focus-planning") &&
    joins.some((item) => item.channel === "#pi-focus-reviews"));

  const legacyUpdate = { v: 1, origin: "legacy-node", kind: "record", recordType: "update",
    record: { id: "legacy-main-update", sessionId: "legacy", sessionName: "legacy", project: "/tmp", text: "must be ignored", createdAt: new Date().toISOString() } };
  broadcast("#pi-test", `PI_TEAM_ROOM/1 ${Buffer.from(JSON.stringify(legacyUpdate)).toString("base64url")}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await readState(leftPath)).updates.some((item) => item.id === "legacy-main-update"), false,
    "protocol history in the human-facing room is ignored");
  left = await readState(leftPath);
  left.updates.push({ id: "left-update", sessionId: "left-session", sessionName: "left", project: "/tmp/left", text: "left update", createdAt: new Date().toISOString() });
  await writeState(leftPath, left);
  await waitFor("update propagation", async () => (await readState(rightPath)).updates.some((item) => item.text === "left update"));
  assert.ok(messages.some((item) => item.target === "#pi-test" && item.text.startsWith("[update]") &&
    item.text.includes("-left-left-left-s: left update")), "human updates identify host, agent, project and session");
  assert.equal(messages.filter((item) => item.target === "#pi-test" && item.text.includes(": left update")).length, 1,
    "only the originating agent publishes its update from shared state");

  left.messages.push({ id: "left-message", kind: "question", fromSessionId: "left-session", fromName: "left",
    toSessionId: "right-session", text: "direct question", createdAt: new Date().toISOString() });
  await writeState(leftPath, left);
  await waitFor("direct question propagation", async () => (await readState(rightPath)).messages.some((item) => item.text === "direct question"));
  assert.ok(messages.some((item) => item.from === leftNick && item.target === rightNick), "targeted messages use the recipient IRC nick");
  assert.ok(messages.some((item) => item.target === "#pi-test" && item.text.startsWith("[focus]") &&
    item.text.includes("-left-left@main-left-s active:")),
    "focus announcements identify host, agent, project, branch and session");
  assert.equal(messages.some((item) => item.target === "#pi-test" && item.text.startsWith("PI_TEAM_ROOM/1")), false,
    "machine protocol payloads stay off the human-facing room");

  right.messages.push({ id: "right-reply", kind: "reply", fromSessionId: "right-session", fromName: "right",
    toSessionId: "left-session", replyToId: "left-message", text: "direct reply", createdAt: new Date().toISOString() });
  await writeState(rightPath, right);
  await waitFor("direct reply propagation", async () => (await readState(leftPath)).messages.some((item) => item.text === "direct reply"));

  const oldFocus = left.sessions.find((item) => item.id === "left-session").focus;
  const localSession = left.sessions.find((item) => item.id === "left-session");
  left.sessions = left.sessions.map((item) => item.id === localSession.id
    ? { ...item, focus: "release automation", updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
    : item);
  await writeState(leftPath, left);
  await waitFor("new focus channel join", () => joins.some((item) => item.nick === leftNick && item.channel === "#pi-focus-release-automation"));
  await waitFor("old focus channel leave", () => parts.some((item) => item.nick === leftNick && item.channel === `#pi-focus-${oldFocus}`));
  assert.ok(messages.some((item) => item.target === "#pi-focus-release-automation"), "focus updates are publicized in the dynamic focus channel");

  const joinedBeforeReconnect = joins.filter((item) => item.nick === leftNick && item.channel === "#pi-test").length;
  [...clients].find((client) => client.nick === leftNick).socket.destroy();
  await waitFor("per-agent bridge reconnect", () => joins.filter((item) => item.nick === leftNick && item.channel === "#pi-test").length > joinedBeforeReconnect);
  await new Promise((resolve) => setTimeout(resolve, 100));
  left = await readState(leftPath);
  left.messages.push({ id: "left-reconnect-message", kind: "question", fromSessionId: "left-session", fromName: "left",
    toSessionId: "right-session", text: "direct question after reconnect", createdAt: new Date().toISOString() });
  await writeState(leftPath, left);
  await waitFor("targeted routing survives reconnect", async () =>
    (await readState(rightPath)).messages.some((item) => item.id === "left-reconnect-message"));
  assert.ok(messages.some((item) => item.from === leftNick && item.target === rightNick),
    "reconnected agent routes messages to remote session nicks rather than rebroadcasting them");

  console.log("IRC backend multi-client integration: PASS");
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 1_000);
  })));
  server.close();
  await rm(dir, { recursive: true, force: true });
}
