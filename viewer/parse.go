package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// entry mirrors one line of a Pi session JSONL file. Content is kept raw so the
// huge tool-result blobs are only decoded when something actually needs them.
type entry struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	ParentID   *string         `json:"parentId"`
	Timestamp  string          `json:"timestamp"`
	CustomType string          `json:"customType"`
	Cwd        string          `json:"cwd"`
	Name       string          `json:"name"`
	Summary    string          `json:"summary"`
	Label      string          `json:"label"`
	Display    bool            `json:"display"`
	Details    json.RawMessage `json:"details"`
	Content    json.RawMessage `json:"content"`
	Message    *msgEntry       `json:"message"`
}

type msgEntry struct {
	Role       string          `json:"role"`
	ToolName   string          `json:"toolName"`
	ToolCallID string          `json:"toolCallId"`
	IsError    bool            `json:"isError"`
	DurationMs float64         `json:"durationMs"`
	Model      string          `json:"model"`
	Provider   string          `json:"provider"`
	StopReason string          `json:"stopReason"`
	Content    json.RawMessage `json:"content"`
	Usage      json.RawMessage `json:"usage"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	MimeType  string          `json:"mimeType"`
	Arguments json.RawMessage `json:"arguments"`
}

type teamArgs struct {
	Action            string `json:"action"`
	Text              string `json:"text"`
	Agent             string `json:"agent"`
	Target            string `json:"target"`
	Scope             string `json:"scope"`
	UserAuthorization string `json:"userAuthorization"`
	AcceptanceChecks  string `json:"acceptanceChecks"`
	ExpectedArtifact  string `json:"expectedArtifact"`
	MessageID         string `json:"messageId"`
	Delivery          string `json:"delivery"`
	Query             string `json:"query"`
}

// wakeDetails is read defensively: the extension has shipped two shapes for the
// same facts - a batch form with arrays (messageIds/from/kinds/delegations) and a
// single form with scalars (messageId/from/kind/delegation). Decoding the scalars
// into slices fails the whole object, which is how 269 of our 337 deliveries look
// like nothing happened.
type wakeDetails struct {
	MessageIDs  json.RawMessage `json:"messageIds"`
	MessageID   json.RawMessage `json:"messageId"`
	From        json.RawMessage `json:"from"`
	Kinds       json.RawMessage `json:"kinds"`
	Kind        json.RawMessage `json:"kind"`
	Delivery    string          `json:"delivery"`
	Delegations json.RawMessage `json:"delegations"`
	Delegation  json.RawMessage `json:"delegation"`
}

// stringsOf takes either a JSON array or a bare string.
func stringsOf(raw json.RawMessage) []string {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] == 'n' {
		return nil
	}
	if t[0] == '"' {
		var one string
		if json.Unmarshal(t, &one) != nil {
			return nil
		}
		return []string{one}
	}
	if t[0] == '[' {
		var many []string
		if json.Unmarshal(t, &many) != nil {
			return nil
		}
		return many
	}
	return nil
}

func rawCount(raw json.RawMessage) int {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] == 'n' {
		return 0
	}
	if t[0] == '[' {
		var many []json.RawMessage
		if json.Unmarshal(t, &many) != nil {
			return 0
		}
		return len(many)
	}
	return 1
}

type sessionHeader struct {
	Type      string `json:"type"`
	Version   int    `json:"version"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	CWD       string `json:"cwd"`
}

var (
	teamRoomMarker    = []byte(`"team_room"`)
	wakeMarker        = []byte("pi-team-room-wake")
	sessionInfoMarker = []byte(`"session_info"`)
	hexRun            = regexp.MustCompile(`^[0-9a-fA-F]+`)
	uuidShape         = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

func parseTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t.UTC()
	}
	return time.Time{}
}

// tokenHash builds a stable display id. Slicing the seed is not enough: every Pi
// session id starts with the same "01a1" prefix, so prefix-derived chat and thread
// ids silently collapse onto each other.
func tokenHash(prefix, seed string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	return fmt.Sprintf("%s%08x", prefix, h.Sum32())
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// blocks decodes a message content field that may be a bare string or an array.
func blocks(raw json.RawMessage) []contentBlock {
	if len(raw) == 0 {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] == '"' {
		var s string
		if json.Unmarshal(trimmed, &s) != nil {
			return nil
		}
		if s == "" {
			return nil
		}
		return []contentBlock{{Type: "text", Text: s}}
	}
	var out []contentBlock
	if json.Unmarshal(trimmed, &out) != nil {
		return nil
	}
	return out
}

// plainText flattens the text/thinking parts of a content field.
func plainText(raw json.RawMessage) string {
	var out strings.Builder
	for _, b := range blocks(raw) {
		switch {
		case b.Text != "":
			out.WriteString(b.Text)
		case b.Thinking != "":
			out.WriteString(b.Thinking)
		case b.Type == "toolCall":
			out.WriteString("[" + b.Name + " " + string(b.Arguments) + "]")
		}
	}
	return out.String()
}

func firstText(raw json.RawMessage) string {
	for _, b := range blocks(raw) {
		if b.Text != "" {
			return b.Text
		}
	}
	return plainText(raw)
}

// entryType reads the entry type without decoding the whole line, which keeps the
// bulk scan of 150MB of transcripts cheap.
func entryType(line []byte) string {
	i := bytes.Index(line, []byte(`"type":"`))
	if i < 0 {
		return ""
	}
	rest := line[i+len(`"type":"`):]
	end := bytes.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return string(rest[:end])
}

func entryTimestamp(line []byte) time.Time {
	// Entry timestamps sit next to the entry id, before any nested message content.
	i := bytes.Index(line, []byte(`"timestamp":"`))
	if i < 0 {
		return time.Time{}
	}
	rest := line[i+len(`"timestamp":"`):]
	end := bytes.IndexByte(rest, '"')
	if end < 0 {
		return time.Time{}
	}
	return parseTime(string(rest[:end]))
}

// scanLine does the cheap targeted work for a line that is not interesting enough
// to fully decode.
type lineFacts struct {
	Type string
	Role string
	At   time.Time
	Full *entry
}

func scanLine(line []byte) lineFacts {
	f := lineFacts{Type: entryType(line), At: entryTimestamp(line)}
	if i := bytes.Index(line, []byte(`"role":"`)); i >= 0 {
		rest := line[i+len(`"role":"`):]
		if end := bytes.IndexByte(rest, '"'); end >= 0 {
			f.Role = string(rest[:end])
		}
	}
	return f
}

func decodeEntry(line []byte) (*entry, error) {
	var e entry
	if err := json.Unmarshal(line, &e); err != nil {
		return nil, err
	}
	return &e, nil
}

// extractCall turns a team_room tool call plus its result into a CallRec.
func extractCall(sessionID string, callEntry *entry, block contentBlock, result *entry) *CallRec {
	var args teamArgs
	_ = json.Unmarshal(block.Arguments, &args)
	rec := &CallRec{
		SessionID:   sessionID,
		EntryID:     callEntry.ID,
		CallID:      block.ID,
		At:          parseTime(callEntry.Timestamp),
		Action:      args.Action,
		Agent:       strings.TrimSpace(args.Agent),
		Text:        args.Text,
		ReplyTo:     strings.TrimSpace(args.MessageID),
		DeliveryReq: args.Delivery,
		Delegation:  delegationFrom(&args),
	}
	if rec.Action == "" {
		rec.Action = "unknown"
	}
	if result != nil {
		rec.ResultID = result.ID
		rec.ResultAt = parseTime(result.Timestamp)
		rec.DurationMs = result.Message.DurationMs
		rec.Error = result.Message.IsError
		text := firstText(result.Message.Content)
		rec.Confirmation = text
		applyConfirmation(rec, text)
		if rec.Error && rec.ErrorText == "" {
			rec.ErrorText = text
		}
	}
	return rec
}

func delegationFrom(args *teamArgs) *Delegation {
	if args.Target == "" && args.Scope == "" && args.UserAuthorization == "" &&
		args.AcceptanceChecks == "" && args.ExpectedArtifact == "" {
		return nil
	}
	return &Delegation{
		Target:            args.Target,
		Scope:             args.Scope,
		UserAuthorization: args.UserAuthorization,
		AcceptanceChecks:  args.AcceptanceChecks,
		ExpectedArtifact:  args.ExpectedArtifact,
	}
}

// applyConfirmation reads back the extension's own confirmation line. It carries
// the resolved peer, the delivery mode that was actually selected (and whether
// the room chose it), and the short message id that ties the send to a delivery.
// roomAnswer is what the room said back about one call. The vocabulary below is taken
// from the transcripts themselves: the room answers in plain sentences, and it does
// not set isError for most failures. Anything that does not start with one of these
// prefixes is not the room talking - a transcript can contain the extension's own
// source code, or a history search result quoting an old confirmation - and parsing
// those would invent facts.
type roomAnswer struct {
	Kind   string // sent | read | rejected | "" (not the room speaking)
	Reason string // for rejected: a short label that can be counted
	Detail string // for rejected: the id or peer the room could not find
}

// roomVocabulary is the room's own way of saying what it did with a send. A refusal is
// reported as prose with isError left false, so the answer's wording is the only evidence
// that a call ever reached anybody, and it has to be read rather than guessed at.
type roomPhrase struct {
	prefix string
	kind   string // sent | read | rejected
	reason string // for rejected: a short, stable label that can be counted
	detail bool   // true when the sentence quotes back the thing the room could not find
}

var roomVocabulary = []roomPhrase{
	{"Reply sent to ", "sent", "", false},
	{"Question sent to ", "sent", "", false},
	{"Delegation sent to ", "sent", "", false},
	{"Shared with the team", "sent", "", false},
	{"Checkpoint saved", "sent", "", false},
	{"Saved to shared", "sent", "", false},
	{"Focus updated", "sent", "", false},

	{"Current checkpoint", "read", "", false},
	{"No checkpoint saved", "read", "", false},
	{"Team pulse", "read", "", false},
	{"No shared history", "read", "", false},
	{"Inbox is clear", "read", "", false},
	{"No teammate", "read", "", false},

	{"No message matching ", "rejected", "the message id did not match anything in the room", true},
	{"No active peer named or identified by ", "rejected", "no such peer is in the room", true},
	{"That message is a terminal ", "rejected", "tried to reply to a terminal acknowledgement", false},
	{"Already shared recently", "rejected", "the room already had that update", false},
	{"Delegation requires an agent and task", "rejected", "delegation called without an agent or task", false},
	{"Delegation requires target and scope", "rejected", "delegation called without target or scope", false},
	{"Ask requires an agent name and question", "rejected", "ask called without a name or question", false},
	{"Reply requires a message id and text", "rejected", "reply called without an id or text", false},
	{"Update cannot be empty", "rejected", "update called with no text", false},
	{"Checkpoint cannot be empty", "rejected", "checkpoint called with no text", false},
	{"A fact or decision is required.", "rejected", "remember called with no fact", false},
	{"Team room session is not ready", "rejected", "the sender had no room session yet", false},
	{"Team room is busy", "rejected", "the room's shared state stayed locked", false},
}

func classifyRoomAnswer(text string) roomAnswer {
	trim := strings.TrimSpace(text)
	for _, v := range roomVocabulary {
		if !strings.HasPrefix(trim, v.prefix) {
			continue
		}
		ans := roomAnswer{Kind: v.kind, Reason: v.reason}
		if ans.Kind == "rejected" && v.detail {
			// What the room could not find: the id it was handed, or the peer it was aimed
			// at. Everything after "found in" is the room's own sentence, not a reference.
			detail := strings.Trim(strings.TrimSpace(trim[len(v.prefix):]), ". ")
			if j := strings.Index(detail, " found in "); j >= 0 {
				detail = detail[:j]
			}
			ans.Detail = detail
		}
		return ans
	}
	return roomAnswer{}
}

func applyConfirmation(rec *CallRec, text string) {
	if text == "" {
		return
	}
	answer := classifyRoomAnswer(text)
	if answer.Kind == "rejected" {
		rec.Error = true
		rec.RejectReason = answer.Reason
		rec.MissingRef = answer.Detail
		rec.ErrorText = strings.TrimSpace(text)
		if answer.Reason == "no such peer is in the room" {
			// Keep the peer name the sender asked for: a refusal still says who it was aimed
			// at, and that is the only way to tell "wrong peer" from "no peer".
			name := strings.TrimPrefix(strings.TrimSpace(text), "No active peer named or identified by ")
			if j := strings.Index(name, " found"); j >= 0 {
				name = name[:j]
			}
			rec.Agent = strings.TrimSpace(name)
			rec.MissingRef = rec.Agent
		}
	}
	if answer.Kind != "sent" {
		return
	}
	if i := strings.Index(text, "message id: "); i >= 0 {
		if m := hexRun.FindString(text[i+len("message id: "):]); m != "" {
			rec.MessageShort = strings.ToLower(m)
		}
	}
	if i := strings.Index(text, "delivery: "); i >= 0 {
		rest := text[i+len("delivery: "):]
		word := regexp.MustCompile(`^[A-Za-z]+`).FindString(rest)
		rec.DeliveryUsed = word
		rec.DeliveryAuto = strings.HasPrefix(rest[len(word):], " (auto)")
	}
	if i := strings.Index(text, " sent to "); i >= 0 {
		rest := text[i+len(" sent to "):]
		if j := strings.Index(rest, " ["); j >= 0 {
			status := strings.SplitN(rest[j+2:], ";", 2)[0]
			if status == "working" || status == "idle" {
				rec.RecipientStatus = status
			}
		}
	}
}

func extractWake(sessionID string, e *entry) *Wake {
	var d wakeDetails
	_ = json.Unmarshal(e.Details, &d)
	body := plainText(e.Content)
	ids := append(stringsOf(d.MessageIDs), stringsOf(d.MessageID)...)
	from := stringsOf(d.From)
	kinds := append(stringsOf(d.Kinds), stringsOf(d.Kind)...)
	shape := "unknown"
	switch {
	case len(stringsOf(d.MessageIDs)) > 0 || rawCount(d.Delegations) > 1:
		shape = "batch"
	case len(stringsOf(d.MessageID)) > 0 || rawCount(d.Delegation) > 0:
		shape = "single"
	}
	return &Wake{
		SessionID:   sessionID,
		EntryID:     e.ID,
		At:          parseTime(e.Timestamp),
		MessageIDs:  ids,
		From:        from,
		Kinds:       kinds,
		Delivery:    d.Delivery,
		Body:        body,
		BodyChars:   len([]rune(body)),
		Delegations: rawCount(d.Delegations) + rawCount(d.Delegation),
		Shape:       shape,
	}
}

// isDirect reports whether an action is point-to-point rather than a room broadcast.
func isDirect(action string) bool {
	switch action {
	case "ask", "reply", "delegate", "steer":
		return true
	}
	return false
}

// stateKind maps the tool-facing action onto the kind the room stores.
func stateKind(action string) string {
	switch action {
	case "ask":
		return "question"
	case "delegate":
		return "delegation"
	case "reply":
		return "reply"
	case "steer":
		return "steer"
	default:
		return action
	}
}

func actionForKind(kind string) string {
	switch kind {
	case "question":
		return "ask"
	case "delegation":
		return "delegate"
	case "reply":
		return "reply"
	default:
		return kind
	}
}

func msString(v float64) string {
	return strconv.FormatFloat(v, 'f', 0, 64)
}
