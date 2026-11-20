# Changelog

## [Unreleased]

- **Room records are clipped in the middle, and the writer is told.** A checkpoint or durable fact
  over its cap used to be cut from the front and saved anyway, with a plain `Checkpoint saved` in
  reply - so the resume instruction, which is the last line people write, was the first thing
  deleted, and a note recording a cross-repo contract was chopped at the 500-character status-update
  cap. Over-cap records now keep their head and their tail with a visible
  ` [...N chars omitted...] ` seam, are stored marked `clipped`, and the result names the lost length
  and the cap. Facts get their own 2,000-character budget instead of sharing a status line's.
  Regression coverage asserts the tail survives, the seam and the `clipped` flag are stored, an
  in-budget fact is kept whole, and reverting to front-clipping fails the suite.
- **The appended room context is delivered only when it says something new.** The pulse is a hidden
  transcript entry, so every turn's copy stays in the model's context for the rest of the session:
  one measured build carried 64,901 characters of room context over 31 turns, and a 2,000-character
  checkpoint was re-sent verbatim every turn whether or not it had moved. A turn whose pulse is
  byte-identical to the one already in context now returns the stable system prompt and appends
  nothing; a checkpoint that has not moved since it was last shown becomes a one-line pointer. A new
  checkpoint, or a compaction (which removed the earlier copy from context), restates both in full.
  Regression coverage asserts the quiet turn appends nothing, a moved checkpoint is shown in full, an
  unchanged one is not repeated, and a compaction restates it.
- Keep volatile pulse data out of the per-turn system prompt. The static room protocol remains in the system prompt, while the current pulse is delivered as hidden appended turn context so peer status, membership, checkpoints, and messages cannot invalidate the reusable provider prefix. Regression coverage asserts that dynamic pulse content is absent from the system prompt and remains available in the appended context.
- Each session now **owns a lane** and is the tiebreaker inside it. Ownership shows as `owns:` in the
  pulse, on every send confirmation, and on every delivered message; it defaults to the part of the
  session name that is not just its project (`life-agent-finance` in `~/Projects/Home/life` owns
  `finance`) because several sessions routinely share one checkout, and it can be declared with
  `/team owns <lane>` or `team_room action=focus owns=<lane>`. The protocol says a non-owner accepts
  an owned result or raises one specific falsifiable defect rather than re-deriving it, so a
  coordinating session that owns no lane is never the tiebreaker for someone else's.
- **Reply chains are depth-capped, throttling the wake rather than the message.** Two agents could
  turn one finding into an all-night correspondence: every link is individually defensible, so no
  "reply once" rule ever fired, and every link woke the other side. Replies are now stamped one
  deeper than the message they answer at send time (so the count survives its own ancestors being
  pruned); at `PI_TEAM_ROOM_THREAD_SOFT_DEPTH` (3) a thread may no longer interrupt and an explicit
  `steer` is downgraded to a `followUp`, and at `PI_TEAM_ROOM_THREAD_HARD_DEPTH` (5) it stops waking
  the recipient at all. Nothing is dropped at any depth: a capped reply is still stored, still in the
  inbox, still in the pulse. The sender is told which of those happened, because a sender that
  believes it interrupted a peer will otherwise keep sending.
- A plain **reply to an idle peer is now a `followUp` rather than a `steer`**. A reply continues an
  exchange the recipient already chose to engage with, so the next round is not a blocker; a question
  or delegation, which is new work, still steers an idle peer immediately.
- Prompt rules for the above, the sharpest being **agreement is not news**: a message whose payload is
  confirmation, reproduction, praise, or a refinement that changes no decision is not worth a turn of
  someone else's attention. Incoming messages carry `owns:` and `thread: N deep` so the recipient can
  see whose call it is and whether the exchange has stopped converging.
- Regression tests cover lane derivation from a shared checkout, declared ownership, depth stamping
  across alternating senders, the steer downgrade at the soft cap, the no-wake cap, and that a capped
  reply is still stored and still readable in the inbox.

- Undirected broadcast is now opt-in. Peer focus (which Pi infers from the latest user prompt),
  published `update`s, and the shared journal had been folded into every session's turn-start system
  prompt, which made parallel agents react to each other's work instead of their own. That push is
  off unless a session sets `PI_TEAM_ROOM_BROADCAST=1`. Directed coordination (`ask`/`delegate`/
  `reply`), this session's own checkpoint, and explicit pulls (`team_room action=pulse`, `/team
  summary`, `inbox`, `history`) are unchanged; a turn start while broadcast is off still lists which
  peers are reachable and any unread messages.
- `team_room action=update` is refused while broadcast is off (`Broadcasts are off ...`) instead of
  writing an update no peer will be shown, and the tool description and prompt guidelines no longer
  invite ambient updates in that mode. The team-room viewer's vocabulary knows the new refusal.
- Regression tests cover the default-off push: a turn start carries neither peer focus nor peer
  updates, an explicit pulse still reads them, and `update` is refused.

## [0.1.2] — 2026-10-29

Fixes in this release, then the items that had been sitting under Unreleased and are released with it.

- Direct messages are near-immediate. Presence, the widget, and summaries stay on a 15-second clock
  (`PI_TEAM_ROOM_HEARTBEAT_MS`, was 30), while message delivery polls on its own inbox clock
  (`PI_TEAM_ROOM_INBOX_MS`, default 1s) and the automatic wake gap drops to 1s
  (`PI_TEAM_ROOM_WAKE_MIN_GAP_MS`). A queued burst now arrives as one wake turn carrying every pending
  message instead of one interruption per message.
- State writes no longer fall back to an unlocked blind write when the advisory lock stays contended:
  the write raises instead, and a session tracks which wakes it already pushed so a failed delivery
  stamp cannot wake the same peer twice. Lock retries are capped and short, and a lock left behind by a
  killed peer is reclaimed after 15 seconds.

- Long teammate messages are no longer silently truncated. `ask`, `reply`, and `delegate` payloads
  (task, scope, user-authorization quote, acceptance checks, expected artifact) had been normalized
  through the one-line status-update cap, so any brief over 500 characters reached the recipient cut
  at 499 characters plus an ellipsis, with paragraph breaks flattened into spaces. Peer messages now
  keep their paragraph breaks and get their own budgets: 6,000 characters of message text and 3,000
  per delegation field. Status updates, checkpoints, and journal lines stay single-line and capped as
  before, and pulse lines plus send confirmations are explicit display previews that say how long the
  full message was.
- Confirmations now report the new message id and echo a preview rather than the whole payload, so a
  long brief is not paid for twice in the sender's transcript.
- Shared state keeps a bounded message budget (`200,000` characters of stored message text, oldest
  dropped first) so longer briefs cannot grow the state file without limit.
- Test harnesses run again against the managed Pi install layout. `pi` on PATH is a launcher script,
  not a symlink into the release, so the harness's `<launcher>/../../node_modules` guess resolved to
  `~/.pi/node_modules` and every `npm test` died with `ERR_MODULE_NOT_FOUND` for `jiti`. The harness
  now resolves `~/.pi/agent/install/releases/<version>/node_modules` (honoring
  `PI_MANAGED_INSTALL_ROOT`, or `PI_TEAM_ROOM_TEST_NODE_MODULES` to override) and fails with an
  actionable message instead.
- Regression tests cover verbatim long-brief storage, paragraph preservation, wake delivery carrying
  the tail, bounded pulse/confirmation rendering, and the cap being announced rather than silent.
- Process note: `v0.1.1` was tagged while `package.json` still read `0.1.0`. `RELEASE.md` step 3 is
  now explicit about verifying the version matches the tag being created.

### Previously listed as Unreleased

- Treat teammate messages as trusted coordination context by default, including clear peer requests and explicitly relayed user approvals within their stated scope.
- Add structured `team_room action=delegate` handoffs with target, scope, user-authorization quote, acceptance checks, and expected artifact; online code owners implement, test, and commit/push while coordinating agents handle integration or rollout.
- Keep regular-mode expansion and regular `/team inbox` feedback in transient overlays, trim their viewport padding, and preserve the live widget row so they never reflow terminal scrollback.
- Recompute regular overlay placement as autocomplete grows, keep the autocomplete list visible, and clean up rows when it shrinks again.
- Retry failed idle-peer wake delivery and treat manual inbox inspection as delivery to avoid duplicate wakeups.
- Queue direct messages for busy peers as follow-ups by default, with explicit sender-requested steering and recipient-side relevance guidance.
- Add a theme-aware highlighted separator to expanded team-room drawers so they remain distinct from teammate chat messages.
- Experimental opt-in cross-host sync node with authenticated HTTP reconciliation, mDNS discovery, and static peer fallback for routed networks.
- Network integration tests covering authentication, state merging, and private state-file permissions.
- Automatic private SQLite projections of persisted Pi session JSONL, plus `pi-team-history` indexing, timestamp pruning, multi-session timeline materialization, and SQL querying.

## [0.1.0] — 2026-08-30

Initial local release of Pi Team Room:

- Machine-wide presence and focus across project directories on one host.
- Prompt-boundary team pulses and searchable shared history.
- Peer questions, replies, inboxes, and optional idle-session wake-up.
- Explicit and automatic shutdown checkpoints.
- Live TUI widget and durable `/team` summary cards.
- Terminal `🐈` acknowledgement protocol to prevent reply loops.
- Multi-peer integration harness covering cross-project visibility and coordination behavior.
