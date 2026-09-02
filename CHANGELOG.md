# Changelog

## Unreleased

- Treat teammate messages as trusted coordination context by default, including clear peer requests and explicitly relayed user approvals within their stated scope.
- Add structured `team_room action=delegate` handoffs with target, scope, user-authorization quote, acceptance checks, and expected artifact; online code owners implement, test, and commit/push while coordinating agents handle integration or rollout.
- Keep regular-mode expansion and regular `/team inbox` feedback in transient overlays, trim their viewport padding, and preserve the live widget row so they never reflow terminal scrollback.
- Recompute regular overlay placement as autocomplete grows, keep the autocomplete list visible, and clean up rows when it shrinks again.
- Retry failed idle-peer wake delivery and treat manual inbox inspection as delivery to avoid duplicate wakeups.
- Queue direct messages for busy peers as follow-ups by default, with explicit sender-requested steering and recipient-side relevance guidance.
- Add a theme-aware highlighted separator to expanded team-room drawers so they remain distinct from teammate chat messages.
- Experimental opt-in cross-host sync node with authenticated HTTP reconciliation, mDNS discovery, and static peer fallback for routed networks.
- Network integration tests covering authentication, state merging, and private state-file permissions.

## [0.1.0] — 2026-08-30

Initial local release of Pi Team Room:

- Machine-wide presence and focus across project directories on one host.
- Prompt-boundary team pulses and searchable shared history.
- Peer questions, replies, inboxes, and optional idle-session wake-up.
- Explicit and automatic shutdown checkpoints.
- Live TUI widget and durable `/team` summary cards.
- Terminal `🐈` acknowledgement protocol to prevent reply loops.
- Multi-peer integration harness covering cross-project visibility and coordination behavior.
