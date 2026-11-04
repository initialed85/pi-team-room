package main

// A hermetic miniature of the room.
//
// Everything the viewer reads is written here in the shapes the real extension writes,
// checked against the live transcripts first: a session header, a session_info rename,
// an assistant toolCall block, the toolResult that confirms it, and a pi-team-room-wake
// custom_message on the receiving side. No real transcript content is in here, so these
// tests state what the viewer promises without depending on Ed's history.
//
// The fixture deliberately contains the awkward cases the viewer exists for: a refusal
// the room reported in plain prose without setting isError, a reply whose messageId is
// a sentence, a loop of identical retries, a send aimed at the sender's own name, a
// peer that is not in the room, a wake whose format changed mid-history, and a send the
// room's own record has already aged out.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	fixtureAlpha = "01a1b000-0000-7000-8000-000000000aaa"
	fixtureBeta  = "01a1b000-0000-7000-8000-000000000bbb"

	askID      = "a1a1a101-0000-4000-8000-000000000001"
	replyID    = "b2b2b202-0000-4000-8000-000000000002"
	delegateID = "c3c3c303-0000-4000-8000-000000000003"

	proseRef = "the earlier note about the fixture gate passing on master"
	notAnID  = "not-an-id"

	loopText = "Verdict for the fixture: the gate passes, the suite is green, nothing else to report."
)

func ts(h, m int) string {
	return fmt.Sprintf("2026-11-05T%02d:%02d:00.000Z", h, m)
}

func at(h, m int) time.Time {
	return time.Date(2026, 11, 5, h, m, 0, 0, time.UTC)
}

func line0(v any) string {
	b, _ := json.Marshal(v)
	return string(b) + "\n"
}

func sessionLine(id, stamp, cwd string) string {
	return line0(map[string]any{
		"type": "session", "version": 3, "id": id, "timestamp": stamp, "cwd": cwd,
	})
}

func infoLine(id, parent, stamp, name string) string {
	return line0(map[string]any{
		"type": "session_info", "id": id, "parentId": parent, "timestamp": stamp, "name": name,
	})
}

func callLine(id, parent, stamp, callID, action string, args map[string]any) string {
	full := map[string]any{"action": action}
	for k, v := range args {
		full[k] = v
	}
	return line0(map[string]any{
		"type": "message", "id": id, "parentId": parent, "timestamp": stamp,
		"message": map[string]any{
			"role": "assistant",
			"content": []any{map[string]any{
				"type": "toolCall", "id": callID, "name": "team_room", "arguments": full,
			}},
		},
	})
}

func resultLine(id, parent, stamp, callID, text string, isError bool) string {
	return line0(map[string]any{
		"type": "message", "id": id, "parentId": parent, "timestamp": stamp,
		"message": map[string]any{
			"role":       "toolResult",
			"toolName":   "team_room",
			"toolCallId": callID,
			"isError":    isError,
			"durationMs": 12.5,
			"content":    []any{map[string]any{"type": "text", "text": text}},
		},
	})
}

func wakeLine(id, parent, stamp string, details map[string]any, content string) string {
	return line0(map[string]any{
		"type": "custom_message", "customType": "pi-team-room-wake",
		"id": id, "parentId": parent, "timestamp": stamp,
		"content": content, "details": details, "display": true,
	})
}

func joinLines(lines []string) string { return strings.Join(lines, "") }

// writeFixture lays out a sessions tree plus a room state file and returns both paths.
func writeFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	alphaDir := filepath.Join(sessions, "alpha")
	betaDir := filepath.Join(sessions, "beta")
	if err := os.MkdirAll(alphaDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(betaDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// coordinator: asks, delegates, broadcasts, and two calls the room refused.
	alpha := []string{
		sessionLine(fixtureAlpha, ts(9, 0), "/fixture/alpha"),
		infoLine("a00", "a0", ts(9, 0), "coordinator"),

		callLine("a01", "a00", ts(9, 1), "call_ask", "ask", map[string]any{
			"agent": "builder", "text": "Do the fixture build? Answer yes or no.",
		}),
		resultLine("a02", "a01", ts(9, 1), "call_ask",
			"Question sent to builder [working; focus: no focus recorded; delivery: auto (auto); message id: "+shortID(askID)+"]: Do the fixture build? Answer yes or no.", false),

		callLine("a03", "a02", ts(9, 3), "call_delegate", "delegate", map[string]any{
			"agent": "builder", "text": "Fix the fixture wiring.",
			"target":           "alpha repo (~/Projects/Home/alpha, branch master)",
			"scope":            "only the test fixture and its helpers",
			"acceptanceChecks": "go test ./... passes in viewer",
			"expectedArtifact": "one commit on master",
			"delivery":         "steer",
		}),
		resultLine("a04", "a03", ts(9, 3), "call_delegate",
			"Delegation sent to builder [idle; focus: verifying the fixture; delivery: steer; message id: "+shortID(delegateID)+"] [target: alpha repo (~/Projects/Home/alpha, branch master); scope: only the test fixture and its helpers]: Fix the fixture wiring.", false),

		// coordinator received the reply it asked for, so the reply has a delivery record
		// on the receiving side too. Lines stay in timestamp order, as the real writer emits them.
		wakeLine("a17", "a04", ts(9, 2), map[string]any{
			"messageIds":  []any{replyID},
			"from":        []any{"builder"},
			"kinds":       []any{"reply"},
			"delivery":    "steer",
			"delegations": []any{},
		}, "[Team inbox — steer]\n\nbuilder: Yes. The fixture builds and its tests pass."),

		// A delegation aimed at a peer that is not in the room. The room says no in prose
		// and does not set isError, so a viewer that trusts isError alone calls this a success.
		callLine("a05", "a04", ts(9, 6), "call_ghost", "delegate", map[string]any{
			"agent": "ghost", "text": "Do nothing at all.", "target": "nowhere", "scope": "nothing",
		}),
		resultLine("a06", "a05", ts(9, 6), "call_ghost",
			"No active peer named or identified by ghost found in this team room. Use action=pulse to see peers.", false),

		// The same broadcast three times, accepted every time.
		callLine("a07", "a06", ts(9, 7), "call_u1", "update", map[string]any{"text": loopText}),
		resultLine("a08", "a07", ts(9, 7), "call_u1", "Shared with the team: "+loopText, false),
		callLine("a09", "a08", ts(9, 8), "call_u2", "update", map[string]any{"text": loopText}),
		resultLine("a10", "a09", ts(9, 8), "call_u2", "Shared with the team: "+loopText, false),
		callLine("a11", "a10", ts(9, 9), "call_u3", "update", map[string]any{"text": loopText}),
		resultLine("a12", "a11", ts(9, 9), "call_u3", "Shared with the team: "+loopText, false),

		// The same text a fourth time inside ten minutes: the room declines to duplicate it.
		// A viewer that only reads isError calls this a successful update.
		callLine("a17", "a12", ts(9, 10), "call_u4", "update", map[string]any{"text": loopText}),
		resultLine("a18", "a17", ts(9, 10), "call_u4", "Already shared recently.", false),

		// A call the room refuses because its arguments are missing.
		callLine("a13", "a18", ts(9, 11), "call_badask", "ask", map[string]any{"agent": "builder"}),
		resultLine("a14", "a13", ts(9, 11), "call_badask", "Ask requires an agent name and question", true),
	}

	beta := []string{
		sessionLine(fixtureBeta, ts(9, 0), "/fixture/beta"),
		infoLine("b00", "b0", ts(9, 0), "builder"),

		// The older wake shape: one message, plain scalars.
		wakeLine("b01", "b00", ts(9, 1), map[string]any{
			"messageId": askID, "from": "coordinator", "kind": "question", "delivery": "auto",
		}, "[Team inbox — auto] coordinator: Do the fixture build? Answer yes or no."),

		callLine("b02", "b01", ts(9, 2), "call_reply", "reply", map[string]any{
			"messageId": askID, "text": "Yes. The fixture builds and its tests pass.",
		}),
		resultLine("b03", "b02", ts(9, 2), "call_reply",
			"Reply sent to coordinator [idle; focus: verifying the fixture; delivery: steer; message id: "+shortID(replyID)+"]: Yes. The fixture builds and its tests pass.", false),

		// The newer wake shape: arrays, plus the delegation record.
		wakeLine("b04", "b03", ts(9, 3), map[string]any{
			"messageIds": []any{delegateID},
			"from":       []any{"coordinator"},
			"kinds":      []any{"delegation"},
			"delivery":   "steer",
			"delegations": []any{map[string]any{
				"target":           "alpha repo (~/Projects/Home/alpha, branch master)",
				"scope":            "only the test fixture and its helpers",
				"acceptanceChecks": "go test ./... passes in viewer",
				"expectedArtifact": "one commit on master",
				"agent":            "builder",
				"task":             "Fix the fixture wiring.",
			}},
		}, "[Team inbox — steer]\n\n[Code-owner delegation from coordinator]\nTask: Fix the fixture wiring."),

		// A reply whose messageId is a sentence copied out of the conversation. The sender
		// knew who it was answering; only the id is broken.
		callLine("b05", "b04", ts(9, 5), "call_prose", "reply", map[string]any{
			"messageId": proseRef, "agent": "coordinator", "text": "Answering the note I quoted.",
		}),
		resultLine("b06", "b05", ts(9, 5), "call_prose", "No message matching "+proseRef+".", false),

		// The same reply three times, each one refused.
		callLine("b07", "b06", ts(9, 11), "call_l1", "reply", map[string]any{"messageId": notAnID, "agent": "coordinator", "text": loopText}),
		resultLine("b08", "b07", ts(9, 11), "call_l1", "No message matching "+notAnID+".", false),
		callLine("b09", "b08", ts(9, 12), "call_l2", "reply", map[string]any{"messageId": notAnID, "agent": "coordinator", "text": loopText}),
		resultLine("b10", "b09", ts(9, 12), "call_l2", "No message matching "+notAnID+".", false),
		callLine("b11", "b10", ts(9, 13), "call_l3", "reply", map[string]any{"messageId": notAnID, "agent": "coordinator", "text": loopText}),
		resultLine("b12", "b11", ts(9, 13), "call_l3", "No message matching "+notAnID+".", false),

		// A reply aimed at the sender's own name.
		callLine("b13", "b12", ts(9, 15), "call_self", "reply", map[string]any{
			"messageId": replyID, "agent": "builder", "text": "Thinking out loud about the fixture.",
		}),
		resultLine("b14", "b13", ts(9, 15), "call_self",
			"Reply sent to builder [idle; focus: verifying the fixture; delivery: steer; message id: d4d4d404]: Thinking out loud about the fixture.", false),

		// Hours later, and deliberately absent from the room's own record: the ring keeps
		// only its most recent messages, so this send has no delivery record to find.
		callLine("b15", "b14", ts(13, 0), "call_late", "reply", map[string]any{
			"messageId": replyID, "agent": "coordinator", "text": "Still green after the overnight run.",
		}),
		resultLine("b16", "b15", ts(13, 0), "call_late",
			"Reply sent to coordinator [idle; focus: building the fixture; delivery: auto (auto); message id: e5e5e505]: Still green after the overnight run.", false),
	}

	if err := os.WriteFile(filepath.Join(alphaDir, "2026-11-05T09-00-00-000Z_"+fixtureAlpha+".jsonl"),
		[]byte(joinLines(alpha)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(betaDir, "2026-11-05T09-00-00-000Z_"+fixtureBeta+".jsonl"),
		[]byte(joinLines(beta)), 0o644); err != nil {
		t.Fatal(err)
	}

	state := map[string]any{
		"version": 1,
		"sessions": []any{
			map[string]any{
				"id": fixtureAlpha, "name": "coordinator", "cwd": "/fixture/alpha",
				"project": "alpha", "status": "working", "connected": true, "focus": "building the fixture",
				"startedAt": ts(9, 0), "updatedAt": ts(9, 10), "lastSeenAt": ts(9, 10), "lastReadAt": ts(9, 2),
			},
			map[string]any{
				"id": fixtureBeta, "name": "builder", "cwd": "/fixture/beta",
				"project": "beta", "status": "idle", "connected": true,
				"startedAt": ts(9, 0), "updatedAt": ts(9, 15), "lastSeenAt": ts(9, 15), "lastReadAt": ts(9, 1),
			},
		},
		"messages": []any{
			map[string]any{
				"id": askID, "kind": "question", "fromSessionId": fixtureAlpha, "fromName": "coordinator",
				"toSessionId": fixtureBeta, "text": "Do the fixture build? Answer yes or no.",
				"createdAt": ts(9, 1), "deliveredAt": ts(9, 1), "readAt": ts(9, 1), "delivery": "auto",
			},
			map[string]any{
				"id": replyID, "kind": "reply", "fromSessionId": fixtureBeta, "fromName": "builder",
				"toSessionId": fixtureAlpha, "text": "Yes. The fixture builds and its tests pass.",
				"createdAt": ts(9, 2), "deliveredAt": ts(9, 2), "readAt": ts(9, 2),
				"replyToId": askID, "delivery": "steer",
			},
			map[string]any{
				"id": delegateID, "kind": "delegation", "fromSessionId": fixtureAlpha, "fromName": "coordinator",
				"toSessionId": fixtureBeta, "text": "Fix the fixture wiring.",
				"createdAt": ts(9, 3), "deliveredAt": ts(9, 3), "delivery": "steer",
			},
		},
		"updates": []any{
			map[string]any{
				"id": "u1", "sessionId": fixtureAlpha, "sessionName": "coordinator", "project": "alpha",
				"text": loopText, "createdAt": ts(9, 7),
			},
		},
		"journal": []any{
			map[string]any{
				"id": "j1", "project": "beta", "sessionName": "builder",
				"text": "checkpoint: fixture written", "createdAt": ts(9, 14),
			},
		},
	}
	statePath := filepath.Join(root, "state.json")
	b, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return sessions, statePath
}

// loadFixture runs the real scan and merge over the fixture and hands back the pieces.
func loadFixture(t *testing.T) (*store, *dataset) {
	t.Helper()
	sessions, statePath := writeFixture(t)
	st := newStore(sessions)
	if _, err := st.refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	room, changed := loadRoomState(statePath, nil)
	if !changed {
		t.Fatal("room state did not load")
	}
	return st, build(st.snapshotSessions(), st.snapshotCalls(), st.snapshotWakes(), room)
}

func findMessage(ds *dataset, want func(*RoomMessage) bool) *RoomMessage {
	for _, m := range ds.Direct {
		if want(m) {
			return m
		}
	}
	return nil
}

func findRefused(ds *dataset, want func(*RoomMessage) bool) *RoomMessage {
	for _, m := range ds.Rejected {
		if want(m) {
			return m
		}
	}
	return nil
}

func TestFixtureScansEveryShape(t *testing.T) {
	st, ds := loadFixture(t)

	if got := len(st.snapshotCalls()); got != 15 {
		t.Errorf("calls = %d, want 15 (8 from coordinator, 7 from builder)", got)
	}
	if got := len(st.snapshotWakes()); got != 3 {
		t.Errorf("wakes = %d, want 3", got)
	}
	if ds.ScanWakeShapes["single"] != 1 || ds.ScanWakeShapes["batch"] != 2 {
		t.Errorf("wake shapes = %v, want single 1 and batch 2 (the extension changed format mid-history)", ds.ScanWakeShapes)
	}
	if got := len(ds.Sessions); got != 2 {
		t.Errorf("sessions = %d, want 2", got)
	}
	// Actors are named, not derived from the directory an agent happened to be sitting in.
	if got := ds.Actors.label(fixtureAlpha); got != "coordinator" {
		t.Errorf("actor label = %q, want coordinator", got)
	}
	if got := ds.Actors.label(fixtureBeta); got != "builder" {
		t.Errorf("actor label = %q, want builder", got)
	}
}

func TestMergedSendCarriesBothSides(t *testing.T) {
	_, ds := loadFixture(t)

	ask := findMessage(ds, func(m *RoomMessage) bool { return m.Kind == "ask" && m.ShortID == shortID(askID) })
	if ask == nil {
		t.Fatalf("no ask bubble among %d direct messages", len(ds.Direct))
	}
	got := map[string]bool{}
	for _, s := range ask.Sources {
		got[s] = true
	}
	for _, want := range []string{"state", "call", "wake"} {
		if !got[want] {
			t.Errorf("ask sources = %v, want state+call+wake", ask.Sources)
		}
	}
	if ask.WakeCount != 1 || len(ask.WokenBy) != 1 || ask.WokenBy[0] != fixtureBeta {
		t.Errorf("ask wake evidence = count %d sessions %v, want one wake that woke the builder session",
			ask.WakeCount, ask.WokenBy)
	}
	if ask.DeliveryUsed != "auto" || !ask.DeliveryAuto {
		t.Errorf("delivery = %q auto=%v, want the room's own auto choice recorded", ask.DeliveryUsed, ask.DeliveryAuto)
	}
	if ask.RecipientStatus != "working" {
		t.Errorf("recipient status = %q, want working (read out of the confirmation prose)", ask.RecipientStatus)
	}
	if ask.FromActor != "coordinator" || ask.ToActor != "builder" {
		t.Errorf("actors = %q -> %q, want coordinator -> builder", ask.FromActor, ask.ToActor)
	}
	if ask.ReadAt.IsZero() {
		t.Error("read receipt missing: only the room state has it, which is why the merge needs it")
	}
	if !ask.Answered {
		t.Errorf("ask not marked answered; answers: %v", ask.AnsweredBy)
	}
	if !ask.LinkedReply {
		t.Errorf("ask should be marked as answered by a reply that quoted its id (replyTo %q)", ask.ReplyTo)
	}
}

func TestReplyLinkResolvesThroughTheWakeID(t *testing.T) {
	_, ds := loadFixture(t)

	// The reply quotes a full uuid. The confirmation only ever published the short form,
	// so the link works because the delivery recorded the room's own id for the message.
	reply := findMessage(ds, func(m *RoomMessage) bool { return m.Kind == "reply" && m.ShortID == shortID(replyID) })
	if reply == nil {
		t.Fatalf("reply bubble not found")
	}
	// findReply is the resolver the grouping uses to decide an exchange is one thread.
	ask := findMessage(ds, func(m *RoomMessage) bool { return m.Kind == "ask" })
	if ask == nil {
		t.Fatal("ask bubble not found")
	}
	if got := ds.findReply(reply.ReplyTo); got == nil || got.ID != ask.ID {
		t.Errorf("reply link unresolved: replyTo=%q resolves to %v", reply.ReplyTo, got)
	}
	if reply.ReplyTo != askID {
		t.Errorf("replyTo = %q, want %q", reply.ReplyTo, askID)
	}
	if reply.ToActor != "coordinator" {
		t.Errorf("reply target = %q, want coordinator", reply.ToActor)
	}
	if reply.WakeCount != 1 {
		t.Errorf("reply wake count = %d, want 1 (the batch that woke coordinator)", reply.WakeCount)
	}
}

func TestDelegationFieldsSurviveTheBatchWake(t *testing.T) {
	_, ds := loadFixture(t)

	dl := findMessage(ds, func(m *RoomMessage) bool { return m.Kind == "delegate" })
	if dl == nil {
		t.Fatalf("delegation bubble not found")
	}
	if dl.Delegation == nil {
		t.Fatalf("delegation record lost")
	}
	if dl.Delegation.Scope != "only the test fixture and its helpers" {
		t.Errorf("scope = %q", dl.Delegation.Scope)
	}
	if dl.Delegation.AcceptanceChecks != "go test ./... passes in viewer" {
		t.Errorf("acceptance checks = %q", dl.Delegation.AcceptanceChecks)
	}
	if dl.Delegation.ExpectedArtifact != "one commit on master" {
		t.Errorf("expected artifact = %q", dl.Delegation.ExpectedArtifact)
	}
	if dl.WakeCount != 1 {
		t.Errorf("wake count = %d, want 1", dl.WakeCount)
	}
	if dl.Answered {
		t.Errorf("delegation counted as answered by %v, but nothing from builder answers it inside the window", dl.AnsweredBy)
	}
}

func TestPlainTextRefusalsAreNotSuccesses(t *testing.T) {
	_, ds := loadFixture(t)

	if got := len(ds.Direct); got != 5 {
		t.Errorf("accepted sends = %d, want 5", got)
	}
	if got := len(ds.Broadcast); got != 3 {
		t.Errorf("broadcasts = %d, want 3", got)
	}
	if got := len(ds.Rejected); got != 7 {
		t.Errorf("refused sends = %d, want 7 (ghost peer, duplicate update, incomplete ask, prose id, 3 identical retries)", got)
	}
	reasons := map[string]int{}
	for _, m := range ds.Rejected {
		reasons[m.RejectReason]++
	}
	for reason, want := range map[string]int{
		"the message id did not match anything in the room": 4,
		"no such peer is in the room":                       1,
		"ask called without a name or question":             1,
		"the room already had that update":                  1,
	} {
		if reasons[reason] != want {
			t.Errorf("reason %q = %d, want %d (all: %v)", reason, reasons[reason], want, reasons)
		}
	}
	for _, m := range ds.Rejected {
		if m.LinkedReply || m.Answered {
			t.Errorf("refused send %s kept a conversation link: %+v", m.ID, m)
		}
	}
	ghost := findRefused(ds, func(m *RoomMessage) bool { return m.RejectReason == "no such peer is in the room" })
	if ghost == nil {
		t.Fatal("the ghost-peer refusal is missing")
	}
	if ghost.ToSession != "" {
		t.Errorf("a refusal of a peer that does not exist should not name a target session, got %q", ghost.ToSession)
	}
	if ghost.ToActor != "ghost" {
		t.Errorf("refusal should still record the peer it tried to reach, got %q", ghost.ToActor)
	}
}

func TestBadMessageIdsAreNamedAsCauses(t *testing.T) {
	_, ds := loadFixture(t)

	prose := findRefused(ds, func(m *RoomMessage) bool { return m.MissingRef == proseRef })
	if prose == nil {
		t.Fatal("the refusal with a sentence for a messageId is missing")
	}
	if prose.BadReplyRef != "pasted conversation text into messageId" {
		t.Errorf("cause = %q, want the id named as conversation text", prose.BadReplyRef)
	}
	// The refusal is still attributed to the peer the sender was trying to answer.
	if prose.ToActor != "coordinator" {
		t.Errorf("target = %q, want coordinator", prose.ToActor)
	}
	bad := 0
	for _, m := range ds.Rejected {
		if m.BadReplyRef != "" {
			bad++
		}
	}
	if bad != 4 {
		t.Errorf("refusals with a named bad id = %d, want 4", bad)
	}
	// A valid uuid must not be flagged.
	for _, m := range ds.Direct {
		if m.BadReplyRef != "" {
			t.Errorf("%s (%s) flagged %q for replyTo %q", m.Kind, m.FromActor, m.BadReplyRef, m.ReplyTo)
		}
	}
}

func TestRepeatGroupsSeparateAcceptedFromRefused(t *testing.T) {
	_, ds := loadFixture(t)

	if len(ds.Repeats) != 2 {
		t.Fatalf("repeat groups = %d, want 2: %s", len(ds.Repeats), describeRepeats(ds.Repeats))
	}
	var coordinator, builder *RepeatGroup
	for i := range ds.Repeats {
		switch ds.Repeats[i].Actor {
		case "coordinator":
			coordinator = &ds.Repeats[i]
		case "builder":
			builder = &ds.Repeats[i]
		}
	}
	if coordinator == nil || builder == nil {
		t.Fatalf("want one loop per actor, got %s", describeRepeats(ds.Repeats))
	}
	// Three accepted, then a fourth attempt the room declined: the loop is four bubbles.
	if coordinator.Count != 4 || coordinator.Rejected != 1 || coordinator.Kind != "update" {
		t.Errorf("coordinator loop = %s ×%d refused=%d, want update ×4 with 1 declined",
			coordinator.Kind, coordinator.Count, coordinator.Rejected)
	}
	if builder.Count != 3 || builder.Rejected != 3 || builder.Kind != "reply" {
		t.Errorf("builder loop = %s ×%d refused=%d, want reply ×3 all refused",
			builder.Kind, builder.Count, builder.Rejected)
	}
	if span := builder.LastAt.Sub(builder.FirstAt); span < 2*time.Minute {
		t.Errorf("loop span = %v, want at least the 2 minutes between the first and last retry", span)
	}
	if !strings.Contains(coordinator.Text, "the suite is green") {
		t.Errorf("loop should quote the text that was repeated, got %q", coordinator.Text)
	}
}

func describeRepeats(rs []RepeatGroup) string {
	out := ""
	for _, r := range rs {
		out += fmt.Sprintf("[%s %s x%d refused=%d] ", r.Actor, r.Kind, r.Count, r.Rejected)
	}
	return out
}

func TestSelfDirectedSendIsFlaggedNotMerged(t *testing.T) {
	_, ds := loadFixture(t)

	self := findMessage(ds, func(m *RoomMessage) bool { return m.SelfLoop })
	if self == nil {
		t.Fatal("no self-directed send found")
	}
	if self.FromActor != "builder" || self.ToActor != "builder" {
		t.Errorf("self loop = %q -> %q, want builder -> builder", self.FromActor, self.ToActor)
	}
	if self.Pending {
		t.Error("a send to yourself should not be counted as undelivered")
	}
}

func TestSendTheRoomForgotIsStillShownButMarked(t *testing.T) {
	_, ds := loadFixture(t)

	late := findMessage(ds, func(m *RoomMessage) bool {
		return m.Kind == "reply" && m.SentAt.Equal(at(13, 0))
	})
	if late == nil {
		t.Fatal("the 13:00 reply is missing: a send only present in the transcript must still appear")
	}
	if !late.Pending {
		t.Error("the 13:00 reply should be marked as having no delivery record")
	}
	if !late.DeliveredAt.IsZero() {
		t.Errorf("delivery time = %v, want none: the room's own record aged this send out", late.DeliveredAt)
	}
}

func TestChatsGroupByActorPairAndSplitOnGap(t *testing.T) {
	mergedDS := func() *dataset {
		_, ds := loadFixture(t)
		return ds
	}
	opts := func(split bool) groupOptions {
		o := defaultOptions()
		o.Split = split
		return o
	}

	ds := mergedDS()
	flagOutcomes(ds, opts(false))
	merged := buildChats(ds, opts(false))
	if len(merged) != 1 {
		t.Fatalf("merged chats = %d, want 1 (one pair of actors, whatever the gap)", len(merged))
	}
	chat := merged[0]
	if len(chat.Actors) != 2 || chat.Actors[0] != "builder" || chat.Actors[1] != "coordinator" {
		t.Errorf("chat actors = %v, want [builder coordinator]", chat.Actors)
	}
	// 5 accepted sends + 5 refusals. Two refused sends are left out: the one aimed at a
	// peer that does not exist and the update the room declined to duplicate. Both name
	// the sender, not a conversation, so they belong in the diagnostics and not in a chat.
	if len(chat.Messages) != 10 {
		t.Errorf("chat messages = %d, want 10", len(chat.Messages))
	}
	if chat.Rejected != 5 {
		t.Errorf("chat refusals = %d, want 5", chat.Rejected)
	}
	if chat.Episodes != 2 {
		t.Errorf("episodes = %d, want 2 (the 09:01 block and the 13:00 reply)", chat.Episodes)
	}
	if chat.MaxRepeat != 3 {
		t.Errorf("chat max repeat = %d, want 3", chat.MaxRepeat)
	}
	if chat.BadReplyRefs != 4 {
		t.Errorf("chat broken reply links = %d, want 4", chat.BadReplyRefs)
	}
	if chat.RepeatBubbles != 3 {
		t.Errorf("chat repeat bubbles = %d, want 3 (the refused loop is in this chat; the update loop is a broadcast)", chat.RepeatBubbles)
	}
	if chat.SelfLoops != 1 {
		t.Errorf("chat self-directed sends = %d, want 1", chat.SelfLoops)
	}
	if chat.Pending != 1 {
		t.Errorf("chat sends with no delivery record = %d, want 1", chat.Pending)
	}
	if chat.Unanswered != 1 {
		t.Errorf("chat unanswered = %d, want 1 (the delegation)", chat.Unanswered)
	}
	if chat.Wakes < 3 {
		t.Errorf("chat wakes = %d, want at least 3", chat.Wakes)
	}

	ds2 := mergedDS()
	flagOutcomes(ds2, opts(true))
	split := buildChats(ds2, opts(true))
	if len(split) != 2 {
		t.Fatalf("split chats = %d, want 2 (one per episode)", len(split))
	}
	seen := map[int]bool{}
	for _, c := range split {
		// A split chat is one episode of a two-episode conversation: it reports both.
		seen[c.Episode] = true
		if c.Episodes != 2 {
			t.Errorf("split chat %q episodes = %d, want 2 (the pair has two episodes)", c.Label, c.Episodes)
		}
	}
	if !seen[1] || !seen[2] {
		t.Errorf("split chat episode indexes = %v, want 1 and 2", seen)
	}
	if split[0].ID == split[1].ID {
		t.Error("split chats share one id")
	}
	if split[0].MaxRepeat+split[1].MaxRepeat != 3 {
		t.Errorf("the loop should live in exactly one episode, got %d and %d", split[0].MaxRepeat, split[1].MaxRepeat)
	}
}

func TestSessionViewCountsRefusalsPerSession(t *testing.T) {
	_, ds := loadFixture(t)

	summaries := sessionSummaries(ds, defaultOptions())
	if len(summaries) != 2 {
		t.Fatalf("session summaries = %d, want 2", len(summaries))
	}
	got := map[string]int{}
	for _, s := range summaries {
		got[s.Label] = s.Rejected
	}
	if got["coordinator"] != 3 {
		t.Errorf("coordinator refusals = %d, want 3 (ghost peer, declined duplicate update, incomplete ask)", got["coordinator"])
	}
	if got["builder"] != 4 {
		t.Errorf("builder refusals = %d, want 4 (prose id, 3 identical retries)", got["builder"])
	}
}

func TestHealthAndWarningsReportTheAnomalies(t *testing.T) {
	_, ds := loadFixture(t)
	v := buildView(*ds, 7)
	if v == nil {
		t.Fatal("no view")
	}
	if v.Generation != 7 {
		t.Errorf("generation = %d, want 7", v.Generation)
	}
	if v.Health.Rejected != 7 {
		t.Errorf("health refusals = %d, want 7", v.Health.Rejected)
	}
	if v.Health.BadReplyRefs != 4 {
		t.Errorf("health bad ids = %d, want 4", v.Health.BadReplyRefs)
	}
	if v.Health.RepeatGroups != 2 {
		t.Errorf("health repeat groups = %d, want 2", v.Health.RepeatGroups)
	}
	if len(v.Rejected) != 7 || len(v.Repeats) != 2 {
		t.Errorf("view did not carry the diagnostics: %d refused, %d loops", len(v.Rejected), len(v.Repeats))
	}
	joined := strings.Join(warningsOf(v), "\n")
	for _, want := range []string{
		"coordinator sent the same update 4 times",
		"1 of them rejected by the room",
		"builder sent the same reply 3 times",
		"the room rejected every one of them",
		"the room rejected 7 sends",
		"not a message id",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("warnings missing %q. got:\n%s", want, joined)
		}
	}
}

func TestFixtureClockIsSane(t *testing.T) {
	// Guards the fixture itself: ts() and at() must describe the same instants, or every
	// timing assertion above quietly measures the wrong clock.
	if got, want := at(9, 1).Format(time.RFC3339Nano), "2026-11-05T09:01:00Z"; got != want {
		t.Fatalf("at() = %s, want %s", got, want)
	}
	if got, want := ts(9, 1), "2026-11-05T09:01:00.000Z"; got != want {
		t.Fatalf("ts() = %s, want %s", got, want)
	}
	if got, want := parseTime(ts(13, 0)), at(13, 0); !got.Equal(want) {
		t.Fatalf("parseTime(ts()) = %v, want %v", got, want)
	}
}
