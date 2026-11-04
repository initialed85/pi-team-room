package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// pendingCall holds a team_room tool call until its tool result lands, which can
// be a different read window than the call itself.
type pendingCall struct {
	entry *entry
	block contentBlock
}

type fileState struct {
	path      string
	dir       string
	sessionID string
	offset    int64
	size      int64
	mtime     time.Time
	hdrDone   bool
	pending   map[string]*pendingCall
	stable    int // consecutive polls with no size change, for truncated-tail rescue
}

// store is the incremental index over ~/.pi/agent/sessions. It keeps the
// team-room-relevant events plus enough session metadata to build both views, and
// deliberately does not hold whole transcripts: session timelines are re-read from
// the JSONL on demand.
type store struct {
	mu         sync.RWMutex
	dir        string
	files      map[string]*fileState
	sessions   map[string]*Session
	calls      []*CallRec
	wakes      []*Wake
	generation int64
	updatedAt  time.Time
	warned     map[string]string

	// What the last refresh actually looked at. Counted while the tree is already open,
	// so no caller has to walk it a second time and get a different answer.
	fileCount int
	indexedMB float64
}

func newStore(dir string) *store {
	return &store{
		dir:      dir,
		files:    map[string]*fileState{},
		sessions: map[string]*Session{},
		warned:   map[string]string{},
	}
}

func sessionIDFor(path string) string {
	base := filepath.Base(path)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	if i := strings.LastIndex(base, "_"); i >= 0 && i < len(base)-1 {
		return base[i+1:]
	}
	return base
}

func projectFor(cwd string) string {
	cwd = strings.TrimRight(cwd, "/")
	if cwd == "" {
		return "?"
	}
	parts := strings.Split(cwd, "/")
	return parts[len(parts)-1]
}

// hostFor labels a session that lives on another machine. Pi paths are Linux here
// and /Users/... on macOS, which is enough to keep the mac agent distinct.
func hostFor(cwd string) string {
	if strings.HasPrefix(cwd, "/Users/") {
		return "mac"
	}
	return ""
}

// refresh walks the session tree and consumes anything new. It returns whether
// anything changed so callers can skip rebuilding derived views.
func (s *store) refresh() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	seen := map[string]bool{}
	var discoveryErr error
	files := 0
	var mb float64
	dirs, err := os.ReadDir(s.dir)
	if err != nil {
		return false, err
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(s.dir, d.Name()))
		if err != nil {
			discoveryErr = err
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(s.dir, d.Name(), e.Name())
			seen[path] = true
			info, err := e.Info()
			if err != nil {
				discoveryErr = err
				continue
			}
			files++
			mb += float64(info.Size()) / (1024 * 1024)
			fs, ok := s.files[path]
			if !ok {
				fs = &fileState{path: path, dir: d.Name(), sessionID: sessionIDFor(path), pending: map[string]*pendingCall{}}
				s.files[path] = fs
			}
			size, mtime := info.Size(), info.ModTime()
			if fs.hdrDone && size == fs.size && mtime.Equal(fs.mtime) {
				fs.stable++
				continue
			}
			if size < fs.offset {
				// The file shrank: a rewrite. Drop everything derived from it.
				s.dropSession(fs.sessionID, path)
				fs.offset, fs.hdrDone = 0, false
				fs.pending = map[string]*pendingCall{}
			}
			if err := s.consume(fs, size); err != nil {
				if s.warned[path] != err.Error() {
					s.warned[path] = err.Error()
				}
				continue
			}
			fs.size, fs.mtime, fs.stable = size, mtime, 0
		}
	}

	s.fileCount, s.indexedMB = files, mb

	for path, fs := range s.files {
		if !seen[path] {
			s.dropSession(fs.sessionID, path)
			delete(s.files, path)
		}
	}

	changed := false
	for _, fs := range s.files {
		if fs.stable == 0 {
			changed = true
			break
		}
	}
	if changed {
		s.generation++
		s.updatedAt = time.Now().UTC()
	}
	return changed, discoveryErr
}

var errPartialLine = errors.New("partial line")

func (s *store) consume(fs *fileState, size int64) error {
	fh, err := os.Open(fs.path)
	if err != nil {
		return err
	}
	defer fh.Close()
	if _, err := fh.Seek(fs.offset, io.SeekStart); err != nil {
		return err
	}
	r := bufio.NewReaderSize(fh, 1<<20)
	consumed := int64(fs.offset)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) == 0 {
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			continue
		}
		if !bytes.HasSuffix(line, []byte("\n")) {
			// A line still being written. Trust it only once the file has stopped
			// growing, otherwise a half-written line can poison the index.
			if size-consumed == int64(len(line)) && fs.stable > 0 {
				s.line(fs, line)
				consumed += int64(len(line))
			}
			break
		}
		s.line(fs, line)
		consumed += int64(len(line))
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	fs.offset = consumed
	return nil
}

func (s *store) line(fs *fileState, line []byte) {
	fact := scanLine(line)
	typ := fact.Type
	if typ == "session" {
		var hdr sessionHeader
		if json.Unmarshal(line, &hdr) == nil {
			if hdr.ID != "" && hdr.ID != fs.sessionID {
				s.dropSession(fs.sessionID, fs.path)
				fs.sessionID = hdr.ID
			}
			sess := s.session(fs)
			sess.ID = hdr.ID
			sess.Cwd = hdr.CWD
			sess.Project = projectFor(hdr.CWD)
			sess.Host = hostFor(hdr.CWD)
			if t := parseTime(hdr.Timestamp); !t.IsZero() {
				sess.Started = t
			}
		}
		fs.hdrDone = true
		return
	}
	fs.hdrDone = true
	sess := s.session(fs)
	sess.Entries++
	role := fact.Role
	switch {
	case typ == "message":
		key := role
		if key == "" {
			key = "message"
		}
		sess.bump(key)
		if role == "user" {
			text := strings.TrimSpace(plainTextLast(line))
			if text != "" {
				sess.Preview = clipPreview(normSpace(text), 220)
			}
		}
	case typ == "custom", typ == "custom_message", typ == "compaction", typ == "context_edit":
		sess.bump(typ)
	default:
		if typ != "" {
			sess.bump(typ)
		}
	}
	if !fact.At.IsZero() {
		sess.Last = fact.At
	}

	switch {
	case bytes.Contains(line, wakeMarker):
		e, err := decodeEntry(line)
		if err != nil || e.Type != "custom_message" {
			return
		}
		w := extractWake(fs.sessionID, e)
		s.wakes = append(s.wakes, w)
		sess.Wakes++
	case bytes.Contains(line, teamRoomMarker):
		e, err := decodeEntry(line)
		if err != nil {
			return
		}
		s.teamRoomLine(fs, sess, e)
	case bytes.Contains(line, sessionInfoMarker):
		e, err := decodeEntry(line)
		if err != nil {
			return
		}
		if e.Type == "session_info" && e.Name != "" {
			sess.Name = e.Name
		}
	}
}

// teamRoomLine pairs a team_room call block with the tool result that confirms it.
func (s *store) teamRoomLine(fs *fileState, sess *Session, e *entry) {
	switch e.Type {
	case "message":
		m := e.Message
		if m == nil {
			return
		}
		if m.Role == "assistant" {
			for _, b := range blocks(m.Content) {
				if b.Type == "toolCall" && b.Name == "team_room" {
					fs.pending[b.ID] = &pendingCall{entry: e, block: b}
				}
			}
			return
		}
		if m.Role == "toolResult" && m.ToolName == "team_room" {
			p := fs.pending[m.ToolCallID]
			if p == nil {
				// A result with no visible call: a slash command or an older file.
				p = &pendingCall{entry: e, block: contentBlock{Type: "toolCall", Name: "team_room"}}
			}
			delete(fs.pending, m.ToolCallID)
			rec := extractCall(fs.sessionID, p.entry, p.block, e)
			s.calls = append(s.calls, rec)
			sess.TeamRoom++
		}
	}
}

func (s *store) session(fs *fileState) *Session {
	if sess, ok := s.sessions[fs.sessionID]; ok && sess.File == fs.path {
		return sess
	}
	sess := &Session{
		ID:        fs.sessionID,
		File:      fs.path,
		Dir:       fs.dir,
		IndexedAt: time.Now().UTC(),
		Counts:    map[string]int{},
	}
	if fs.sessionID != "" {
		s.sessions[fs.sessionID] = sess
	}
	return sess
}

func (sess *Session) bump(key string) {
	if sess.Counts == nil {
		sess.Counts = map[string]int{}
	}
	sess.Counts[key]++
}

func (s *store) dropSession(id, path string) {
	delete(s.sessions, id)
	out := s.calls[:0]
	for _, c := range s.calls {
		if c.SessionID != id {
			out = append(out, c)
		}
	}
	s.calls = out
	wakes := s.wakes[:0]
	for _, w := range s.wakes {
		if w.SessionID != id {
			wakes = append(wakes, w)
		}
	}
	s.wakes = wakes
	for _, fs := range s.files {
		if fs.path == path {
			fs.pending = map[string]*pendingCall{}
		}
	}
}

// plainTextLast pulls the text out of the message content on a line without a
// full decode of the entry, used only for the session preview.
func plainTextLast(line []byte) string {
	i := bytes.Index(line, []byte(`"content":`))
	if i < 0 {
		return ""
	}
	var raw json.RawMessage = line[i+len(`"content":`):]
	// Trim to the end of the content value by decoding just that prefix.
	dec := json.NewDecoder(bytes.NewReader(raw))
	var v any
	if dec.Decode(&v) != nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var b strings.Builder
		for _, item := range t {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if s, _ := m["text"].(string); s != "" {
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

func (s *store) snapshotSessions() []Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		cp := *sess
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Last.After(out[j].Last) })
	return out
}

func (s *store) snapshotCalls() []CallRec {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]CallRec, len(s.calls))
	for i, c := range s.calls {
		out[i] = *c
	}
	return out
}

func (s *store) snapshotWakes() []Wake {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Wake, len(s.wakes))
	for i, w := range s.wakes {
		out[i] = *w
	}
	return out
}

func (s *store) sessionByFile(path string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sess := range s.sessions {
		if sess.File == path {
			return *sess, true
		}
	}
	return Session{}, false
}
