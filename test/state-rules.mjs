import assert from "node:assert/strict";
import { pruneState, resolveLimits, serializeState } from "../state-rules.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const at = (offsetMs) => new Date(NOW - offsetMs).toISOString();

function state() {
  return {
    version: 1,
    sessions: [
      { id: "live", name: "live", lastSeenAt: at(60_000), updatedAt: at(60_000), connected: true },
      { id: "exited-recently", name: "exited", lastSeenAt: at(2 * HOUR), updatedAt: at(2 * HOUR), connected: false },
      { id: "exited-long-ago", name: "exited", lastSeenAt: at(10 * HOUR), updatedAt: at(10 * HOUR), connected: false },
      { id: "crashed", name: "crashed", lastSeenAt: at(30 * HOUR), updatedAt: at(30 * HOUR), connected: true },
    ],
    messages: [
      { id: "msg-fresh", createdAt: at(2 * HOUR), text: "fresh question", toSessionId: "live" },
      { id: "msg-stale", createdAt: at(30 * HOUR), text: "old question", toSessionId: "live" },
    ],
    updates: [
      { id: "upd-fresh", createdAt: at(1 * HOUR), text: "recent decision" },
      { id: "upd-stale", createdAt: at(50 * HOUR), text: "ancient decision" },
    ],
    journal: [
      { id: "j-fresh", createdAt: at(1 * HOUR), text: "durable decision" },
      { id: "j-stale", createdAt: at(40 * DAY), text: "decision from a month ago" },
    ],
  };
}

const limits = resolveLimits();
const pruned = pruneState(state(), { nowMs: NOW, limits });
const ids = (list) => list.map((item) => item.id);

assert.deepEqual(ids(pruned.state.sessions), ["live", "exited-recently"], "live peers and recently exited resume points survive");
assert.deepEqual(ids(pruned.state.messages), ["msg-fresh"], "stale coordination traffic is dropped, fresh messages survive");
assert.deepEqual(ids(pruned.state.updates), ["upd-fresh"], "the pulse only carries recent updates");
assert.deepEqual(ids(pruned.state.journal), ["j-fresh"], "the journal keeps its 30 day window");
assert.deepEqual(pruned.dropped, { sessions: 2, messages: 1, updates: 1, journal: 1 }, "drop counts are reported for both writers");

// Pruning must be idempotent: a peer that already pruned must not prune further
// on the next write, or the fleet would keep eating its own live records.
const twice = pruneState(pruned.state, { nowMs: NOW, limits });
assert.deepEqual(twice.state, pruned.state, "pruning is idempotent");
assert.deepEqual(twice.dropped, { sessions: 0, messages: 0, updates: 0, journal: 0 }, "a pruned state has nothing left to prune");

// Convergence: a sleeping peer wakes with an old snapshot and POSTs it back.
// The receiving side prunes at ingest, so the old records do not come back.
const merged = {
  version: 1,
  sessions: [...pruned.state.sessions, ...state().sessions],
  messages: [...pruned.state.messages, ...state().messages],
  updates: [...pruned.state.updates, ...state().updates],
  journal: [...pruned.state.journal, ...state().journal],
};
const rePruned = pruneState(merged, { nowMs: NOW, limits });
assert.deepEqual(ids(rePruned.state.sessions), ["live", "exited-recently"], "re-imported stale sessions are dropped again");
assert.deepEqual(ids(rePruned.state.messages), ["msg-fresh"], "re-imported stale messages are dropped again");

// A session the caller is still writing to must never be pruned out from under it.
const kept = pruneState({ ...state(), sessions: [{ id: "crashed", lastSeenAt: at(40 * HOUR), updatedAt: at(40 * HOUR), connected: true }] }, { nowMs: NOW, limits, keepSessionIds: ["crashed"] });
assert.deepEqual(ids(kept.state.sessions), ["crashed"], "the current session is never pruned, however old its record is");

// Character budgets keep the newest records and drop from the oldest end.
const chatty = {
  version: 1,
  sessions: [],
  updates: [],
  journal: [],
  messages: Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, createdAt: at(index * 1_000), text: "x".repeat(4_000) })),
};
const trimmed = pruneState(chatty, { nowMs: NOW, limits: resolveLimits({ maxMessageChars: 20_000 }) });
const remainingText = trimmed.state.messages.reduce((sum, message) => sum + message.text.length, 0);
assert.ok(remainingText <= 20_000, `message text is capped at the budget (got ${remainingText})`);
assert.ok(trimmed.state.messages.some((message) => message.id === "m0"), "the newest messages survive a character budget (m0 is the freshest)");
assert.ok(!trimmed.state.messages.some((message) => message.id === "m39"), "the oldest messages are what the budget removes");
assert.ok(trimmed.state.messages.length < 40, "older messages are dropped first");

// The serialized-file ceiling is a hard stop even with generous retention.
const huge = {
  version: 1,
  sessions: [{ id: "live", lastSeenAt: at(1000), updatedAt: at(1000), connected: true }],
  messages: [],
  journal: [],
  updates: Array.from({ length: 60 }, (_, index) => ({ id: `u${index}`, createdAt: at(index * 1000), text: "y".repeat(3_000) })),
};
const capped = pruneState(huge, { nowMs: NOW, limits: resolveLimits({ maxStateChars: 30_000 }) });
assert.ok(JSON.stringify(capped.state).length <= 30_000, "the state file stays under its ceiling");
assert.ok(capped.state.updates.length < 60, "the ceiling trims updates");
assert.ok(capped.state.updates.some((update) => update.id === "u0"), "the ceiling keeps the freshest updates");
assert.ok(!capped.state.updates.some((update) => update.id === "u59"), "the ceiling removes the oldest updates");
assert.ok(capped.state.sessions.length === 1, "the ceiling never drops session records, which is what makes peers addressable");

// pruneState must not mutate its input: the extension hands cached snapshots to
// renderers, and a mutating prune would corrupt them.
const original = state();
const snapshot = JSON.stringify(original);
pruneState(original, { nowMs: NOW, limits });
assert.equal(JSON.stringify(original), snapshot, "pruning does not mutate the input state");

// Serialization is compact, and still valid JSON for jq consumers.
const line = serializeState({ version: 1, sessions: [], messages: [], updates: [], journal: [] });
assert.ok(!line.includes("\n  "), "state is written compact rather than pretty-printed");
assert.equal(JSON.parse(line).version, 1, "compact state is still parseable");

console.log("state pruning rules harness: PASS");
