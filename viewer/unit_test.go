package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The room's own sentences, read out of the extension that writes them.
//
// The viewer classifies what the room said rather than trusting isError, which means it
// has to know the room's vocabulary. This test reads extension.ts and requires the viewer
// to recognise every sentence the room can hand back from a tool call, so a new sentence
// in the extension shows up here as a failing test instead of as a send the viewer quietly
// mislabels.

var litString = regexp.MustCompile("(`[^`]{8,200}`|\"[^\"]{8,200}\")")
var interpolation = regexp.MustCompile(`\$\{[^{}]*\}`)
var lineComment = regexp.MustCompile(`//.*`)

// roomSentences returns every string literal the extension returns, throws, or passes to
// toolResult. Interpolated parts become a lowercase x, so a template that starts with an
// interpolated value (the ask confirmation, whose label varies) drops out of the set.
func roomSentences(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile("../extension.ts")
	if err != nil {
		t.Skipf("extension source not available: %v", err)
	}
	out := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(lineComment.ReplaceAllString(string(b), ""), "\n") {
		if !strings.Contains(line, "return ") && !strings.Contains(line, "throw new Error(") && !strings.Contains(line, "toolResult(") {
			continue
		}
		for _, m := range litString.FindAllStringSubmatch(line, -1) {
			s := strings.TrimSpace(interpolation.ReplaceAllString(m[1][1:len(m[1])-1], "x"))
			if s == "" || s[0] < 'A' || s[0] > 'Z' {
				continue
			}
			if seen[s] {
				continue
			}
			seen[s] = true
			out = append(out, s)
		}
	}
	if len(out) < 20 {
		t.Fatalf("found only %d room sentences in extension.ts; the extractor has drifted", len(out))
	}
	return out
}

// knownNonAnswer are the strings that are not a room's verdict about a send, and are
// allowed to stay unclassified on purpose.
var knownNonAnswer = map[string]string{
	"Team: x":               "a pulse line listing who is in the room, not a verdict about a send",
	"Usage: /team delegate": "slash command help, which the tool itself never returns",
	"Usage: /team remember": "slash command help, which the tool itself never returns",
}

// prefixOf reports which allowlisted prefix a sentence starts with, or "".
func prefixOf(allow map[string]string, s string) string {
	for prefix := range allow {
		if strings.HasPrefix(s, prefix) {
			return prefix
		}
	}
	return ""
}

func TestVocabularyCoversTheRoomsOwnSentences(t *testing.T) {
	for _, s := range roomSentences(t) {
		if classifyRoomAnswer(s).Kind != "" {
			continue
		}
		if prefixOf(knownNonAnswer, s) != "" {
			continue
		}
		t.Errorf("the room can say %q and the viewer classifies it as nothing; add it to roomVocabulary", s)
	}
}

func TestClassifyRoomAnswer(t *testing.T) {
	cases := []struct {
		answer string
		kind   string
		reason string
		detail string
	}{
		// Confirmations, in the format the extension actually emits.
		{"Question sent to builder [working; focus: no focus recorded; delivery: auto (auto); message id: a1a1a101]: Do the build?", "sent", "", ""},
		{"Delegation sent to builder [idle; focus: verifying; delivery: steer; message id: c3c3c303] [target: alpha repo; scope: the fixture]: Fix it.", "sent", "", ""},
		{"Reply sent to coordinator [idle; focus: verifying; delivery: steer; message id: b2b2b202]: Yes.", "sent", "", ""},
		{"Shared with the team: the gate passes.", "sent", "", ""},
		{"Checkpoint saved: fixture written", "sent", "", ""},
		{"Focus updated: building the fixture", "sent", "", ""},
		{"Saved to shared history: the viewer is untracked", "sent", "", ""},

		// Reads.
		{"Inbox is clear.", "read", "", ""},
		{"No shared history found.", "read", "", ""},
		{"No checkpoint saved.", "read", "", ""},
		{"Current checkpoint: fixture written", "read", "", ""},
		{"Team pulse (machine-wide shared context):", "read", "", ""},

		// Refusals the room reports in prose, with isError left false.
		{"No message matching a1a1a101 found in your inbox.", "rejected", "the message id did not match anything in the room", "a1a1a101"},
		{"No active peer named or identified by probe-1 found in this team room. Use action=pulse to see peers.", "rejected", "no such peer is in the room", "probe-1"},
		{"Already shared recently.", "rejected", "the room already had that update", ""},
		{"That message is a terminal signal; do not reply to it.", "rejected", "tried to reply to a terminal acknowledgement", ""},
		{"Team room session is not ready", "rejected", "the sender had no room session yet", ""},
		{"Team room is busy: the shared state stayed locked, so this change was not saved.", "rejected", "the room's shared state stayed locked", ""},
		{"Ask requires an agent name and question", "rejected", "ask called without a name or question", ""},
		{"Reply requires a message id and text", "rejected", "reply called without an id or text", ""},
		{"Delegation requires an agent and task", "rejected", "delegation called without an agent or task", ""},
		{"Delegation requires target and scope", "rejected", "delegation called without target or scope", ""},
		{"Update cannot be empty", "rejected", "update called with no text", ""},
		{"Checkpoint cannot be empty", "rejected", "checkpoint called with no text", ""},
		{"A fact or decision is required.", "rejected", "remember called with no fact", ""},

		// Not the room talking: an agent's own prose that happens to mention the room must
		// not be read as a room verdict.
		{"The team room rejected my earlier send, so I resent it with a new id.", "", "", ""},
		{"No active peer review remains on this branch.", "", "", ""},
		{"", "", "", ""},
	}
	for _, c := range cases {
		got := classifyRoomAnswer(c.answer)
		if got.Kind != c.kind {
			t.Errorf("kind for %q = %q, want %q", c.answer, got.Kind, c.kind)
			continue
		}
		if c.reason != "" && got.Reason != c.reason {
			t.Errorf("reason for %q = %q, want %q", c.answer, got.Reason, c.reason)
		}
		if got.Detail != c.detail {
			t.Errorf("detail for %q = %q, want %q", c.answer, got.Detail, c.detail)
		}
	}
}

func TestBadMessageIDNamesTheMistake(t *testing.T) {
	cases := []struct {
		ref  string
		want string
		why  string
	}{
		{"", "", "no reply link at all is not a mistake"},
		{"a1a1a101", "", "the room's own short id"},
		{"abcdef", "", "short hex ids are accepted down to six digits"},
		{"abcdef123456", "", "and up to twelve"},
		{"01a1b000-0000-7000-8000-000000000aaa", "", "a full uuid"},
		{"01A1B000-0000-7000-8000-000000000AAA", "", "a uuid written in capitals"},
		{"[Team inbox — steer]\n\nbuilder: Yes.", "quoted the inbox envelope instead of an id", "the wrapper, not the id"},
		{"the earlier note about the fixture gate passing on master", "pasted conversation text into messageId", "a sentence"},
		{"123e4567-e89b-12d3-a456-4266141740", "uuid-shaped but the wrong number of hex digits", "a uuid with a group missing"},
		{"not-an-id", "not a message id", "plain nonsense"},
		{"abcdef1234567890", "not a message id", "the room publishes 8 hex digits, so a longer hex run is worth a look"},
	}
	for _, c := range cases {
		if got := badMessageID(c.ref); got != c.want {
			t.Errorf("badMessageID(%q) = %q, want %q (%s)", c.ref, got, c.want, c.why)
		}
	}
}

func TestApplyConfirmationReadsTheRealConfirmation(t *testing.T) {
	rec := &CallRec{Action: "delegate"}
	applyConfirmation(rec, "Delegation sent to builder [working; focus: keep the ring warm; delivery: steer; message id: c3c3c303] [target: alpha repo; scope: the fixture]: Fix it.")
	if rec.MessageShort != "c3c3c303" {
		t.Errorf("message short = %q, want c3c3c303", rec.MessageShort)
	}
	if rec.DeliveryUsed != "steer" || rec.DeliveryAuto {
		t.Errorf("delivery = %q auto=%v, want steer, not auto", rec.DeliveryUsed, rec.DeliveryAuto)
	}
	if rec.RecipientStatus != "working" {
		t.Errorf("recipient status = %q, want working", rec.RecipientStatus)
	}
	if rec.Error {
		t.Error("a confirmation must not be recorded as a refusal")
	}

	rec = &CallRec{Action: "ask"}
	applyConfirmation(rec, "Question sent to builder [idle; focus: none; delivery: followUp (auto); message id: a1a1a101]: Do it?")
	if !rec.DeliveryAuto || rec.DeliveryUsed != "followUp" {
		t.Errorf("delivery = %q auto=%v, want the room's own followUp choice marked as auto", rec.DeliveryUsed, rec.DeliveryAuto)
	}

	rec = &CallRec{Action: "reply"}
	applyConfirmation(rec, "No message matching a1a1a101 found in your inbox.")
	if !rec.Error {
		t.Error("a refusal the room wrote as prose must still be recorded as a refusal")
	}
	if rec.MissingRef != "a1a1a101" {
		t.Errorf("missing ref = %q, want the id the room could not find", rec.MissingRef)
	}
	if rec.RejectReason != "the message id did not match anything in the room" {
		t.Errorf("reason = %q", rec.RejectReason)
	}
}

func TestWakeShapesBothOldAndNew(t *testing.T) {
	old := wakeLine("w1", "p", ts(9, 1), map[string]any{
		"messageId": askID, "from": "coordinator", "kind": "question", "delivery": "auto",
	}, "[Team inbox — auto] coordinator: Do the fixture build? Answer yes or no.")
	e1 := &entry{}
	if err := json.Unmarshal([]byte(old), e1); err != nil {
		t.Fatal(err)
	}
	w1 := extractWake(fixtureBeta, e1)
	if w1.Shape != "single" {
		t.Errorf("old shape detected as %q, want single", w1.Shape)
	}
	if len(w1.MessageIDs) != 1 || w1.MessageIDs[0] != askID {
		t.Errorf("ids = %v, want the one id", w1.MessageIDs)
	}
	if len(w1.From) != 1 || w1.From[0] != "coordinator" || len(w1.Kinds) != 1 || w1.Kinds[0] != "question" {
		t.Errorf("from/kinds = %v / %v, want coordinator / question", w1.From, w1.Kinds)
	}

	nw := wakeLine("w2", "p", ts(9, 2), map[string]any{
		"messageIds": []any{delegateID, replyID},
		"from":       []any{"coordinator", "builder"},
		"kinds":      []any{"delegation", "reply"},
		"delivery":   "steer",
	}, "[Team inbox — steer]")
	e2 := &entry{}
	if err := json.Unmarshal([]byte(nw), e2); err != nil {
		t.Fatal(err)
	}
	w2 := extractWake(fixtureAlpha, e2)
	if w2.Shape != "batch" {
		t.Errorf("new shape detected as %q, want batch", w2.Shape)
	}
	if len(w2.MessageIDs) != 2 {
		t.Errorf("ids = %v, want two", w2.MessageIDs)
	}
	if len(w2.From) != 2 || w2.From[1] != "builder" {
		t.Errorf("from = %v, want both senders", w2.From)
	}
	if w2.Delivery != "steer" {
		t.Errorf("delivery = %q, want steer", w2.Delivery)
	}
}

func TestRescanAddsTheNewLineWithoutDoubleCounting(t *testing.T) {
	sessions, _ := writeFixture(t)
	st := newStore(sessions)
	if _, err := st.refresh(); err != nil {
		t.Fatal(err)
	}
	beforeCalls := len(st.snapshotCalls())
	beforeBroadcasts := len(build(st.snapshotSessions(), st.snapshotCalls(), st.snapshotWakes(), mustRoomState(t, sessions)).Broadcast)

	files, err := filepath.Glob(filepath.Join(sessions, "beta", "*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("fixture transcript not found: %v", err)
	}
	f, err := os.OpenFile(files[0], os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(callLine("b17", "b16", ts(13, 1), "call_appended", "update", map[string]any{"text": "Appended after the first scan."}))
	f.WriteString(resultLine("b18", "b17", ts(13, 1), "call_appended", "Shared with the team: Appended after the first scan.", false))
	f.Close()

	if _, err := st.refresh(); err != nil {
		t.Fatal(err)
	}
	after := build(st.snapshotSessions(), st.snapshotCalls(), st.snapshotWakes(), mustRoomState(t, sessions))
	if got := len(st.snapshotCalls()); got != beforeCalls+1 {
		t.Errorf("calls = %d, want %d: a rescan must read only what was appended", got, beforeCalls+1)
	}
	if got := len(after.Broadcast); got != beforeBroadcasts+1 {
		t.Errorf("broadcasts = %d, want %d", got, beforeBroadcasts+1)
	}
	seen := map[string]int{}
	for _, c := range st.snapshotCalls() {
		seen[c.EntryID]++
	}
	for id, n := range seen {
		if n > 1 {
			t.Errorf("entry %s read %d times in one scan", id, n)
		}
	}
}

func TestJoinReasonsIsStableAndWorstFirst(t *testing.T) {
	got := joinReasons(map[string]int{
		"no such peer is in the room":                       1,
		"the message id did not match anything in the room": 44,
		"ask called without a name or question":             13,
	})
	want := "44 × the message id did not match anything in the room; 13 × ask called without a name or question; 1 × no such peer is in the room"
	if got != want {
		t.Errorf("joinReasons = %q, want %q", got, want)
	}
	// Equal counts must order by name, or the same data reads as a different sentence on
	// every rebuild.
	a := joinReasons(map[string]int{"b reason": 2, "a reason": 2})
	b := joinReasons(map[string]int{"a reason": 2, "b reason": 2})
	if a != b {
		t.Errorf("equal counts rendered differently: %q vs %q", a, b)
	}
}

// mustRoomState loads the fixture's own state file, which sits next to the sessions tree.
func mustRoomState(t *testing.T, sessions string) *roomState {
	t.Helper()
	path := filepath.Join(filepath.Dir(sessions), "state.json")
	st, _ := loadRoomState(path, nil)
	return st
}

// TestRepeatedReadsAreNotALoop keeps repeat detection pointed at sends. The real
// transcripts contain an agent that asked for the team pulse four times in a day and got
// the same answer every time; that is the room being consistent, and calling it a loop
// buries the loops that matter.
func TestRepeatedReadsAreNotALoop(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	dir := filepath.Join(sessions, "reader")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	pulse := "Team pulse (machine-wide shared context): - alpha [01a1b000] (idle, ~/alpha): no focus recorded"
	history := "No shared history found."
	shared := "Deployed the viewer build to home-dev and rolled the pod."

	lines := []string{sessionLine(fixtureAlpha, ts(9, 0), "/fixture/alpha")}
	parent := ""
	add := func(id, stamp, callID, action, answer string) {
		// The call and its confirmation carry the same text, exactly as a broadcast does
		// in a real transcript, so the bubble is recognisable from either side.
		lines = append(lines, callLine(id, parent, stamp, callID, action, map[string]any{"text": answer}))
		lines = append(lines, resultLine(id+"r", id, stamp, callID, answer, false))
		parent = id + "r"
	}
	for i := 0; i < 4; i++ {
		add(fmt.Sprintf("p%d", i), ts(9, 1+i), fmt.Sprintf("call_pulse%d", i), "pulse", pulse)
	}
	for i := 0; i < 3; i++ {
		add(fmt.Sprintf("h%d", i), ts(9, 5+i), fmt.Sprintf("call_hist%d", i), "history", history)
	}
	for i := 0; i < 3; i++ {
		add(fmt.Sprintf("u%d", i), ts(9, 8+i), fmt.Sprintf("call_upd%d", i), "update", shared)
	}

	if err := os.WriteFile(filepath.Join(dir, "2026-11-05T09-00-00-000Z_"+fixtureAlpha+".jsonl"),
		[]byte(joinLines(lines)), 0o644); err != nil {
		t.Fatal(err)
	}

	st := newStore(sessions)
	if _, err := st.refresh(); err != nil {
		t.Fatal(err)
	}
	ds := build(st.snapshotSessions(), st.snapshotCalls(), st.snapshotWakes(), nil)
	if len(ds.Repeats) != 1 {
		t.Fatalf("repeat groups = %d, want only the broadcast loop: %s", len(ds.Repeats), describeRepeats(ds.Repeats))
	}
	got := ds.Repeats[0]
	if got.Kind != "update" || got.Count != 3 {
		t.Errorf("loop = %s ×%d, want update ×3", got.Kind, got.Count)
	}
}

// TestRefusedRepliesFindThePeerTheyWereTryingToReach covers the case the real transcripts
// are full of: a reply the room refused because the message id it quoted did not exist.
// The reply link is useless there, but the sender's own inbox still says who woke it, and
// that is what puts the attempt back in the conversation it was attempted in.
func TestRefusedRepliesFindThePeerTheyWereTryingToReach(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	alpha := filepath.Join(sessions, "coordinator")
	beta := filepath.Join(sessions, "builder")
	for _, d := range []string{alpha, beta} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	coordinator := []string{
		sessionLine(fixtureAlpha, ts(10, 0), "/fixture/alpha"),
		infoLine("c00", "", ts(10, 0), "coordinator"),
		callLine("c01", "c00", ts(10, 1), "call_ask", "ask", map[string]any{
			"agent": "builder", "text": "Run the acceptance gate and tell me the verdict.",
		}),
		resultLine("c02", "c01", ts(10, 1), "call_ask",
			"Question sent to builder [working; focus: none; delivery: auto (auto); message id: b2b2b202]: Run the acceptance gate and tell me the verdict.", false),
	}
	builder := []string{
		sessionLine(fixtureBeta, ts(10, 0), "/fixture/beta"),
		infoLine("b00", "", ts(10, 0), "builder"),
		// coordinator's question arrives in builder's own transcript.
		wakeLine("b01", "b00", ts(10, 2), map[string]any{
			"messageIds": []any{replyID}, "from": []any{"coordinator"}, "kinds": []any{"question"},
		}, "[Team inbox — auto] coordinator: Run the acceptance gate and tell me the verdict."),
	}
	parent := "b01"
	for i := 0; i < 2; i++ {
		n := itoa(i)
		builder = append(builder,
			callLine("b1"+n, parent, ts(10, 3+i), "call_reply"+n, "reply", map[string]any{
				"messageId": notAnID, "text": "Verdict: PASS, the gate is green on master.",
			}),
			resultLine("b2"+n, "b1"+n, ts(10, 3+i), "call_reply"+n,
				"No message matching not-an-id found in your inbox.", false),
		)
		parent = "b2" + n
	}

	write := func(dir, prefix, name string, lines []string) {
		if err := os.WriteFile(filepath.Join(dir, prefix+"_"+name+".jsonl"), []byte(joinLines(lines)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(alpha, "2026-11-05T10-00-00-000Z", fixtureAlpha, coordinator)
	write(beta, "2026-11-05T10-00-00-000Z", fixtureBeta, builder)

	st := newStore(sessions)
	if _, err := st.refresh(); err != nil {
		t.Fatal(err)
	}
	ds := build(st.snapshotSessions(), st.snapshotCalls(), st.snapshotWakes(), nil)

	var refused []*RoomMessage
	for _, m := range ds.Rejected {
		if m.Kind == "reply" {
			refused = append(refused, m)
		}
	}
	if len(refused) != 2 {
		t.Fatalf("refused replies = %d, want 2", len(refused))
	}
	for _, m := range refused {
		if m.ToActor != "coordinator" {
			t.Errorf("refused reply addressed to %q, want coordinator", m.ToActor)
		}
		if m.ToSession != fixtureAlpha {
			t.Errorf("toSession = %q, want the coordinator's real session id", m.ToSession)
		}
		if !m.InferredTarget {
			t.Error("an inferred target has to be marked as inferred")
		}
	}

	chats := buildChats(ds, defaultOptions())
	if len(chats) != 1 {
		t.Fatalf("chats = %d, want the refused attempts to file into one conversation: %s", len(chats), describeChats(chats))
	}
	got := chats[0]
	if got.Rejected != 2 {
		t.Errorf("chat rejected = %d, want 2: %s", got.Rejected, describeChats(chats))
	}
	if got.Rejected != 2 || len(got.Actors) != 2 {
		t.Errorf("chat = %s", describeChats(chats))
	}
}

// TestTargetSessionsAreRealSessions guards the one invariant every link in the viewer
// depends on: a session field holds a session id, never an actor's name. Put a name there
// and the viewer invents a peer that nobody ran.
func TestTargetSessionsAreRealSessions(t *testing.T) {
	_, ds := loadFixture(t)
	known := map[string]bool{}
	for _, s := range ds.Sessions {
		known[s.ID] = true
	}
	check := func(m *RoomMessage, what string) {
		if m.ToSession == "" {
			return
		}
		if !known[m.ToSession] {
			t.Errorf("%s %s points at session %q, which is not a session in the transcripts", what, m.ID, m.ToSession)
		}
	}
	for _, m := range ds.Direct {
		check(m, "send")
	}
	for _, m := range ds.Rejected {
		check(m, "refused send")
	}
	for _, m := range ds.Broadcast {
		check(m, "broadcast")
	}
}

// describeChats renders chat summaries for failure messages.
func describeChats(chats []Chat) string {
	out := ""
	for _, c := range chats {
		out += fmt.Sprintf("[%s actors=%v msgs=%d rejected=%d] ", c.ID, c.Actors, len(c.Messages), c.Rejected)
	}
	return out
}

// TestEveryViewReportsTheSameTranscripts keeps the numbers the UI reads honest. The health
// endpoint, the chat list, a re-grouped chat list and the live stream are four different
// code paths over one index; if any of them measures the transcripts for itself, they
// drift and the viewer shows a different room to two tabs open on the same data.
func TestEveryViewReportsTheSameTranscripts(t *testing.T) {
	sessions, statePath := writeFixture(t)
	srv := newServer(sessions, statePath, 40*time.Millisecond)
	if !srv.bootstrap() {
		t.Fatal("server did not index the fixture")
	}
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()

	pick := func(url string) Health {
		t.Helper()
		resp, err := http.Get(url)
		if err != nil {
			t.Fatalf("GET %s: %v", url, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d", url, resp.StatusCode)
		}
		var payload struct {
			Health Health `json:"health"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
		return payload.Health
	}

	// The live stream sends one view frame per change; read the first one and hang up.
	streamHealth := func() Health {
		t.Helper()
		req, err := http.NewRequest("GET", ts.URL+"/api/events", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /api/events: %v", err)
		}
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		for i := 0; i < 40 && sc.Scan(); i++ {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var payload struct {
				Health Health `json:"health"`
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload); err != nil {
				t.Fatalf("decode stream frame: %v", err)
			}
			return payload.Health
		}
		t.Fatal("no view frame arrived on /api/events")
		return Health{}
	}

	views := map[string]Health{
		"/api/health":              pick(ts.URL + "/api/health"),
		"/api/chats":               pick(ts.URL + "/api/chats"),
		"/api/chats?split=1":       pick(ts.URL + "/api/chats?split=1&limit=50"),
		"/api/chats?actor=builder": pick(ts.URL + "/api/chats?actor=builder"),
		"/api/events":              streamHealth(),
	}

	// Fields that describe the transcripts, not the grouping. None of these may depend on
	// which view asked for them.
	fields := []struct {
		name string
		get  func(Health) int
	}{
		{"files", func(h Health) int { return h.Files }},
		{"sessions", func(h Health) int { return h.Sessions }},
		{"directMessages", func(h Health) int { return h.Direct }},
		{"wakes", func(h Health) int { return h.Wakes }},
		{"rejectedSends", func(h Health) int { return h.Rejected }},
		{"teamRoomCalls", func(h Health) int { return h.TeamRoomCalls }},
	}
	for _, f := range fields {
		want := -1
		for name, h := range views {
			got := f.get(h)
			if want < 0 {
				want = got
				continue
			}
			if got != want {
				t.Errorf("%s reported as %d by %s, but %d elsewhere", f.name, got, name, want)
			}
		}
		if f.name == "files" && want != 2 {
			t.Errorf("files = %d, want the 2 transcripts the fixture wrote", want)
		}
	}
	for name, h := range views {
		if h.IndexedMB <= 0 {
			t.Errorf("%s reports %.3f MB indexed, which means nobody measured the transcripts", name, h.IndexedMB)
		}
	}
}
