import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stat, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  console.log("session history integration harness: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
