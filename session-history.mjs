#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";

// node:sqlite is available in the supported Node range but remains marked
// experimental in Node 22. Keep its one-time runtime warning from appearing
// on every Pi startup; other process warnings retain their normal handler.
const existingWarningListeners = process.listeners("warning");
for (const listener of existingWarningListeners) process.removeListener("warning", listener);
const sqliteWarningFilter = (warning) => {
  if (warning?.name === "ExperimentalWarning" && /SQLite/i.test(warning?.message || "")) return;
  for (const listener of existingWarningListeners) listener.call(process, warning);
};
process.on("warning", sqliteWarningFilter);
const { DatabaseSync } = await import("node:sqlite");
await new Promise((resolveWarning) => setImmediate(resolveWarning));
process.removeListener("warning", sqliteWarningFilter);
for (const listener of existingWarningListeners) process.on("warning", listener);
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HISTORY_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? ".", ".pi", "agent");
export const DEFAULT_HISTORY_DIR = join(DEFAULT_AGENT_DIR, "session-history");
export const DEFAULT_SESSION_DIR = join(DEFAULT_AGENT_DIR, "sessions");

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA user_version = ${HISTORY_SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL UNIQUE,
  cwd TEXT,
  name TEXT,
  parent_session TEXT,
  header_json TEXT NOT NULL,
  first_timestamp TEXT,
  last_timestamp TEXT,
  indexed_at TEXT NOT NULL,
  selected_from TEXT,
  selected_to TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  role TEXT,
  text TEXT,
  command TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  is_error INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS entries_by_time ON entries(timestamp, session_id, ordinal);
CREATE INDEX IF NOT EXISTS entries_by_role ON entries(session_id, role, timestamp);
CREATE INDEX IF NOT EXISTS entries_by_type ON entries(session_id, type, timestamp);

CREATE TABLE IF NOT EXISTS content_blocks (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  name TEXT,
  tool_call_id TEXT,
  arguments_json TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (session_id, entry_id, block_index),
  FOREIGN KEY (session_id, entry_id) REFERENCES entries(session_id, entry_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS blocks_by_type ON content_blocks(session_id, type, block_index);
CREATE INDEX IF NOT EXISTS blocks_by_tool_call ON content_blocks(session_id, tool_call_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL,
  call_entry_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT,
  called_at TEXT NOT NULL,
  result_entry_id TEXT,
  result_json TEXT,
  result_text TEXT,
  result_is_error INTEGER,
  result_at TEXT,
  PRIMARY KEY (session_id, call_entry_id, block_index),
  FOREIGN KEY (session_id, call_entry_id) REFERENCES entries(session_id, entry_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_calls_by_name ON tool_calls(session_id, tool_name, called_at);
CREATE INDEX IF NOT EXISTS tool_calls_by_call_id ON tool_calls(session_id, call_id);

CREATE VIEW IF NOT EXISTS timeline AS
SELECT
  e.session_id,
  s.source_file,
  s.cwd,
  s.name AS session_name,
  e.entry_id,
  e.parent_id,
  e.ordinal,
  e.type,
  e.timestamp,
  e.role,
  e.text,
  e.command,
  e.tool_name,
  e.tool_call_id,
  e.is_error,
  e.raw_json
FROM entries AS e
JOIN sessions AS s ON s.session_id = e.session_id;

INSERT INTO metadata(key, value) VALUES ('schema_version', '${HISTORY_SCHEMA_VERSION}')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort on platforms without chmod */ }
}

function ensurePrivateFile(path) {
  try { chmodSync(path, 0o600); } catch { /* best effort on platforms without chmod */ }
}

export function openHistoryDatabase(path, { initialize = true } = {}) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec("PRAGMA busy_timeout = 5000;");
  if (initialize) db.exec(SCHEMA_SQL);
  ensurePrivateFile(absolute);
  return db;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function contentBlocks(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.filter((block) => block && typeof block === "object") : [];
}

function blockText(block) {
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  if (block.type === "toolCall") {
    const name = typeof block.name === "string" ? block.name : "tool";
    return `[${name} ${json(block.arguments)}]`;
  }
  if (block.type === "image") return `[image ${block.mimeType || "unknown"}]`;
  return "";
}

function messageForEntry(entry) {
  if (entry?.type === "message") return entry.message && typeof entry.message === "object" ? entry.message : {};
  if (entry?.type === "custom_message") return entry;
  return entry && typeof entry === "object" ? entry : {};
}

function textForEntry(entry, message) {
  if (entry?.type === "compaction" || entry?.type === "branch_summary") return typeof entry.summary === "string" ? entry.summary : "";
  if (entry?.type === "model_change") return `${entry.provider || ""}/${entry.modelId || ""}`.replace(/^\//, "");
  if (entry?.type === "thinking_level_change") return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "";
  if (entry?.type === "session_info") return typeof entry.name === "string" ? entry.name : "";
  if (entry?.type === "label") return typeof entry.label === "string" ? entry.label : "";
  if (entry?.type === "message" || entry?.type === "custom_message") {
    return contentBlocks(message.content).map(blockText).filter(Boolean).join("\n");
  }
  if (entry?.type === "custom") return typeof entry.data === "string" ? entry.data : json(entry.data);
  return "";
}

function rowsForEntry(entry, ordinal, rawJson) {
  const message = messageForEntry(entry);
  const role = typeof message.role === "string" ? message.role : null;
  const blocks = entry?.type === "message" || entry?.type === "custom_message" ? contentBlocks(message.content) : [];
  const firstToolCall = blocks.find((block) => block.type === "toolCall");
  const timestamp = typeof entry?.timestamp === "string" && entry.timestamp ? entry.timestamp : new Date(0).toISOString();
  const text = textForEntry(entry, message);
  return {
    entry: {
      entryId: typeof entry?.id === "string" && entry.id ? entry.id : `line-${ordinal}`,
      ordinal,
      parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
      type: typeof entry?.type === "string" ? entry.type : "unknown",
      timestamp,
      role,
      text: text || null,
      command: typeof message.command === "string" ? message.command : null,
      toolName: typeof message.toolName === "string" ? message.toolName : (typeof firstToolCall?.name === "string" ? firstToolCall.name : null),
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : null,
      isError: typeof message.isError === "boolean" ? (message.isError ? 1 : 0) : null,
      rawJson: rawJson || json(entry),
    },
    blocks: blocks.map((block, blockIndex) => ({
      blockIndex,
      type: typeof block.type === "string" ? block.type : "unknown",
      text: blockText(block) || null,
      name: typeof block.name === "string" ? block.name : null,
      toolCallId: typeof block.id === "string" && block.type === "toolCall" ? block.id : null,
      argumentsJson: block.type === "toolCall" ? json(block.arguments) : null,
      rawJson: json(block),
    })),
  };
}

function readSessionPayload(sessionFile) {
  const absolute = resolve(sessionFile);
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new Error(`Session file is empty: ${absolute}`);
  let header;
  const entries = [];
  const rawEntries = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let value;
    try {
      value = JSON.parse(lines[lineIndex]);
    } catch (error) {
      throw new Error(`Invalid JSON in ${absolute} at line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (lineIndex === 0 && value?.type === "session") header = value;
    else {
      entries.push(value);
      rawEntries.push(lines[lineIndex]);
    }
  }
  if (!header) throw new Error(`Session file has no session header: ${absolute}`);
  return { sessionFile: absolute, header, entries, rawEntries };
}

export function parseSessionFile(sessionFile) {
  const payload = readSessionPayload(sessionFile);
  return { sessionFile: payload.sessionFile, header: payload.header, entries: payload.entries };
}

function payloadFromOptions(options) {
  const sessionFile = resolve(options.sessionFile);
  if (options.entries) {
    const header = options.header || { type: "session", version: 3, id: basename(sessionFile, extname(sessionFile)), timestamp: new Date(0).toISOString(), cwd: "" };
    return { sessionFile, header, entries: options.entries, rawEntries: options.entries.map((entry) => json(entry)) };
  }
  return readSessionPayload(sessionFile);
}

function sessionIdFor(payload) {
  if (typeof payload.header?.id === "string" && payload.header.id) return payload.header.id;
  return createHash("sha256").update(payload.sessionFile).digest("hex").slice(0, 32);
}

function sessionNameFor(payload, explicitName) {
  if (typeof explicitName === "string" && explicitName.trim()) return explicitName.trim();
  for (let index = payload.entries.length - 1; index >= 0; index--) {
    const entry = payload.entries[index];
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
  }
  return null;
}

function timestampBounds(entries, header) {
  const timestamps = entries.map((item) => item.entry.timestamp).filter(Boolean).sort();
  return {
    first: timestamps[0] || (typeof header.timestamp === "string" ? header.timestamp : null),
    last: timestamps.at(-1) || (typeof header.timestamp === "string" ? header.timestamp : null),
  };
}

function upsertSession(db, payload, options, rows, sessionId) {
  const bounds = timestampBounds(rows, payload.header);
  db.prepare(`
    INSERT INTO sessions(session_id, source_file, cwd, name, parent_session, header_json, first_timestamp, last_timestamp, indexed_at, selected_from, selected_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(session_id) DO UPDATE SET
      source_file = excluded.source_file,
      cwd = excluded.cwd,
      name = excluded.name,
      parent_session = excluded.parent_session,
      header_json = excluded.header_json,
      first_timestamp = excluded.first_timestamp,
      last_timestamp = excluded.last_timestamp,
      indexed_at = excluded.indexed_at,
      selected_from = NULL,
      selected_to = NULL
  `).run(
    sessionId,
    payload.sessionFile,
    typeof payload.header.cwd === "string" ? payload.header.cwd : null,
    sessionNameFor(payload, options.sessionName),
    typeof payload.header.parentSession === "string" ? payload.header.parentSession : null,
    json(payload.header),
    bounds.first,
    bounds.last,
    new Date().toISOString(),
  );
}

function rebuildToolCalls(db, sessionId) {
  db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
  const calls = db.prepare(`
    SELECT b.entry_id AS call_entry_id, b.block_index, b.tool_call_id AS call_id, b.name AS tool_name,
           b.arguments_json, e.timestamp AS called_at
    FROM content_blocks AS b
    JOIN entries AS e ON e.session_id = b.session_id AND e.entry_id = b.entry_id
    WHERE b.session_id = ? AND b.type = 'toolCall' AND b.tool_call_id IS NOT NULL
    ORDER BY e.ordinal, b.block_index
  `).all(sessionId);
  const resultByCallId = new Map();
  for (const result of db.prepare(`
    SELECT entry_id, tool_call_id, raw_json, text, is_error, timestamp
    FROM entries
    WHERE session_id = ? AND role = 'toolResult' AND tool_call_id IS NOT NULL
    ORDER BY ordinal
  `).all(sessionId)) {
    if (!resultByCallId.has(result.tool_call_id)) resultByCallId.set(result.tool_call_id, result);
  }
  const insert = db.prepare(`
    INSERT INTO tool_calls(session_id, call_entry_id, block_index, call_id, tool_name, arguments_json, called_at, result_entry_id, result_json, result_text, result_is_error, result_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const call of calls) {
    const result = resultByCallId.get(call.call_id);
    insert.run(sessionId, call.call_entry_id, call.block_index, call.call_id, call.tool_name || "tool", call.arguments_json,
      call.called_at, result?.entry_id ?? null, result?.raw_json ?? null, result?.text ?? null, result?.is_error ?? null, result?.timestamp ?? null);
  }
}

function writePayload(db, payload, options = {}) {
  const sessionId = sessionIdFor(payload);
  const rows = payload.entries.map((entry, index) => rowsForEntry(entry, index, payload.rawEntries[index]));
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertSession(db, payload, options, rows, sessionId);
    db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);
    const insertEntry = db.prepare(`
      INSERT INTO entries(session_id, entry_id, ordinal, parent_id, type, timestamp, role, text, command, tool_name, tool_call_id, is_error, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBlock = db.prepare(`
      INSERT INTO content_blocks(session_id, entry_id, block_index, type, text, name, tool_call_id, arguments_json, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const item = row.entry;
      insertEntry.run(sessionId, item.entryId, item.ordinal, item.parentId, item.type, item.timestamp, item.role, item.text,
        item.command, item.toolName, item.toolCallId, item.isError, item.rawJson);
      for (const block of row.blocks) {
        insertBlock.run(sessionId, item.entryId, block.blockIndex, block.type, block.text, block.name, block.toolCallId,
          block.argumentsJson, block.rawJson);
      }
    }
    rebuildToolCalls(db, sessionId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
  return sessionId;
}

/** Materialize or refresh one session's private SQLite history database. */
export function syncSessionDatabase(options) {
  if (!options?.sessionFile) throw new Error("sessionFile is required");
  const payload = payloadFromOptions(options);
  const sessionId = sessionIdFor(payload);
  const dbPath = resolve(options.dbPath || join(options.historyDir || DEFAULT_HISTORY_DIR, `${sessionId}.sqlite`));
  ensurePrivateDirectory(dirname(dbPath));
  const db = openHistoryDatabase(dbPath);
  try {
    writePayload(db, payload, options);
  } finally {
    db.close();
    ensurePrivateFile(dbPath);
  }
  return dbPath;
}

export function normalizeBoundary(value, end = false) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T${end ? "23:59:59.999" : "00:00:00.000"}Z`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp boundary: ${value}`);
  return date.toISOString();
}

function selectedRows(db, sessionId, from, to, table = "entries") {
  const where = ["session_id = ?"];
  const args = [sessionId];
  if (from) { where.push("timestamp >= ?"); args.push(from); }
  if (to) { where.push("timestamp <= ?"); args.push(to); }
  return db.prepare(`SELECT * FROM ${table} WHERE ${where.join(" AND ")} ORDER BY timestamp, ordinal`).all(...args);
}

function copySession(db, source, spec) {
  const sourceSession = source.prepare("SELECT * FROM sessions WHERE session_id = ?").get(spec.sessionId);
  if (!sourceSession) throw new Error(`No session ${spec.sessionId} in ${spec.dbPath}`);
  db.prepare(`
    INSERT INTO sessions(session_id, source_file, cwd, name, parent_session, header_json, first_timestamp, last_timestamp, indexed_at, selected_from, selected_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sourceSession.session_id, sourceSession.source_file, sourceSession.cwd, sourceSession.name, sourceSession.parent_session,
    sourceSession.header_json, sourceSession.first_timestamp, sourceSession.last_timestamp, new Date().toISOString(), spec.from ?? null, spec.to ?? null);

  const entries = selectedRows(source, spec.sessionId, spec.from, spec.to);
  const selectedIds = new Set(entries.map((entry) => entry.entry_id));
  const insertEntry = db.prepare(`
    INSERT INTO entries(session_id, entry_id, ordinal, parent_id, type, timestamp, role, text, command, tool_name, tool_call_id, is_error, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of entries) {
    insertEntry.run(entry.session_id, entry.entry_id, entry.ordinal, entry.parent_id, entry.type, entry.timestamp, entry.role, entry.text,
      entry.command, entry.tool_name, entry.tool_call_id, entry.is_error, entry.raw_json);
  }
  const insertBlock = db.prepare(`
    INSERT INTO content_blocks(session_id, entry_id, block_index, type, text, name, tool_call_id, arguments_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const block of source.prepare("SELECT * FROM content_blocks WHERE session_id = ? ORDER BY entry_id, block_index").all(spec.sessionId)) {
    if (selectedIds.has(block.entry_id)) insertBlock.run(block.session_id, block.entry_id, block.block_index, block.type, block.text, block.name,
      block.tool_call_id, block.arguments_json, block.raw_json);
  }
  const insertCall = db.prepare(`
    INSERT INTO tool_calls(session_id, call_entry_id, block_index, call_id, tool_name, arguments_json, called_at, result_entry_id, result_json, result_text, result_is_error, result_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const call of source.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY called_at, block_index").all(spec.sessionId)) {
    if (selectedIds.has(call.call_entry_id)) {
      insertCall.run(call.session_id, call.call_entry_id, call.block_index, call.call_id, call.tool_name, call.arguments_json, call.called_at,
        selectedIds.has(call.result_entry_id) ? call.result_entry_id : null,
        selectedIds.has(call.result_entry_id) ? call.result_json : null,
        selectedIds.has(call.result_entry_id) ? call.result_text : null,
        selectedIds.has(call.result_entry_id) ? call.result_is_error : null,
        selectedIds.has(call.result_entry_id) ? call.result_at : null);
    }
  }
}

/** Merge selected per-session databases into one timestamp-queryable SQLite DB. */
export function mergeHistoryDatabases(sources, outputPath) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("At least one source session is required");
  const absoluteOutput = resolve(outputPath);
  if (sources.some((source) => resolve(source.dbPath) === absoluteOutput)) {
    throw new Error("Output DB must be different from every per-session source DB");
  }
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  if (existsSync(absoluteOutput)) unlinkSync(absoluteOutput);
  const output = openHistoryDatabase(absoluteOutput);
  const seenSessions = new Set();
  output.exec("BEGIN IMMEDIATE");
  try {
    for (const spec of sources) {
      if (seenSessions.has(spec.sessionId)) throw new Error(`Session listed more than once: ${spec.sessionId}`);
      seenSessions.add(spec.sessionId);
      const source = openHistoryDatabase(spec.dbPath);
      try { copySession(output, source, spec); }
      finally { source.close(); }
    }
    output.prepare("INSERT INTO metadata(key, value) VALUES ('materialized_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
    output.prepare("INSERT INTO metadata(key, value) VALUES ('source_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(sources.length));
    output.exec("COMMIT");
  } catch (error) {
    try { output.exec("ROLLBACK"); } catch { /* preserve original error */ }
    output.close();
    try { unlinkSync(absoluteOutput); } catch { /* best effort */ }
    throw error;
  }
  output.close();
  ensurePrivateFile(absoluteOutput);
  return absoluteOutput;
}

export function listSessionFiles(root = DEFAULT_SESSION_DIR) {
  const result = [];
  const walk = (directory) => {
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) walk(path);
      else if (child.isFile() && child.name.endsWith(".jsonl")) result.push(path);
    }
  };
  walk(resolve(root));
  return result.sort();
}

export function resolveSessionFile(value, sessionsDir = DEFAULT_SESSION_DIR) {
  const raw = String(value);
  const expanded = raw.startsWith("~/") ? join(process.env.HOME ?? ".", raw.slice(2)) : raw;
  if (existsSync(expanded)) return resolve(expanded);
  const candidates = listSessionFiles(sessionsDir);
  for (const path of candidates) {
    try {
      const firstLine = readFileSync(path, "utf8").split(/\r?\n/, 1)[0];
      const header = JSON.parse(firstLine);
      if (header?.id === value || basename(path).startsWith(value)) return path;
    } catch { /* skip incomplete/deleted sessions */ }
  }
  throw new Error(`Could not find session path or id: ${value}`);
}

function usage() {
  return `pi-team-history — materialize and query Pi JSONL sessions as SQLite\n\nUsage:\n  pi-team-history list [--sessions-dir DIR]\n  pi-team-history index [--session PATH|ID ...] [--history-dir DIR] [--sessions-dir DIR]\n  pi-team-history build --session PATH|ID [--from TIME] [--to TIME] ... --output FILE [--force]\n  pi-team-history query --db FILE --sql 'SELECT ...' [--json]\n  pi-team-history schema\n\nCommands:\n  list       List saved Pi sessions and their metadata.\n  index      Create/refresh one private SQLite DB per session; with no --session, index all sessions.\n  build      Refresh selected sessions, then merge their timestamp-filtered entries into one DB.\n             Repeat --session to interleave multiple sessions by querying timeline ORDER BY timestamp.\n  query      Run SQL against a materialized DB (JSON output by default).\n  schema     Print the SQLite schema.\n\nTime bounds accept ISO timestamps or YYYY-MM-DD (inclusive).\nEnvironment: PI_CODING_AGENT_DIR, PI_SESSION_HISTORY_DIR.\n`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseCli(argv) {
  const command = argv.shift() || "help";
  const result = { command, sessions: [], historyDir: process.env.PI_SESSION_HISTORY_DIR || DEFAULT_HISTORY_DIR, sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR || DEFAULT_SESSION_DIR, output: "pi-history.sqlite", sql: undefined, json: false, force: false, globalFrom: undefined, globalTo: undefined };
  let current;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--session" || arg === "-s") {
      const value = takeValue(argv, index++, arg);
      current = { value, from: result.globalFrom, to: result.globalTo };
      result.sessions.push(current);
    } else if (arg === "--history-dir") result.historyDir = takeValue(argv, index++, arg);
    else if (arg === "--sessions-dir") result.sessionsDir = takeValue(argv, index++, arg);
    else if (arg === "--output" || arg === "-o") result.output = takeValue(argv, index++, arg);
    else if (arg === "--db") result.db = takeValue(argv, index++, arg);
    else if (arg === "--sql") result.sql = takeValue(argv, index++, arg);
    else if (arg === "--from" || arg === "--since") {
      const value = takeValue(argv, index++, arg);
      if (current) current.from = normalizeBoundary(value, false); else result.globalFrom = normalizeBoundary(value, false);
    } else if (arg === "--to" || arg === "--until") {
      const value = takeValue(argv, index++, arg);
      if (current) current.to = normalizeBoundary(value, true); else result.globalTo = normalizeBoundary(value, true);
    } else if (arg === "--json") result.json = true;
    else if (arg === "--force") result.force = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (!arg.startsWith("--") && command === "build") result.sessions.push({ value: arg, from: result.globalFrom, to: result.globalTo });
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function sessionInfo(path) {
  try {
    const payload = readSessionPayload(path);
    const name = sessionNameFor(payload);
    return { id: sessionIdFor(payload), path: payload.sessionFile, cwd: payload.header.cwd || "", name, entries: payload.entries.length, created: payload.header.timestamp || null };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

function printRows(rows, _asJson) {
  // JSON is intentionally the default: it is stable for shell pipelines and
  // can be fed directly into jq or another post-processing tool.
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli([...argv]);
  if (parsed.help || parsed.command === "help" || parsed.command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (parsed.command === "schema") {
    process.stdout.write(`${SCHEMA_SQL.trim()}\n`);
    return;
  }
  if (parsed.command === "list") {
    printRows(listSessionFiles(parsed.sessionsDir).map(sessionInfo), parsed.json);
    return;
  }
  if (parsed.command === "index") {
    const values = parsed.sessions.length > 0 ? parsed.sessions : listSessionFiles(parsed.sessionsDir).map((path) => ({ value: path }));
    const indexed = [];
    for (const spec of values) {
      const sessionFile = resolveSessionFile(spec.value, parsed.sessionsDir);
      const dbPath = syncSessionDatabase({ sessionFile, historyDir: parsed.historyDir });
      const payload = readSessionPayload(sessionFile);
      indexed.push({ id: sessionIdFor(payload), sessionFile, dbPath, entries: payload.entries.length });
    }
    printRows(indexed, parsed.json);
    return;
  }
  if (parsed.command === "build" || parsed.command === "materialize") {
    if (parsed.sessions.length === 0) throw new Error("build requires at least one --session PATH|ID");
    if (existsSync(resolve(parsed.output)) && !parsed.force) throw new Error(`Output already exists: ${parsed.output} (pass --force to replace it)`);
    const sources = [];
    for (const spec of parsed.sessions) {
      const sessionFile = resolveSessionFile(spec.value, parsed.sessionsDir);
      const dbPath = syncSessionDatabase({ sessionFile, historyDir: parsed.historyDir });
      const payload = readSessionPayload(sessionFile);
      const from = spec.from ? normalizeBoundary(spec.from, false) : undefined;
      const to = spec.to ? normalizeBoundary(spec.to, true) : undefined;
      if (from && to && from > to) throw new Error(`--from must not be after --to for ${sessionFile}`);
      sources.push({ dbPath, sessionId: sessionIdFor(payload), from, to });
    }
    const output = mergeHistoryDatabases(sources, parsed.output);
    printRows([{ output, sources: sources.length }], parsed.json);
    return;
  }
  if (parsed.command === "query") {
    if (!parsed.db || !parsed.sql) throw new Error("query requires --db FILE and --sql SQL");
    const db = new DatabaseSync(resolve(parsed.db));
    try {
      const rows = db.prepare(parsed.sql).all();
      printRows(rows, true);
    } finally { db.close(); }
    return;
  }
  throw new Error(`Unknown command: ${parsed.command}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`pi-team-history: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
