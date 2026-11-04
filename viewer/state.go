package main

import (
	"encoding/json"
	"os"
	"time"
)

// roomState mirrors ~/.pi/team-room/state.json. It is the only source that knows
// the read receipt and the room's own message id, so the viewer merges it with the
// transcripts rather than treating either side as complete.
type roomState struct {
	Version  int            `json:"version"`
	Sessions []stateSession `json:"sessions"`
	Messages []stateMessage `json:"messages"`
	Updates  []stateUpdate  `json:"updates"`
	Journal  []stateJournal `json:"journal"`

	path     string
	size     int64
	modTime  time.Time
	loadedAt time.Time
}

type stateSession struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Cwd         string      `json:"cwd"`
	Project     string      `json:"project"`
	Branch      string      `json:"branch,omitempty"`
	Focus       string      `json:"focus,omitempty"`
	FocusPinned bool        `json:"focusPinned,omitempty"`
	Status      string      `json:"status"`
	Connected   bool        `json:"connected"`
	StartedAt   string      `json:"startedAt,omitempty"`
	UpdatedAt   string      `json:"updatedAt"`
	LastSeenAt  string      `json:"lastSeenAt"`
	LastReadAt  string      `json:"lastReadAt,omitempty"`
	LastPulseAt string      `json:"lastPulseAt,omitempty"`
	Checkpoint  *checkpoint `json:"checkpoint,omitempty"`
	RecentPaths []string    `json:"recentPaths,omitempty"`
}

type checkpoint struct {
	Text      string `json:"text"`
	UpdatedAt string `json:"updatedAt"`
	SessionID string `json:"sessionId"`
	Auto      bool   `json:"auto,omitempty"`
}

type stateMessage struct {
	ID            string      `json:"id"`
	Kind          string      `json:"kind"`
	FromSessionID string      `json:"fromSessionId"`
	FromName      string      `json:"fromName"`
	ToSessionID   string      `json:"toSessionId"`
	Text          string      `json:"text"`
	CreatedAt     string      `json:"createdAt"`
	DeliveredAt   string      `json:"deliveredAt,omitempty"`
	ReadAt        string      `json:"readAt,omitempty"`
	ReplyToID     string      `json:"replyToId,omitempty"`
	Delivery      string      `json:"delivery,omitempty"`
	Delegation    *Delegation `json:"delegation,omitempty"`
}

type stateUpdate struct {
	ID          string `json:"id"`
	SessionID   string `json:"sessionId"`
	SessionName string `json:"sessionName"`
	Project     string `json:"project"`
	Text        string `json:"text"`
	CreatedAt   string `json:"createdAt"`
}

type stateJournal struct {
	ID          string `json:"id"`
	Project     string `json:"project"`
	SessionName string `json:"sessionName"`
	Text        string `json:"text"`
	CreatedAt   string `json:"createdAt"`
}

func loadRoomState(path string, prev *roomState) (*roomState, bool) {
	info, err := os.Stat(path)
	if err != nil {
		if prev != nil {
			return prev, false
		}
		return &roomState{path: path}, false
	}
	if prev != nil && prev.size == info.Size() && prev.modTime.Equal(info.ModTime()) {
		return prev, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if prev != nil {
			return prev, false
		}
		return &roomState{path: path}, false
	}
	var st roomState
	if err := json.Unmarshal(raw, &st); err != nil {
		if prev != nil {
			return prev, false
		}
		return &roomState{path: path}, false
	}
	st.path, st.size, st.modTime = path, info.Size(), info.ModTime()
	st.loadedAt = time.Now().UTC()
	return &st, true
}

// shortID matches the extension's own confirmations, which quote eight hex chars.
func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

func (r *roomState) messageIndex() (map[string]*stateMessage, map[string]*stateMessage) {
	byID := map[string]*stateMessage{}
	byShort := map[string]*stateMessage{}
	if r == nil {
		return byID, byShort
	}
	for i := range r.Messages {
		m := &r.Messages[i]
		byID[m.ID] = m
		byShort[shortID(m.ID)] = m
	}
	return byID, byShort
}

func (r *roomState) sessionIndex() map[string]*stateSession {
	out := map[string]*stateSession{}
	if r == nil {
		return out
	}
	for i := range r.Sessions {
		s := &r.Sessions[i]
		out[s.ID] = s
	}
	return out
}
