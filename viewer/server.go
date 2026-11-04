package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type server struct {
	dir       string
	statePath string
	interval  time.Duration

	store *store

	mu          sync.Mutex
	state       *roomState
	view        *view
	base        *view
	generation  int64
	scanSeconds float64
	indexedMB   float64
	warnings    []string

	subsMu sync.Mutex
	subs   map[chan string]bool
}

func newServer(dir, statePath string, interval time.Duration) *server {
	return &server{
		dir:       dir,
		statePath: statePath,
		interval:  interval,
		store:     newStore(dir),
		subs:      map[chan string]bool{},
	}
}

// poll keeps the index, the room state, and the built view in step with the files.
// Only the appended tail of each transcript is read, so a 150MB corpus costs about
// the same per tick as a single session.
func (s *server) poll() {
	tick := time.NewTicker(s.interval)
	defer tick.Stop()
	for range tick.C {
		s.refreshOnce()
	}
}

func (s *server) refreshOnce() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	started := time.Now()
	changed, scanErr := s.store.refresh()
	state, stateChanged := loadRoomState(s.statePath, s.state)
	s.state = state
	if scanErr != nil {
		log.Printf("scan: %v", scanErr)
	}
	if changed || stateChanged || s.base == nil {
		s.scanSeconds = time.Since(started).Seconds()
		s.base = buildView(s.snapshot(), s.store.generation)
		s.warnings = warningsOf(s.base)
		s.notify()
	}
	return changed || stateChanged
}

func (s *server) snapshot() dataset {
	sessions := s.store.snapshotSessions()
	calls := s.store.snapshotCalls()
	wakes := s.store.snapshotWakes()
	ds := build(sessions, calls, wakes, s.state)
	// The store already walked the tree to scan it. Reuse that measurement instead of
	// walking again per request, which is how the health endpoint and the live stream
	// came to quote different numbers for the same transcripts.
	s.store.mu.RLock()
	ds.Health.Files, ds.Health.IndexedMB = s.store.fileCount, s.store.indexedMB
	s.store.mu.RUnlock()
	return *ds
}

// buildView applies the default grouping; the request layer re-groups on demand from
// the same dataset so view options are cheap.
func buildView(ds dataset, generation int64) *view {
	opts := defaultOptions()
	flagOutcomes(&ds, opts)
	chats := buildChats(&ds, opts)
	v := &view{
		Generation:  generation,
		Mode:        opts.Mode,
		Options:     opts,
		Chats:       chats,
		Sessions:    sessionSummaries(&ds, opts),
		Messages:    ds.Direct,
		Broadcast:   ds.Broadcast,
		Rejected:    ds.Rejected,
		Repeats:     ds.Repeats,
		Health:      ds.Health,
		GeneratedAt: time.Now().UTC(),
	}
	return v
}

func (s *server) currentView(opts groupOptions) *view {
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	if base == nil {
		return nil
	}
	if opts.Mode == base.Options.Mode && !opts.Split && opts.Actor == base.Options.Actor &&
		opts.Search == base.Options.Search && opts.Window == base.Options.Window &&
		opts.Limit == base.Options.Limit {
		return base
	}
	ds := s.snapshot()
	flagOutcomes(&ds, opts)
	v := &view{
		Generation:  base.Generation,
		Mode:        opts.Mode,
		Options:     opts,
		Chats:       buildChats(&ds, opts),
		Sessions:    sessionSummaries(&ds, opts),
		Messages:    ds.Direct,
		Broadcast:   ds.Broadcast,
		Rejected:    ds.Rejected,
		Repeats:     ds.Repeats,
		Health:      ds.Health,
		GeneratedAt: time.Now().UTC(),
	}
	return v
}

// warningsOf turns the counts a chat client would rather not show into a short list
// of things a human should look at.
func warningsOf(v *view) []string {
	if v == nil {
		return nil
	}
	out := []string{}
	for _, r := range v.Repeats {
		if r.Count < 3 {
			continue
		}
		alsoSaid := ""
		if r.Rejected > 0 {
			if r.Rejected == r.Count {
				alsoSaid = " - and the room rejected every one of them"
			} else {
				alsoSaid = fmt.Sprintf(" - %d of them rejected by the room", r.Rejected)
			}
		}
		out = append(out, fmt.Sprintf("%s sent the same %s %d times in %s%s: %s",
			r.Actor, r.Kind, r.Count, humanSpan(r.SpanSec), alsoSaid, clipPreview(r.Text, 120)))
		if len(out) >= 6 {
			break
		}
	}
	if v.Health.Rejected > 0 {
		out = append(out, fmt.Sprintf("the room rejected %d sends: %s",
			v.Health.Rejected, joinReasons(v.Health.RejectReasons)))
	}
	shapes := make([]string, 0, len(v.Health.WakeShapes))
	for shape, n := range v.Health.WakeShapes {
		shapes = append(shapes, fmt.Sprintf("%s %d", shape, n))
	}
	sort.Strings(shapes)
	if len(shapes) > 1 {
		out = append(out, "wake details arrive in "+itoa(len(shapes))+" shapes ("+strings.Join(shapes, ", ")+"): the extension changed format mid-history")
	}
	if v.Health.BadReplyRefs > 0 {
		out = append(out, fmt.Sprintf("%d replies quote something that is not a message id: %s",
			v.Health.BadReplyRefs, joinReasons(v.Health.BadReplyReasons)))
	}
	if v.Health.UnresolvedSend > 0 {
		out = append(out, itoa(v.Health.UnresolvedSend)+" sends never resolved a peer")
	}
	if v.Health.Direct > 0 && v.Health.Matched < v.Health.Direct {
		out = append(out, fmt.Sprintf("%d of %d messages are only visible from one side (the room record aged out)",
			v.Health.Direct-v.Health.Matched, v.Health.Direct))
	}
	return out
}

// notify broadcasts a generation update to SSE subscribers. Callers must already
// hold s.mu - refreshOnce does, and taking it again here deadlocks the whole server.
func (s *server) notify() {
	warnings, _ := json.Marshal(s.warnings)
	payload := fmt.Sprintf(`{"generation":%d,"generatedAt":%q,"warnings":%s,"health":%s}`,
		s.base.Generation, s.base.GeneratedAt.Format(time.RFC3339Nano), string(warnings), jsonText(s.base.Health))
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- payload:
		default:
		}
	}
}

func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/chats", s.handleChats)
	mux.HandleFunc("/api/chat", s.handleChat)
	mux.HandleFunc("/api/sessions", s.handleSessions)
	mux.HandleFunc("/api/session", s.handleSession)
	mux.HandleFunc("/api/broadcast", s.handleBroadcast)
	mux.HandleFunc("/api/rejects", s.handleRejects)
	mux.HandleFunc("/api/repeats", s.handleRepeats)
	mux.HandleFunc("/api/messages", s.handleMessages)
	mux.HandleFunc("/api/events", s.handleEvents)
	return logRequests(mux)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			start := time.Now()
			next.ServeHTTP(w, r)
			log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func optionsFrom(r *http.Request) groupOptions {
	opts := defaultOptions()
	q := r.URL.Query()
	if v := q.Get("mode"); v == "sessions" || v == "participants" {
		opts.Mode = v
	}
	if v := q.Get("actor"); v != "" {
		opts.Actor = v
	}
	if v := q.Get("q"); v != "" {
		opts.Search = v
	}
	if q.Get("split") == "1" {
		opts.Split = true
	}
	if v := q.Get("window"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			opts.Window = time.Duration(n) * time.Minute
		}
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			opts.Limit = n
		}
	}
	return opts
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(indexHTML)
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	base := s.base
	warnings := append([]string{}, s.warnings...)
	s.mu.Unlock()
	h := Health{}
	if base != nil {
		h = base.Health
	}
	h.ScanSeconds = s.scanSeconds
	writeJSON(w, map[string]any{
		"health":       h,
		"warnings":     warnings,
		"generation":   s.generationCounter(),
		"sessionsDir":  s.dir,
		"statePath":    s.statePath,
		"pollInterval": s.interval.String(),
	})
}

func (s *server) generationCounter() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.base == nil {
		return 0
	}
	return s.base.Generation
}

// chatMeta strips message bodies so the chat list stays a list.
type chatMeta struct {
	ID             string    `json:"id"`
	Label          string    `json:"label"`
	Actors         []string  `json:"actors"`
	Mode           string    `json:"mode"`
	Distinct       int       `json:"distinct"`
	FirstAt        time.Time `json:"firstAt,omitempty"`
	LastAt         time.Time `json:"lastAt,omitempty"`
	Episodes       int       `json:"episodes,omitempty"`
	Sessions       []string  `json:"sessions,omitempty"`
	Count          int       `json:"messages"`
	Asks           int       `json:"asks"`
	Replies        int       `json:"replies"`
	Delegations    int       `json:"delegations"`
	Steers         int       `json:"steers"`
	Wakes          int       `json:"wakes"`
	MaxWakes       int       `json:"maxWakesOnOneMessage,omitempty"`
	Unanswered     int       `json:"unanswered"`
	Pending        int       `json:"pending"`
	Rejected       int       `json:"rejected"`
	RepeatBubbles  int       `json:"repeatBubbles"`
	MaxRepeat      int       `json:"maxRepeat"`
	SelfLoops      int       `json:"selfLoops"`
	UnresolvedSend int       `json:"unresolvedSends"`
}

func metaOf(c Chat) chatMeta {
	return chatMeta{
		ID: c.ID, Label: c.Label, Actors: c.Actors, Mode: c.Mode, Distinct: c.Distinct,
		FirstAt: c.FirstAt, LastAt: c.LastAt, Episodes: c.Episodes, Sessions: c.Sessions,
		Count: len(c.Messages), Asks: c.Asks, Replies: c.Replies, Delegations: c.Delegations,
		Steers: c.Steers, Wakes: c.Wakes, MaxWakes: c.MaxWakes, Unanswered: c.Unanswered,
		Pending: c.Pending, Rejected: c.Rejected, RepeatBubbles: c.RepeatBubbles,
		MaxRepeat: c.MaxRepeat, SelfLoops: c.SelfLoops, UnresolvedSend: c.UnresolvedSend,
	}
}

func (s *server) handleChats(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(optionsFrom(r))
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	metas := make([]chatMeta, 0, len(v.Chats))
	for _, c := range v.Chats {
		metas = append(metas, metaOf(c))
	}
	writeJSON(w, map[string]any{
		"generation": v.Generation, "mode": v.Mode, "options": v.Options,
		"health": v.Health, "chats": metas, "warnings": warningsOf(v),
		"repeats": v.Repeats, "rejectedSends": v.Rejected,
	})
}

func (s *server) handleChat(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	v := s.currentView(optionsFrom(r))
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	for _, c := range v.Chats {
		if c.ID == id {
			limit := 400
			if lv := r.URL.Query().Get("limit"); lv != "" {
				if n, err := strconv.Atoi(lv); err == nil && n > 0 {
					limit = n
				}
			}
			msgs := c.Messages
			truncated := false
			if len(msgs) > limit {
				msgs = msgs[len(msgs)-limit:]
				truncated = true
			}
			writeJSON(w, map[string]any{
				"generation": v.Generation, "chat": metaOf(c), "messages": msgs,
				"truncated": truncated, "total": len(c.Messages),
			})
			return
		}
	}
	http.NotFound(w, r)
}

// warningsOf reads the anomaly list stored with the current base view.
func (s *server) warningsLocked() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.warnings...)
}

func (s *server) handleSessions(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(optionsFrom(r))
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	writeJSON(w, map[string]any{
		"generation": v.Generation, "health": v.Health, "sessions": v.Sessions,
		"warnings": s.warningsLocked(),
	})
}

func (s *server) handleSession(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	sessions := s.store.snapshotSessions()
	var found *Session
	for i := range sessions {
		sess := sessions[i]
		if sess.ID == id || shortID(sess.ID) == id || strings.HasPrefix(sess.ID, id) {
			found = &sess
			break
		}
	}
	if found == nil {
		http.NotFound(w, r)
		return
	}
	opts := timelineOptions{Limit: 200, Offset: 0, Only: q.Get("only")}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			opts.Limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			opts.Offset = n
		}
	}
	items, total, err := sessionTimeline(found.File, opts)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	v := s.currentView(defaultOptions())
	var summary *SessionSummary
	if v != nil {
		for i := range v.Sessions {
			if v.Sessions[i].ID == found.ID {
				summary = &v.Sessions[i]
				break
			}
		}
	}
	writeJSON(w, map[string]any{
		"session": found, "summary": summary, "timeline": items,
		"total": total, "offset": opts.Offset, "limit": opts.Limit,
		"hasMore": opts.Offset+opts.Limit < total,
	})
}

// handleRejects lists the sends the room rejected, newest first. These never become
// messages, so they are invisible to every other view unless asked for.
func (s *server) handleRejects(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(optionsFrom(r))
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	limit := 200
	if lv := r.URL.Query().Get("limit"); lv != "" {
		if n, err := strconv.Atoi(lv); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}
	out := make([]*RoomMessage, 0, limit)
	for i := len(v.Rejected) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, v.Rejected[i])
	}
	writeJSON(w, map[string]any{"total": len(v.Rejected), "reasons": v.Health.RejectReasons, "sends": out})
}

func (s *server) handleRepeats(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(optionsFrom(r))
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	writeJSON(w, map[string]any{"groups": v.Repeats, "bubbles": v.Health.RepeatBubbles})
}

func (s *server) handleBroadcast(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(defaultOptions())
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	limit := 200
	if lv := r.URL.Query().Get("limit"); lv != "" {
		if n, err := strconv.Atoi(lv); err == nil && n > 0 {
			limit = n
		}
	}
	kind := r.URL.Query().Get("kind")
	actor := strings.ToLower(r.URL.Query().Get("actor"))
	out := make([]*RoomMessage, 0, limit)
	for i := len(v.Broadcast) - 1; i >= 0 && len(out) < limit; i-- {
		m := v.Broadcast[i]
		if kind != "" && m.Kind != kind {
			continue
		}
		if actor != "" && !strings.Contains(strings.ToLower(m.FromActor), actor) {
			continue
		}
		out = append(out, m)
	}
	writeJSON(w, map[string]any{"generation": v.Generation, "broadcast": out, "total": len(v.Broadcast)})
}

func (s *server) handleMessages(w http.ResponseWriter, r *http.Request) {
	v := s.currentView(defaultOptions())
	if v == nil {
		writeJSON(w, map[string]any{"error": "index not ready"})
		return
	}
	q := r.URL.Query()
	limit := 200
	if lv := q.Get("limit"); lv != "" {
		if n, err := strconv.Atoi(lv); err == nil && n > 0 {
			limit = n
		}
	}
	want := strings.ToLower(q.Get("q"))
	actor := strings.ToLower(q.Get("actor"))
	kind := q.Get("kind")
	only := q.Get("only")
	out := make([]*RoomMessage, 0, limit)
	for i := len(v.Messages) - 1; i >= 0 && len(out) < limit; i-- {
		m := v.Messages[i]
		if kind != "" && m.Kind != kind {
			continue
		}
		if actor != "" && !strings.Contains(strings.ToLower(m.FromActor), actor) &&
			!strings.Contains(strings.ToLower(m.ToActor), actor) {
			continue
		}
		if only == "unanswered" && (m.Answered || m.Kind == "reply") {
			continue
		}
		if only == "pending" && !m.Pending {
			continue
		}
		if only == "errors" && !m.Error {
			continue
		}
		if want != "" && !strings.Contains(strings.ToLower(m.Text), want) &&
			!strings.Contains(strings.ToLower(m.Confirmation), want) {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SentAt.Before(out[j].SentAt) })
	writeJSON(w, map[string]any{
		"generation": v.Generation, "messages": out, "total": len(v.Messages), "shown": len(out),
	})
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch := make(chan string, 8)
	s.subsMu.Lock()
	s.subs[ch] = true
	s.subsMu.Unlock()
	defer func() {
		s.subsMu.Lock()
		delete(s.subs, ch)
		s.subsMu.Unlock()
	}()

	ctx := r.Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	s.mu.Lock()
	if s.base != nil {
		fmt.Fprintf(w, "event: update\ndata: %s\n\n", fmt.Sprintf(
			`{"generation":%d,"generatedAt":%q,"health":%s}`,
			s.base.Generation, s.base.GeneratedAt.Format(time.RFC3339Nano), jsonText(s.base.Health)))
		flusher.Flush()
	}
	s.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case payload := <-ch:
			fmt.Fprintf(w, "event: update\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// joinReasons flattens a reason -> count map into "44 × x; 13 × y", worst first.
func joinReasons(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%d × %s", m[k], k))
	}
	return strings.Join(parts, "; ")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}
