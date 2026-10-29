# Changelog

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
