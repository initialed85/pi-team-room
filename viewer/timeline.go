package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sort"
	"time"
)

// TimelineItem is one entry of a session's raw story, which is what the session view
// is for: seeing the exact context an agent was carrying when it sent or received a
// teammate message.
type TimelineItem struct {
	EntryID    string    `json:"entryId"`
	ParentID   string    `json:"parentId,omitempty"`
	At         time.Time `json:"at,omitempty"`
	Kind       string    `json:"kind"`
	Tool       string    `json:"tool,omitempty"`
	Text       string    `json:"text,omitempty"`
	Thinking   string    `json:"thinking,omitempty"`
	Preview    string    `json:"preview,omitempty"`
	Chars      int       `json:"chars,omitempty"`
	Model      string    `json:"model,omitempty"`
	IsError    bool      `json:"isError,omitempty"`
	DurationMs float64   `json:"durationMs,omitempty"`
	TeamRoom   *CallRec  `json:"teamRoom,omitempty"`
	Wake       *Wake     `json:"wake,omitempty"`
	Name       string    `json:"name,omitempty"`
	Summary    string    `json:"summary,omitempty"`
}

type timelineOptions struct {
	Limit  int // newest items to return
	Offset int // items dropped from the tail side of the page (0 = most recent page)
	Before time.Time
	After  time.Time
	Only   string // "team" restricts to team-room traffic
}

// sessionTimeline reads one JSONL file fresh. Transcripts are large and this is a
// per-click request, so it streams rather than keeping them resident.
func sessionTimeline(path string, opts timelineOptions) ([]TimelineItem, int, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()
	all := make([]TimelineItem, 0, 256)
	r := bufio.NewReaderSize(fh, 1<<20)
	pending := map[string]*pendingCall{}
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if e, derr := decodeEntry(line); derr == nil {
				item, items := timelineEntry(e, pending)
				for _, it := range items {
					if !keepItem(it, opts) {
						continue
					}
					all = append(all, it)
				}
				_ = item
			}
		}
		if err != nil {
			break
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].At.Before(all[j].At) })
	total := len(all)
	if opts.Limit <= 0 {
		opts.Limit = 200
	}
	end := total - opts.Offset
	start := end - opts.Limit
	if start < 0 {
		start = 0
	}
	if end < start {
		end = start
	}
	return all[start:end], total, nil
}

func keepItem(it TimelineItem, opts timelineOptions) bool {
	if opts.Only == "team" && it.TeamRoom == nil && it.Wake == nil && it.Kind != "user" {
		return false
	}
	if !opts.Before.IsZero() && it.At.After(opts.Before) {
		return false
	}
	if !opts.After.IsZero() && it.At.Before(opts.After) {
		return false
	}
	return true
}

func timelineEntry(e *entry, pending map[string]*pendingCall) (*TimelineItem, []TimelineItem) {
	switch e.Type {
	case "session":
		return nil, []TimelineItem{{EntryID: e.ID, At: parseTime(e.Timestamp), Kind: "session", Text: e.Cwd}}
	case "session_info":
		return nil, []TimelineItem{{EntryID: e.ID, At: parseTime(e.Timestamp), Kind: "session_info", Name: e.Name}}
	case "compaction", "context_edit":
		return nil, []TimelineItem{{
			EntryID: e.ID, At: parseTime(e.Timestamp), Kind: e.Type,
			Summary: clipPreview(e.Summary, 300),
		}}
	case "custom_message", "custom":
		if e.CustomType == "pi-team-room-wake" {
			w := extractWake("", e)
			w.SessionID = ""
			body := clipPreview(wakeBody(w.Body), 900)
			return nil, []TimelineItem{{
				EntryID: e.ID, ParentID: deref(e.ParentID), At: parseTime(e.Timestamp), Kind: "wake",
				Text: body, Chars: w.BodyChars, Wake: w,
			}}
		}
		return nil, []TimelineItem{{
			EntryID: e.ID, At: parseTime(e.Timestamp), Kind: "custom", Name: e.CustomType,
			Text: clipPreview(plainText(e.Content), 500),
		}}
	case "message":
		m := e.Message
		if m == nil {
			return nil, nil
		}
		switch m.Role {
		case "user":
			text := firstText(m.Content)
			return nil, []TimelineItem{{
				EntryID: e.ID, ParentID: deref(e.ParentID), At: parseTime(e.Timestamp), Kind: "user",
				Text: text, Chars: len([]rune(text)),
			}}
		case "assistant":
			var out []TimelineItem
			thinking := ""
			text := ""
			for _, b := range blocks(m.Content) {
				switch b.Type {
				case "thinking":
					thinking += b.Thinking
				case "text":
					text += b.Text
				case "toolCall":
					it := TimelineItem{
						EntryID: e.ID + ":" + b.ID, ParentID: deref(e.ParentID), At: parseTime(e.Timestamp),
						Kind: "tool", Tool: b.Name, Preview: preview(string(b.Arguments), 400),
						Chars: len(string(b.Arguments)),
					}
					if b.Name == "team_room" {
						pending[b.ID] = &pendingCall{entry: e, block: b}
						var args teamArgs
						_ = json.Unmarshal(b.Arguments, &args)
						rec := &CallRec{
							EntryID: e.ID, CallID: b.ID, At: parseTime(e.Timestamp), Action: args.Action,
							Agent: args.Agent, Text: clipPreview(args.Text, 4000), ReplyTo: args.MessageID,
							DeliveryReq: args.Delivery, Delegation: delegationFrom(&args),
						}
						it.TeamRoom = rec
						it.Tool = "team_room"
						it.Preview = ""
						it.Text = clipPreview(args.Text, 2000)
					}
					out = append(out, it)
				}
			}
			if thinking != "" || text != "" {
				out = append([]TimelineItem{{
					EntryID: e.ID, ParentID: deref(e.ParentID), At: parseTime(e.Timestamp), Kind: "assistant",
					Text: clipPreview(text, 3000), Thinking: clipPreview(thinking, 1500),
					Chars: len([]rune(text + thinking)), Model: m.Model,
				}}, out...)
			}
			return nil, out
		case "toolResult":
			text := plainText(m.Content)
			it := TimelineItem{
				EntryID: e.ID, ParentID: deref(e.ParentID), At: parseTime(e.Timestamp), Kind: "tool_result",
				Tool: m.ToolName, Preview: clipPreview(normSpace(text), 700), Chars: len([]rune(text)),
				IsError: m.IsError, DurationMs: m.DurationMs,
			}
			if m.ToolName == "team_room" {
				if p := pending[m.ToolCallID]; p != nil {
					delete(pending, m.ToolCallID)
					rec := extractCall("", p.entry, p.block, e)
					rec.SessionID = ""
					it.TeamRoom = rec
					it.Text = clipPreview(rec.Confirmation, 1200)
				}
			}
			return nil, []TimelineItem{it}
		}
	}
	return nil, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func preview(s string, max int) string {
	return clipPreview(normSpace(s), max)
}

// mergeRoomTimeline rebuilds the direct-message view for a time window straight from
// the transcripts, which is how the replay mode stays honest: nothing is served from
// a cache that has already moved on.
func mergeRoomTimeline(ds *dataset, paths map[string]bool, from, to time.Time) []*RoomMessage {
	out := []*RoomMessage{}
	for _, m := range ds.Direct {
		if len(paths) > 0 && !paths[m.FromSession] && !paths[m.ToSession] && !anyIn(paths, m.WokenBy) {
			continue
		}
		if !from.IsZero() && m.SentAt.Before(from) {
			continue
		}
		if !to.IsZero() && m.SentAt.After(to) {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SentAt.Before(out[j].SentAt) })
	return out
}

func anyIn(paths map[string]bool, xs []string) bool {
	for _, x := range xs {
		if paths[x] {
			return true
		}
	}
	return false
}
