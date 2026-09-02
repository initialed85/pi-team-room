import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, type TUI } from "@earendil-works/pi-tui";
import { type TObject, type TSchema, type Static, Type } from "typebox";

const STATE_ENV = "PI_TEAM_ROOM_STATE";
const DEFAULT_STATE_PATH = join(process.env.HOME ?? ".", ".pi", "team-room", "state.json");
const STALE_AFTER_MS = 30 * 60 * 1000;
const MAX_UPDATE_LENGTH = 500;
const MAX_CHECKPOINT_LENGTH = 2_000;
const MAX_PULSE_ITEMS = 8;
const MAX_HISTORY_ITEMS = 20;
const MAX_MESSAGES_PER_SESSION = 50;
const MAX_SESSIONS = 100;
const HEARTBEAT_MS = Number(process.env.PI_TEAM_ROOM_HEARTBEAT_MS) || 30_000;
const WAKE_ENABLED = process.env.PI_TEAM_ROOM_WAKE !== "0";
const WAKE_MIN_GAP_MS = 20_000;
const NETWORK_ENABLED = process.env.PI_TEAM_ROOM_NETWORK === "1";
const NETWORK_SERVICE_PATH = fileURLToPath(new URL("./network-service.mjs", import.meta.url));
const AUTO_CHECKPOINT_MIN_MS = (() => {
  const parsed = Number(process.env.PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
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
  text: Type.Optional(Type.String({ description: "Focus, update, question, delegated task, checkpoint, or fact text" })),
  agent: Type.Optional(Type.String({ description: "Peer session name for ask or delegate" })),
  target: Type.Optional(Type.String({ description: "Repository or component targeted by a delegated task" })),
  scope: Type.Optional(Type.String({ description: "Concrete boundaries of a delegated task" })),
  userAuthorization: Type.Optional(Type.String({ description: "Concise exact quote of the user's authorization, when applicable" })),
  acceptanceChecks: Type.Optional(Type.String({ description: "Tests or acceptance checks the code owner should perform" })),
  expectedArtifact: Type.Optional(Type.String({ description: "Expected handoff artifact, such as a commit, image tag, or release" })),
  messageId: Type.Optional(Type.String({ description: "Message id (or prefix) to reply to" })),
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
};

type TeamUpdate = {
  id: string;
  sessionId: string;
  sessionName: string;
  project: string;
  text: string;
  createdAt: string;
};

type JournalItem = {
  id: string;
  project: string;
  text: string;
  createdAt: string;
  sessionName: string;
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
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function projectLabel(project: string): string {
  const home = process.env.HOME;
  if (home && (project === home || project.startsWith(`${home}/`))) return `~${project.slice(home.length)}`;
  return project;
}

function statePath(): string {
  return process.env[STATE_ENV] || DEFAULT_STATE_PATH;
}

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

async function saveState(state: TeamRoomState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function withState<T>(fn: (state: TeamRoomState) => T | Promise<T>): Promise<T> {
  // Atomic rename prevents partial JSON reads. The lock is advisory and short-lived;
  // retrying makes simultaneous Pi processes unlikely to overwrite each other.
  const path = statePath();
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
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
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15 + attempt * 5));
    }
  }
  // A crashed process can leave a lock behind. Do not make the room take the
  // whole assistant down; best-effort operation is preferable to coordination
  // becoming an obstacle to ordinary work.
  return fn(await loadState());
}

async function updateState<T>(fn: (state: TeamRoomState) => T | Promise<T>): Promise<T> {
  return withState(async (state) => {
    const result = await fn(state);
    await saveState(state);
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
  return state.journal
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

function renderPulse(state: TeamRoomState, current: WorkSession): string {
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
      lines.push(`- ${peer.name} [${shortId(peer.id)}] (${peer.status}, ${projectLabel(peer.project)}): ${truncate(focus, 150)}`);
    }
  }

  if (updates.length > 0) {
    lines.push("", current.lastPulseAt ? "Since you were last here:" : "Recent teammate updates:");
    for (const update of updates.slice(0, 4)) lines.push(`- ${update.sessionName}: ${update.text}`);
  }
  if (messages.length > 0) {
    lines.push("", "New teammate messages:");
    for (const message of messages.slice(0, 4)) {
      lines.push(`- [${shortId(message.id)}] ${message.fromName}: ${message.text}${delegationInline(message)}`);
    }
    if (messages.length > 4) lines.push(`- … and ${messages.length - 4} more; use team_room action=inbox.`);
  }
  const journal = recentJournal(state, current);
  if (journal.length > 0) {
    lines.push("", "Recent shared decisions/history:");
    for (const item of journal) lines.push(`- ${item.sessionName} [${projectLabel(item.project)}]: ${item.text}`);
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
      const header = `[${message.kind} ${shortId(message.id)}] ${message.fromName}: ${message.text}`;
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
  let deliveryInFlight = false;
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
  const regularOverlayComponents = new Set<unknown>();
  let restoreRegularOverlayPatch: (() => void) | undefined;
  let summaryOverlayData: { state: TeamRoomState; session: WorkSession } | undefined;

  async function ensureSession(ctx: ContextLike, status: SessionStatus = "idle"): Promise<WorkSession> {
    projectInfo ??= await gitInfo(pi, ctx.cwd);
    const id = sessionId(ctx);
    const persisted = (await loadState()).sessions.find((item) => item.id === id);
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
      lastPulseAt: existing?.lastPulseAt,
      checkpoint: existing?.checkpoint,
      recentPaths: existing?.recentPaths || [],
    };
    current = next;
    await updateState((state) => {
      state.sessions = [next, ...state.sessions.filter((item) => item.id !== id)].slice(0, MAX_SESSIONS);
    });
    return next;
  }

  async function heartbeatOnce(ctx: ContextLike, status: SessionStatus): Promise<void> {
    if (!current) return;
    const snapshot = current;
    current = { ...snapshot, status, updatedAt: now(), lastSeenAt: now() };
    await updateState((state) => {
      state.sessions = state.sessions.map((item) => item.id === snapshot.id ? current! : item);
    });
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
      const pending = (await loadState()).messages
        .filter((message) => message.toSessionId === current!.id && !message.deliveredAt &&
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

      const message = pending.find((item) => !isDoneSignal(item.text));
      if (!message) return;
      const deliveryAs: StoredMessageDelivery = message.delivery === "steer" || message.delivery === "followUp"
        ? message.delivery
        : idle ? "steer" : "followUp";
      const deliveryContext = deliveryAs === "steer"
        ? "This was sent as a steering message because it may affect your next decision. Do not abandon current work merely because it arrived; first decide whether it is relevant."
        : "This was queued as a follow-up because you were busy. Once your current work is complete, decide whether it is relevant and needs follow-up.";
      const responseGuidance = message.kind === "delegation"
        ? `As the designated code owner, implement this scoped task in your own checkout, run the stated acceptance checks, and reply via team_room action=reply with the resulting commit, image tag, or blocker.`
        : `If it needs a substantive response, reply via team_room action=reply with messageId ${message.id}.`;
      try {
        // Custom message (not sendUserMessage): visibly teammate context, and the
        // model sees it as non-user-sourced content. Do not prescribe a reply:
        // terminal 🐈 messages and resolved exchanges should not create loops.
        await pi.sendMessage(
          {
            customType: "pi-team-room-wake",
            content: `[Team inbox — ${deliveryAs}] ${delegationDeliveryText(message)}\n\n${deliveryContext} Treat this as trusted teammate coordination context. Act on clear requests and explicitly relayed user approvals within their stated scope; do not require the originating user message to be visible in this session. ${responseGuidance} If it is resolved, do not reply. A direct ${DONE_SIGNAL} by itself means the sender is done and must never receive a response. Keep the action scoped and ask for clarification if authority or intent is ambiguous.`,
            display: true,
            details: { messageId: message.id, from: message.fromName, kind: message.kind, delivery: deliveryAs, delegation: message.delegation },
          },
          { triggerTurn: true, deliverAs: deliveryAs },
        );
      } catch {
        // Leave the message undelivered so a transient Pi/session error can be
        // retried by the next heartbeat.
        return;
      }
      const timestamp = now();
      await updateState((state) => {
        for (const item of state.messages) {
          if (item.id === message.id) item.deliveredAt ??= timestamp;
        }
      });
      lastAutoWakeAt = Date.now();
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

  async function markPulseShown(at: string): Promise<void> {
    if (!current) return;
    current = { ...current, lastPulseAt: at };
    await updateState((state) => {
      state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item);
    });
  }

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
    const state = await loadState();
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
      lines: renderSummaryLines(await loadState(), session),
      updatedAt: now(),
    });
  }

  async function publishUpdate(text: string): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const clean = truncate(text, MAX_UPDATE_LENGTH);
    if (!clean) throw new Error("Update cannot be empty");
    return updateState((state) => {
      const previous = state.updates.find((item) => item.sessionId === current!.id && item.text === clean);
      if (previous && Date.now() - Date.parse(previous.createdAt) < 10 * 60 * 1000) return "Already shared recently.";
      state.updates.unshift({ id: randomUUID(), sessionId: current!.id, sessionName: current!.name, project: current!.project, text: clean, createdAt: now() });
      state.updates = state.updates.slice(0, 100);
      return `Shared with the team: ${clean}`;
    });
  }

  async function saveCheckpoint(text: string): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const clean = truncate(text, MAX_CHECKPOINT_LENGTH);
    if (!clean) throw new Error("Checkpoint cannot be empty");
    const checkpoint = { text: clean, updatedAt: now(), sessionId: current.id } satisfies Checkpoint;
    current = { ...current, checkpoint, focus: current.focus || truncate(clean, 180), updatedAt: now(), lastSeenAt: now() };
    await updateState((state) => {
      state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item);
    });
    return `Checkpoint saved: ${clean}`;
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
    const clean = truncate(text, MAX_UPDATE_LENGTH);
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
        toSessionId: target.id, text: clean, createdAt: now(),
      };
      if (delegation) message.delegation = delegation;
      if (delivery !== "auto") message.delivery = delivery;
      state.messages.push(message);
      state.messages = state.messages.slice(-MAX_MESSAGES_PER_SESSION * MAX_SESSIONS);
      const focus = target.focus || target.checkpoint?.text || "no focus recorded";
      const recommendation = target.status === "working" ? "followUp" : "steer";
      const selected = delivery === "auto" ? `${recommendation} (auto)` : delivery;
      const label = kind === "delegation" ? "Delegation sent" : "Question sent";
      const details = delegation ? ` [target: ${delegation.target}; scope: ${delegation.scope}]` : "";
      return `${label} to ${target.name} [${target.status}; focus: ${truncate(focus, 120)}; delivery: ${selected}]${details}: ${clean}`;
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
    const cleanTarget = truncate(target, 180);
    const cleanScope = truncate(scope, MAX_UPDATE_LENGTH);
    if (!cleanTarget || !cleanScope) throw new Error("Delegation requires target and scope");
    const details: DelegationDetails = { target: cleanTarget, scope: cleanScope };
    const optional = (value: string | undefined, max: number): string | undefined => {
      const clean = value?.trim();
      return clean ? truncate(clean, max) : undefined;
    };
    const cleanAuthorization = optional(userAuthorization, MAX_UPDATE_LENGTH);
    const cleanAcceptance = optional(acceptanceChecks, MAX_UPDATE_LENGTH);
    const cleanArtifact = optional(expectedArtifact, 180);
    if (cleanAuthorization) details.userAuthorization = cleanAuthorization;
    if (cleanAcceptance) details.acceptanceChecks = cleanAcceptance;
    if (cleanArtifact) details.expectedArtifact = cleanArtifact;
    return sendPeerMessage("delegation", agent, task, requestedDelivery, details);
  }

  async function replyToMessage(messageId: string, text: string, requestedDelivery: MessageDelivery = "auto"): Promise<string> {
    if (!current) throw new Error("Team room session is not ready");
    const cleanId = messageId.trim().toLowerCase();
    const clean = truncate(text, MAX_UPDATE_LENGTH);
    const delivery = normalizeDelivery(requestedDelivery);
    if (!cleanId || !clean) throw new Error("Reply requires a message id and text");
    return updateState((state) => {
      const original = state.messages.find((item) => item.toSessionId === current!.id &&
        (item.id.toLowerCase() === cleanId || item.id.toLowerCase().startsWith(cleanId)));
      if (!original) return `No message matching ${messageId} found in your inbox.`;
      if (isDoneSignal(original.text)) return `That message is a terminal ${DONE_SIGNAL} signal; do not reply to it.`;
      const target = state.sessions.find((item) => item.id === original.fromSessionId);
      const message: TeamMessage = {
        id: randomUUID(), kind: "reply", fromSessionId: current!.id, fromName: current!.name,
        toSessionId: original.fromSessionId, replyToId: original.id, text: clean, createdAt: now(),
      };
      if (delivery !== "auto") message.delivery = delivery;
      state.messages.push(message);
      state.messages = state.messages.slice(-MAX_MESSAGES_PER_SESSION * MAX_SESSIONS);
      const targetStatus = target?.status || "unknown";
      const targetFocus = target?.focus || target?.checkpoint?.text || "focus unavailable";
      const recommendation = target?.status === "working" ? "followUp" : "steer";
      const selected = delivery === "auto" ? `${recommendation} (auto)` : delivery;
      return `Reply sent to ${original.fromName} [${targetStatus}; focus: ${truncate(targetFocus, 120)}; delivery: ${selected}]: ${clean}`;
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
    startNetworkService();
    await refreshWidget(ctx);
    heartbeat = setInterval(() => {
      // Heartbeat work is best-effort. A session can shut down while one of
      // these asynchronous state operations is in flight; do not turn that
      // expected race into an unhandled rejection.
      void heartbeatOnce(ctx, ctx.isIdle() ? "idle" : "working").catch(() => undefined);
      void deliverPendingMessages(ctx).catch(() => undefined);
      void refreshWidget(ctx).catch(() => undefined);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (!current) return;
    current = { ...current, name: sessionName(ctx, current.name), updatedAt: now(), lastSeenAt: now() };
    await updateState((state) => { state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item); });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const session = await ensureSession(ctx, "working");
    const state = await loadState();
    const pulse = renderPulse(state, session);
    const checkpoint = session.checkpoint ? `\n\nYour current checkpoint:\n- ${session.checkpoint.text}` : "";
    const pulseAt = now();
    await markPulseShown(pulseAt);
    return {
      // Use the system prompt rather than a persistent custom message: the
      // pulse is ambient state for this turn, not another transcript entry.
      systemPrompt: `${event.systemPrompt}\n\n## Shared team room\n${pulse}${checkpoint}\n\n${TEAM_ROOM_PROTOCOL} Use team_room only for meaningful updates, questions, replies, checkpoints, decisions, or relevant history. Do not narrate routine file edits or test runs.`,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (current) {
      await heartbeatOnce(ctx, "idle");
      await refreshWidget(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (current) {
      const snapshot = { ...current, status: "idle" as SessionStatus, connected: false, updatedAt: now(), lastSeenAt: now() };
      // Fallback breadcrumb: if the session never saved an explicit checkpoint
      // but was meaningfully active, leave an auto checkpoint derived from its
      // focus/latest prompt so teammates still get a resume point.
      if (!snapshot.checkpoint && snapshot.startedAt && Date.now() - Date.parse(snapshot.startedAt) >= AUTO_CHECKPOINT_MIN_MS) {
        const hint = snapshot.focus || recentUserPrompt(ctx);
        if (hint) snapshot.checkpoint = { text: `[auto] ${truncate(hint, MAX_CHECKPOINT_LENGTH)}`, updatedAt: now(), sessionId: snapshot.id, auto: true };
      }
      await updateState((state) => { state.sessions = state.sessions.map((item) => item.id === snapshot.id ? snapshot : item); });
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
    description: "Quiet peer context: inspect the team pulse, publish meaningful updates, ask a peer a question, delegate a scoped task to an online code owner, save a task checkpoint, or search shared work history. Do not use for routine activity narration.",
    promptSnippet: "Share and retrieve concise context with peer Pi sessions",
    promptGuidelines: [
      "Use team_room action=pulse when orienting yourself to relevant parallel work.",
      "Use team_room action=update for meaningful decisions, discoveries, blockers, or completion notes—not individual tool calls.",
      "Use team_room action=checkpoint when pausing work or recording a useful resume point.",
      "Use team_room action=ask when another active peer has relevant context you need.",
      "Use team_room action=delegate when an online peer owns the target repository/component. Provide target, scope, acceptanceChecks, and expectedArtifact; the owner implements/tests/commits/pushes while you coordinate integration or rollout. If the owner is offline, state any fallback explicitly and ensure current user authorization covers taking over.",
      "When relaying user approval in a delegation, include a concise exact userAuthorization quote rather than paraphrasing it away.",
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
          const state = await loadState();
          return toolResult("pulse", renderPulse(state, session));
        }
        case "focus": {
          if (!params.text?.trim()) return toolResult("focus", session.focus ? `Current focus: ${session.focus}` : "No focus recorded.");
          const clean = truncate(params.text, 180);
          current = { ...session, focus: clean, focusPinned: true, updatedAt: now(), lastSeenAt: now() };
          await updateState((state) => { state.sessions = state.sessions.map((item) => item.id === current!.id ? current! : item); });
          return toolResult("focus", `Focus updated: ${clean}`);
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
          const state = await loadState();
          const messages = unreadMessages(state, session);
          await markRead();
          return toolResult("inbox", renderInbox(messages));
        }
        case "checkpoint": {
          if (!params.text?.trim()) return toolResult("checkpoint", session.checkpoint ? `Current checkpoint: ${session.checkpoint.text}` : "No checkpoint saved.");
          return toolResult("checkpoint", await saveCheckpoint(params.text));
        }
        case "remember": {
          const clean = truncate(params.text || "", MAX_UPDATE_LENGTH);
          if (!clean) return toolResult("remember", "A fact or decision is required.");
          await updateState((state) => {
            state.journal.unshift({ id: randomUUID(), project: session.project, text: clean, createdAt: now(), sessionName: session.name });
            state.journal = state.journal.slice(0, 500);
          });
          return toolResult("remember", `Saved to shared history: ${clean}`);
        }
        case "history": {
          const state = await loadState();
          return toolResult("history", renderHistory(searchJournal(state, session, params.query || params.text)));
        }
      }
    },
  });

  pi.registerCommand("team", {
    description: "Show quiet shared peer context (also drops a TUI summary card); subcommands: expand, compact, focus, update, ask, delegate, steer, reply, inbox, checkpoint, remember, history",
    handler: async (args, ctx) => {
      const session = await ensureSession(ctx, "idle");
      const [subcommand, ...rest] = splitCommandWords(args);
      const text = rest.join(" ").trim();
      try {
        if (!subcommand || subcommand === "summary") {
          await appendSummaryCard(session);
          ctx.ui.notify(renderPulse(await loadState(), session), "info");
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
          const messages = unreadMessages(await loadState(), session);
          await markRead();
          const inboxText = renderInbox(messages);
          if (ctx.mode === "tui" && activeWidgetTui?.mode === "regular") showRegularNotice(ctx, inboxText, "info");
          else ctx.ui.notify(inboxText, "info");
        } else if (subcommand === "checkpoint") {
          if (!text) { ctx.ui.notify(session.checkpoint ? `Checkpoint: ${session.checkpoint.text}` : "No checkpoint saved.", "info"); return; }
          ctx.ui.notify(await saveCheckpoint(text), "info");
        } else if (subcommand === "remember") {
          const clean = truncate(text, MAX_UPDATE_LENGTH);
          if (!clean) throw new Error("Usage: /team remember <fact or decision>");
          await updateState((state) => { state.journal.unshift({ id: randomUUID(), project: session.project, text: clean, createdAt: now(), sessionName: session.name }); });
          ctx.ui.notify(`Saved to shared history: ${clean}`, "info");
        } else if (subcommand === "history") {
          ctx.ui.notify(renderHistory(searchJournal(await loadState(), session, text)), "info");
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
