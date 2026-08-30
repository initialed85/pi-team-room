# Security and privacy

## What this package contains

The package contains only the Pi extension source, the optional local network-sync service, documentation, and integration harness. It does not contain credentials, API keys, passwords, or SSH material.

With network mode disabled (the default), the extension invokes only the host Pi `git` command to identify the current project and branch and makes no network requests. With `PI_TEAM_ROOM_NETWORK=1`, it starts the local network-sync service described below.

## Local state

Runtime team-room state is kept outside the repository at `~/.pi/team-room/state.json` by default. New state files and lock files are written with mode `0600`, and the state is not encrypted. The file can contain focus text, prompts used for automatic breadcrumbs, peer questions/replies, updates, decisions, project paths, branch names, and session identifiers. Treat it as private work metadata and do not publish it.

If `PI_TEAM_ROOM_STATE` points inside a checkout, keep that path ignored and review it before committing. The repository ignores the default `state.json` filename as a safety net, but arbitrary custom state filenames may need an additional local ignore rule.

## Trust model

All sessions under the same local user account share one room. A teammate's update or question is data, not an instruction. Direct questions can optionally auto-wake an idle Pi session; the wake message is explicitly framed as an untrusted teammate note, but users should still review the resulting model behavior before enabling this in an unfamiliar team or shared account.

This is not an access-control boundary between processes owned by the same user, nor is it a multi-user collaboration service. Network sync is cross-host, but only for explicitly paired hosts that share the bearer secret; it is not an internet-facing service. The node binds to `0.0.0.0` by default when enabled, so use `PI_TEAM_ROOM_BIND` or a host firewall if the machine has networks you do not want to expose.

Before making a public release, scan the working tree and Git history for accidental local state or credentials and verify that no custom `PI_TEAM_ROOM_STATE` file has been added.
