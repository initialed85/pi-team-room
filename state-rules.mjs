// Shared pruning rules for the machine-wide team-room state.
//
// Both the Pi-side extension and the network service apply exactly these rules
// on every write, which is what makes pruning converge. The network service
// POSTs whole state snapshots to peers every sync cycle, so an aggressively
// pruned node would otherwise have those records re-imported by the next peer's
// snapshot. Age-based rules evaluated identically on every node mean a
// resurrected record is dropped again on the next write by every node that
// already dropped it, instead of circulating forever.
//
// The whole point is size: every Pi presence tick, turn start, and inbox poll
// reads and rewrites this file, and Pi pays that cost inside the session.
//
// Tunable through the environment so a fleet can dial retention without a code
// change. Units are hours/days for readability.

const HOURS = 3_600_000;
const DAYS = 24 * HOURS;

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const STATE_LIMITS = {
  // A session that exited cleanly is kept this long so teammates still see its
  // resume point; anything silent longer than SESSION_GONE_HOURS is gone even if
  // it never wrote a shutdown record (killed process, closed laptop).
  sessionRetentionMs: envNumber("PI_TEAM_ROOM_SESSION_RETENTION_HOURS", 6) * HOURS,
  sessionGoneMs: envNumber("PI_TEAM_ROOM_SESSION_GONE_HOURS", 24) * HOURS,
  // Direct messages, delegations, and replies older than a day are stale
  // coordination traffic, not history: durable notes belong in the journal.
  messageRetentionMs: envNumber("PI_TEAM_ROOM_MESSAGE_RETENTION_HOURS", 24) * HOURS,
  // The pulse reads "since you were last here"; week-old updates are noise.
  updateRetentionMs: envNumber("PI_TEAM_ROOM_UPDATE_RETENTION_HOURS", 24) * HOURS,
  // The journal is the durable part of the room, so it keeps the longest window.
  journalRetentionMs: envNumber("PI_TEAM_ROOM_JOURNAL_RETENTION_DAYS", 30) * DAYS,
  maxSessions: envNumber("PI_TEAM_ROOM_MAX_SESSIONS", 100),
  maxMessages: envNumber("PI_TEAM_ROOM_MAX_MESSAGES", 5_000),
  maxUpdates: envNumber("PI_TEAM_ROOM_MAX_UPDATES", 60),
  maxJournalItems: envNumber("PI_TEAM_ROOM_MAX_JOURNAL", 200),
  maxJournalChars: envNumber("PI_TEAM_ROOM_MAX_JOURNAL_CHARS", 60_000),
  maxMessageChars: envNumber("PI_TEAM_ROOM_MAX_MESSAGE_CHARS", 100_000),
  // Hard ceiling on the serialized state. When the file would grow past this,
  // the oldest records are dropped first so Pi's per-turn cost stays bounded
  // even if retention windows are configured generously.
  maxStateChars: envNumber("PI_TEAM_ROOM_MAX_STATE_CHARS", 150_000),
};

export function resolveLimits(overrides = {}) {
  return { ...STATE_LIMITS, ...overrides };
}

function ageOf(timestamp, nowMs) {
  const parsed = Date.parse(timestamp || "");
  return Number.isFinite(parsed) ? nowMs - parsed : Number.MAX_SAFE_INTEGER;
}

function byNewest(a, b) {
  return (Date.parse(b.createdAt || b.updatedAt || "") || 0) - (Date.parse(a.createdAt || a.updatedAt || "") || 0);
}

function emptyState() {
  return { version: 1, sessions: [], messages: [], updates: [], journal: [] };
}

function isRecord(value) {
  return !!value && typeof value === "object" && typeof value.id === "string";
}

// Whole-state snapshots cross node boundaries, so the same record can arrive
// twice from two peers. Keeping one copy (the freshest) keeps the file from
// growing on merge traffic alone, and makes the retention counts meaningful.
function dedupeById(records, timeOf) {
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing || timeOf(record) > timeOf(existing)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

// Sessions are only useful while they are addressable: a peer that has not been
// seen recently cannot receive a wake, and a crashed session never reads its
// inbox again. Live records heartbeat every presence tick, so age is the signal.
function keepSession(session, nowMs, limits, keepIds) {
  if (keepIds.has(session.id)) return true;
  const age = ageOf(session.lastSeenAt || session.updatedAt, nowMs);
  if (age > limits.sessionGoneMs) return false;
  if (age > limits.sessionRetentionMs && session.connected === false) return false;
  return true;
}

// Oldest-first trimming against a character budget, used for the two record
// kinds whose text length is unbounded (peer messages, journal entries).
function trimToCharBudget(records, maxChars, read) {
  let total = records.reduce((sum, record) => sum + read(record).length, 0);
  if (total <= maxChars) return records;
  const sorted = [...records].sort((a, b) => (Date.parse(a.createdAt || "") || 0) - (Date.parse(b.createdAt || "") || 0));
  let dropped = 0;
  while (dropped < sorted.length && total > maxChars) {
    total -= read(sorted[dropped]).length;
    dropped += 1;
  }
  const kept = new Set(sorted.slice(dropped));
  return records.filter((record) => kept.has(record));
}

/**
 * Apply the shared retention rules to a state snapshot.
 *
 * Returns a new state (inputs are never mutated, because the caller may be
 * holding a cached read-only snapshot) plus counts of what was dropped, so the
 * extension and the network service can report the same numbers.
 */
export function pruneState(state, { nowMs = Date.now(), limits = STATE_LIMITS, keepSessionIds = [] } = {}) {
  const keepIds = new Set(keepSessionIds);
  const dropped = { sessions: 0, messages: 0, updates: 0, journal: 0 };
  const result = { version: 1, sessions: [], messages: [], updates: [], journal: [] };

  const sessions = dedupeById((state.sessions || []).filter(isRecord), (session) => Date.parse(session.lastSeenAt || session.updatedAt || "") || 0)
    .sort(byNewest)
    .slice(0, limits.maxSessions);
  result.sessions = sessions.filter((session) => keepSession(session, nowMs, limits, keepIds));
  dropped.sessions = (state.sessions || []).length - result.sessions.length;

  const messages = dedupeById((state.messages || []).filter(isRecord), (message) => Date.parse(message.createdAt || "") || 0)
    .filter((record) => ageOf(record.createdAt, nowMs) <= limits.messageRetentionMs)
    .sort(byNewest)
    .slice(0, limits.maxMessages);
  result.messages = trimToCharBudget(messages, limits.maxMessageChars, (message) => String(message.text ?? ""));
  dropped.messages = (state.messages || []).length - result.messages.length;

  const updates = dedupeById((state.updates || []).filter(isRecord), (update) => Date.parse(update.createdAt || "") || 0)
    .filter((record) => ageOf(record.createdAt, nowMs) <= limits.updateRetentionMs)
    .sort(byNewest)
    .slice(0, limits.maxUpdates);
  result.updates = updates;
  dropped.updates = (state.updates || []).length - result.updates.length;

  const journal = dedupeById((state.journal || []).filter(isRecord), (item) => Date.parse(item.createdAt || "") || 0)
    .filter((record) => ageOf(record.createdAt, nowMs) <= limits.journalRetentionMs)
    .sort(byNewest)
    .slice(0, limits.maxJournalItems);
  result.journal = trimToCharBudget(journal, limits.maxJournalChars, (item) => String(item.text ?? ""));
  dropped.journal = (state.journal || []).length - result.journal.length;

  // Last resort: the serialized file must stay bounded. Drop in the order of
  // how useful each category is when old: messages first, then updates, then
  // the journal, and never sessions (they are small and are what makes a peer
  // addressable at all).
  //
  // The size is measured once and then adjusted per removal. Re-serializing to
  // test the ceiling on every drop would make pruning cost more than the write
  // it is trying to protect, and this runs on every network ingest as well.
  let size = JSON.stringify(result).length;
  const popOldest = (list) => {
    let oldestIndex = -1;
    for (let index = 0; index < list.length; index++) {
      const age = Date.parse(list[index].createdAt || "") || 0;
      if (oldestIndex < 0 || age < (Date.parse(list[oldestIndex].createdAt || "") || 0)) oldestIndex = index;
    }
    if (oldestIndex < 0) return false;
    const [removed] = list.splice(oldestIndex, 1);
    // +1 accounts for the comma the removed record occupied.
    size -= JSON.stringify(removed).length + 1;
    return true;
  };
  while (size > limits.maxStateChars && result.messages.length > 0) { popOldest(result.messages); dropped.messages += 1; }
  while (size > limits.maxStateChars && result.updates.length > 0) { popOldest(result.updates); dropped.updates += 1; }
  while (size > limits.maxStateChars && result.journal.length > 0) { popOldest(result.journal); dropped.journal += 1; }

  return { state: result, dropped };
}

/**
 * Compact serialization. Pretty-printing a 400 KB shared file buys nothing
 * except bytes: `jq .` on the file renders it for humans, while every Pi
 * process pays for the extra whitespace on each read and write.
 */
export function serializeState(state) {
  return `${JSON.stringify(state)}\n`;
}

export function emptyStateValue() {
  return emptyState();
}
