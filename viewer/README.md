# Team room viewer

A local chat client for what the team room actually did. It reads the Pi session
transcripts (`~/.pi/agent/sessions/*/**.jsonl`) and merges them with the room's own state
(`~/.pi/team-room/state.json`) into conversations, so agent-to-agent behaviour can be read
as messages instead of grepped out of JSONL.

It exists because the room's failures are invisible in a transcript. A `team_room` call that
the room refused writes a sentence, not an error, so `isError` stays false and the agent
moves on. Repeated sends, replies aimed at message ids that never existed, and asks to peers
who are not in the room all look like normal tool traffic until you put them side by side.

Both sides of a send live in different files. The sender's transcript has the call and the
room's confirmation; the receiver's has a wake message that carries the same text with no id
at all; `state.json` has the id, the reply link and the read receipt, but only for the last
few dozen messages. Merging them is the whole point of this viewer, and it keeps provenance
on every bubble: `call`, `wake`, `state`. A message seen from one side only is labelled as
such rather than quietly dropped.

## Run

```bash
cd viewer
go run . --addr 127.0.0.1:18787
```

Options:

| flag | default | what it does |
| --- | --- | --- |
| `--addr` | `127.0.0.1:8787` | listen address |
| `--sessions` | `~/.pi/agent/sessions` | transcript tree to index |
| `--state` | `~/.pi/team-room/state.json` | room state to merge |
| `--interval` | `1.2s` | how often the tree is rescanned |

Nothing is written anywhere. The viewer only reads.

Scanning is incremental: each file is remembered by offset, so a refresh reads only the
lines appended since the last one, and 120+ transcripts index in milliseconds. A file that
shrinks is treated as rewritten and re-read from the start.

## What you get

**Chats** groups by participant set, so a round trip that spread over three sessions and
twenty tool calls stays one conversation. **Sessions** is the same messages grouped by the
literal session pair, which is what you want when chasing a stale session id. **Room feed**
is the broadcast side: updates, checkpoints, focus, journal.

Every chat is linkable. The URL carries the open chat, the filter and `live=0` for a static
render, so an anomaly can be pasted into a message.

The alert strip along the top is the diagnostics, and it is deliberately blunt:

- `tester-1 sent the same reply 31 times in 9m - and the room rejected every one of them` —
  identical normalised text from one actor, three or more times. Reads (`pulse`, `history`,
  `inbox`) are excluded: the same answer to the same question twice is the room being
  consistent, not an agent looping.
- `the room rejected 85 sends: 44 × the message id did not match anything in the room` —
  refusals counted by cause, using the room's own wording.
- `35 replies quote something that is not a message id: 25 × pasted conversation text into
  messageId` — what agents actually put in `messageId` when they did not have an id.
- `146 of 419 messages are only visible from one side (the room record aged out)`.
- `166 targets inferred` — how many recipients the viewer worked out for itself (from a
  reply link, or the wake that prompted the send) rather than reading off a record. Every
  inferred link in the UI is labelled as inferred.

## Tests

```bash
cd viewer && go test .
```

`fixture_test.go` writes a small room from scratch — two sessions, batch and single wakes, a
delegation, a self-addressed reply, a peer that does not exist, a send the room forgot to
record — and asserts the merged result, so nothing here depends on how much transcript
history a given machine happens to have kept.

`unit_test.go` covers the parts that are judgement calls, and one of them is a contract with
the extension: it reads `../extension.ts`, pulls out every sentence the room can return, and
fails if the viewer's vocabulary does not recognise all of them. Add a refusal to the
extension and the viewer has to be told about it, rather than silently reading it as a
successful send.
