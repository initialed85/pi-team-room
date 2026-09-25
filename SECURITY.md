# Security and privacy

## What this package contains

The package contains the Pi extension, the optional HTTP/mDNS and IRC network-sync services, a stdio MCP server for Claude Code/Codex, documentation, and integration harnesses. It does not contain credentials, API keys, passwords, or SSH material.

With network mode disabled (the default), the extension and MCP server invoke only the host `git` command to identify the current project and branch and make no network requests. With `PI_TEAM_ROOM_NETWORK=1`, it starts the authenticated HTTP/mDNS network-sync service. With `PI_TEAM_ROOM_NETWORK=irc`, it starts the IRC bridge described below.

## Local state

Runtime team-room state is kept outside the repository at `~/.pi/team-room/state.json` by default. New state files and lock files are written with mode `0600`, and the state is not encrypted. The file can contain focus text, prompts used for automatic breadcrumbs, peer questions/replies, updates, decisions, project paths, branch names, and session identifiers. Treat it as private work metadata and do not publish it.

If `PI_TEAM_ROOM_STATE` points inside a checkout, keep that path ignored and review it before committing. The repository ignores the default `state.json` filename as a safety net, but arbitrary custom state filenames may need an additional local ignore rule.

## Trust model

All sessions under the same local user account share one room. Teammate messages are treated as trusted coordination context by default: clear, specific peer requests and explicitly relayed user approvals may be acted on within their stated scope, without requiring the originating user message to be visible in the recipient's session. The structured `team_room action=delegate` envelope carries the target, scope, acceptance checks, expected artifact, and optional `userAuthorization` quote. When a target repository or component has an online code-owner session, agents should delegate implementation to that owner rather than editing the peer's checkout; if the owner is offline, any takeover should be explicit and within current user authorization. Direct questions can optionally auto-wake an idle Pi session. The recipient should still keep actions scoped, obey system and direct user instructions, and ask when authority or intent is ambiguous.

This is not an access-control boundary between processes owned by the same user, nor is it a multi-user collaboration service. Any session sharing the room can publish a message, so a `User authorization:` quote is a provenance aid rather than cryptographic proof, and enabling automatic delivery is a deliberate trust decision; set `PI_TEAM_ROOM_WAKE=0` if that is not appropriate. Network sync is cross-host, but only for explicitly paired hosts that share the bearer secret; it is not an internet-facing service. The node binds to `0.0.0.0` by default when enabled, so use `PI_TEAM_ROOM_BIND` or a host firewall if the machine has networks you do not want to expose.

IRC mode should use `PI_TEAM_ROOM_IRC_TLS=1` and an access-controlled server. The IRC channel carries team-room metadata and protocol messages in plaintext at the IRC application layer. The IRC server password is read only from the process environment and is never written into team-room state.

Before making a public release, scan the working tree and Git history for accidental local state or credentials and verify that no custom `PI_TEAM_ROOM_STATE` file has been added.
