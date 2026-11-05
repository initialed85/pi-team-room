#!/usr/bin/env node
// Maintenance CLI for the machine-wide team-room state file.
//
// Reporting is the point: the file is read and rewritten by every Pi process on
// the node (presence tick, turn start, inbox poll), so its size is a per-turn
// cost rather than a disk concern. `--apply` runs the same pruning rules both
// writers use, for the case where a node was offline long enough to accumulate
// records the retention windows would have dropped.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pruneState, resolveLimits, serializeState } from "./state-rules.mjs";

const STATE_PATH = process.env.PI_TEAM_ROOM_STATE || join(process.env.HOME || process.cwd(), ".pi", "team-room", "state.json");
const apply = process.argv.includes("--apply");

function ageHours(oldest) {
  const parsed = Date.parse(oldest || "");
  if (!Number.isFinite(parsed)) return "none";
  return ((Date.now() - parsed) / 3_600_000).toFixed(1);
}

function oldestOf(records) {
  let oldest;
  for (const record of records) {
    const at = record.createdAt || record.updatedAt || "";
    if (!oldest || Date.parse(at) < Date.parse(oldest)) oldest = at;
  }
  return oldest;
}

let state;
try {
  state = JSON.parse(await readFile(STATE_PATH, "utf8"));
} catch {
  console.log(`${STATE_PATH}: no readable state file`);
  process.exit(0);
}

const limits = resolveLimits();
const before = JSON.stringify(state).length;
const { state: pruned, dropped } = pruneState(state, { limits });
const after = JSON.stringify(pruned).length;
const age = (list) => ageHours(oldestOf(list));

const rows = [
  ["path", STATE_PATH],
  ["node", hostname()],
  ["bytes", `${before} -> ${after} (${before ? ((1 - after / before) * 100).toFixed(1) : "0.0"}% reduction)`],
  ["sessions", `${pruned.sessions.length} kept, ${dropped.sessions} pruned (oldest ${age(state.sessions)}h old)`],
  ["messages", `${pruned.messages.length} kept, ${dropped.messages} pruned (oldest ${age(state.messages)}h old)`],
  ["updates", `${pruned.updates.length} kept, ${dropped.updates} pruned (oldest ${age(state.updates)}h old)`],
  ["journal", `${pruned.journal.length} kept, ${dropped.journal} pruned (oldest ${age(state.journal)}h old)`],
  ["retention", `sessions ${limits.sessionRetentionMs / 3_600_000}h (gone ${limits.sessionGoneMs / 3_600_000}h), messages ${limits.messageRetentionMs / 3_600_000}h, updates ${limits.updateRetentionMs / 3_600_000}h, journal ${limits.journalRetentionMs / 86_400_000}d`],
  ["ceilings", `state ${limits.maxStateChars} chars, messages ${limits.maxMessages} records/${limits.maxMessageChars} chars, journal ${limits.maxJournalItems} records/${limits.maxJournalChars} chars`],
];

for (const [label, value] of rows) console.log(`${label.padEnd(10)} ${value}`);

if (!apply) {
  console.log("\nno changes written; pass --apply to prune in place");
  process.exit(0);
}

if (before === after) {
  console.log("\nstate already matches the retention rules; nothing to rewrite");
  process.exit(0);
}

const temp = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
await mkdir(dirname(STATE_PATH), { recursive: true });
try {
  await writeFile(temp, serializeState(pruned), { mode: 0o600 });
  await rename(temp, STATE_PATH);
} catch (error) {
  await unlink(temp).catch(() => {});
  console.error(`rewrite failed: ${error.message}`);
  process.exit(1);
}
console.log(`\npruned ${STATE_PATH}: ${before} -> ${after} bytes`);
