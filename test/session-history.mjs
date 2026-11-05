import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  mergeHistoryDatabases,
  openHistoryDatabase,
  parseSessionFile,
  syncSessionDatabase,
} from "../session-history.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-session-history-test-"));
const historyDir = join(root, "history");
const sessionA = join(root, "a.jsonl");
const sessionB = join(root, "b.jsonl");

function writeSession(path, id, cwd, entries) {
  const header = { type: "session", version: 3, id, timestamp: "2026-09-03T10:00:00.000Z", cwd };
  return writeFile(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

try {
  await writeSession(sessionA, "session-a", "/work/a", [
    { type: "message", id: "a-user", parentId: null, timestamp: "2026-09-03T10:00:01.000Z", message: { role: "user", content: "Investigate the service" } },
    { type: "message", id: "a-assistant", parentId: "a-user", timestamp: "2026-09-03T10:00:03.000Z", message: { role: "assistant", content: [
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "npm test" } },
    ] } },
    { type: "message", id: "a-result", parentId: "a-assistant", timestamp: "2026-09-03T10:00:04.000Z", message: { role: "toolResult", toolCallId: "call-a", toolName: "bash", content: [{ type: "text", text: "PASS" }], isError: false } },
  ]);
  await writeSession(sessionB, "session-b", "/work/b", [
    { type: "message", id: "b-user", parentId: null, timestamp: "2026-09-03T10:00:02.000Z", message: { role: "user", content: "Review the deployment" } },
    { type: "message", id: "b-assistant", parentId: "b-user", timestamp: "2026-09-03T10:00:05.000Z", message: { role: "assistant", content: "Deployment looks healthy." } },
  ]);

  const parsed = parseSessionFile(sessionA);
  assert.equal(parsed.header.id, "session-a");
  assert.equal(parsed.entries.length, 3);

  const dbA = syncSessionDatabase({ sessionFile: sessionA, historyDir });
  const dbB = syncSessionDatabase({ sessionFile: sessionB, historyDir });
  assert.equal((await stat(dbA)).mode & 0o777, 0o600);
  assert.equal((await stat(historyDir)).mode & 0o777, 0o700);

  const inspect = new DatabaseSync(dbA);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 3);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM content_blocks WHERE type = 'toolCall'").get().count, 1);
  const tool = inspect.prepare("SELECT * FROM tool_calls").get();
  assert.equal(tool.call_id, "call-a");
  assert.equal(tool.tool_name, "bash");
  assert.equal(tool.result_text, "PASS");
  inspect.close();

  const merged = mergeHistoryDatabases([
    { dbPath: dbA, sessionId: "session-a", from: "2026-09-03T10:00:01.000Z", to: "2026-09-03T10:00:04.000Z" },
    { dbPath: dbB, sessionId: "session-b" },
  ], join(root, "merged.sqlite"));
  const combined = openHistoryDatabase(merged);
  const timeline = combined.prepare("SELECT session_id, entry_id FROM timeline ORDER BY timestamp, session_id, ordinal").all();
  assert.deepEqual(timeline.map((row) => row.entry_id), ["a-user", "b-user", "a-assistant", "a-result", "b-assistant"]);
  assert.equal(combined.prepare("SELECT COUNT(*) AS count FROM tool_calls").get().count, 1);
  assert.equal(combined.prepare("SELECT selected_from FROM sessions WHERE session_id = 'session-a'").get().selected_from, "2026-09-03T10:00:01.000Z");
  combined.close();

  const cliScript = fileURLToPath(new URL("../session-history.mjs", import.meta.url));
  const cliOutput = execFileSync(process.execPath, [cliScript, "build", "--from", "2026-09-03T10:00:02Z",
    "--session", sessionA, "--session", sessionB, "--output", join(root, "cli.sqlite")], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
  assert.match(cliOutput, /cli\.sqlite/);
  const cliDb = new DatabaseSync(join(root, "cli.sqlite"));
  assert.deepEqual(cliDb.prepare("SELECT entry_id FROM timeline ORDER BY timestamp, session_id, ordinal").all().map((row) => row.entry_id), ["b-user", "a-assistant", "a-result", "b-assistant"]);
  cliDb.close();

  // A Pi transcript is append-only, so refreshing a sidecar must add the new
  // tail rather than rewrite the session, and must fall back to a full rebuild
  // when the stored prefix is no longer the transcript's prefix.
  const appendSession = join(root, "append.jsonl");
  const appendEntries = () => [
    { type: "message", id: "ap-user", parentId: null, timestamp: "2026-09-03T11:00:01.000Z", message: { role: "user", content: "First request" } },
    { type: "message", id: "ap-call", parentId: "ap-user", timestamp: "2026-09-03T11:00:02.000Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "call-ap", name: "bash", arguments: { command: "id" } },
    ] } },
  ];
  await writeSession(appendSession, "session-append", "/work/append", appendEntries());
  const appendDb = syncSessionDatabase({ sessionFile: appendSession, historyDir });

  // An unchanged transcript must not re-index: a real write would bump the
  // session row's indexed_at.
  const indexedAt = new DatabaseSync(appendDb).prepare("SELECT indexed_at FROM sessions WHERE session_id = 'session-append'").get().indexed_at;
  const bytesBefore = await readFile(appendDb);
  syncSessionDatabase({ sessionFile: appendSession, historyDir });
  const afterNoop = new DatabaseSync(appendDb).prepare("SELECT indexed_at FROM sessions WHERE session_id = 'session-append'").get().indexed_at;
  assert.equal(afterNoop, indexedAt, "an unchanged transcript re-indexed");
  assert.deepEqual(await readFile(appendDb), bytesBefore);

  // The tool result arrives in the next batch: the appended tail must be indexed
  // and the call recorded earlier must gain its result.
  await appendFile(appendSession, `${JSON.stringify({
    type: "message", id: "ap-result", parentId: "ap-call", timestamp: "2026-09-03T11:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call-ap", toolName: "bash", content: [{ type: "text", text: "uid=0" }], isError: false },
  })}\n`);
  await appendFile(appendSession, `${JSON.stringify({
    type: "message", id: "ap-next", parentId: "ap-result", timestamp: "2026-09-03T11:00:04.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  })}\n`);
  syncSessionDatabase({ sessionFile: appendSession, historyDir });

  const fromScratch = syncSessionDatabase({ sessionFile: appendSession, dbPath: join(root, "append-fresh.sqlite") });
  const projection = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    const out = {
      entries: db.prepare("SELECT entry_id, ordinal, parent_id, type, role, text FROM entries ORDER BY ordinal").all(),
      blocks: db.prepare("SELECT entry_id, block_index, type, name, tool_call_id FROM content_blocks ORDER BY entry_id, block_index").all(),
      calls: db.prepare("SELECT call_entry_id, block_index, call_id, tool_name, called_at, result_entry_id, result_text FROM tool_calls ORDER BY call_entry_id, block_index").all(),
    };
    db.close();
    return out;
  };
  assert.deepEqual(projection(appendDb), projection(fromScratch), "an appended tail must match a from-scratch index");
  assert.deepEqual(projection(appendDb).entries.map((row) => row.entry_id), ["ap-user", "ap-call", "ap-result", "ap-next"]);
  assert.equal(projection(appendDb).calls[0].result_text, "uid=0");

  // A rewrite inside the indexed prefix (a branch switch, a tree rewrite) must
  // not be appended onto: it has to rebuild, or the sidecar keeps entries the
  // transcript no longer has.
  await writeFile(appendSession, `${JSON.stringify({ type: "session", version: 3, id: "session-append", timestamp: "2026-09-03T11:00:00.000Z", cwd: "/work/append" })}\n${[
    { type: "message", id: "ap-user", parentId: null, timestamp: "2026-09-03T11:00:01.000Z", message: { role: "user", content: "Rewritten request" } },
    ...appendEntries().slice(1),
    { type: "message", id: "ap-result", parentId: "ap-call", timestamp: "2026-09-03T11:00:03.000Z", message: { role: "toolResult", toolCallId: "call-ap", toolName: "bash", content: [{ type: "text", text: "uid=0" }], isError: false } },
    { type: "message", id: "ap-next", parentId: "ap-result", timestamp: "2026-09-03T11:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "rewritten tail" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  syncSessionDatabase({ sessionFile: appendSession, historyDir });
  const rewritten = syncSessionDatabase({ sessionFile: appendSession, dbPath: join(root, "append-fresh-2.sqlite") });
  assert.deepEqual(projection(appendDb), projection(rewritten), "a rewrite inside the indexed prefix must rebuild, not append");
  assert.equal(new DatabaseSync(appendDb, { readOnly: true }).prepare("SELECT text FROM entries WHERE entry_id = 'ap-user'").get().text, "Rewritten request");

  // Which path actually ran matters: a full rebuild that happens to produce the
  // right rows would pass every comparison above. The rebuild path clears the
  // session's entry rows first (and content blocks cascade with them), so a
  // block that only an append can leave behind is a mechanism probe.
  const probeSession = join(root, "probe.jsonl");
  await writeSession(probeSession, "session-probe", "/work/probe", [
    { type: "message", id: "pr-user", parentId: null, timestamp: "2026-09-03T12:00:01.000Z", message: { role: "user", content: "Probe" } },
  ]);
  const probeDb = syncSessionDatabase({ sessionFile: probeSession, historyDir });
  {
    const db = new DatabaseSync(probeDb);
    db.prepare("INSERT INTO content_blocks(session_id, entry_id, block_index, type, text, raw_json) VALUES ('session-probe', 'pr-user', 999, 'sentinel', 'only an append can keep this', '{}')").run();
    db.close();
  }
  const sentinelCount = () => new DatabaseSync(probeDb, { readOnly: true }).prepare("SELECT COUNT(*) AS count FROM content_blocks WHERE block_index = 999").get().count;
  await appendFile(probeSession, `${JSON.stringify({
    type: "message", id: "pr-next", parentId: "pr-user", timestamp: "2026-09-03T12:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "tail" }] },
  })}\n`);
  syncSessionDatabase({ sessionFile: probeSession, historyDir });
  assert.equal(sentinelCount(), 1, "a tail sync rebuilt the session instead of extending it");

  await writeFile(probeSession, `${JSON.stringify({ type: "session", version: 3, id: "session-probe", timestamp: "2026-09-03T12:00:00.000Z", cwd: "/work/probe" })}\n${[
    { type: "message", id: "pr-user", parentId: null, timestamp: "2026-09-03T12:00:01.000Z", message: { role: "user", content: "Rewritten probe" } },
    { type: "message", id: "pr-next", parentId: "pr-user", timestamp: "2026-09-03T12:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "tail" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  syncSessionDatabase({ sessionFile: probeSession, historyDir });
  assert.equal(sentinelCount(), 0, "a rewritten prefix appended instead of rebuilding");
  assert.equal(new DatabaseSync(probeDb, { readOnly: true }).prepare("SELECT COUNT(*) AS count FROM entries").get().count, 2);
  assert.equal(new DatabaseSync(probeDb, { readOnly: true }).prepare("SELECT text FROM entries WHERE entry_id = 'pr-user'").get().text, "Rewritten probe");

  console.log("session history integration harness: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
