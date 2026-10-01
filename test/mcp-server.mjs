import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateDir = await mkdtemp(join(tmpdir(), "pi-team-room-mcp-"));
const statePath = join(stateDir, "state.json");
const serverPath = join(root, "mcp-server.mjs");
const transports = [];
const clients = [];

function makeClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: stateDir,
    stderr: "pipe",
    env: {
      ...process.env,
      PI_TEAM_ROOM_AGENT_NAME: name,
      PI_TEAM_ROOM_HEARTBEAT_MS: "100",
      PI_TEAM_ROOM_NETWORK: "0",
      PI_TEAM_ROOM_STATE: statePath,
    },
  });
  const client = new Client({ name: `test-${name}`, version: "1.0.0" }, { capabilities: {} });
  transports.push(transport);
  clients.push(client);
  return client.connect(transport).then(() => client);
}

async function state() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function waitFor(label, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const codex = await makeClient("codex-test");
  const claude = await makeClient("claude-test");
  await waitFor("both MCP sessions", async () => {
    const sessions = (await state()).sessions;
    return sessions.some((session) => session.name === "codex-test") && sessions.some((session) => session.name === "claude-test");
  });
  const listed = await codex.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["team_room"]);

  const codexPulse = await codex.callTool({ name: "team_room", arguments: { action: "pulse" } });
  assert.match(codexPulse.content[0].text, /claude-test/);
  const sessions = (await state()).sessions;
  const codexSession = sessions.find((session) => session.name === "codex-test");
  const claudeSession = sessions.find((session) => session.name === "claude-test");
  assert.ok(codexSession && claudeSession, "each MCP connection registers a presence session");
  assert.match((await codex.callTool({ name: "team_room", arguments: { action: "focus", text: "MCP adapter" } })).content[0].text, /Focus updated/);
  assert.match((await claude.callTool({ name: "team_room", arguments: { action: "update", text: "MCP server connected" } })).content[0].text, /Shared with the team/);

  const ask = await codex.callTool({ name: "team_room", arguments: { action: "ask", agent: "claude-test", text: "Can you validate this handoff?" } });
  assert.match(ask.content[0].text, /Question sent to claude-test/);
  const inbox = await claude.callTool({ name: "team_room", arguments: { action: "inbox" } });
  assert.match(inbox.content[0].text, /Can you validate this handoff/);
  const messageId = inbox.content[0].text.match(/\[question ([0-9a-f]{8})\]/)?.[1];
  assert.ok(messageId, "MCP inbox gives the sender a reply id");
  const reply = await claude.callTool({ name: "team_room", arguments: { action: "reply", messageId, text: "Validated; looks good." } });
  assert.match(reply.content[0].text, /Reply sent to codex-test/);
  assert.match((await codex.callTool({ name: "team_room", arguments: { action: "inbox" } })).content[0].text, /Validated; looks good/);

  const messagesBeforeOverLimit = (await state()).messages.length;
  const longAsk = await codex.callTool({ name: "team_room", arguments: { action: "ask", agent: "claude-test", text: "x".repeat(501) } });
  assert.equal(longAsk.isError, true, "over-limit ask surfaces as an MCP tool error");
  assert.match(longAsk.content[0].text, /501 characters; the limit is 500.*Nothing was sent/);
  const longReply = await claude.callTool({ name: "team_room", arguments: { action: "reply", messageId, text: "y".repeat(501) } });
  assert.equal(longReply.isError, true, "over-limit reply surfaces as an MCP tool error");
  assert.equal((await state()).messages.length, messagesBeforeOverLimit, "over-limit ask/reply is refused, not truncated and sent");

  // The heartbeat refreshes liveness but must not overwrite status (e.g. flip a running call to idle).
  const lockPath = `${statePath}.lock`;
  await writeFile(lockPath, "test\n", { flag: "wx" });
  const marked = await state();
  const claudeBefore = marked.sessions.find((session) => session.name === "claude-test");
  claudeBefore.status = "working";
  await writeFile(statePath, `${JSON.stringify(marked, null, 2)}\n`, { mode: 0o600 });
  await rm(lockPath);
  const refreshed = await waitFor("a heartbeat after marking working", async () => {
    const session = (await state()).sessions.find((item) => item.name === "claude-test");
    return Date.parse(session.lastSeenAt) > Date.parse(claudeBefore.lastSeenAt) + 250 ? session : undefined;
  });
  assert.equal(refreshed.status, "working", "heartbeats refresh lastSeenAt without overwriting status");

  const delegation = await codex.callTool({
    name: "team_room",
    arguments: {
      action: "delegate",
      agent: "claude-test",
      text: "Implement the scoped test change.",
      target: "pi-team-room/test",
      scope: "Only the MCP integration harness.",
      userAuthorization: "Commit this scoped change.",
      acceptanceChecks: "Run npm test.",
      expectedArtifact: "Commit SHA",
    },
  });
  assert.match(delegation.content[0].text, /Delegation sent to claude-test/);
  const delegatedInbox = await claude.callTool({ name: "team_room", arguments: { action: "inbox" } });
  assert.match(delegatedInbox.content[0].text, /User authorization: Commit this scoped change/);
  assert.match(delegatedInbox.content[0].text, /Expected artifact: Commit SHA/);

  assert.match((await claude.callTool({ name: "team_room", arguments: { action: "remember", text: "MCP tool interoperability" } })).content[0].text, /Saved to shared history/);
  assert.match((await codex.callTool({ name: "team_room", arguments: { action: "history", query: "interoperability" } })).content[0].text, /MCP tool interoperability/);
  const badDelegation = await codex.callTool({ name: "team_room", arguments: { action: "delegate", agent: "claude-test", text: "Missing scope" } });
  assert.equal(badDelegation.isError, true, "invalid delegation arguments surface as an MCP tool error");

  const mode = (await stat(statePath)).mode & 0o777;
  assert.equal(mode, 0o600, "MCP-created shared state remains private to the local user");
  console.log("pi-team-room MCP integration harness: PASS");
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  for (const transport of transports) {
    const pid = transport.pid;
    if (pid) process.kill(pid, "SIGTERM");
  }
  await rm(stateDir, { recursive: true, force: true });
}
