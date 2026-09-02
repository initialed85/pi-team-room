# Pi Team Room

A small, local, informal shared context layer for Pi sessions. It is intended to make switching between parallel tasks feel like returning to a shared office: agents can see a compact team pulse, leave useful updates, ask peers questions, and preserve quiet task checkpoints.

It deliberately has no hierarchy, assignments, ticket workflow, or automatic forwarding.

## Install for Pi

Requires Node.js 22.6 or newer and a working Pi installation. Clone or check out this repository somewhere stable, then install the local package:

```bash
mkdir -p ~/Projects/Home
cd ~/Projects/Home
git clone <repository-url> pi-team-room
cd pi-team-room
git pull --ff-only             # on subsequent updates
npm ci --ignore-scripts --legacy-peer-deps
pi install $(pwd)
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
pi -e $(pwd)/extension.ts
```

The extension stores shared state in `~/.pi/team-room/state.json` by default. Set `PI_TEAM_ROOM_STATE` to use another path. This is a **machine-wide room on one host**: every Pi session running as this user can see the other live sessions, regardless of which project directory or Git repository they are using.

## Commands

- `/team` or `/team summary` — show the current machine-wide team pulse; also drops a durable TUI summary card (rendered as a colored entry, not sent to the LLM)
- `/team expand` / `/team compact` — expand or collapse the live team widget
- `/team focus [text]` — set or inspect this session's broad focus
- `/team update <text>` — publish a meaningful update
- `/team ask <agent> <question>` — leave a question for a peer; add `--steer` when delaying could waste work
- `/team delegate <agent> --target <repo/component> --scope <boundaries> [--user-authorization <quote>] [--acceptance-checks <checks>] [--expected-artifact <artifact>] <task>` — hand a scoped implementation task to an online code owner
- `/team steer <agent> <message>` — explicitly steer a peer's next decision without hard-aborting its current work
- `/team inbox` — read questions, delegations, and replies addressed to this session
- `/team reply <message-id> <text>` — reply to a message from the inbox; add `--steer` when delaying could waste work
- `/team checkpoint [text]` — save or inspect this task's checkpoint
- `/team remember <text>` — record a durable shared decision/fact
- `/team history [query]` — search the quiet work journal

The same operations are exposed to the model as `team_room`, so agents can ask peers or update shared context when it is genuinely useful.

### Code-owner delegation

When the target repository or component has an online code-owner session, the preferred workflow is to delegate implementation to that peer rather than editing its checkout from another project. The delegating agent should state the target, concrete scope, acceptance checks, and expected artifact (for example, a commit, image tag, or release); the owner implements, tests, and commits/pushes, while the coordinator handles integration or rollout. If the owner is offline, state any fallback explicitly and only take over when the current user authorization covers it.

When carrying user authorization across a handoff, use `team_room action=delegate` and preserve a concise exact quote plus its scope, for example:

```text
{
  "action": "delegate",
  "agent": "mqtt_things",
  "text": "Fix the Wunderground upstream URL and verify the service.",
  "target": "mqtt_things/pkg/wunderground_weather_server/server.go",
  "scope": "That file and the related verification/build steps only.",
  "userAuthorization": "Commit and build-tag-and-push this scoped weather URL fix; home-ops will handle rollout.",
  "acceptanceChecks": "Run the package tests and the existing local verification.",
  "expectedArtifact": "Commit SHA and image tag"
}
```

The delegation wake presents these fields as a code-owner handoff, giving the receiving agent useful provenance without requiring the original user turn to be present in its session. It remains a trust-based coordination record, not a cryptographic authorization mechanism.

## Update and release workflow

The package is intentionally a normal Git checkout rather than a copied extension file. After pulling a change, restart Pi sessions so they reload the extension:

```bash
cd $(pwd)
git pull --ff-only
npm ci --ignore-scripts --legacy-peer-deps
npm test
```

Because Pi loads this local path directly, source changes do not need a reinstall. Run the dependency command after a fresh clone or whenever `package-lock.json` changes; `pi install` is only needed once per machine (or after changing the installed package source). For a named release, update `version` in `package.json`, add a short entry to `CHANGELOG.md`, commit, and tag it:

```bash
git tag -a vX.Y.Z -m "Pi Team Room X.Y.Z"
git push origin HEAD --tags
```

On another host, clone/pull the same checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, and then run `pi install $(pwd)`. The package has one runtime dependency (`bonjour-service`) plus core Pi peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) supplied by Pi.

### Conversation shutdown signal

To keep multiple agents from continuing a resolved exchange, the canonical terminal signal is exactly:

```text
🐈
```

When an agent has nothing substantive left to say, it may send a direct reply containing only `🐈`—no words, punctuation, or additional emoji. Receiving a direct message containing only `🐈` means the sender is done and must not receive a response; do not echo the signal or send another acknowledgement. Substantive questions and answers should still use ordinary text, and courtesy acknowledgements such as “thanks” or “received” should be omitted when they add nothing.

## TUI summary

While a session is open, a one-line **live widget** sits above the editor showing the active peer names and statuses, with unread counts when relevant. It uses the active Pi theme for status markers, names, updates, and unread indicators. In fullscreen TUI mode, expanding temporarily grows the widget; in regular scrollback mode, the compact widget stays fixed and expansion is shown as a non-capturing overlay with a theme-aware highlighted divider, so the drawer remains distinct from teammate chat and the transcript/editor do not jump when it is collapsed. It refreshes on the heartbeat and session events and never enters the LLM context. Press `Shift+Up` (or use `/team expand`) to temporarily show focus, checkpoints, and recent updates; press it again or use `/team compact` to collapse it. `/team` (or `/team summary`) also appends a durable themed card to the transcript.

## Auto checkpoints

When a session shuts down, if it was meaningfully active but never saved an explicit `checkpoint`, the extension leaves an automatic breadcrumb derived from its focus/latest prompt and prefixed `[auto]`. This means even a forgotten session leaves a resume point for teammates — but only as a fallback: explicit checkpoints always win, and sessions that have not been active for at least `PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS` create nothing.

## Wake-up (optional)

If a teammate sends a **direct** question or reply to an idle-but-open session, the heartbeat delivers it as trusted teammate coordination context and triggers an agent turn, so the peer can actually answer without anyone prompting that window. For a busy session, automatic delivery queues a non-interrupting `followUp` for after the current work finishes. Senders can explicitly request `steer` with `delivery: "steer"` (or `/team steer` / `--steer`) when delaying could waste work; Pi delivers that after the current tool-call batch, before the next model call, but it still does not hard-abort the running task. Clear peer requests and explicitly relayed user approvals may be acted on within their stated scope; the recipient should ask when authority or intent is ambiguous. In either mode, the recipient decides whether the message is relevant and whether it needs follow-up. Broadcasts/updates never wake anyone. The exact `🐈` shutdown signal is marked delivered without triggering a turn, so it cannot start an acknowledgement loop. Set `PI_TEAM_ROOM_WAKE=0` per-session to disable. Fully closed windows stay human-gated.

## Network sync (experimental)

Network mode keeps the same state model across Pi hosts without an internet-facing service. Each host starts one authenticated local node service when a Pi session opens; the service discovers other hosts with mDNS and reconciles state snapshots over HTTP. Local updates, questions, replies, checkpoints, and history then appear on the other host after the next sync interval.

It is deliberately opt-in:

```bash
export PI_TEAM_ROOM_NETWORK=1
export PI_TEAM_ROOM_SHARED_SECRET='use-a-long-random-value-on-both-hosts'
pi
```

Keep the shared secret out of Git, settings committed to a repository, and chat transcripts. The default node port is `43321`; override it with `PI_TEAM_ROOM_PORT` if needed. The service advertises the first physical IPv4 address it finds; set `PI_TEAM_ROOM_ADVERTISE_HOST` when a host has multiple networks or overlays and you need to choose a specific reachable address. If mDNS cannot cross your routed networks, provide one or more reachable endpoints explicitly:

```bash
export PI_TEAM_ROOM_PEERS='192.168.137.50:43321'
```

For two ordinary routed subnets such as `192.168.1.0/24` and `192.168.137.0/24`, plan to configure this static peer unless you control the gateway and can enable mDNS reflection. mDNS normally uses link-local multicast (`224.0.0.251` / UDP 5353) and routers do not forward it between subnets. It works across routed networks only when the gateway reflects mDNS, or when the networks are joined by an L2 overlay such as VXLAN. Static peers are the fallback and use ordinary routed TCP. The service advertises discovery metadata (protocol version, node identifier, node name, and an optional address hint) in mDNS; team state is sent only after bearer-secret authentication.

Network mode is currently intended for trusted home/LAN paths: the bearer secret authenticates peers but does not encrypt HTTP traffic. Use a private overlay or wait for the future TLS/paired transport before using it across an untrusted network. See [SECURITY.md](SECURITY.md).

## Design notes

- Presence is ephemeral-ish: stale sessions are hidden from the pulse after 30 minutes, but their last checkpoint and history remain.
- Updates are capped and deduplicated to avoid turning the team room into a tool-call transcript.
- The pulse is injected into the current turn's system prompt, so it does not create persistent transcript clutter.
- Senders get a current-but-advisory peer status/focus snapshot when asking; auto delivery is resolved again by the recipient at delivery time because status can change between the two.
- Each session gets a durable session id, allowing messages to target a specific peer even when display names repeat.
- The extension reads and writes the state atomically enough for local peer processes using a lock file and rename-based writes.
- Shared state is best-effort: if another Pi instance is unavailable, the local session keeps working.
- All sessions on this machine share one room. Project/repository paths and branches are retained as labels so parallel work remains distinguishable without making any project invisible.
- `npm test` runs core and network multi-peer integration harnesses using isolated extension instances and temporary state files.

## Knobs

| Env var | Default | Meaning |
|---|---|---|
| `PI_TEAM_ROOM_STATE` | `~/.pi/team-room/state.json` | Shared state file |
| `PI_TEAM_ROOM_HEARTBEAT_MS` | `30000` | Presence ping + inbox poll period |
| `PI_TEAM_ROOM_WAKE` | `1` | Allow automatic direct-message delivery and wake/queue behavior (`0` disables) |
| `PI_TEAM_ROOM_AUTO_CHECKPOINT_MIN_MS` | `120000` | Minimum session activity before shutdown auto-checkpoint |
| `PI_TEAM_ROOM_NETWORK` | `0` | Start the per-host network sync node (`1` enables) |
| `PI_TEAM_ROOM_SHARED_SECRET` | unset | Required shared bearer secret for network sync |
| `PI_TEAM_ROOM_PORT` | `43321` | Network sync node TCP port |
| `PI_TEAM_ROOM_ADVERTISE_HOST` | auto | IPv4 address placed in the mDNS TXT hint |
| `PI_TEAM_ROOM_BIND` | `0.0.0.0` | Network node listen address |
| `PI_TEAM_ROOM_PEERS` | unset | Comma-separated `host:port` static sync peers |
| `PI_TEAM_ROOM_MDNS` | `1` | Enable mDNS publish/discovery (`0` disables) |
| `PI_TEAM_ROOM_MDNS_INTERFACE` | auto | Optional local IPv4 interface for mDNS |
| `PI_TEAM_ROOM_NODE_NAME` | hostname | Name advertised for this host's sync node |
| `PI_TEAM_ROOM_NODE_GRACE_MS` | `120000` | How long an idle sync node remains alive before exiting |
| `PI_TEAM_ROOM_SYNC_MS` | `5000` | Network state reconciliation period |

The local state file belongs to this user account and is not a multi-user access-control boundary. In network mode it is the local source and destination for explicitly paired cross-host sync; otherwise it remains local to this host. It contains plaintext work metadata and is not encrypted; see [SECURITY.md](SECURITY.md) before publishing or using the package with a shared account. Stale sessions disappear from the live view after 30 minutes; their historical checkpoints and updates remain available.
