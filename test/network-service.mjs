import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLimits } from "../state-rules.mjs";

const MESSAGE_TEXT_BUDGET = resolveLimits().maxMessageChars;

const servicePath = fileURLToPath(new URL("../network-service.mjs", import.meta.url));
const secret = "test-only-shared-secret";

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function session(id, name) {
  const timestamp = new Date().toISOString();
  return {
    id,
    name,
    cwd: `/tmp/${name}`,
    project: `/tmp/${name}`,
    branch: "main",
    status: "idle",
    connected: true,
    startedAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    recentPaths: [],
  };
}

function initialState(id, name, updateText) {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    sessions: [session(id, name)],
    messages: [],
    updates: [{ id: `update-${name}`, sessionId: id, sessionName: name, project: `/tmp/${name}`, text: updateText, createdAt: timestamp }],
    journal: [],
  };
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function request(endpoint, path, options = {}) {
  return fetch(`${endpoint}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${secret}`, ...(options.headers || {}) },
  });
}

const leftDir = await mkdtemp(join(tmpdir(), "pi-team-room-left-"));
const rightDir = await mkdtemp(join(tmpdir(), "pi-team-room-right-"));
const leftState = join(leftDir, "state.json");
const rightState = join(rightDir, "state.json");
const leftPort = await freePort();
const rightPort = await freePort();
const leftEndpoint = `http://127.0.0.1:${leftPort}`;
const rightEndpoint = `http://127.0.0.1:${rightPort}`;
const children = [];
// Peers that accept a socket and never answer, started mid-run to prove a whole
// room is not held behind one unreachable node. Declared outside the try so the
// finally can always close them.
const blockers = [];
let lagDir;

function start(statePath, port, peer) {
  const child = spawn(process.execPath, [servicePath], {
    env: {
      ...process.env,
      PI_TEAM_ROOM_NETWORK: "1",
      PI_TEAM_ROOM_MDNS: "0",
      PI_TEAM_ROOM_SHARED_SECRET: secret,
      PI_TEAM_ROOM_STATE: statePath,
      PI_TEAM_ROOM_PORT: String(port),
      PI_TEAM_ROOM_BIND: "127.0.0.1",
      PI_TEAM_ROOM_PEERS: peer,
      PI_TEAM_ROOM_SYNC_MS: "100",
      PI_TEAM_ROOM_NODE_GRACE_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.failureOutput = () => stderr;
  children.push(child);
  return child;
}

try {
  const leftInitial = initialState("left-session", "desktop", "desktop update");
  leftInitial.messages.push({
    id: "delegation-desktop",
    kind: "delegation",
    fromSessionId: "left-session",
    fromName: "desktop",
    toSessionId: "right-session",
    text: "Implement the networked handoff.",
    delegation: {
      target: "mqtt_things/pkg/service",
      scope: "The service package only.",
      userAuthorization: "Commit the scoped service fix.",
      acceptanceChecks: "Run npm test.",
      expectedArtifact: "Commit SHA",
    },
    createdAt: new Date().toISOString(),
  });
  await writeState(leftState, leftInitial);
  await writeState(rightState, initialState("right-session", "laptop", "laptop update"));
  start(leftState, leftPort, rightEndpoint);
  start(rightState, rightPort, leftEndpoint);

  await waitFor("left service health", async () => (await fetch(`${leftEndpoint}/healthz`)).ok);
  await waitFor("right service health", async () => (await fetch(`${rightEndpoint}/healthz`)).ok);

  const unauthorized = await fetch(`${leftEndpoint}/v1/state`);
  assert.equal(unauthorized.status, 401, "state endpoint requires the shared secret");
  const info = await request(leftEndpoint, "/v1/info");
  assert.equal(info.status, 200);
  assert.equal((await info.json()).protocol, 1);

  await waitFor("desktop update on laptop", async () => {
    const state = await (await request(rightEndpoint, "/v1/state")).json();
    return state.updates.some((item) => item.text === "desktop update");
  });
  await waitFor("laptop update on desktop", async () => {
    const state = await (await request(leftEndpoint, "/v1/state")).json();
    return state.updates.some((item) => item.text === "laptop update");
  });
  await waitFor("structured delegation on laptop", async () => {
    const state = await (await request(rightEndpoint, "/v1/state")).json();
    return state.messages.some((item) => item.kind === "delegation" && item.delegation?.userAuthorization === "Commit the scoped service fix.");
  });

  // A sleeping laptop is the ordinary case, and it looks like a peer that accepts
  // a socket and never answers. That peer must not hold every other peer's update
  // behind its request timeout, and it must not be re-tried every sync cycle.
  async function silentPeer() {
    const sockets = new Set();
    const peer = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolvePromise, reject) => {
      peer.once("error", reject);
      peer.listen(0, "127.0.0.1", resolvePromise);
    });
    blockers.push(peer);
    return `http://127.0.0.1:${peer.address().port}`;
  }
  const blockedEndpoints = [await silentPeer(), await silentPeer(), await silentPeer()];
  lagDir = await mkdtemp(join(tmpdir(), "pi-team-room-lag-"));
  const lagState = join(lagDir, "state.json");
  const lagPort = await freePort();
  const lagEndpoint = `http://127.0.0.1:${lagPort}`;
  await writeState(lagState, initialState("lag-session", "relay", "relay update"));
  // Silent peers are listed first on purpose: a peer loop that walks the list in
  // order spends its whole cycle on them before it ever reaches the live peer.
  // Two live peers as well as the silent ones: the relay merges both snapshots
  // concurrently, which is where a lost update would appear.
  start(lagState, lagPort, [...blockedEndpoints, rightEndpoint, leftEndpoint].join(","));
  await waitFor("relay service health", async () => (await fetch(`${lagEndpoint}/healthz`)).ok);

  const liveState = await (await request(rightEndpoint, "/v1/state")).json();
  liveState.updates.push({
    id: "update-crosses-the-room",
    sessionId: "right-session",
    sessionName: "laptop",
    project: "/tmp/laptop",
    text: "an update that has to cross a room with a silent peer",
    createdAt: new Date().toISOString(),
  });
  await request(rightEndpoint, "/v1/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(liveState),
  });
  const crossingStartedAt = Date.now();
  const crossed = await waitFor("update crossing a room with silent peers", async () =>
    (await (await request(lagEndpoint, "/v1/state")).json()).updates.some((item) => item.id === "update-crosses-the-room"), 8_000);
  const crossingMs = Date.now() - crossingStartedAt;
  assert.ok(crossed, "an update still reaches a peer behind three unresponsive ones");
  assert.ok(crossingMs < 3_000, `a silent peer held the room open for ${crossingMs}ms; peers are synced concurrently`);

  // The relay never talks to the desktop directly; it only hears about the desktop
  // through the laptop's merged snapshot. Two-hop propagation is what makes a room
  // of peers one context rather than a set of pairwise links, and it has to hold
  // while the relay is also merging a second live peer concurrently.
  await waitFor("a two-hop update reaches the relay", async () => {
    const state = await (await request(lagEndpoint, "/v1/state")).json();
    return state.updates.some((item) => item.text === "desktop update") &&
      state.updates.some((item) => item.text === "laptop update");
  }, 6_000);

  const peerHealth = await waitFor("silent peers reported and backed off", async () => {
    const peers = (await (await request(lagEndpoint, "/v1/peers")).json()).peers;
    const blocked = peers.filter((item) => blockedEndpoints.includes(item.endpoint));
    const live = peers.find((item) => item.endpoint === rightEndpoint);
    if (blocked.length !== 3) return undefined;
    if (!blocked.every((item) => item.failures >= 1 && Date.parse(item.nextRetryAt) > Date.now())) return undefined;
    if (!live || live.failures !== 0 || !live.lastSuccessAt) return undefined;
    return { blocked, live };
  }, 6_000);
  assert.ok(peerHealth, "the relay reports each silent peer with a retry backoff, and the live peer as healthy");
  const attemptsBefore = peerHealth.blocked.map((item) => `${item.endpoint}:${item.failures}`).join("|");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  const attemptsAfter = (await (await request(lagEndpoint, "/v1/peers")).json()).peers
    .filter((item) => blockedEndpoints.includes(item.endpoint))
    .map((item) => `${item.endpoint}:${item.failures}`)
    .join("|");
  assert.equal(attemptsAfter, attemptsBefore, "a peer that is not answering is backed off, not retried every cycle");
  await waitFor("the live peer keeps syncing while silent peers are backed off", async () =>
    (await (await request(lagEndpoint, "/v1/peers")).json()).peers
      .find((item) => item.endpoint === rightEndpoint)?.lastSuccessAt);

  // Long briefs are bounded on the wire too: a snapshot whose message text blows
  // past the shared budget keeps the newest messages and drops the oldest.
  const flood = Array.from({ length: 60 }, (_unused, index) => ({
    id: `flood-${String(index).padStart(3, "0")}`,
    kind: "reply",
    fromSessionId: "flood-session",
    fromName: "flood",
    toSessionId: "left-session",
    text: `${"y".repeat(4_990)}${String(index).padStart(10, "0")}`,
    // Recent on purpose: retention prunes stale coordination traffic, so a
    // budget test has to flood with messages the pruning rules consider live.
    createdAt: new Date(Date.now() - (60 - index) * 1_000).toISOString(),
  }));
  const flooded = await request(leftEndpoint, "/v1/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, sessions: [], messages: flood, updates: [], journal: [] }),
  });
  assert.equal(flooded.status, 200, "oversized message flood is accepted, not rejected");
  const floodState = (await flooded.json()).state;
  const storedChars = floodState.messages.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(storedChars <= MESSAGE_TEXT_BUDGET, `stored message text stays under budget (${storedChars})`);
  assert.ok(floodState.messages.some((item) => item.id === "flood-059"), "newest long message survives the budget");
  assert.ok(!floodState.messages.some((item) => item.id === "flood-000"), "oldest long messages are dropped first");

  const invalid = await request(leftEndpoint, "/v1/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 999 }),
  });
  assert.equal(invalid.status, 400, "invalid remote state is rejected");
  const mode = (await stat(leftState)).mode & 0o777;
  assert.equal(mode, 0o600, "synced state remains private to the local user");

  console.log("network service integration harness: PASS");
} finally {
  for (const peer of blockers) {
    try { peer.removeAllListeners(); } catch { /* best effort */ }
    try { peer.close(); } catch { /* best effort */ }
  }
  for (const child of children) {
    // Some sandboxes refuse to signal a child process. Cleanup must not throw
    // here: an exception in this finally replaces whatever real assertion just
    // failed, which turns a genuine test failure into a confusing EACCES.
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* the child is unref'd below either way */
      }
    }
    // A child that ignores the signal must not hold this harness open either;
    // the exit race below is what bounds the wait, not the child handle.
    child.unref();
  }
  await Promise.all(children.map((child) => new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    child.once("exit", resolvePromise);
    setTimeout(resolvePromise, 1_000);
  })));
  for (const directory of [leftDir, rightDir, lagDir]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" || attempt === 5) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
  }
}
