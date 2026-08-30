# Pi Team Room

A small, local, informal shared context layer for Pi sessions. It is intended to make switching between parallel tasks feel like returning to a shared office: agents can see a compact team pulse, leave useful updates, ask peers questions, and preserve quiet task checkpoints.

It deliberately has no hierarchy, assignments, ticket workflow, or automatic forwarding.

## Install for Pi

Clone or check out this repository somewhere stable, then install the local package:

```bash
mkdir -p ~/Projects/Home
cd ~/Projects/Home
git clone <repository-url> pi-team-room
cd pi-team-room
git pull --ff-only             # on subsequent updates
pi install ~/Projects/Home/pi-team-room
```

For a direct development checkout, the package can also be referenced from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Projects/Home/pi-team-room"
  ]
}
```

Or test the extension directly:

```bash
pi -e ~/Projects/Home/pi-team-room/extension.ts
```

The extension stores shared state in `~/.pi/team-room/state.json` by default. Set `PI_TEAM_ROOM_STATE` to use another path. This is a **machine-wide room on one host**: every Pi session running as this user can see the other live sessions, regardless of which project directory or Git repository they are using.

## Commands

- `/team` or `/team summary` — show the current machine-wide team pulse; also drops a durable TUI summary card (rendered as a colored entry, not sent to the LLM)
- `/team focus [text]` — set or inspect this session's broad focus
- `/team update <text>` — publish a meaningful update
- `/team ask <agent> <question>` — leave a question for a peer
- `/team inbox` — read questions and replies addressed to this session
- `/team reply <message-id> <text>` — reply to a message from the inbox
- `/team checkpoint [text]` — save or inspect this task's checkpoint
- `/team remember <text>` — record a durable shared decision/fact
- `/team history [query]` — search the quiet work journal

The same operations are exposed to the model as `team_room`, so agents can ask peers or update shared context when it is genuinely useful.

## Update and release workflow

The package is intentionally a normal Git checkout rather than a copied extension file. After pulling a change, restart Pi sessions so they reload the extension:

```bash
cd ~/Projects/Home/pi-team-room
git pull --ff-only
npm test
```

Because Pi loads this local path directly, `git pull` is enough; `pi install` is only needed once per machine (or after changing the installed package source). For a named release, update `version` in `package.json`, add a short entry to `CHANGELOG.md`, commit, and tag it:

```bash
git tag -a v0.1.0 -m "Pi team-room 0.1.0"
git push origin main --tags
```

On another host, clone/pull the same checkout and run `pi install ~/Projects/Home/pi-team-room`. The package has no bundled runtime dependencies; Pi supplies its core peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`).

### Conversation shutdown signal

To keep multiple agents from continuing a resolved exchange, the canonical terminal signal is exactly:

```text
🐈
```

When an agent has nothing substantive left to say, it may send a direct reply containing only `🐈`—no words, punctuation, or additional emoji. Receiving a direct message containing only `🐈` means the sender is done and must not receive a response; do not echo the signal or send another acknowledgement. Substantive questions and answers should still use ordinary text, and courtesy acknowledgements such as “thanks” or “received” should be omitted when they add nothing.

## TUI summary

While a session is open, a compact **live widget** sits above the editor showing the current room: active peers, their focus, unread messages, and the latest teammate updates. It refreshes on the heartbeat and session events and never enters the LLM context. `/team` (or `/team summary`) also appends a durable themed card to the transcript.

## Auto checkpoints

When a session shuts down, if it was meaningfully active but never saved an explicit `checkpoint`, the extension leaves an automatic breadcrumb derived from its focus/latest prompt and prefixed `[auto]`. This means even a forgotten session leaves a resume point for teammates — but only as a fallback: explicit checkpoints always win, and barely-started sessions (`PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS` elapsed) create nothing.

## Wake-up (optional)

If a teammate sends a **direct** question or reply to an idle-but-open session, the heartbeat delivers it as an untrusted teammate message and triggers an agent turn, so the peer can actually answer without anyone prompting that window. Busy (mid-run) sessions are never interrupted, and broadcasts/updates never wake anyone. The exact `🐈` shutdown signal is marked delivered without triggering a turn, so it cannot start an acknowledgement loop. Set `PI_TEAM_ROOM_WAKE=0` per-session to disable. Fully closed windows stay human-gated.

## Design notes

- Presence is ephemeral-ish: stale sessions are hidden from the pulse after 30 minutes, but their last checkpoint and history remain.
- Updates are capped and deduplicated to avoid turning the team room into a tool-call transcript.
- The pulse is injected into the current turn's system prompt, so it does not create persistent transcript clutter.
- Each session gets a durable session id, allowing messages to target a specific peer even when display names repeat.
- The extension reads and writes the state atomically enough for local peer processes using a lock file and rename-based writes.
- Shared state is best-effort: if another Pi instance is unavailable, the local session keeps working.
- All sessions on this machine share one room. Project/repository paths and branches are retained as labels so parallel work remains distinguishable without making any project invisible.
- `npm test` runs a multi-peer integration harness using isolated extension instances and a temporary state file.

## Knobs

| Env var | Default | Meaning |
|---|---|---|
| `PI_TEAM_ROOM_STATE` | `~/.pi/team-room/state.json` | Shared state file |
| `PI_TEAM_ROOM_HEARTBEAT_MS` | `30000` | Presence ping + inbox poll period |
| `PI_TEAM_ROOM_WAKE` | `1` | Allow auto-wake turns for idle peers (`0` disables) |
| `PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS` | `120000` | Minimum session activity before shutdown auto-checkpoint |

The state file is local to this user account and is not intended as a multi-user coordination channel or cross-host transport. It contains plaintext work metadata and is not encrypted; see [SECURITY.md](SECURITY.md) before publishing or using the package with a shared account. Stale sessions disappear from the live view after 30 minutes; their historical checkpoints and updates remain available.
