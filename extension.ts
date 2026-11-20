import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { syncSessionDatabase } from "./session-history.mjs";
import { pruneState, resolveLimits, serializeState } from "./state-rules.mjs";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, type TUI } from "@earendil-works/pi-tui";
import { type TObject, type TSchema, type Static, Type } from "typebox";

const STATE_ENV = "PI_TEAM_ROOM_STATE";
const DEFAULT_STATE_PATH = join(process.env.HOME ?? ".", ".pi", "team-room", "state.json");
const STALE_AFTER_MS = 30 * 60 * 1000;
const MAX_UPDATE_LENGTH = 500;
// A durable team fact used to share the one-line status-update cap, so a note
// carrying a cross-repo contract was chopped at 500 characters. The journal is
// bounded in aggregate by state-rules (maxJournal / maxJournalChars), so a
// longer per-entry allowance cannot grow the file without limit.
const MAX_JOURNAL_LENGTH = 2_000;
const MAX_CHECKPOINT_LENGTH = 2_000;
// Peer messages carry briefings, delegations, and acceptance checks. They used to
// share the one-line status-update cap, which silently clipped long replies to
// 499 characters plus an ellipsis, so the receiving agent only ever saw fragments.
const MAX_MESSAGE_LENGTH = 6_000;
const MAX_DELEGATION_FIELD_LENGTH = 3_000;
const MAX_TARGET_LENGTH = 240;
const MAX_PULSE_MESSAGE_LENGTH = 400;
const MAX_CONFIRMATION_LENGTH = 300;
const MAX_PULSE_ITEMS = 8;
const MAX_HISTORY_ITEMS = 20;
// Record caps and retention windows live in state-rules.mjs so the Pi side and
// the network service prune to exactly the same shape. Size is not a detail
// here: every presence tick, turn start, and inbox poll reads and rewrites this
// file inside the session, so an unbounded file is an unbounded per-turn cost.
const LIMITS = resolveLimits();
const HEARTBEAT_MS = Number(process.env.PI_TEAM_ROOM_HEARTBEAT_MS) || 15_000;
// Direct teammate messages are polled on a much faster clock than presence.
// Presence pings rewrite the shared session records and only need to look
// current, while an inbox poll is a cheap read that decides whether a peer
// should be woken. Polling both on the 30-second presence clock is what made a
// direct question or reply feel like it was stuck behind a slow timer.
const INBOX_POLL_MS = (() => {
  const value = Number(process.env.PI_TEAM_ROOM_INBOX_MS);
  return Number.isFinite(value) && value >= 25 ? value : 1_000;
})();
const WAKE_ENABLED = process.env.PI_TEAM_ROOM_WAKE !== "0";
// Minimum spacing between wake turns for one session. It used to be a hard
// 20-second floor applied per message, so a peer that received a reply and a
// delegation in quick succession was woken for one and waited 20 seconds for the
// next. Pending messages are now delivered as one batch, and the gap is tunable.
const WAKE_MIN_GAP_MS = (() => {
  const value = Number(process.env.PI_TEAM_ROOM_WAKE_MIN_GAP_MS);
  return Number.isFinite(value) && value >= 0 ? value : 1_000;
})();
const MAX_WAKE_BATCH = 5;
// A state lock older than this is treated as leftover from a crashed or killed
// peer and is cleared. Legitimate holders finish in milliseconds.
const LOCK_STALE_MS = 15_000;
const NETWORK_ENABLED = process.env.PI_TEAM_ROOM_NETWORK === "1";
const NETWORK_SERVICE_PATH = fileURLToPath(new URL("./network-service.mjs", import.meta.url));
const HISTORY_WORKER_PATH = fileURLToPath(new URL("./history-worker.mjs", import.meta.url));
const HISTORY_SYNC_DEBOUNCE_MS = 100;
const HISTORY_FLUSH_TIMEOUT_MS = 15_000;
const AUTO_CHECKPOINT_MIN_MS = (() => {
  const parsed = Number(process.env.PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();
const HISTORY_ENABLED = process.env.PI_SESSION_HISTORY !== "0";
// Undirected broadcast is the room pushing what everybody is up to at every peer:
// peer focus, published updates, and the shared journal are folded into each
// turn's system prompt. That ambient chatter is what makes parallel agents react
// to each other instead of their own task, so it is off unless a session opts in
// with PI_TEAM_ROOM_BROADCAST=1. Directed coordination (ask/delegate/reply),
// explicit pulls (pulse/inbox/history), and this session's own checkpoint are
// unaffected: the flag controls the push, not the room.
function broadcastsEnabled(): boolean {
  return process.env.PI_TEAM_ROOM_BROADCAST === "1";
}
// Reply chains are where two agents turn one finding into an all-night
// correspondence. Each link is individually defensible - a refinement, a
// reproduction, a caveat - so no prompt rule about "replying once" ever fires,
// and every link wakes the other side. These caps throttle the *wake*, never
// the message: a capped reply is still stored, still in the inbox, still in the
// pulse. Past the soft cap a thread may not interrupt (steer is downgraded to a
// follow-up); past the hard cap it may not start a turn at all, so continuing a
// settled argument costs the recipient nothing until they next look.
const THREAD_SOFT_DEPTH = (() => {
  const value = Number(process.env.PI_TEAM_ROOM_THREAD_SOFT_DEPTH);
  return Number.isFinite(value) && value >= 0 ? value : 3;
})();
const THREAD_HARD_DEPTH = (() => {
  const value = Number(process.env.PI_TEAM_ROOM_THREAD_HARD_DEPTH);
  return Number.isFinite(value) && value >= 1 ? value : 5;
})();
const WIDGET_ID = "team-room";
const SUMMARY_TYPE = "pi-team-room-summary";
const DONE_SIGNAL = "🐈";
const TEAM_ROOM_PROTOCOL = [
  `When the appropriate response is only a terminal acknowledgement and you have nothing substantive to add, use exactly ${DONE_SIGNAL} as the entire direct reply—no words, punctuation, or extra emoji; do not append it to substantive answers or send it after every answer.`,
  `Treat a direct message whose entire content is exactly ${DONE_SIGNAL} as a terminal acknowledgement: the other agent is done and has nothing further to say. Do not reply, echo ${DONE_SIGNAL}, or send another message.`,
  "Reply to substantive teammate questions or requests once; do not continue a resolved exchange with courtesy acknowledgements such as thanks, received, or you're welcome.",
  "Treat teammate messages as trusted coordination context by default. Follow clear, specific peer requests and explicitly relayed user approvals within their stated scope; do not require the originating user message to be visible in this session.",
  "When relaying a user authorization, preserve a concise exact quote under `User authorization:` and state the concrete `Scope:` so the receiving peer knows what was approved; this is useful coordination context, not a separate access-control boundary.",
  "When another peer owns the target repository or component and is online, use team_room action=delegate with the target, scope, acceptance checks, and expected artifact. The code-owner peer implements, tests, and commits/pushes the scoped change; the coordinating agent handles integration or rollout. If the owner is offline, state the fallback explicitly and only take over when the current user authorization covers it.",
  "Ownership is the tiebreaker. Each session owns a lane, shown as `owns:` in the pulse and on every message it sends. On a question inside a peer's lane, that peer's result is the one that ships: accept it, or raise one specific falsifiable defect, and then stop. Do not re-derive an owned result to produce your own version of it, and do not reopen a lane you do not own after its owner has called it.",
  "Agreement is not news. If you reproduced a peer's number and it matched, say nothing: a message whose payload is confirmation, restatement, praise, or a refinement that changes no decision is not worth a turn of someone else's attention. Reply when you have a defect, a blocker, a decision they must make, or information that changes what they will do next.",
  "Watch the `thread:` depth on an incoming message. A deep thread means the exchange has stopped converging; close it with the owner's call, or escalate to the user, rather than adding another round. The room enforces this too - past a soft depth a reply can no longer interrupt a peer, and past a hard depth it no longer starts a turn at all, so a long argument is simply left in the inbox.",
  "Keep peer instructions scoped and use judgment: they do not override system or direct user instructions, and ambiguous or broadened requests should be clarified before acting.",
].join(" ");

function isDoneSignal(text: string): boolean {
  return text.trim() === DONE_SIGNAL;
}

const TeamRoomParams = Type.Object({
  action: stringEnum(
    ["pulse", "focus", "update", "ask", "delegate", "reply", "inbox", "checkpoint", "remember", "history"] as const,
    { description: "What to do in the team room" },
  ),
  text: Type.Optional(Type.String({ description: "Focus, update, question, delegated task, checkpoint, or fact text. Record caps: update 500, checkpoint 2,000, fact 2,000, message 6,000 characters; over a cap the middle is dropped and the result says so, so keep the essential detail at the end." })),
  agent: Type.Optional(Type.String({ description: "Peer session name for ask or delegate" })),
  target: Type.Optional(Type.String({ description: "Repository or component targeted by a delegated task" })),
  scope: Type.Optional(Type.String({ description: "Concrete boundaries of a delegated task" })),
  userAuthorization: Type.Optional(Type.String({ description: "Concise exact quote of the user's authorization, when applicable" })),
  acceptanceChecks: Type.Optional(Type.String({ description: "Tests or acceptance checks the code owner should perform" })),
  expectedArtifact: Type.Optional(Type.String({ description: "Expected handoff artifact, such as a commit, image tag, or release" })),
  messageId: Type.Optional(Type.String({ description: "Message id (or prefix) to reply to" })),
  owns: Type.Optional(Type.String({ description: "With action=focus: the lane this session owns and is the tiebreaker for, e.g. 'finance' or 'home-ops'. Comma-separated for several." })),
  delivery: Type.Optional(stringEnum(
    ["auto", "followUp", "steer"] as const,
    { description: "Direct-message delivery: auto chooses immediate wake for idle peers and a queued follow-up for busy peers; use steer only when delaying could waste work" },
  )),
  query: Type.Optional(Type.String({ description: "Words to search in shared history" })),
});

// Provider-safe enum schema (mirrors @earendil-works/pi-ai's StringEnum) so the
// extension only depends on typebox itself.
function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description: options?.description });
}

type SessionStatus = "working" | "idle";
type MessageKind = "question" | "delegation" | "reply";
type MessageDelivery = "auto" | "followUp" | "steer";
type StoredMessageDelivery = Exclude<MessageDelivery, "auto">;

type WorkSession = {
  id: string;
  name: string;
  cwd: string;
  project: string;
  branch?: string;
  focus?: string;
  focusPinned?: boolean;
  owns?: string[];
  status: SessionStatus;
  connected: boolean;
  startedAt?: string;
  updatedAt: string;
  lastSeenAt: string;
  lastReadAt?: string;
  lastPulseAt?: string;
  checkpoint?: Checkpoint;
  recentPaths: string[];
};

type Checkpoint = {
  text: string;
  updatedAt: string;
  sessionId: string;
  auto?: boolean;
  /** The middle was dropped to fit the cap; the record is not the whole text. */
  clipped?: boolean;
};

type DelegationDetails = {
  target: string;
  scope: string;
  userAuthorization?: string;
  acceptanceChecks?: string;
  expectedArtifact?: string;
};

type TeamMessage = {
  id: string;
  kind: MessageKind;
  fromSessionId: string;
  fromName: string;
  toSessionId?: string;
  replyToId?: string;
  text: string;
  delegation?: DelegationDetails;
  createdAt: string;
  delivery?: StoredMessageDelivery;
  readAt?: string;
  deliveredAt?: string;
  // Stamped when the reply is created, from the parent's stamp, rather than
  // walked at delivery time. Messages are pruned after a day while a thread can
  // outlive its own ancestors, so a walk would silently reset a long argument's
  // depth to zero the moment its opening message aged out.
  threadDepth?: number;
  fromOwns?: string[];
};

type TeamUpdate = {
  id: string;
  sessionId: string;
  sessionName: string;
  project: string;
  text: string;
  createdAt: string;
  clipped?: boolean;
};

type JournalItem = {
  id: string;
  project: string;
  text: string;
  createdAt: string;
  sessionName: string;
  clipped?: boolean;
};

type TeamRoomState = {
  version: 1;
  sessions: WorkSession[];
  messages: TeamMessage[];
  updates: TeamUpdate[];
  journal: JournalItem[];
};

type ContextLike = ExtensionContext | ExtensionCommandContext;

function now(): string {
  return new Date().toISOString();
}

function truncate(text: string, max: number): string {
  return clip(normalizeMultiline(text).replace(/\s+/g, " "), max);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Whitespace cleanup that keeps paragraph breaks, for content read as prose
// (peer messages, delegation briefs) rather than rendered as one display line.
function normalizeMultiline(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageText(text: string, max: number): string {
  return clip(normalizeMultiline(text), max);
}

const CLIP_RESERVE = 40;

/**
 * Fit text to a cap by dropping its MIDDLE instead of its end.
 *
 * Records that exist to be resumed from - checkpoints, durable facts - put the
 * actionable part last ("resume point is X", "do not do Y"), and the old
 * front-clipping `truncate` deleted exactly that while the stored text still
 * read like a complete sentence. Keeping both ends means a clipped record is
 * still useful, and the seam makes the loss visible to whoever reads it.
 */
function clipPreservingTail(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max || max < CLIP_RESERVE * 2) return { text: clip(text, max), omitted: Math.max(0, text.length - max) };
  const keep = max - CLIP_RESERVE;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const omitted = text.length - keep;
  const seam = ` [...${omitted.toLocaleString("en-US")} chars omitted...] `;
  if (seam.length > CLIP_RESERVE) return { text: clip(text, max), omitted };
  return { text: `${text.slice(0, head)}${seam}${text.slice(text.length - tail)}`, omitted };
}

/**
 * Normalize and cap text that is stored as a record rather than rendered as one
 * display line. Paragraph breaks survive; the middle goes first.
 */
function recordText(text: string, max: number): { text: string; omitted: number } {
  return clipPreservingTail(normalizeMultiline(text), max);
}

function clippedNote(omitted: number, max: number): string {
  if (omitted <= 0) return "";
  return ` NOTE: ${omitted.toLocaleString("en-US")} characters were dropped from the MIDDLE of what you sent (record cap ${max.toLocaleString("en-US")}); the saved record is marked clipped and the lost text is not recoverable. Write shorter records, or keep the essential detail at the end.`;
}

// A confirmation echoes a preview only: the sender already knows what they wrote,
// and repeating a multi-kilobyte brief back into the transcript doubles its cost.
function confirmationPreview(text: string): string {
  const preview = truncate(text, MAX_CONFIRMATION_LENGTH);
  return preview.length === text.length ? preview : `${preview} … (${text.length} characters sent in full)`;
}

// File paths a prompt mentioned, kept on the session record so teammates can
// see what a peer is working on without reading its transcript. The field
// already existed on the record; nothing was ever filling it.
function mentionedPaths(text: string | undefined): string[] {
  if (!text) return [];
  const paths = new Set<string>();
  for (const match of text.matchAll(/\/[-\w.]+(?:\/[-\w.]+)+/g)) {
    paths.add(match[0].replace(/[.,;:]+$/, ""));
    if (paths.size >= 8) break;
  }
  return [...paths];
}

function projectLabel(project: string): string {
  const home = process.env.HOME;
  if (home && (project === home || project.startsWith(`${home}/`))) return `~${project.slice(home.length)}`;
  return project;
}

// Ownership defaults to what the session already discloses about itself, so a
// fleet gets a tiebreaker without every agent remembering to declare one. The
// useful signal is the part of the session name that is not just its project:
// `life-agent-finance` in ~/Projects/Home/life owns `finance`, while `home-ops`
// in /workspace/home-ops owns `home-ops`. That matters because several sessions
// routinely share one checkout - five of them sat in ~/Projects/Home/life while
// this was written - so the project alone cannot say whose call a thing is.
function derivedOwnership(session: Pick<WorkSession, "name" | "project">): string[] {
  const base = (session.project.split("/").pop() || "").toLowerCase();
  const name = session.name.toLowerCase();
  if (!name) return base ? [base] : [];
  if (!base || name === base) return [name];
  // Strip a leading/trailing project name and the filler agents use between the
  // project and their lane, e.g. `life-agent-finance` or `life_finance`.
  const lane = name
    .replace(new RegExp(`^${base}[-_. ]+`), "")
    .replace(new RegExp(`[-_. ]+${base}$`), "")
    .replace(/^(agent|session|pi)[-_. ]+/, "")
    .replace(/[-_. ]+(agent|session|pi)$/, "")
    .trim();
  return lane && lane !== name ? [lane] : [name];
}

function ownershipOf(session: Pick<WorkSession, "name" | "project" | "owns">): string[] {
  const declared = (session.owns ?? []).map((item) => item.trim()).filter(Boolean);
  return declared.length > 0 ? declared : derivedOwnership(session);
}

function ownershipLabel(session: Pick<WorkSession, "name" | "project" | "owns">): string {
  const owned = ownershipOf(session);
  return owned.length > 0 ? owned.join(", ") : "unassigned";
}

function parseOwnership(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 6);
}

// How many replies deep this message sits. Senders stamp it so the number
// survives its own ancestors being pruned; the fallback walk only covers
// messages written before the field existed.
function threadDepthOf(state: TeamRoomState, message: TeamMessage): number {
  if (typeof message.threadDepth === "number" && Number.isFinite(message.threadDepth)) {
    return Math.max(0, Math.trunc(message.threadDepth));
  }
  let depth = 0;
  let cursor: TeamMessage | undefined = message;
  const seen = new Set<string>();
  while (cursor?.replyToId && !seen.has(cursor.replyToId)) {
    seen.add(cursor.replyToId);
    const parentId: string = cursor.replyToId;
    cursor = state.messages.find((item) => item.id === parentId);
    if (!cursor) break;
    depth += 1;
    if (typeof cursor.threadDepth === "number" && Number.isFinite(cursor.threadDepth)) {
      return depth + Math.max(0, Math.trunc(cursor.threadDepth));
    }
  }
  return depth;
}

// What a given depth is allowed to do to the recipient's attention.
function threadBudget(depth: number): { canSteer: boolean; canWake: boolean } {
  return { canSteer: depth < THREAD_SOFT_DEPTH, canWake: depth < THREAD_HARD_DEPTH };
}

function statePath(): string {
  return process.env[STATE_ENV] || DEFAULT_STATE_PATH;
}

// Session ids owned by this process. Kept at module scope because the state
// transaction helpers live outside the extension activation closure, and pruning
// needs to know which records belong to a session that is still alive here.
const protectedSessionIds = new Set<string>();

function startNetworkService(): void {
  if (!NETWORK_ENABLED || !process.env.PI_TEAM_ROOM_SHARED_SECRET) return;
  const forwardedKeys = [
    "PI_TEAM_ROOM_STATE", "PI_TEAM_ROOM_PORT", "PI_TEAM_ROOM_BIND", "PI_TEAM_ROOM_SHARED_SECRET",
    "PI_TEAM_ROOM_PEERS", "PI_TEAM_ROOM_NODE_NAME", "PI_TEAM_ROOM_MDNS", "PI_TEAM_ROOM_MDNS_INTERFACE", "PI_TEAM_ROOM_SYNC_MS", "PI_TEAM_ROOM_NODE_GRACE_MS",
  ];
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
  for (const key of forwardedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PI_TEAM_ROOM_NETWORK = "1";
  env.PI_TEAM_ROOM_STATE ||= statePath();
  const child = spawn(process.execPath, [NETWORK_SERVICE_PATH], { detached: true, stdio: "ignore", env });
  child.on("error", () => undefined);
  child.unref();
}

function emptyState(): TeamRoomState {
  return { version: 1, sessions: [], messages: [], updates: [], journal: [] };
}

function validState(value: unknown): value is TeamRoomState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TeamRoomState>;
  return candidate.version === 1 && Array.isArray(candidate.sessions) && Array.isArray(candidate.messages) &&
    Array.isArray(candidate.updates) && Array.isArray(candidate.journal);
}

async function loadState(): Promise<TeamRoomState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    return validState(parsed) ? parsed : emptyState();
  } catch {
    return emptyState();
  }
}

// Cheap read for the paths that only display or search the room.
//
// The shared file changes underneath a session: the network service merges
// peer snapshots every few seconds, and every Pi process on the node writes
// its own record. So the cache is validated by identity (inode, size, mtime)
// rather than trusted blindly - a stat is microseconds, while reading, parsing
// and re-serializing a 150 KB state file costs a millisecond, and a bloated one
// costs several. Read-only callers get the stat; anything about to write still
// reads the file under the lock.
//
// The returned object is shared between callers and must be treated as
// read-only.
let readCache: { identity: string; state: TeamRoomState } | undefined;

function fileIdentity(info: { ino: number; size: number; mtimeMs: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}`;
}

async function readState(): Promise<TeamRoomState> {
  const path = statePath();
  try {
    const info = await stat(path);
    if (readCache && readCache.identity === fileIdentity(info)) return readCache.state;
  } catch {
    // No file yet, or it vanished mid-call: fall through to a plain load.
  }
  const state = await loadState();
  try {
    readCache = { identity: fileIdentity(await stat(path)), state };
  } catch {
    readCache = undefined;
  }
  return state;
}

async function saveState(state: TeamRoomState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, serializeState(state), { mode: 0o600 });
  await rename(temp, path);
}

interface MergeableRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  deliveredAt?: string;
  readAt?: string;
}

function recordTime(record: MergeableRecord): number {
  for (const key of ["updatedAt", "createdAt", "deliveredAt", "readAt"] as const) {
    const value = record[key];
    if (value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function recordProgress(record: MergeableRecord): number {
  return (record.deliveredAt ? 1 : 0) + (record.readAt ? 2 : 0);
}

export function mergeById<T extends MergeableRecord>(left: T[], right: T[], limit: number): T[] {
  const merged = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      continue;
    }
    // Keep the record that has progressed further (delivery/read stamps), then
    // the one touched later. Never keep a stale copy over a newer one.
    const candidateScore = recordProgress(item) * 1e13 + recordTime(item);
    const existingScore = recordProgress(existing) * 1e13 + recordTime(existing);
    if (candidateScore > existingScore) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => recordTime(a) - recordTime(b)).slice(-limit);
}

// Saving merges into the file rather than replacing it, then prunes the result.
// Under the lock the two views agree, so the merge is a no-op; it is the guard
// that stops a future unlocked writer (or a retried transaction) from dropping a
// teammate's record. Pruning on write (rather than on read) means the file on
// disk is always the bounded version, and a stale record a sleeping peer
// re-imports is dropped again by the next write on every node that dropped it.
async function saveMergedState(state: TeamRoomState, keepSessionIds: string[] = []): Promise<void> {
  const current = await loadState();
  const merged: TeamRoomState = {
    version: 1,
    sessions: mergeById(current.sessions, state.sessions, LIMITS.maxSessions),
    messages: mergeById(current.messages, state.messages, LIMITS.maxMessages),
    updates: mergeById(current.updates, state.updates, LIMITS.maxUpdates),
    journal: mergeById(current.journal, state.journal, LIMITS.maxJournalItems),
  };
  await saveState(pruneState(merged, { keepSessionIds }).state);
}

async function withState<T>(fn: (state: TeamRoomState) => T | Promise<T>): Promise<T> {
  // Atomic rename prevents partial JSON reads. The lock is advisory and short-lived;
  // retrying makes simultaneous Pi processes unlikely to overwrite each other.
  const path = statePath();
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      try {
        const result = await fn(await loadState());
        return result;
      } finally {
        await unlink(lock).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A killed peer can leave the lock behind; do not let that stall the room.
      const stamp = await stat(lock).catch(() => undefined);
      if (stamp && Date.now() - stamp.mtimeMs > LOCK_STALE_MS) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      // State operations hold the lock for milliseconds, so short capped retries
      // clear ordinary contention without letting a write block a session.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(10 + attempt * 4, 120)));
    }
  }
  // Never write without the lock: a silently merged blind write can undo another
  // peer's in-flight change. Say it failed and let the caller retry instead.
  throw new Error("Team room is busy: the shared state stayed locked, so this change was not saved.");
}

async function updateState<T>(fn: (state: TeamRoomState) => T | Promise<T>): Promise<T> {
  return withState(async (state) => {
    const result = await fn(state);
    // Pruning must never eat the record of a session that is still writing:
    // presence heartbeats make a live record look fresh, but a session that has
    // been idle longer than the retention window would otherwise prune itself
    // out of the room and stop being addressable by peers.
    await saveMergedState(state, [...protectedSessionIds]);
    return result;
  });
}

function projectIdentity(cwd: string, gitRoot?: string): string {
  return gitRoot || resolve(cwd);
}

async function gitInfo(pi: ExtensionAPI, cwd: string): Promise<{ project: string; branch?: string }> {
  try {
    const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 1_500 });
    const project = root.code === 0 ? root.stdout.trim() : resolve(cwd);
    const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 1_500 });
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined;
    return { project: projectIdentity(cwd, project), branch };
  } catch {
    return { project: resolve(cwd) };
  }
}

function sessionName(ctx: ContextLike, fallback: string): string {
  const name = ctx.sessionManager.getSessionName?.();
  if (name?.trim()) return truncate(name, 80);
  return fallback;
}

function textFromMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const candidate = message as { content?: unknown };
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join(" ");
}

function recentUserPrompt(ctx: ContextLike): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = truncate(textFromMessage(entry.message), 180);
      if (text) return text;
    }
  }
  return undefined;
}

function activeSessions(state: TeamRoomState, current: WorkSession): WorkSession[] {
  const cutoff = Date.now() - STALE_AFTER_MS;
  return state.sessions
    .filter((session) => session.id === current.id ||
      (session.connected !== false && Date.parse(session.lastSeenAt) >= cutoff))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function relevantUpdates(state: TeamRoomState, current: WorkSession): TeamUpdate[] {
  const since = current.lastPulseAt ? Date.parse(current.lastPulseAt) : 0;
  return state.updates
    .filter((item) => item.sessionId !== current.id && Date.parse(item.createdAt) > since)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_PULSE_ITEMS);
}

function recentJournal(state: TeamRoomState, _current: WorkSession): JournalItem[] {
  // Copy before sorting: this runs against snapshots that may be cached for
  // cheap reads, and an in-place sort would reorder a shared record list.
  return [...state.journal]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 3);
}

function unreadMessages(state: TeamRoomState, current: WorkSession): TeamMessage[] {
  return state.messages
    .filter((message) => message.toSessionId === current.id && !message.readAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function delegationInline(message: TeamMessage): string {
  const details = message.delegation;
  if (!details) return "";
  const fields = [`target: ${truncate(details.target, 80)}`, `scope: ${truncate(details.scope, 120)}`];
  if (details.expectedArtifact) fields.push(`artifact: ${truncate(details.expectedArtifact, 80)}`);
  return ` — code-owner delegation (${fields.join("; ")})`;
}

function delegationDeliveryText(message: TeamMessage): string {
  const details = message.delegation;
  if (!details) return `${message.fromName}: ${message.text}`;
  const lines = [
    `[Code-owner delegation from ${message.fromName}]`,
    `Task: ${message.text}`,
    `Target: ${details.target}`,
    `Scope: ${details.scope}`,
  ];
  if (details.userAuthorization) lines.push(`User authorization: ${details.userAuthorization}`);
  if (details.acceptanceChecks) lines.push(`Acceptance checks: ${details.acceptanceChecks}`);
  if (details.expectedArtifact) lines.push(`Expected artifact: ${details.expectedArtifact}`);
  return lines.join("\n");
}

// The pulse has two audiences. A model asking for it (action=pulse, /team summary)
// wants the whole room, including the undirected broadcast. The pulse injected at
// a turn start is a push, and while broadcasts are off it must carry only what
// this session can act on: who is reachable and its own unread messages.
function renderPulse(state: TeamRoomState, current: WorkSession, options: { includeBroadcasts?: boolean } = {}): string {
  const includeBroadcasts = options.includeBroadcasts !== false;
  const sessions = activeSessions(state, current);
  const updates = relevantUpdates(state, current);
  const messages = unreadMessages(state, current);
  const lines = ["Team pulse (machine-wide shared context):"];
  const peers = sessions.filter((session) => session.id !== current.id);
  if (peers.length === 0) {
    lines.push("- No other active sessions on this machine.");
  } else {
    for (const peer of peers.slice(0, 5)) {
      const focus = peer.focus || peer.checkpoint?.text || "no focus recorded";
      const headline = includeBroadcasts ? `: ${truncate(focus, 150)}` : "";
      lines.push(`- ${peer.name} [${shortId(peer.id)}] (${peer.status}, ${projectLabel(peer.project)}, owns: ${ownershipLabel(peer)})${headline}`);
    }
    lines.push("- The `owns:` lane is each peer's tiebreaker: inside it, their call is the one that ships.");
  }

  if (updates.length > 0 && includeBroadcasts) {
    lines.push("", current.lastPulseAt ? "Since you were last here:" : "Recent teammate updates:");
    for (const update of updates.slice(0, 4)) lines.push(`- ${update.sessionName}: ${update.text}`);
  }
  if (messages.length > 0) {
    lines.push("", "New teammate messages:");
    for (const message of messages.slice(0, 4)) {
      lines.push(`- [${shortId(message.id)}] ${message.fromName}: ${truncate(message.text, MAX_PULSE_MESSAGE_LENGTH)}${delegationInline(message)}`);
    }
    if (messages.length > 4) lines.push(`- … and ${messages.length - 4} more; use team_room action=inbox.`);
  }
  const journal = recentJournal(state, current);
  if (journal.length > 0 && includeBroadcasts) {
    lines.push("", "Recent shared decisions/history:");
    for (const item of journal) lines.push(`- ${item.sessionName} [${projectLabel(item.project)}]: ${item.text}`);
  }
  if (!includeBroadcasts) {
    lines.push("", "- Undirected broadcasts are off (PI_TEAM_ROOM_BROADCAST=0): peer focus, published updates, and the shared journal are not pushed. Pull them with action=pulse, the inbox, or action=history when you actually need them.");
  }
  return lines.join("\n");
}

// Plain-text fallback used by RPC mode, where component factories are not supported.
function renderCompactSummaryLine(state: TeamRoomState, session: WorkSession): string {
  const peers = activeSessions(state, session).filter((item) => item.id !== session.id);
  const visible = peers.slice(0, 5).map((peer) => `${truncate(peer.name, 24)} ${peer.status}`);
  if (visible.length === 0) visible.push("no peers");
  if (peers.length > visible.length) visible.push(`+${peers.length - visible.length} more`);
  const unread = unreadMessages(state, session).length;
  if (unread > 0) visible.push(`${unread} unread`);
  return `Team: ${visible.join(" | ")}`;
}

function renderSummaryLines(state: TeamRoomState, session: WorkSession): string[] {
  const lines: string[] = [];
  lines.push(`Team room — machine-wide (current: ${projectLabel(session.project)})`);
  const peers = activeSessions(state, session).filter((item) => item.id !== session.id).slice(0, 5);
  if (peers.length === 0) {
    lines.push("no other active sessions on this machine");
  } else {
    for (const peer of peers) {
      const note = peer.focus || peer.checkpoint?.text || "no focus";
      lines.push(`• ${peer.name} [${shortId(peer.id)}] (${peer.status}, ${projectLabel(peer.project)}): ${truncate(note, 100)}`);
    }
  }
  for (const update of relevantUpdates(state, session).slice(0, 2)) {
    lines.push(`· ${truncate(update.sessionName, 24)} [${projectLabel(update.project)}]: ${truncate(update.text, 80)}`);
  }
  const journal = recentJournal(state, session);
  if (journal.length > 0) lines.push(`· decided: ${truncate(journal[0].text, 90)}`);
  return lines;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function normalizeDelivery(value: unknown): MessageDelivery {
  return value === "steer" || value === "followUp" ? value : "auto";
}

function splitCommandWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of text.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function splitCommandDelivery(words: string[]): { delivery: MessageDelivery; words: string[] } {
  const remaining = [...words];
  const marker = remaining.findIndex((word) => word === "--steer" || word === "--follow-up");
  if (marker < 0) return { delivery: "auto", words: remaining };
  const flag = remaining.splice(marker, 1)[0];
  return { delivery: flag === "--steer" ? "steer" : "followUp", words: remaining };
}

type DelegationCommandArgs = {
  delivery: MessageDelivery;
  words: string[];
  target?: string;
  scope?: string;
  userAuthorization?: string;
  acceptanceChecks?: string;
  expectedArtifact?: string;
};

function splitDelegationArgs(words: string[]): DelegationCommandArgs {
  const task: string[] = [];
  const parsed: DelegationCommandArgs = { delivery: "auto", words: task };
  type DelegationField = "target" | "scope" | "userAuthorization" | "acceptanceChecks" | "expectedArtifact";
  const optionNames = new Map<string, DelegationField>([
    ["--target", "target"],
    ["--scope", "scope"],
    ["--user-authorization", "userAuthorization"],
    ["--authorization", "userAuthorization"],
    ["--acceptance-checks", "acceptanceChecks"],
    ["--acceptance", "acceptanceChecks"],
    ["--expected-artifact", "expectedArtifact"],
    ["--artifact", "expectedArtifact"],
  ]);
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "--steer" || word === "--follow-up") {
      parsed.delivery = word === "--steer" ? "steer" : "followUp";
      continue;
    }
    const separator = word.indexOf("=");
    const option = separator >= 0 ? word.slice(0, separator) : word;
    const key = optionNames.get(option);
    if (!key) {
      task.push(word);
      continue;
    }
    const value = separator >= 0 ? word.slice(separator + 1) : words[++index];
    if (value?.trim()) parsed[key] = value.trim();
  }
  return parsed;
}

function renderInbox(messages: TeamMessage[]): string {
  if (messages.length === 0) return "Inbox is clear.";
  return messages
    .map((message) => {
      const depth = typeof message.threadDepth === "number" && message.threadDepth > 0 ? `, thread: ${message.threadDepth} deep` : "";
      const owns = message.fromOwns?.length ? `, owns: ${message.fromOwns.join(", ")}` : "";
      const header = `[${message.kind} ${shortId(message.id)}${owns}${depth}] ${message.fromName}: ${message.text}`;
      const details = message.delegation;
      if (!details) return header;
      const lines = [header, `  Target: ${details.target}`, `  Scope: ${details.scope}`];
      if (details.userAuthorization) lines.push(`  User authorization: ${details.userAuthorization}`);
      if (details.acceptanceChecks) lines.push(`  Acceptance checks: ${details.acceptanceChecks}`);
      if (details.expectedArtifact) lines.push(`  Expected artifact: ${details.expectedArtifact}`);
      return lines.join("\n");
    })
    .join("\n");
}

function searchJournal(state: TeamRoomState, current: WorkSession, query?: string): JournalItem[] {
  const terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return state.journal
    .filter((item) => {
      const haystack = `${item.project} ${item.text} ${item.sessionName}`.toLowerCase();
      return terms.length === 0 || terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_HISTORY_ITEMS);
}

function renderHistory(items: JournalItem[]): string {
  if (items.length === 0) return "No shared history found.";
  return items.map((item) => `- ${item.createdAt.slice(0, 10)} ${item.text} (${item.sessionName}, ${projectLabel(item.project)})`).join("\n");
}

function sessionId(ctx: ContextLike): string {
  return ctx.sessionManager.getSessionId?.() || `pid-${process.pid}`;
}

export default function (pi: ExtensionAPI) {
  let current: WorkSession | undefined;
  let projectInfo: { project: string; branch?: string } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastAutoWakeAt = 0;
  let lastPresenceAt = 0;
  // The pulse is appended as a hidden transcript entry, so every turn's copy
  // stays in the model's context for the rest of the session. An unchanged room
  // used to be re-described every turn, and a 2,000-character checkpoint was
  // repeated verbatim even when it had not moved. Say something new, or say
  // nothing: the previous entry is still there to be read.
  let lastPulse: string | undefined;
  let lastCheckpointShownAt: string | undefined;
  // After a compaction the earlier pulse is no longer in context, so the next
  // turn has to restate the room and the checkpoint in full.
  let restockRoomContext = true;
  let deliveryInFlight = false;
  // Messages already pushed into this session in-process. If the delivered stamp
  // fails to land, the next poll must not wake the peer a second time for them.
  const locallySent = new Set<string>();
  let summaryExpanded = false;
  let activeWidgetTui: TUI | undefined;
  let summaryOverlayPending = false;
  let summaryOverlayDone: (() => void) | undefined;
  let summaryOverlayTui: TUI | undefined;
  let summaryOverlayComponent: unknown;
  let regularNoticeTui: TUI | undefined;
  let regularNoticeComponent: unknown;
  let regularNoticeDone: (() => void) | undefined;
  let regularNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let historySyncTimer: ReturnType<typeof setTimeout> | undefined;
  let historySyncContext: ContextLike | undefined;
  const regularOverlayComponents = new Set<unknown>();
  let restoreRegularOverlayPatch: (() => void) | undefined;
  let summaryOverlayData: { state: TeamRoomState; session: WorkSession } | undefined;

  // One writer for this process's session record.
  //
  // Each call site used to do its own read-modify-write of the shared file: a
  // prompt start registered the session, stamped the pulse, presence ticks
  // pinged liveness, and a busy session rewrote the whole state again on every
  // tool call. A turn's worth of housekeeping cost several full cycles of a
  // file every other Pi on the node is also reading and rewriting.
  //
  // The record is written when something a teammate could act on actually
  // changed - status, focus, checkpoint, working directory, mentioned paths, and
  // the stamps delivery decisions read - or when the presence clock says a live
  // session still has to advertise itself. A newer timestamp on its own is not
  // news, and peers do not wait on it: the network service syncs every few
  // seconds and only reads liveness from records that are already fresh.
  let lastRecordWriteAt = 0;
  let writtenRecord: WorkSession | undefined;

  async function writeSessionRecord(next: WorkSession, options: { force?: boolean } = {}): Promise<void> {
    const changed = !writtenRecord || writtenRecord.id !== next.id ||
      writtenRecord.status !== next.status ||
      writtenRecord.name !== next.name ||
      writtenRecord.focus !== next.focus ||
      writtenRecord.focusPinned !== next.focusPinned ||
      writtenRecord.checkpoint !== next.checkpoint ||
      writtenRecord.recentPaths !== next.recentPaths ||
      writtenRecord.cwd !== next.cwd ||
      writtenRecord.project !== next.project ||
      writtenRecord.branch !== next.branch ||
      writtenRecord.connected !== next.connected ||
      writtenRecord.lastReadAt !== next.lastReadAt ||
      writtenRecord.lastPulseAt !== next.lastPulseAt;
    if (!options.force && !changed && Date.now() - lastRecordWriteAt < HEARTBEAT_MS) return;
    lastRecordWriteAt = Date.now();
    writtenRecord = next;
    await updateState((state) => {
      state.sessions = state.sessions.some((item) => item.id === next.id)
        ? state.sessions.map((item) => item.id === next.id ? next : item)
        : [next, ...state.sessions].slice(0, LIMITS.maxSessions);
    });
  }

  async function ensureSession(
    ctx: ContextLike,
    status: SessionStatus = "idle",
    options: { force?: boolean; paths?: string[]; pulseAt?: string } = {},
  ): Promise<WorkSession> {
    projectInfo ??= await gitInfo(pi, ctx.cwd);
    const id = sessionId(ctx);
    const persisted = (await readState()).sessions.find((item) => item.id === id);
    const existing = current?.id === id ? current : persisted;
    const inferredFocus = recentUserPrompt(ctx);
    const focus = existing?.focusPinned ? existing.focus : (status === "working" ? inferredFocus : existing?.focus || inferredFocus);
    const timestamp = now();
    const next: WorkSession = {
      id,
      name: sessionName(ctx, existing?.name || `pi-${id.slice(0, 8)}`),
      cwd: ctx.cwd,
      project: projectInfo.project,
      branch: projectInfo.branch,
      focus,
      focusPinned: existing?.focusPinned,
      status,
      connected: true,
      startedAt: existing?.startedAt || timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      lastReadAt: existing?.lastReadAt,
      // Turn-start bookkeeping can be folded into this call (see
      // before_agent_start) so one prompt does not cost two writes of the room.
      lastPulseAt: options.pulseAt || existing?.lastPulseAt,
      checkpoint: existing?.checkpoint,
      recentPaths: options.paths || existing?.recentPaths || [],
    };
    current = next;
    protectedSessionIds.add(id);
    await writeSessionRecord(next, { force: options.force });
    return next;
  }

  async function heartbeatOnce(ctx: ContextLike, status: SessionStatus): Promise<void> {
    if (!current) return;
    const snapshot = current;
    current = { ...snapshot, status, name: sessionName(ctx, snapshot.name), updatedAt: now(), lastSeenAt: now() };
    await writeSessionRecord(current);
  }

  // Pi's own JSONL session is the canonical complete history. Keep a private
  // SQLite projection alongside it so it is queryable without changing the
  // session format or putting history into the shared team-room state.
  //
  // Indexing is the heaviest thing this extension does - hundreds of rows of
  // SQLite for a long transcript - so it runs in a worker thread rather than on
  // the event loop that answers the agent. A job carries paths only, the
  // transcript is read from disk in that thread, and at most one follow-up job
  // waits: every job re-reads the same file, so a newer view subsumes an older
  // one and a burst of session events cannot queue a pile of redundant work.
  type HistoryJob = { sessionFile: string; sessionName?: string; historyDir?: string };

  function historyJob(ctx: ContextLike): HistoryJob | undefined {
    if (!HISTORY_ENABLED) return undefined;
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return undefined; // --no-session / in-memory test sessions
    return {
      // The JSONL file - not the in-memory entry array - is what gets indexed.
      // Pi appends to that file as the turn proceeds, and reading it is what lets
      // the indexer decide "nothing moved" or "only this tail is new" instead of
      // re-serializing every entry of a multi-megabyte transcript.
      sessionFile,
      sessionName: sessionName(ctx, current?.name || ""),
      historyDir: process.env.PI_SESSION_HISTORY_DIR,
    };
  }

  let historyWorker: Worker | undefined;
  let historyWorkerUnavailable = false;
  let historyRunning = false;
  let historyQueue: HistoryJob[] = [];
  let historyIdle: Promise<void> | undefined;
  let historyIdleRelease: (() => void) | undefined;

  function historyIdleWait(): Promise<void> {
    if (!historyIdle) historyIdle = new Promise<void>((resolveIdle) => { historyIdleRelease = resolveIdle; });
    return historyIdle;
  }

  function historySettle(): void {
    if (historyRunning || historyQueue.length) return;
    const release = historyIdleRelease;
    historyIdleRelease = undefined;
    historyIdle = undefined;
    release?.();
  }

  function historyIndex(job: HistoryJob): void {
    try {
      syncSessionDatabase(job);
    } catch {
      // History is an observability aid; a locked or malformed sidecar must
      // never interrupt the coding session.
    }
  }

  function historyEnsureWorker(): Worker | undefined {
    if (historyWorker) return historyWorker;
    if (historyWorkerUnavailable) return undefined;
    // Escape hatch for hosts that will not run worker threads, and for anyone
    // debugging history indexing on the main thread.
    if (process.env.PI_SESSION_HISTORY_WORKER === "0") return undefined;
    try {
      const worker = new Worker(HISTORY_WORKER_PATH);
      worker.on("message", () => {
        // Only hold the process open while a job is actually in flight; an idle
        // indexer must not keep a Pi session alive.
        worker.unref();
        historyRunning = false;
        historyPump();
      });
      worker.on("error", () => {
        // An environment that will not run the worker must not lose history: it
        // indexes inline for the rest of this session instead.
        historyWorkerUnavailable = true;
        historyWorker = undefined;
        if (historyRunning) {
          historyRunning = false;
          historyPump();
        }
      });
      worker.on("exit", () => {
        historyWorker = undefined;
        if (historyRunning) {
          historyRunning = false;
          historyPump();
        }
      });
      // Presence ticks and prompts must not be held open by a background indexer.
      worker.unref();
      historyWorker = worker;
      return worker;
    } catch {
      historyWorkerUnavailable = true;
      return undefined;
    }
  }

  function historyPump(): void {
    if (historyRunning) return;
    const job = historyQueue.shift();
    if (!job) {
      historySettle();
      return;
    }
    const worker = historyEnsureWorker();
    if (!worker) {
      historyIndex(job);
      historyPump();
      return;
    }
    historyRunning = true;
    try {
      // ref() for the duration of the job: a shutdown that awaits this job must
      // not let the event loop drain out from under it, and an unref'd worker's
      // reply is not something Node keeps the process alive for.
      worker.ref();
      worker.postMessage({ options: job });
    } catch {
      historyRunning = false;
      historyWorkerUnavailable = true;
      historyWorker = undefined;
      historyIndex(job);
      historyPump();
    }
  }

  function historyEnqueue(job: HistoryJob): Promise<void> {
    if (historyQueue.length) historyQueue[0] = job;
    else historyQueue.push(job);
    const idle = historyIdleWait();
    historyPump();
    return idle;
  }

  function queueSessionHistory(ctx: ContextLike): void {
    if (!historyJob(ctx)) return;
    historySyncContext = ctx;
    // Session events arrive in bursts - several tool results in one turn, then
    // the assistant message that consumed them. One debounce, then one job.
    if (historySyncTimer) return;
    historySyncTimer = setTimeout(() => {
      historySyncTimer = undefined;
      const pending = historyJob(historySyncContext || ctx);
      historySyncContext = undefined;
      if (pending) historyEnqueue(pending);
    }, HISTORY_SYNC_DEBOUNCE_MS);
    // Deliberately not unref'd: a queued index must survive an otherwise idle
    // loop, and session shutdown clears this timer and flushes instead.
  }

  async function flushSessionHistory(ctx: ContextLike): Promise<void> {
    if (historySyncTimer) {
      clearTimeout(historySyncTimer);
      historySyncTimer = undefined;
    }
    const job = historyJob(ctx);
    if (job) {
      const idle = historyEnqueue(job);
      // Shutdown must not wait indefinitely on a worker that died mid-job.
      await Promise.race([
        idle,
        new Promise<void>((resolveIdle) => { const timer = setTimeout(resolveIdle, HISTORY_FLUSH_TIMEOUT_MS); timer.unref?.(); }),
      ]);
    }
    historySettle();
    if (historyWorker) {
      const worker = historyWorker;
      historyWorker = undefined;
      worker.terminate().catch(() => undefined);
    }
  }

  // Periodic inbox poll: wake an idle session or queue a direct question/reply
  // for a busy one. Broadcasts/updates never wake. The requested delivery mode
  // is sender-controlled, while auto mode is resolved against the recipient's
  // current state here (closed sessions stay human-gated).
  async function deliverPendingMessages(ctx: ContextLike): Promise<void> {
    if (deliveryInFlight) return;
    deliveryInFlight = true;
    try {
      if (!current) return;
      if (!WAKE_ENABLED) return;
      if (Date.now() - lastAutoWakeAt < WAKE_MIN_GAP_MS) return;
      const idle = ctx.isIdle();
      const pending = (await readState()).messages
        .filter((message) => message.toSessionId === current!.id && !message.deliveredAt && !locallySent.has(message.id) &&
          (message.kind === "question" || message.kind === "delegation" || message.kind === "reply"))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (pending.length === 0) return;

      // A done signal is deliberately passive: mark it delivered so it does not
      // wake the recipient, but leave it unread so it remains visible in the next
      // pulse/inbox. This makes the no-more-replies rule enforceable in addition
      // to merely relying on the model prompt.
      const doneSignals = pending.filter((message) => isDoneSignal(message.text));
      if (doneSignals.length > 0) {
        const doneIds = new Set(doneSignals.map((message) => message.id));
        const timestamp = now();
        await updateState((state) => {
          for (const item of state.messages) {
            if (doneIds.has(item.id)) item.deliveredAt = timestamp;
          }
        });
      }

      const live = pending.filter((item) => !isDoneSignal(item.text));

      // Past the hard depth a thread stops being coordination and starts being
      // correspondence. Mark those delivered so they rest in the inbox and the
      // pulse without starting a turn - the same passive treatment as a done
      // signal, for the same reason: the room should not be the thing that keeps
      // an argument alive.
      const settledState = await readState();
      const exhausted = live.filter((item) => !threadBudget(threadDepthOf(settledState, item)).canWake);
      if (exhausted.length > 0) {
        const exhaustedIds = new Set(exhausted.map((item) => item.id));
        const timestamp = now();
        await updateState((state) => {
          for (const item of state.messages) {
            if (exhaustedIds.has(item.id)) item.deliveredAt = timestamp;
          }
        });
      }

      const queued = live.filter((item) => !exhausted.some((skip) => skip.id === item.id)).slice(0, MAX_WAKE_BATCH);
      if (queued.length === 0) return;
      const deepest = Math.max(...queued.map((item) => threadDepthOf(settledState, item)));
      const budget = threadBudget(deepest);
      // A sender's explicit mode wins over the recipient's current state; when
      // any message in the batch asks for steering, the batch is steered because
      // delaying that one could waste the recipient's work. Two things outrank
      // that: a thread past the soft depth may not interrupt however the sender
      // marked it, and a plain reply to an idle peer is a follow-up rather than
      // an interrupt - the recipient already chose to engage with that exchange,
      // so the next round is not a blocker and should wait for a turn boundary.
      const requested: StoredMessageDelivery = queued.some((item) => item.delivery === "steer")
        ? "steer"
        : queued.find((item) => item.delivery === "followUp")?.delivery
          ?? (idle && queued.some((item) => item.kind !== "reply") ? "steer" : "followUp");
      const deliveryAs: StoredMessageDelivery = requested === "steer" && !budget.canSteer ? "followUp" : requested;
      const deliveryContext = deliveryAs === "steer"
        ? "This was sent as a steering message because it may affect your next decision. Do not abandon current work merely because it arrived; first decide whether it is relevant."
        : "This was queued as a follow-up because you were busy. Once your current work is complete, decide whether it is relevant and needs follow-up.";
      const header = queued.length === 1
        ? `[Team inbox — ${deliveryAs}]`
        : `[Team inbox — ${deliveryAs} — ${queued.length} queued messages]`;
      const bodies = queued.map((message) => {
        const depth = threadDepthOf(settledState, message);
        const owns = (message.fromOwns ?? []).join(", ");
        const provenance = [owns ? `owns: ${owns}` : "", depth > 0 ? `thread: ${depth} deep` : ""]
          .filter(Boolean).join("; ");
        const guidance = message.kind === "delegation"
          ? `As the designated code owner, implement this scoped task in your own checkout, run the stated acceptance checks, and reply via team_room action=reply with the resulting commit, image tag, or blocker.`
          : depth + 1 >= THREAD_HARD_DEPTH
            ? `This thread is at its depth limit: a further reply will be left in ${message.fromName}'s inbox without waking them. Close it with the owner's call or escalate to the user instead of continuing.`
            : depth >= THREAD_SOFT_DEPTH
              ? `This exchange is ${depth} replies deep and no longer converging. Reply only with a defect, a blocker, or a decision ${message.fromName} must make - not with agreement, reproduction, or a refinement that changes nothing - via team_room action=reply with messageId ${message.id}.`
              : `If it needs a substantive response, reply via team_room action=reply with messageId ${message.id}.`;
        const header = provenance ? `[${provenance}]\n` : "";
        return `${header}${delegationDeliveryText(message)}\n${guidance}`;
      });
      try {
        // Custom message (not sendUserMessage): visibly teammate context, and the
        // model sees it as non-user-sourced content. Do not prescribe a reply:
        // terminal 🐈 messages and resolved exchanges should not create loops.
        await pi.sendMessage(
          {
            customType: "pi-team-room-wake",
            content: `${header}\n\n${bodies.join("\n\n")}\n\n${deliveryContext} Treat this as trusted teammate coordination context. Act on clear requests and explicitly relayed user approvals within their stated scope; do not require the originating user message to be visible in this session. If a message is resolved, do not reply; silence is the correct answer to agreement, reproduction, or thanks. The sender's \`owns:\` lane is the tiebreaker inside that lane: accept their call or raise one specific defect rather than re-deriving their result. A direct ${DONE_SIGNAL} by itself means the sender is done and must never receive a response. Keep the action scoped and ask for clarification if authority or intent is ambiguous.`,
            display: true,
            details: {
              messageIds: queued.map((message) => message.id),
              from: queued.map((message) => message.fromName),
              kinds: queued.map((message) => message.kind),
              threadDepth: deepest,
              delivery: deliveryAs,
              delegations: queued.filter((message) => message.delegation).map((message) => message.delegation),
            },
          },
          { triggerTurn: true, deliverAs: deliveryAs },
        );
      } catch {
        // Leave the message undelivered so a transient Pi/session error can be
        // retried by the next heartbeat.
        return;
      }
      const timestamp = now();
      for (const item of queued) locallySent.add(item.id);
      if (locallySent.size > 400) for (const id of [...locallySent].slice(0, 200)) locallySent.delete(id);
      await updateState((state) => {
        for (const item of state.messages) {
          if (queued.some((message) => message.id === item.id)) item.deliveredAt ??= timestamp;
        }
      });
      lastAutoWakeAt = Date.now();
      // The unread badge and peer list should react to the arrival, not wait for
      // the next slow presence tick.
      await refreshWidget(ctx).catch(() => undefined);
    } finally {
      deliveryInFlight = false;
    }
  }

  async function markRead(): Promise<void> {
    if (!current) return;
    const timestamp = now();
    current = { ...current, lastReadAt: timestamp };
    await updateState((state) => {
      for (const message of state.messages) {
        if (message.toSessionId !== current!.id) continue;
        if (!message.readAt) message.readAt = timestamp;
        // Reading via /team inbox is an explicit delivery path. Do not leave a
        // manually inspected message eligible for a later duplicate auto-wake.
        message.deliveredAt ??= message.readAt ?? timestamp;
      }
      state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item);
    });
  }

  // The pulse stamp is folded into ensureSession's options at turn start; a
  // separate write here would rewrite the whole room a second time per prompt.

  // Build the themed summary used by both the live widget and the regular-mode
  // overlay. The overlay can reserve a trailing blank row so an expanded
  // summary grows upward from the compact line without covering the editor.
  function buildSummaryBox(state: TeamRoomState, session: WorkSession, theme: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  }, expanded: boolean, includeLeadingSpacer = false, includeTrailingSpacer = false): Box {
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    const addLine = (line: string): void => box.addChild(new Text(line, 0, 0));
    if (expanded) {
      // Match Pi's standard highlighted divider without importing the interactive
      // runtime component (the extension also runs in lightweight test/RPC hosts).
      box.addChild({
        render: (width: number): string[] => [theme.fg("borderAccent", "─".repeat(Math.max(1, width)))],
        invalidate: (): void => undefined,
      });
    }
    if (includeLeadingSpacer) addLine("");
    const rail = theme.fg("accent", "▌ ");
    const peers = activeSessions(state, session).filter((item) => item.id !== session.id);
    const statusMark = (status: SessionStatus): string => status === "working" ? "●" : "○";
    const statusColor = (status: SessionStatus): "warning" | "success" => status === "working" ? "warning" : "success";
    const peerLabel = (peer: WorkSession): string =>
      `${theme.fg(statusColor(peer.status), statusMark(peer.status))} ${theme.fg("accent", truncate(peer.name, 24))} ${theme.fg("dim", peer.status)}`;

    if (!expanded) {
      const visible = peers.slice(0, 5).map(peerLabel);
      if (visible.length === 0) visible.push(theme.fg("dim", "no peers"));
      if (peers.length > visible.length) visible.push(theme.fg("muted", `+${peers.length - visible.length} more`));
      const unread = unreadMessages(state, session).length;
      if (unread > 0) visible.push(theme.fg("error", `${unread} unread`));
      addLine(`${rail}${theme.bold(theme.fg("accent", "Team:"))} ${visible.join(theme.fg("borderMuted", " | "))}`);
    } else {
      addLine(`${rail}${theme.bold(theme.fg("accent", "Team room"))} ${theme.fg("dim", "— machine-wide")} ${theme.fg("muted", `(${projectLabel(session.project)})`)}`);
      if (peers.length === 0) {
        addLine(`${rail}${theme.fg("dim", "no other active sessions on this machine")}`);
      } else {
        for (const peer of peers.slice(0, 5)) {
          const note = peer.focus || peer.checkpoint?.text || "no focus";
          addLine(`${rail}${peerLabel(peer)} ${theme.fg("dim", `[${shortId(peer.id)}] (${projectLabel(peer.project)}):`)} ${theme.fg("text", truncate(note, 100))}`);
        }
      }
      for (const update of relevantUpdates(state, session).slice(0, 2)) {
        addLine(`${rail}${theme.fg("warning", "↳")} ${theme.fg("accent", `${truncate(update.sessionName, 24)}:`)} ${theme.fg("text", truncate(update.text, 80))}`);
      }
      const journal = recentJournal(state, session);
      if (journal.length > 0) addLine(`${rail}${theme.fg("success", "◆")} ${theme.fg("dim", "decided:")} ${theme.fg("text", truncate(journal[0].text, 90))}`);
      if (includeTrailingSpacer) addLine("");
    }
    return box;
  }

  // The regular TUI renders into terminal scrollback rather than a fixed
  // viewport. Shrinking an above-editor widget cannot reveal the older rows
  // that were scrolled off-screen, so the dock rises and leaves blank rows.
  // Keep the live widget one line in regular mode and show expanded details as
  // a non-capturing overlay instead. The overlay follows the actual compact
  // widget row, so its details do not require guessing the editor height.
  //
  // TuiBase's overlay compositor pads a short regular-mode render to the full
  // terminal height before compositing. That is correct for a modal overlay in
  // a viewport, but it turns a short scrollback render into a screenful of blank
  // lines here. While this one overlay is mounted, trim that compositor result
  // back to the base render plus only the rows needed by the overlay. The
  // overlay uses getter-backed layout options so its position follows editor
  // and autocomplete growth without retaining terminal-height padding in
  // scrollback. Pi resolves an overlayOptions callback once when mounting, but
  // TuiBase reads the stored option object on every render.
  type OverlayEntry = { component?: unknown };
  type OverlayRenderingTui = TUI & {
    compositeOverlays?: (lines: string[], width: number, height: number) => string[];
    overlayStack?: OverlayEntry[];
    previousLines?: string[];
    maxLinesRendered?: number;
  };

  function regularOverlayPosition(tui: TUI, overlayHeight: number, renderedLines?: string[]): { row: number; maxHeight: number } {
    const lines = renderedLines || tui.render(tui.terminal.columns);
    const widgetLine = lines.findLastIndex((line) => line.includes("Team:"));
    const viewportTop = Math.max(0, lines.length - tui.terminal.rows);
    const widgetRow = widgetLine >= 0 ? widgetLine - viewportTop : undefined;
    const targetLine = widgetLine >= 0 ? widgetLine - overlayHeight + 1 : tui.terminal.rows - overlayHeight;
    const row = Math.max(0, Math.min(tui.terminal.rows - 1, targetLine - viewportTop));

    // Autocomplete is rendered below the editor. If it grows enough to move
    // the compact widget toward the top of the viewport, a tall summary can
    // otherwise be clamped to row 0 and paint over autocomplete. The overlay
    // must never extend below the compact widget's screen row.
    const availableAboveWidget = widgetRow === undefined ? tui.terminal.rows - row : widgetRow - row + 1;
    return {
      row,
      maxHeight: Math.max(1, Math.min(tui.terminal.rows - row, availableAboveWidget)),
    };
  }

  function temporarilyDetachOwnedOverlaysForShrink(
    tui: OverlayRenderingTui,
    stack: OverlayEntry[] | undefined,
    lines: string[],
  ): void {
    if (!stack || stack.length === 0) return;
    const previousLength = Math.max(
      Array.isArray(tui.previousLines) ? tui.previousLines.length : 0,
      typeof tui.maxLinesRendered === "number" ? tui.maxLinesRendered : 0,
    );
    if (lines.length >= previousLength) return;

    // TuiMainScreen deliberately skips clearOnShrink while any overlay is
    // mounted, because normal overlays need its terminal-height padding. Our
    // non-capturing overlays are already composited into the base render and
    // trimmed below, so temporarily removing them lets Pi perform the normal
    // shrink redraw. Restore the entries after doRender() has completed; the
    // current frame already contains the composited summary.
    const owned = stack.filter((entry) => regularOverlayComponents.has(entry.component));
    if (owned.length === 0 || owned.length !== stack.length) return;
    stack.splice(0, stack.length);
    queueMicrotask(() => {
      const currentStack = tui.overlayStack;
      if (!currentStack) return;
      for (const entry of owned) {
        if (regularOverlayComponents.has(entry.component) && !currentStack.includes(entry)) currentStack.push(entry);
      }
    });
  }

  function patchRegularOverlayCompositor(tui: TUI): void {
    if (restoreRegularOverlayPatch) return;
    const renderingTui = tui as OverlayRenderingTui;
    // activeWidgetTui is normally Pi's stable TUI proxy. Read the method from
    // its prototype rather than retaining the proxy's per-access wrapper, so
    // repeated expand/collapse cycles do not build a wrapper chain.
    let owner = Object.getPrototypeOf(renderingTui) as object | null;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, "compositeOverlays")) {
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    const inherited = owner && (owner as Partial<OverlayRenderingTui>).compositeOverlays;
    const original = inherited || renderingTui.compositeOverlays;
    if (!original) return;
    const patched = function (this: OverlayRenderingTui, lines: string[], width: number, height: number): string[] {
      const composed = original.call(this, lines, width, height);
      // If the runtime does not expose overlayStack (for example, a test or an
      // older Pi), this patch is only installed while one of our overlays is
      // active anyway.
      const stack = (this as OverlayRenderingTui & { overlayStack?: Array<{ component?: unknown }> }).overlayStack;
      const mounted = !stack || stack.some((entry) => regularOverlayComponents.has(entry.component));
      // All of our regular overlays are positioned within the existing base
      // render. Discard only TuiBase's terminal-height padding; retaining it
      // makes a later ordinary render look shorter and triggers scrollback
      // reflow/blank rows.
      const trimmed = mounted && composed.length > lines.length ? composed.slice(0, lines.length) : composed;
      if (mounted) temporarilyDetachOwnedOverlaysForShrink(this, stack, lines);
      return trimmed;
    };
    renderingTui.compositeOverlays = patched;
    restoreRegularOverlayPatch = () => {
      renderingTui.compositeOverlays = original;
      restoreRegularOverlayPatch = undefined;
    };
  }

  function closeSummaryOverlay(): void {
    // Pi's hideOverlay() closes the topmost overlay. Remove a notice first so
    // a compact/rebuild action cannot accidentally close the wrong overlay.
    if (regularNoticeDone) closeRegularNotice();
    const done = summaryOverlayDone;
    summaryOverlayDone = undefined;
    summaryOverlayTui = undefined;
    if (summaryOverlayComponent) regularOverlayComponents.delete(summaryOverlayComponent);
    summaryOverlayComponent = undefined;
    maybeRestoreRegularOverlayPatch();
    done?.();
  }

  function maybeRestoreRegularOverlayPatch(): void {
    if (regularOverlayComponents.size === 0) restoreRegularOverlayPatch?.();
  }

  function closeRegularNotice(): void {
    if (regularNoticeTimer) clearTimeout(regularNoticeTimer);
    regularNoticeTimer = undefined;
    const done = regularNoticeDone;
    regularNoticeDone = undefined;
    if (regularNoticeComponent) regularOverlayComponents.delete(regularNoticeComponent);
    regularNoticeComponent = undefined;
    regularNoticeTui = undefined;
    maybeRestoreRegularOverlayPatch();
    done?.();
  }

  function showRegularNotice(ctx: ContextLike, message: string, type: "info" | "warning"): void {
    closeRegularNotice();
    const tui = activeWidgetTui;
    if (ctx.mode !== "tui" || tui?.mode !== "regular") {
      ctx.ui.notify(message, type);
      return;
    }
    patchRegularOverlayCompositor(tui);
    let createdNoticeComponent: unknown;
    let overlay: Promise<void>;
    overlay = ctx.ui.custom<void>((noticeTui, initialTheme, _keybindings, done) => {
      regularNoticeTui = noticeTui;
      regularNoticeDone = () => done(undefined);
      const component = {
        render: (width: number): string[] => message.split("\n").map((line) => {
          const clean = line.replace(/[\r\t]+/g, " ").trim();
          return initialTheme.fg(type === "warning" ? "warning" : "dim", clean.slice(0, Math.max(1, width - 1)));
        }),
        invalidate: (): void => undefined,
      };
      createdNoticeComponent = component;
      regularNoticeComponent = component;
      regularOverlayComponents.add(component);
      return component;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        get row(): number {
          const noticeTui = regularNoticeTui || activeWidgetTui;
          const lineCount = message.split("\n").length;
          return noticeTui ? regularOverlayPosition(noticeTui, lineCount).row : 0;
        },
        col: 0,
        width: "100%",
        get maxHeight(): number {
          const noticeTui = regularNoticeTui || activeWidgetTui;
          const lineCount = message.split("\n").length;
          return noticeTui ? regularOverlayPosition(noticeTui, lineCount).maxHeight : 1;
        },
        nonCapturing: true,
      },
    });
    regularNoticeTimer = setTimeout(() => closeRegularNotice(), 4_000);
    regularNoticeTimer.unref?.();
    void overlay.finally(() => {
      regularOverlayComponents.delete(createdNoticeComponent);
      if (regularNoticeComponent !== createdNoticeComponent) {
        maybeRestoreRegularOverlayPatch();
        return;
      }
      regularNoticeDone = undefined;
      regularNoticeTui = undefined;
      regularNoticeComponent = undefined;
      regularNoticeTimer = undefined;
      maybeRestoreRegularOverlayPatch();
    }).catch(() => undefined);
  }

  function openSummaryOverlay(ctx: ContextLike): void {
    if (ctx.mode !== "tui" || summaryOverlayPending || summaryOverlayDone) return;
    summaryOverlayPending = true;
    if (activeWidgetTui) patchRegularOverlayCompositor(activeWidgetTui);
    let createdSummaryComponent: unknown;
    const overlay = ctx.ui.custom<void>((tui, initialTheme, _keybindings, done) => {
      summaryOverlayTui = tui;
      summaryOverlayDone = () => done(undefined);
      let overlayTheme = initialTheme;
      const component = {
        render: (width: number): string[] => {
          const data = summaryOverlayData;
          return data ? buildSummaryBox(data.state, data.session, overlayTheme, true, false, true).render(width) : [];
        },
        invalidate: (): void => { overlayTheme = ctx.ui.theme; },
      };
      createdSummaryComponent = component;
      summaryOverlayComponent = component;
      regularOverlayComponents.add(component);
      return component;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        get row(): number {
          const tui = summaryOverlayTui || activeWidgetTui;
          const height = summaryOverlayComponent && typeof (summaryOverlayComponent as { render?: unknown }).render === "function"
            ? (summaryOverlayComponent as { render(width: number): string[] }).render(tui?.terminal.columns ?? 80).length
            : 1;
          return tui ? regularOverlayPosition(tui, height).row : 0;
        },
        col: 0,
        width: "100%",
        get maxHeight(): number {
          const tui = summaryOverlayTui || activeWidgetTui;
          const height = summaryOverlayComponent && typeof (summaryOverlayComponent as { render?: unknown }).render === "function"
            ? (summaryOverlayComponent as { render(width: number): string[] }).render(tui?.terminal.columns ?? 80).length
            : 1;
          return tui ? regularOverlayPosition(tui, height).maxHeight : 1;
        },
        nonCapturing: true,
      },
    });
    void overlay.finally(() => {
      summaryOverlayPending = false;
      summaryOverlayDone = undefined;
      summaryOverlayTui = undefined;
      regularOverlayComponents.delete(createdSummaryComponent);
      if (summaryOverlayComponent === createdSummaryComponent) summaryOverlayComponent = undefined;
      maybeRestoreRegularOverlayPatch();
    }).catch(() => undefined);
  }

  // Live always-on summary widget (never touches LLM context).
  async function refreshWidget(ctx: ContextLike): Promise<void> {
    if (!current || !ctx.hasUI) return;
    const state = await readState();
    const session = current;
    const expanded = summaryExpanded;

    // RPC mode only accepts plain string arrays.
    if (ctx.mode !== "tui") {
      closeSummaryOverlay();
      ctx.ui.setWidget(WIDGET_ID, expanded ? renderSummaryLines(state, session) : [renderCompactSummaryLine(state, session)], { placement: "aboveEditor" });
      return;
    }

    const regularMode = activeWidgetTui?.mode === "regular";
    if (regularMode) {
      summaryOverlayData = { state, session };
      if (expanded) openSummaryOverlay(ctx);
      else closeSummaryOverlay();
    } else {
      // A pending regular overlay prevents mode switching; close it before a
      // fullscreen widget is rebuilt.
      closeSummaryOverlay();
    }

    ctx.ui.setWidget(WIDGET_ID, (tui, initialTheme) => {
      activeWidgetTui = tui;
      const widgetExpanded = regularMode ? false : expanded;
      let box = buildSummaryBox(state, session, initialTheme, widgetExpanded);
      return {
        render: (width: number): string[] => box.render(width),
        invalidate: (): void => { box = buildSummaryBox(state, session, ctx.ui.theme, widgetExpanded); },
      };
    }, { placement: "aboveEditor" });
  }

  async function appendSummaryCard(session: WorkSession): Promise<void> {
    pi.appendEntry(SUMMARY_TYPE, {
      lines: renderSummaryLines(await readState(), session),
      updatedAt: now(),
    });
  }

  async function publishUpdate(text: string): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    // Refuse rather than silently park the text where no peer will read it: the
    // sender should learn that this room does not do undirected broadcast.
    if (!broadcastsEnabled()) return "Broadcasts are off (set PI_TEAM_ROOM_BROADCAST=1 to enable); use action=ask, action=delegate, or action=checkpoint for context that has a specific reader.";
    const { text: clean, omitted } = recordText(text, MAX_UPDATE_LENGTH);
    if (!clean) throw new Error("Update cannot be empty");
    return updateState((state) => {
      const previous = state.updates.find((item) => item.sessionId === current!.id && item.text === clean);
      if (previous && Date.now() - Date.parse(previous.createdAt) < 10 * 60 * 1000) return "Already shared recently.";
      state.updates.unshift({ id: randomUUID(), sessionId: current!.id, sessionName: current!.name, project: current!.project, text: clean, createdAt: now(), ...(omitted > 0 ? { clipped: true } : {}) });
      state.updates = state.updates.slice(0, LIMITS.maxUpdates);
      return `Shared with the team: ${clean}${clippedNote(omitted, MAX_UPDATE_LENGTH)}`;
    });
  }

  // A durable fact, read by sessions that were not part of the conversation that
  // wrote it. It gets the record treatment (paragraphs kept, middle dropped) and
  // its own cap, because a cross-repo contract does not fit in one status line.
  async function saveFact(text: string): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const { text: clean, omitted } = recordText(text, MAX_JOURNAL_LENGTH);
    if (!clean) throw new Error("A fact or decision is required");
    await updateState((state) => {
      state.journal.unshift({ id: randomUUID(), project: current!.project, text: clean, createdAt: now(), sessionName: current!.name, ...(omitted > 0 ? { clipped: true } : {}) });
      state.journal = state.journal.slice(0, LIMITS.maxJournalItems);
    });
    return `Saved to shared history: ${clean}${clippedNote(omitted, MAX_JOURNAL_LENGTH)}`;
  }

  async function saveCheckpoint(text: string): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const { text: clean, omitted } = recordText(text, MAX_CHECKPOINT_LENGTH);
    if (!clean) throw new Error("Checkpoint cannot be empty");
    const checkpoint = { text: clean, updatedAt: now(), sessionId: current.id, ...(omitted > 0 ? { clipped: true } : {}) } satisfies Checkpoint;
    current = { ...current, checkpoint, focus: current.focus || truncate(clean, 180), updatedAt: now(), lastSeenAt: now() };
    await updateState((state) => {
      state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item);
    });
    return `Checkpoint saved: ${clean}${clippedNote(omitted, MAX_CHECKPOINT_LENGTH)}`;
  }

  async function sendPeerMessage(
    kind: "question" | "delegation",
    agent: string,
    text: string,
    requestedDelivery: MessageDelivery = "auto",
    delegation?: DelegationDetails,
  ): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const cleanAgent = agent.trim().toLowerCase();
    const clean = messageText(text, MAX_MESSAGE_LENGTH);
    const delivery = normalizeDelivery(requestedDelivery);
    if (!cleanAgent || !clean) throw new Error(kind === "delegation" ? "Delegation requires an agent and task" : "Ask requires an agent name and question");
    if (kind === "delegation" && (!delegation?.target || !delegation.scope)) {
      throw new Error("Delegation requires target and scope");
    }
    return updateState((state) => {
      const target = activeSessions(state, current!).find((item) => item.id !== current!.id &&
        (item.name.toLowerCase() === cleanAgent || item.id.toLowerCase() === cleanAgent || item.id.toLowerCase().startsWith(cleanAgent)));
      if (!target) return `No active peer named or identified by ${agent} found in this team room. Use action=pulse to see peers.`;
      const message: TeamMessage = {
        id: randomUUID(), kind, fromSessionId: current!.id, fromName: current!.name,
        toSessionId: target.id, text: clean, createdAt: now(), threadDepth: 0,
        fromOwns: ownershipOf(current!),
      };
      if (delegation) message.delegation = delegation;
      if (delivery !== "auto") message.delivery = delivery;
      state.messages.push(message);
      const focus = target.focus || target.checkpoint?.text || "no focus recorded";
      const recommendation = target.status === "working" ? "followUp" : "steer";
      const selected = delivery === "auto" ? `${recommendation} (auto)` : delivery;
      const label = kind === "delegation" ? "Delegation sent" : "Question sent";
      const details = delegation ? ` [target: ${truncate(delegation.target, 120)}; scope: ${confirmationPreview(delegation.scope)}]` : "";
      return `${label} to ${target.name} [${target.status}; owns: ${ownershipLabel(target)}; focus: ${truncate(focus, 120)}; delivery: ${selected}; message id: ${shortId(message.id)}]${details}: ${confirmationPreview(clean)}`;
    });
  }

  async function askPeer(agent: string, text: string, requestedDelivery: MessageDelivery = "auto"): Promise<string> {
    return sendPeerMessage("question", agent, text, requestedDelivery);
  }

  async function delegatePeer(
    agent: string,
    task: string,
    target: string,
    scope: string,
    userAuthorization?: string,
    acceptanceChecks?: string,
    expectedArtifact?: string,
    requestedDelivery: MessageDelivery = "auto",
  ): Promise<string> {
    const cleanTarget = truncate(target, MAX_TARGET_LENGTH);
    const cleanScope = messageText(scope, MAX_DELEGATION_FIELD_LENGTH);
    if (!cleanTarget || !cleanScope) throw new Error("Delegation requires target and scope");
    const details: DelegationDetails = { target: cleanTarget, scope: cleanScope };
    const optional = (value: string | undefined, max: number): string | undefined => {
      const clean = value?.trim();
      return clean ? messageText(clean, max) : undefined;
    };
    const cleanAuthorization = optional(userAuthorization, MAX_DELEGATION_FIELD_LENGTH);
    const cleanAcceptance = optional(acceptanceChecks, MAX_DELEGATION_FIELD_LENGTH);
    const cleanArtifact = optional(expectedArtifact, MAX_TARGET_LENGTH);
    if (cleanAuthorization) details.userAuthorization = cleanAuthorization;
    if (cleanAcceptance) details.acceptanceChecks = cleanAcceptance;
    if (cleanArtifact) details.expectedArtifact = cleanArtifact;
    return sendPeerMessage("delegation", agent, task, requestedDelivery, details);
  }

  async function replyToMessage(messageId: string, text: string, requestedDelivery: MessageDelivery = "auto"): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const cleanId = messageId.trim().toLowerCase();
    const clean = messageText(text, MAX_MESSAGE_LENGTH);
    const delivery = normalizeDelivery(requestedDelivery);
    if (!cleanId || !clean) throw new Error("Reply requires a message id and text");
    return updateState((state) => {
      const original = state.messages.find((item) => item.toSessionId === current!.id &&
        (item.id.toLowerCase() === cleanId || item.id.toLowerCase().startsWith(cleanId)));
      if (!original) return `No message matching ${messageId} found in your inbox.`;
      if (isDoneSignal(original.text)) return `That message is a terminal ${DONE_SIGNAL} signal; do not reply to it.`;
      const target = state.sessions.find((item) => item.id === original.fromSessionId);
      const depth = threadDepthOf(state, original) + 1;
      const budget = threadBudget(depth);
      const message: TeamMessage = {
        id: randomUUID(), kind: "reply", fromSessionId: current!.id, fromName: current!.name,
        toSessionId: original.fromSessionId, replyToId: original.id, text: clean, createdAt: now(),
        threadDepth: depth, fromOwns: ownershipOf(current!),
      };
      if (delivery !== "auto") message.delivery = delivery;
      state.messages.push(message);
      const targetStatus = target?.status || "unknown";
      const targetFocus = target?.focus || target?.checkpoint?.text || "focus unavailable";
      const recommendation = target?.status === "working" ? "followUp" : "steer";
      const requested = delivery === "auto" ? recommendation : delivery;
      // Say plainly what this reply will do to the recipient. A sender that
      // thinks it interrupted a peer, when the room quietly filed the message
      // instead, will keep sending - so the throttle has to be visible at the
      // point of sending, not only in the docs.
      const effect = !budget.canWake
        ? "no wake (thread at depth limit; it rests in their inbox until they look)"
        : requested === "steer" && !budget.canSteer
          ? "followUp (downgraded from steer: thread past its soft depth and may not interrupt)"
          : delivery === "auto" ? `${requested} (auto)` : requested;
      const advice = !budget.canWake
        ? ` This exchange is settled as far as the room is concerned: close it with the owning session's call or put the open question to the user.`
        : depth >= THREAD_SOFT_DEPTH
          ? ` Thread is ${depth} deep; prefer closing it over another round.`
          : "";
      return `Reply sent to ${original.fromName} [${targetStatus}; owns: ${target ? ownershipLabel(target) : "unknown"}; focus: ${truncate(targetFocus, 120)}; delivery: ${effect}; thread depth: ${depth}; message id: ${shortId(message.id)}]: ${confirmationPreview(clean)}${advice}`;
    });
  }

  async function toolResult(action: string, text: string): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
    return { content: [{ type: "text", text }], details: { action } };
  }

  pi.registerShortcut("shift+up", {
    description: "Expand or collapse the team-room summary",
    handler: async (ctx) => {
      summaryExpanded = !summaryExpanded;
      await refreshWidget(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    projectInfo = undefined;
    await ensureSession(ctx, "idle");
    // A resumed or continued session already has a transcript worth indexing
    // before the first turn ends, but session start is not the place to pay for
    // it either: queue it and let the worker take it.
    const initialHistory = historyJob(ctx);
    if (initialHistory) historyEnqueue(initialHistory);
    startNetworkService();
    await refreshWidget(ctx);
    heartbeat = setInterval(() => {
      // Heartbeat work is best-effort. A session can shut down while one of
      // these asynchronous state operations is in flight; do not turn that
      // expected race into an unhandled rejection.
      // Direct messages are polled on the fast clock; presence pings and the
      // widget redraw stay on the slow clock because nothing waits on them.
      void deliverPendingMessages(ctx).catch(() => undefined);
      if (Date.now() - lastPresenceAt >= HEARTBEAT_MS) {
        lastPresenceAt = Date.now();
        void heartbeatOnce(ctx, ctx.isIdle() ? "idle" : "working").catch(() => undefined);
        void refreshWidget(ctx).catch(() => undefined);
      }
    }, INBOX_POLL_MS);
    heartbeat.unref?.();
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (!current) return;
    current = { ...current, name: sessionName(ctx, current.name), updatedAt: now(), lastSeenAt: now() };
    await writeSessionRecord(current);
    queueSessionHistory(ctx);
  });

  pi.on("message_end", async (_event, ctx) => {
    queueSessionHistory(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    // The summary replaces older entries, including the room's pulse and
    // checkpoint. Ask for them again on the next turn instead of letting the
    // session resume blind.
    restockRoomContext = true;
    lastPulse = undefined;
    lastCheckpointShownAt = undefined;
    queueSessionHistory(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    queueSessionHistory(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // One transaction for the whole turn start. This used to be three separate
    // operations on the shared file: register the session, then a full read for
    // the pulse render, then a stamp write for the pulse itself. The paths the
    // prompt mentioned are folded into the same record, and the pulse render
    // goes through the cached read.
    const broadcasts = broadcastsEnabled();
    // With broadcasts off the injected pulse does not carry updates, so it must
    // not advance the "since you were last here" stamp either: stamping here
    // would silently swallow updates published by sessions that do opt in before
    // this one gets around to pulling them.
    const pulseAt = broadcasts ? now() : undefined;
    const paths = mentionedPaths(event.messageType === "user" ? event.prompt : undefined);
    const session = await ensureSession(ctx, "working", { paths, pulseAt });
    const pulse = renderPulse(await readState(), session, { includeBroadcasts: broadcasts });
    const pulseChanged = pulse !== lastPulse;
    // A checkpoint earns a full re-send when it moved since the last one, or
    // when a compaction dropped the earlier copy. Otherwise the model already
    // has it in context and the rest of the turn is cheaper for everyone.
    const restatesCheckpoint = !!session.checkpoint && (
      restockRoomContext || lastCheckpointShownAt !== session.checkpoint.updatedAt
    );
    const roomUse = broadcasts
      ? "Use team_room only for meaningful updates, questions, replies, checkpoints, decisions, or relevant history. Do not narrate routine file edits or test runs."
      : "Undirected broadcasts are off here: do not publish updates or expect peer focus to arrive on its own. Use team_room only for directed questions, replies, and delegations, for your own checkpoint, or for history you deliberately pull. Do not narrate routine file edits or test runs.";
    // Keep the system prompt stable: a volatile pulse here would change the
    // token prefix before the entire conversation history and force a full
    // prefill on every peer status/message change. The static protocol belongs
    // in the system prompt; this turn's room snapshot is appended after the
    // starting user/custom message so the existing prefix remains cacheable.
    const systemPrompt = `${event.systemPrompt}\n\n## Shared team room\n${TEAM_ROOM_PROTOCOL} ${roomUse}`;
    const staticOnly = { systemPrompt };
    if (!pulseChanged && !restatesCheckpoint) {
      // Nothing new since the entry the model can already see. Appending another
      // copy is the cost that made a long session pay for the room forever.
      return staticOnly;
    }
    const parts: string[] = [];
    if (pulseChanged) parts.push(pulse);
    if (session.checkpoint) {
      parts.push(restatesCheckpoint
        ? `Your current checkpoint:\n- ${session.checkpoint.text}`
        : `Your checkpoint is unchanged since it was last shown (${session.checkpoint.updatedAt}).`);
    }
    if (pulseChanged) lastPulse = pulse;
    if (restatesCheckpoint && session.checkpoint) lastCheckpointShownAt = session.checkpoint.updatedAt;
    restockRoomContext = false;
    return {
      systemPrompt,
      message: {
        customType: "pi-team-room-pulse",
        content: parts.join("\n\n"),
        display: false,
        details: { broadcasts, pulseChanged, restatesCheckpoint },
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (current) {
      await heartbeatOnce(ctx, "idle");
      await refreshWidget(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // This process is finishing with its session record, so it stops protecting
    // it: the record stays visible for the retention window as a resume point,
    // then pruning is allowed to drop it like any other dead session.
    if (current) protectedSessionIds.delete(current.id);
    await flushSessionHistory(ctx);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (current) {
      const snapshot = { ...current, status: "idle" as SessionStatus, connected: false, updatedAt: now(), lastSeenAt: now() };
      current = snapshot;
      // Fallback breadcrumb: if the session never saved an explicit checkpoint
      // but was meaningfully active, leave an auto checkpoint derived from its
      // focus/latest prompt so teammates still get a resume point.
      if (!snapshot.checkpoint && snapshot.startedAt && Date.now() - Date.parse(snapshot.startedAt) >= AUTO_CHECKPOINT_MIN_MS) {
        const hint = snapshot.focus || recentUserPrompt(ctx);
        if (hint) {
          const auto = recordText(hint, MAX_CHECKPOINT_LENGTH - 7);
          snapshot.checkpoint = { text: `[auto] ${auto.text}`, updatedAt: now(), sessionId: snapshot.id, auto: true, ...(auto.omitted > 0 ? { clipped: true } : {}) };
        }
      }
      await writeSessionRecord(snapshot, { force: true });
    }
    closeSummaryOverlay();
    closeRegularNotice();
    activeWidgetTui = undefined;
    summaryOverlayData = undefined;
    try { ctx.ui.setWidget(WIDGET_ID, undefined); } catch { /* no UI in this context */ }
  });

  pi.registerTool({
    name: "team_room",
    label: "Team Room",
    description: broadcastsEnabled()
      ? "Quiet peer context: inspect the team pulse, publish meaningful updates, ask a peer a question, delegate a scoped task to an online code owner, save a task checkpoint, or search shared work history. Do not use for routine activity narration."
      : "Directed peer context: inspect the team pulse on request, ask a peer a question, delegate a scoped task to an online code owner, save a task checkpoint, or search shared work history. Undirected updates are disabled. Do not use for routine activity narration.",
    promptSnippet: "Share and retrieve concise context with peer Pi sessions",
    promptGuidelines: [
      "Use team_room action=pulse when orienting yourself to relevant parallel work.",
      broadcastsEnabled()
        ? "Use team_room action=update for meaningful decisions, discoveries, blockers, or completion notes—not individual tool calls."
        : "Do not call action=update: undirected broadcasts are off in this room. Use ask/delegate for a peer who needs the context.",
      "Use team_room action=checkpoint when pausing work or recording a useful resume point.",
      "Use team_room action=ask when another active peer has relevant context you need.",
      "Use team_room action=delegate when an online peer owns the target repository/component. Provide target, scope, acceptanceChecks, and expectedArtifact; the owner implements/tests/commits/pushes while you coordinate integration or rollout. If the owner is offline, state any fallback explicitly and ensure current user authorization covers taking over.",
      "When relaying user approval in a delegation, include a concise exact userAuthorization quote rather than paraphrasing it away.",
      "Use team_room action=focus with owns=<lane> once per session to declare the lane you are the tiebreaker for; it otherwise defaults to what your session name and project already imply. Inside a peer's lane, accept their result or raise one specific defect - do not re-derive it.",
      "Do not reply to agree, to confirm you reproduced a peer's number, or to add a refinement that changes no decision: that costs the peer a turn and returns nothing. Reply for defects, blockers, and decisions they must make.",
      "For ask/reply, omit delivery for auto routing; use delivery=steer only when delaying until the peer finishes could waste work or leave a blocker unresolved. Steering is a nudge, not an instruction to abandon the peer's current task; the recipient decides whether the message is relevant.",
      "Use team_room action=remember for durable team decisions that future sessions should know.",
      `When a teammate exchange needs only a terminal acknowledgement, reply with exactly ${DONE_SIGNAL} only—not after a substantive answer; receiving exactly ${DONE_SIGNAL} means the other agent is done, so do not reply or echo it.`,
      "Do not answer terminal acknowledgements such as thanks, received, or you're welcome; direct replies should happen once and only when they add substantive information.",
      `Never send ${DONE_SIGNAL} as a courtesy after every message; it is reserved for closing a non-substantive acknowledgement.`,
    ],
    parameters: TeamRoomParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await ensureSession(ctx, "working");
      switch (params.action) {
        case "pulse": {
          const state = await readState();
          return toolResult("pulse", renderPulse(state, session));
        }
        case "focus": {
          const owns = params.owns?.trim() ? parseOwnership(params.owns) : undefined;
          if (!params.text?.trim() && !owns) {
            const label = `owns: ${ownershipLabel(session)}${session.owns?.length ? "" : " (derived from this session's name and project; set it with action=focus owns=...)"}`;
            return toolResult("focus", `${session.focus ? `Current focus: ${session.focus}` : "No focus recorded."} ${label}`);
          }
          const clean = params.text?.trim() ? truncate(params.text, 180) : session.focus;
          current = { ...session, focus: clean, focusPinned: clean ? true : session.focusPinned, updatedAt: now(), lastSeenAt: now() };
          if (owns) current.owns = owns;
          await writeSessionRecord(current, { force: true });
          const parts = [clean ? `Focus updated: ${clean}` : "", owns ? `Owns: ${owns.join(", ")} — you are the tiebreaker for this lane, and peers are told so on every message you send.` : ""];
          return toolResult("focus", parts.filter(Boolean).join(" "));
        }
        case "update":
          return toolResult("update", await publishUpdate(params.text || ""));
        case "ask":
          return toolResult("ask", await askPeer(params.agent || "", params.text || "", normalizeDelivery(params.delivery)));
        case "delegate":
          return toolResult("delegate", await delegatePeer(
            params.agent || "",
            params.text || "",
            params.target || "",
            params.scope || "",
            params.userAuthorization,
            params.acceptanceChecks,
            params.expectedArtifact,
            normalizeDelivery(params.delivery),
          ));
        case "reply":
          return toolResult("reply", await replyToMessage(params.messageId || "", params.text || "", normalizeDelivery(params.delivery)));
        case "inbox": {
          const state = await readState();
          const messages = unreadMessages(state, session);
          await markRead();
          return toolResult("inbox", renderInbox(messages));
        }
        case "checkpoint": {
          if (!params.text?.trim()) return toolResult("checkpoint", session.checkpoint ? `Current checkpoint: ${session.checkpoint.text}` : "No checkpoint saved.");
          return toolResult("checkpoint", await saveCheckpoint(params.text));
        }
        case "remember": {
          if (!params.text?.trim()) return toolResult("remember", "A fact or decision is required.");
          return toolResult("remember", await saveFact(params.text));
        }
        case "history": {
          const state = await readState();
          return toolResult("history", renderHistory(searchJournal(state, session, params.query || params.text)));
        }
      }
    },
  });

  pi.registerCommand("team", {
    description: "Show quiet shared peer context (also drops a TUI summary card); subcommands: expand, compact, focus, owns, update, ask, delegate, steer, reply, inbox, checkpoint, remember, history",
    handler: async (args, ctx) => {
      const session = await ensureSession(ctx, "idle");
      const [subcommand, ...rest] = splitCommandWords(args);
      const text = rest.join(" ").trim();
      try {
        if (!subcommand || subcommand === "summary") {
          await appendSummaryCard(session);
          ctx.ui.notify(renderPulse(await readState(), session), "info");
          await refreshWidget(ctx);
          return;
        }
        if (subcommand === "expand" || subcommand === "details") {
          summaryExpanded = true;
          await refreshWidget(ctx);
          ctx.ui.notify("Team summary expanded", "info");
        } else if (subcommand === "compact" || subcommand === "collapse") {
          summaryExpanded = false;
          await refreshWidget(ctx);
          ctx.ui.notify("Team summary compacted", "info");
        } else if (subcommand === "focus") {
          if (!text) { ctx.ui.notify(session.focus ? `Focus: ${session.focus}` : "No focus recorded.", "info"); return; }
          current = { ...session, focus: truncate(text, 180), focusPinned: true, updatedAt: now(), lastSeenAt: now() };
          await updateState((state) => { state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item); });
          ctx.ui.notify(`Focus updated: ${current.focus}`, "info");
        } else if (subcommand === "owns") {
          if (!text) { ctx.ui.notify(`Owns: ${ownershipLabel(session)}${session.owns?.length ? "" : " (derived from session name and project)"}`, "info"); return; }
          const owned = parseOwnership(text);
          current = { ...session, owns: owned, updatedAt: now(), lastSeenAt: now() };
          await updateState((state) => { state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item); });
          ctx.ui.notify(`Owns: ${owned.join(", ")} — tiebreaker for this lane`, "info");
        } else if (subcommand === "update") {
          ctx.ui.notify(await publishUpdate(text), "info");
        } else if (subcommand === "ask" || subcommand === "steer") {
          const [agent, ...questionWords] = rest;
          const parsed = subcommand === "steer"
            ? { delivery: "steer" as const, words: questionWords }
            : splitCommandDelivery(questionWords);
          ctx.ui.notify(await askPeer(agent || "", parsed.words.join(" "), parsed.delivery), "info");
        } else if (subcommand === "delegate") {
          const [agent, ...delegationWords] = rest;
          const parsed = splitDelegationArgs(delegationWords);
          if (!agent || !parsed.target || !parsed.scope || parsed.words.length === 0) {
            throw new Error("Usage: /team delegate <agent> --target <repo/component> --scope <boundaries> [--user-authorization <quote>] [--acceptance-checks <checks>] [--expected-artifact <artifact>] <task>");
          }
          ctx.ui.notify(await delegatePeer(agent, parsed.words.join(" "), parsed.target, parsed.scope,
            parsed.userAuthorization, parsed.acceptanceChecks, parsed.expectedArtifact, parsed.delivery), "info");
        } else if (subcommand === "reply") {
          const [messageId, ...replyWords] = rest;
          const parsed = splitCommandDelivery(replyWords);
          ctx.ui.notify(await replyToMessage(messageId || "", parsed.words.join(" "), parsed.delivery), "info");
        } else if (subcommand === "inbox") {
          const messages = unreadMessages(await readState(), session);
          await markRead();
          const inboxText = renderInbox(messages);
          if (ctx.mode === "tui" && activeWidgetTui?.mode === "regular") showRegularNotice(ctx, inboxText, "info");
          else ctx.ui.notify(inboxText, "info");
        } else if (subcommand === "checkpoint") {
          if (!text) { ctx.ui.notify(session.checkpoint ? `Checkpoint: ${session.checkpoint.text}` : "No checkpoint saved.", "info"); return; }
          ctx.ui.notify(await saveCheckpoint(text), "info");
        } else if (subcommand === "remember") {
          if (!text.trim()) throw new Error("Usage: /team remember <fact or decision>");
          ctx.ui.notify(await saveFact(text), "info");
        } else if (subcommand === "history") {
          ctx.ui.notify(renderHistory(searchJournal(await readState(), session, text)), "info");
        } else {
          ctx.ui.notify("Usage: /team [focus|update|ask|delegate|steer|reply|inbox|checkpoint|remember|history] ...", "warning");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  // Durable, non-LLM summary card rendered in the TUI chat by /team.
  pi.registerEntryRenderer<{ lines: string[]; updatedAt: string }>(SUMMARY_TYPE, (entry, _options, theme) => {
    const data = entry.data ?? { lines: ["Team room"], updatedAt: now() };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", data.lines[0] ?? "Team room"), 0, 0));
    for (const line of data.lines.slice(1)) box.addChild(new Text(line, 0, 0));
    box.addChild(new Text(theme.fg("dim", `updated ${new Date(data.updatedAt).toLocaleTimeString()}`), 0, 0));
    return box;
  });
}
