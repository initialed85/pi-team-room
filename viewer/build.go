package main

import (
	"sort"
	"strings"
	"time"
)

// actorTable gives every session a stable, human-readable participant label.
// Pi session names are already short ("home-ops", "coder-1", "rooter"); the pulse
// renders them as "home-ops focused on <focus>", which agents then copy into
// `agent:`, so focus variants must fold back onto the underlying agent.
type actorTable struct {
	bySession map[string]string
	byName    map[string]string
	projects  map[string]bool
}

func newActorTable(sessions []Session, st *roomState) *actorTable {
	a := &actorTable{
		bySession: map[string]string{},
		byName:    map[string]string{},
		projects:  map[string]bool{},
	}
	for _, s := range sessions {
		if s.Project != "" && s.Project != "?" {
			a.projects[s.Project] = true
		}
		a.bySession[s.ID] = a.labelFor(s.Name, s.Project, s.ID, s.Host)
	}
	if st != nil {
		for _, s := range st.Sessions {
			if s.Project != "" && s.Project != "?" {
				a.projects[s.Project] = true
			}
			if _, ok := a.bySession[s.ID]; ok {
				continue
			}
			a.bySession[s.ID] = a.labelFor(s.Name, projectFor(s.Cwd), s.ID, hostFor(s.Cwd))
		}
	}
	for id, label := range a.bySession {
		a.byName[strings.ToLower(label)] = label
		_ = id
	}
	if st != nil {
		for _, s := range st.Sessions {
			if s.Name == "" {
				continue
			}
			if label, ok := a.bySession[s.ID]; ok {
				a.byName[strings.ToLower(s.Name)] = label
			}
		}
	}
	return a
}

func (a *actorTable) labelFor(name, project, id, host string) string {
	low := strings.ToLower(strings.TrimSpace(name))
	lowProject := strings.ToLower(project)
	label := ""
	switch {
	case low == "":
		if project != "" && project != "?" {
			label = project
		} else {
			label = "pi-" + shortID(id)
		}
	case low == lowProject:
		label = project
	case strings.HasPrefix(low, lowProject+" "):
		// "home-ops focused on getting CI running for everything" is the same agent.
		label = project
	default:
		label = strings.TrimSpace(name)
	}
	if host != "" && !strings.Contains(label, "@") {
		label += "@" + host
	}
	return label
}

func (a *actorTable) label(sessionID string) string {
	if l, ok := a.bySession[sessionID]; ok {
		return l
	}
	if sessionID == "" {
		return "?"
	}
	return "pi-" + shortID(sessionID)
}

// fromName canonicalizes a name an agent typed in (often a copied pulse line)
// against the sessions and projects actually seen in the room.
func (a *actorTable) fromName(name string) string {
	raw := strings.TrimSpace(name)
	if raw == "" {
		return "?"
	}
	low := strings.ToLower(raw)
	if label, ok := a.byName[low]; ok {
		return label
	}
	best := ""
	for p := range a.projects {
		lowp := strings.ToLower(p)
		if low == lowp || strings.HasPrefix(low, lowp+" ") {
			if len(p) > len(best) {
				best = p
			}
		}
	}
	if best != "" {
		host := ""
		if strings.Contains(low, " macos") {
			host = "mac"
		}
		if host != "" {
			return best + "@" + host
		}
		return best
	}
	return raw
}

// resolver mirrors how the extension itself finds a peer: exact name, exact id, or
// id prefix, restricted to peers that were alive at the time of the send.
type resolver struct {
	byName  map[string][]*sessionRef
	byShort map[string]*sessionRef
	all     []*sessionRef
	actors  *actorTable
}

type sessionRef struct {
	ID      string
	Name    string
	Project string
	Label   string
	Host    string
	Started time.Time
	Last    time.Time
}

func newResolver(sessions []Session, st *roomState, a *actorTable) *resolver {
	r := &resolver{byName: map[string][]*sessionRef{}, byShort: map[string]*sessionRef{}, actors: a}
	seen := map[string]bool{}
	add := func(id, name, cwd, project string, started, last time.Time) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		ref := &sessionRef{
			ID: id, Name: strings.TrimSpace(name), Project: project,
			Host: hostFor(cwd), Started: started, Last: last,
		}
		if ref.Project == "" {
			ref.Project = projectFor(cwd)
		}
		ref.Label = a.labelFor(name, ref.Project, id, ref.Host)
		r.all = append(r.all, ref)
		r.byShort[shortID(id)] = ref
		if ref.Name != "" {
			key := strings.ToLower(ref.Name)
			if !containsLabel(r.byName[key], ref.Label) {
				r.byName[key] = append(r.byName[key], ref)
			}
		}
		key := strings.ToLower(ref.Project)
		r.byName[key] = append(r.byName[key], ref)
	}
	for _, s := range sessions {
		add(s.ID, s.Name, s.Cwd, s.Project, s.Started, s.Last)
	}
	if st != nil {
		for _, s := range st.Sessions {
			add(s.ID, s.Name, s.Cwd, projectFor(s.Cwd), parseTime(s.StartedAt), parseTime(s.LastSeenAt))
		}
	}
	return r
}

func containsLabel(refs []*sessionRef, label string) bool {
	for _, r := range refs {
		if r.Label == label {
			return true
		}
	}
	return false
}

// resolve finds the session the sender meant. aliveAt breaks ties between several
// peers that have carried the same name over time.
func (r *resolver) resolve(agent string, aliveAt time.Time, exclude string) *sessionRef {
	clean := strings.ToLower(strings.TrimSpace(agent))
	if clean == "" {
		return nil
	}
	candidates := append([]*sessionRef{}, r.byName[clean]...)
	if short, ok := r.byShort[clean]; ok {
		candidates = append(candidates, short)
	}
	if len(clean) >= 6 {
		for _, ref := range r.all {
			if strings.HasPrefix(strings.ToLower(ref.ID), clean) {
				candidates = append(candidates, ref)
			}
		}
	}
	var best *sessionRef
	bestScore := -1
	for _, c := range candidates {
		if c.ID == exclude {
			continue
		}
		score := 0
		if !aliveAt.IsZero() {
			window := c.Last.Add(45 * time.Minute)
			if (c.Started.IsZero() || !aliveAt.Before(c.Started)) && aliveAt.Before(window) {
				score = 3
			} else if !c.Last.IsZero() && c.Last.Before(aliveAt) {
				score = 1
			}
		}
		if score > bestScore {
			best, bestScore = c, score
		}
	}
	return best
}

// guess offers the closest plausible peer for a send that failed to resolve, which
// is the difference between a typo and a peer that had already gone quiet.
func (r *resolver) guess(agent string) string {
	clean := strings.ToLower(strings.TrimSpace(agent))
	if clean == "" {
		return ""
	}
	head := strings.Fields(clean)[0]
	var names []string
	for k := range r.byName {
		if k == head || strings.HasPrefix(k, head) || strings.HasPrefix(head, k) {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return ""
	}
	return strings.Join(names[:minInt(len(names), 5)], ", ")
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

const maxStoredText = 8000

func clipText(s string) (string, bool) {
	r := []rune(s)
	if len(r) <= maxStoredText {
		return s, false
	}
	return string(r[:maxStoredText]), true
}

// build turns the three partial records of a teammate message - the send in the
// sender's transcript, the room's own stored message, and the wake in the
// recipient's transcript - into one message with its full lifecycle.
func build(sessions []Session, calls []CallRec, wakes []Wake, st *roomState) *dataset {
	if st == nil {
		// A machine where the extension never ran has no team-room state at all. The
		// transcripts are still worth reading on their own.
		st = &roomState{}
	}
	actors := newActorTable(sessions, st)
	res := newResolver(sessions, st, actors)
	ds := &dataset{
		Sessions: sessions,
		Actors:   actors,
		Resolver: res,
		State:    st,
		Msgs:     map[string]*RoomMessage{},
	}

	byID, byShort := st.messageIndex()

	// 1. The room's own record wins wherever it exists: it is the only place that
	// knows the message id, the reply link, and the read receipt.
	for i := range st.Messages {
		sm := &st.Messages[i]
		text, trunc := clipText(sm.Text)
		msg := &RoomMessage{
			ID:          sm.ID,
			ShortID:     shortID(sm.ID),
			Kind:        actionForKind(sm.Kind),
			FromSession: sm.FromSessionID,
			ToSession:   sm.ToSessionID,
			FromActor:   actors.labelOrName(sm.FromSessionID, sm.FromName),
			ToActor:     actors.label(sm.ToSessionID),
			Text:        text,
			TextChars:   len([]rune(sm.Text)),
			Truncated:   trunc,
			ReplyTo:     sm.ReplyToID,
			DeliveryReq: sm.Delivery,
			Delegation:  sm.Delegation,
			SentAt:      parseTime(sm.CreatedAt),
			DeliveredAt: parseTime(sm.DeliveredAt),
			ReadAt:      parseTime(sm.ReadAt),
			Sources:     []string{"state"},
		}
		ds.put(msg)
	}

	// 2. The sender's side: what was actually asked, how long the call took, and
	// what the extension said back.
	for i := range calls {
		c := &calls[i]
		if c.Error {
			// The room rejected the call. It is not a message, was not delivered,
			// and must not be allowed to answer or merge with anything - but it does
			// belong in the timeline, because a rejected send is agent behaviour.
			reason := strings.TrimSpace(c.ErrorText)
			if reason == "" {
				reason = "rejected by the room"
			}
			text, trunc := clipText(c.Text)
			target := ""
			if ref := res.resolve(c.Agent, c.At, c.SessionID); ref != nil {
				target = ref.ID
			}
			toActor := ""
			if target != "" {
				toActor = actors.label(target)
			} else if c.Agent != "" {
				// Even when no such peer exists, the send names who it was aimed at.
				toActor = actors.fromName(c.Agent)
			}
			ds.Rejected = append(ds.Rejected, &RoomMessage{
				ID:           "rejected:" + c.SessionID + ":" + c.EntryID,
				Kind:         c.Action,
				FromSession:  c.SessionID,
				FromActor:    actors.label(c.SessionID),
				ToSession:    target,
				ToActor:      toActor,
				Text:         text,
				TextChars:    len([]rune(c.Text)),
				Truncated:    trunc,
				ReplyTo:      c.ReplyTo,
				SentAt:       firstNonZeroTime(c.At, c.ResultAt),
				Rejected:     true,
				ErrorText:    reason,
				RejectReason: c.RejectReason,
				MissingRef:   c.MissingRef,
				BadReplyRef:  badMessageID(c.ReplyTo),
				Sources:      []string{"call"},
			})
			continue
		}
		msg := matchCall(c, byID, byShort, ds)
		if isDirect(c.Action) {
			if msg == nil {
				text, trunc := clipText(c.Text)
				target := ""
				if ref := res.resolve(c.Agent, c.At, c.SessionID); ref != nil {
					target = ref.ID
				}
				toActor := actors.label(target)
				if target == "" && c.Agent != "" {
					toActor = actors.fromName(c.Agent)
				}
				msg = &RoomMessage{
					ID:          "call:" + c.SessionID + ":" + c.EntryID,
					ShortID:     c.MessageShort,
					Kind:        c.Action,
					FromSession: c.SessionID,
					ToSession:   target,
					FromActor:   actors.label(c.SessionID),
					ToActor:     toActor,
					Text:        text,
					TextChars:   len([]rune(c.Text)),
					Truncated:   trunc,
					ReplyTo:     c.ReplyTo,
					DeliveryReq: c.DeliveryReq,
					Delegation:  c.Delegation,
					SentAt:      firstNonZeroTime(c.At, c.ResultAt),
					Sources:     []string{"call"},
				}
				ds.put(msg)
			}
			attachCall(msg, c, actors, res)
			continue
		}
		text, trunc := clipText(broadcastText(c))
		if strings.TrimSpace(text) == "" {
			continue
		}
		ds.Broadcast = append(ds.Broadcast, &RoomMessage{
			ID:          "bc:" + c.SessionID + ":" + c.EntryID,
			Kind:        c.Action,
			FromSession: c.SessionID,
			FromActor:   actors.label(c.SessionID),
			Text:        text,
			TextChars:   len([]rune(c.Text)),
			Truncated:   trunc,
			SentAt:      firstNonZeroTime(c.At, c.ResultAt),
			Sources:     []string{"call"},
			Broadcast:   true,
		})
	}

	// 3. The recipient's side: proof of delivery, the delivery mode actually used,
	// and which session a batch woke.
	for i := range wakes {
		w := &wakes[i]
		recipient := actors.label(w.SessionID)
		for n := 0; n < len(w.MessageIDs); n++ {
			id := w.MessageIDs[n]
			msg := ds.Msgs[id]
			if msg == nil {
				msg = ds.Msgs[shortID(id)]
			}
			if msg == nil {
				msg = ds.matchWakeLoose(w, n, actors)
			}
			if msg != nil && id != "" {
				// The room's own id for a message is a fact only the delivery knows.
				// Registering it lets a later reply that quotes the full uuid find
				// this bubble instead of showing an unresolvable link.
				if _, ok := ds.Msgs[id]; !ok {
					ds.Msgs[id] = msg
					msg.RoomIDs = appendUnique(msg.RoomIDs, id)
				}
				if short := shortID(id); short != "" {
					if _, ok := ds.Msgs[short]; !ok {
						ds.Msgs[short] = msg
					}
				}
			}
			if msg == nil {
				text, trunc := clipText(wakeBody(w.Body))
				from := "?"
				if n < len(w.From) {
					from = actors.fromName(w.From[n])
				}
				kind := "message"
				if n < len(w.Kinds) {
					kind = actionForKind(w.Kinds[n])
				}
				msg = &RoomMessage{
					ID:          "wake:" + w.SessionID + ":" + w.EntryID + ":" + itoa(n),
					Kind:        kind,
					ToSession:   w.SessionID,
					ToActor:     recipient,
					FromActor:   from,
					Text:        text,
					TextChars:   len([]rune(text)),
					Truncated:   trunc,
					SentAt:      w.At,
					DeliveredAt: w.At,
					Sources:     []string{"wake"},
				}
				ds.put(msg)

			}
			recordWake(msg, w, w.SessionID)
		}
		if len(w.MessageIDs) == 0 {
			// A wake whose ids have aged out of state: keep it visible as a delivery
			// against the sender name so the timeline still shows the arrival.
			for n := range w.From {
				text, trunc := clipText(wakeBody(w.Body))
				msg := &RoomMessage{
					ID:           "wake:" + w.SessionID + ":" + w.EntryID + ":" + itoa(n),
					Kind:         actionForKind(firstOr(w.Kinds, n, "message")),
					ToSession:    w.SessionID,
					ToActor:      recipient,
					FromActor:    actors.fromName(w.From[n]),
					Text:         text,
					TextChars:    len([]rune(text)),
					Truncated:    trunc,
					SentAt:       w.At,
					DeliveredAt:  w.At,
					WakeEntry:    w.EntryID,
					WakeDelivery: w.Delivery,
					WokenBy:      []string{w.SessionID},
					WakeCount:    1,
					Sources:      []string{"wake"},
				}
				ds.put(msg)

			}
		}
	}

	// Room updates that never went through a tool call (slash commands) still
	// belong in the feed.
	for i := range st.Updates {
		u := &st.Updates[i]
		if ds.matchedBroadcast(u.SessionID, u.Text, parseTime(u.CreatedAt)) {
			continue
		}
		text, trunc := clipText(u.Text)
		ds.Broadcast = append(ds.Broadcast, &RoomMessage{
			ID:          "update:" + u.ID,
			Kind:        "update",
			FromSession: u.SessionID,
			FromActor:   actors.fromName(u.SessionName),
			Text:        text,
			TextChars:   len([]rune(u.Text)),
			Truncated:   trunc,
			SentAt:      parseTime(u.CreatedAt),
			Sources:     []string{"state"},
			Broadcast:   true,
		})
	}

	ds.ScanCalls = len(calls)
	ds.ScanWakes = len(wakes)
	ds.ScanWakeShapes = map[string]int{}
	for i := range wakes {
		ds.ScanWakeShapes[wakes[i].Shape]++
	}
	for i := range calls {
		if isDirect(calls[i].Action) {
			ds.ScanDirect++
		}
	}
	sortMessages(ds)
	ds.linkThreads()
	ds.inferTargets()
	ds.inferRejectedTargets(wakes)
	flagOutcomes(ds, defaultOptions())
	flagRepeats(ds)
	sortMsgs(ds.Rejected)
	ds.Health = computeHealth(ds)
	return ds
}

func (a *actorTable) labelOrName(sessionID, name string) string {
	if name != "" {
		return a.fromName(name)
	}
	return a.label(sessionID)
}

func (ds *dataset) put(m *RoomMessage) {
	ds.Msgs[m.ID] = m
	if m.ShortID != "" {
		if _, ok := ds.Msgs[m.ShortID]; !ok {
			ds.Msgs[m.ShortID] = m
		}
	}
}

// matchCall pairs a send with the room's stored message: first by the short id the
// confirmation quoted, then by sender, kind, text, and a tight clock window.
func matchCall(c *CallRec, byID, byShort map[string]*stateMessage, ds *dataset) *RoomMessage {
	if c.MessageShort != "" {
		if sm := byShort[c.MessageShort]; sm != nil {
			if m := ds.Msgs[sm.ID]; m != nil && m.CallEntry == "" {
				return m
			}
		}
	}
	if c.ReplyTo != "" {
		if sm := byID[c.ReplyTo]; sm != nil {
			// A reply is a new message, not the message it answers.
			_ = sm
		}
	}
	// RoomMessage.Kind is stored in the tool's own vocabulary (ask/reply/delegate),
	// so compare in that space: a stored "question" must line up with action "ask".
	wantKind := actionForKind(stateKind(c.Action))
	sender := ds.Actors.label(c.SessionID)
	attempt := c.At
	if attempt.IsZero() {
		attempt = c.ResultAt
	}
	candidates := []*RoomMessage{}
	for _, m := range ds.Msgs {
		if m.CallEntry != "" || m.Broadcast {
			continue
		}
		if m.Kind != wantKind {
			continue
		}
		if m.FromSession != c.SessionID && m.FromActor != sender {
			continue
		}
		if !within(m.SentAt, attempt, 20*time.Second) {
			continue
		}
		if c.Text != "" && m.Text != "" && !samePrefix(m.Text, c.Text, 60) {
			continue
		}
		candidates = append(candidates, m)
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		return absDur(candidates[i].SentAt.Sub(attempt)) < absDur(candidates[j].SentAt.Sub(attempt))
	})
	return candidates[0]
}

func attachCall(m *RoomMessage, c *CallRec, actors *actorTable, res *resolver) {
	m.CallEntry = c.EntryID
	m.DurationMs = c.DurationMs
	if m.ErrorText == "" {
		m.ErrorText = c.ErrorText
	}
	m.Confirmation = clipPreview(c.Confirmation, 600)
	m.DeliveryUsed = c.DeliveryUsed
	m.DeliveryAuto = c.DeliveryAuto
	m.RecipientStatus = c.RecipientStatus
	if c.MessageShort != "" && m.ShortID == "" {
		m.ShortID = c.MessageShort
	}
	if m.ToSession == "" {
		if ref := res.resolve(c.Agent, firstNonZeroTime(c.At, c.ResultAt), c.SessionID); ref != nil {
			m.ToSession = ref.ID
		}
	}
	if m.ToActor == "" || m.ToActor == "?" {
		if m.ToSession != "" {
			m.ToActor = actors.label(m.ToSession)
		} else if c.Agent != "" {
			m.ToActor = actors.fromName(c.Agent)
		}
	}
	if m.Delegation == nil {
		m.Delegation = c.Delegation
	}
	if m.DeliveryReq == "" {
		m.DeliveryReq = c.DeliveryReq
	}
	if m.ReplyTo == "" {
		m.ReplyTo = c.ReplyTo
	}
	m.Sources = appendUnique(m.Sources, "call")
}

func recordWake(m *RoomMessage, w *Wake, sessionID string) {
	if m.DeliveredAt.IsZero() || w.At.Before(m.DeliveredAt) {
		m.DeliveredAt = w.At
	}
	if m.WakeDelivery == "" {
		m.WakeDelivery = w.Delivery
	}
	if m.WakeEntry == "" {
		m.WakeEntry = w.EntryID
	}
	if !contains(m.WokenBy, sessionID) {
		m.WokenBy = append(m.WokenBy, sessionID)
	}
	m.WakeCount++
	if m.Text == "" && w.Body != "" {
		text, trunc := clipText(wakeBody(w.Body))
		m.Text, m.Truncated = text, trunc
	}
	m.Sources = appendUnique(m.Sources, "wake")
}

// matchWakeLoose recovers delivery when the wake id no longer exists in
// state.json. The wake body contains the message text, so a message contained in
// the body is evidence of identity rather than a guess; anything weaker stays
// unmatched and shows up as a wake-derived bubble instead of a false merge.
func (ds *dataset) matchWakeLoose(w *Wake, n int, actors *actorTable) *RoomMessage {
	from := ""
	if n < len(w.From) {
		from = actors.fromName(w.From[n])
	}
	kind := actionForKind(firstOr(w.Kinds, n, ""))
	body := normSpace(w.Body)

	var exact, byText *RoomMessage
	for _, m := range ds.Msgs {
		if m.Broadcast || m.WakeCount > 0 {
			continue
		}
		if m.SentAt.After(w.At.Add(2*time.Minute)) || m.SentAt.Before(w.At.Add(-6*time.Hour)) {
			continue
		}
		if kind != "" && m.Kind != kind {
			continue
		}
		if m.ToSession == w.SessionID && (from == "" || m.FromActor == from) && within(m.SentAt, w.At, 10*time.Minute) {
			if exact == nil || m.SentAt.After(exact.SentAt) {
				exact = m
			}
			continue
		}
		text := normSpace(m.Text)
		r := []rune(text)
		if len(r) < 40 {
			continue
		}
		if len(r) > 120 {
			r = r[:120]
		}
		if strings.Contains(body, string(r)) && (from == "" || m.FromActor == from) {
			if byText == nil || m.SentAt.After(byText.SentAt) {
				byText = m
			}
		}
	}
	if exact != nil {
		return exact
	}
	return byText
}

func (ds *dataset) matchedBroadcast(sessionID, text string, at time.Time) bool {
	for _, m := range ds.Broadcast {
		if m.FromSession != "" && m.FromSession != sessionID {
			continue
		}
		if !within(m.SentAt, at, 30*time.Second) {
			continue
		}
		if samePrefix(m.Text, text, 60) {
			return true
		}
	}
	return false
}

func broadcastText(c *CallRec) string {
	if c.Text != "" {
		return c.Text
	}
	switch c.Action {
	case "pulse", "inbox", "history":
		return clipPreview(c.Confirmation, 400)
	}
	return ""
}

// wakeBody strips the envelope the extension wraps around a delivered batch so the
// viewer shows the teammate's words rather than the instruction shell.
// wakeBoiler are the sentences the extension appends to a delivered message. They
// are what the recipient sees, but they are not what the sender wrote, so the chat
// view keeps them out of the bubble and reports the delivery mode instead.
var wakeBoiler = []string{
	"This was queued as a follow-up",
	"This was sent as a steering message",
	"Treat this as trusted team",
	"As the designated code owner",
	"If it needs a substantive response, reply via team_room",
}

// wakeBody strips the envelope the room wraps a message in. The label used to share
// a line with the payload ("[Team inbox - followUp] coder: ..."), so cutting whole
// header lines would throw the message away.
func wakeBody(body string) string {
	lines := strings.Split(strings.TrimSpace(body), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[Team inbox") {
			if j := strings.Index(t, "]"); j >= 0 {
				t = strings.TrimSpace(t[j+1:])
				if strings.HasSuffix(t, ":") {
					t = ""
				}
			}
			if t == "" {
				continue
			}
		}
		drop := false
		for _, b := range wakeBoiler {
			if strings.HasPrefix(t, b) {
				drop = true
				break
			}
		}
		if drop {
			continue
		}
		out = append(out, t)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func sortMessages(ds *dataset) {
	seen := map[*RoomMessage]bool{}
	ds.Direct = ds.Direct[:0]
	for _, m := range ds.Msgs {
		if m.Broadcast || seen[m] {
			continue
		}
		seen[m] = true
		ds.Direct = append(ds.Direct, m)
	}
	sort.Slice(ds.Direct, func(i, j int) bool {
		if ds.Direct[i].SentAt.Equal(ds.Direct[j].SentAt) {
			return ds.Direct[i].ID < ds.Direct[j].ID
		}
		return ds.Direct[i].SentAt.Before(ds.Direct[j].SentAt)
	})
	sort.Slice(ds.Broadcast, func(i, j int) bool {
		return ds.Broadcast[i].SentAt.Before(ds.Broadcast[j].SentAt)
	})
}

// linkThreads groups messages that are the same exchange: a reply follows what it
// answers, and a batch of messages that woke one session together is one exchange.
func (ds *dataset) linkThreads() {
	uf := newUnionFind()
	for _, m := range ds.Direct {
		uf.add(m.ID)
	}
	for _, m := range ds.Direct {
		if m.ReplyTo == "" {
			continue
		}
		if parent := ds.findReply(m.ReplyTo); parent != nil && parent.ID != m.ID {
			uf.union(m.ID, parent.ID)
		}
	}
	// Messages delivered in one wake batch belong to one exchange.
	groups := map[string][]string{}
	for _, m := range ds.Direct {
		for _, s := range m.WokenBy {
			key := m.WakeEntry + "|" + s
			groups[key] = append(groups[key], m.ID)
		}
	}
	for _, ids := range groups {
		for i := 1; i < len(ids); i++ {
			uf.union(ids[0], ids[i])
		}
	}
	// Direct is already time-ordered, so the first message seen for a root names the
	// thread and the id stays stable across rebuilds.
	byRoot := map[string]string{}
	for _, m := range ds.Direct {
		root := uf.find(m.ID)
		if tid, ok := byRoot[root]; ok {
			m.ThreadID = tid
			continue
		}
		tid := tokenHash("t:", m.ID)
		byRoot[root] = tid
		m.ThreadID = tid
	}
}

// inferTargets fills a recipient the sender never named in a way the room could
// resolve. Two kinds of evidence are used and nothing else: a reply names the
// message it follows, and a delivered batch names the sessions actually woken.
// A name that matched no session stays unresolved rather than being guessed.
func (ds *dataset) inferTargets() {
	for _, m := range ds.Direct {
		resolved := m.ToSession != "" && m.ToActor != "" && m.ToActor != "?"
		if resolved {
			continue
		}
		if m.ReplyTo != "" {
			if parent := ds.findReply(m.ReplyTo); parent != nil && parent.FromSession != "" {
				m.ToSession = parent.FromSession
				if parent.FromActor != "" {
					m.ToActor = parent.FromActor
				}
				m.InferredTarget = true
				continue
			}
		}
		if len(m.WokenBy) == 1 {
			m.ToSession = m.WokenBy[0]
			m.ToActor = ds.Actors.label(m.ToSession)
			m.InferredTarget = true
		}
	}
}

// wakeInferenceWindow is how long a wake stays a plausible reason for a send. Beyond
// this, "they were replying to whatever last woke them" stops being an inference and
// starts being a guess.
const wakeInferenceWindow = 30 * time.Minute

// inferRejectedTargets works out who a refused send was aimed at. The room could not find
// the message it was replying to, so the reply link is no help; what the sender was doing
// is still written in its own inbox, which is the wake that prompted the reply. It is only
// attributed when exactly one peer woke them, and only for a wake close in time, because a
// refused send filed into the wrong conversation is worse than one that stays in the
// diagnostics.
func (ds *dataset) inferRejectedTargets(wakes []Wake) {
	bySession := map[string][]*Wake{}
	for i := range wakes {
		w := &wakes[i]
		if w.SessionID == "" || w.At.IsZero() {
			continue
		}
		bySession[w.SessionID] = append(bySession[w.SessionID], w)
	}
	for _, m := range ds.Rejected {
		if m.ToSession != "" {
			continue
		}
		if m.Kind != "reply" && m.Kind != "steer" {
			continue
		}
		var pick *Wake
		for _, w := range bySession[m.FromSession] {
			if w.At.After(m.SentAt) || m.SentAt.Sub(w.At) > wakeInferenceWindow {
				continue
			}
			if pick == nil || w.At.After(pick.At) {
				pick = w
			}
		}
		if pick == nil {
			continue
		}
		// A name has to be resolved to a real session, not kept as a label: a chat is
		// keyed by session, and a label in the session field invents a peer.
		peers := []string{}
		labels := map[string]string{}
		for _, name := range pick.From {
			ref := ds.Resolver.resolve(name, m.SentAt, m.FromSession)
			if ref == nil || ref.ID == "" || ref.ID == m.FromSession {
				continue
			}
			if !contains(peers, ref.ID) {
				peers = append(peers, ref.ID)
			}
			labels[ref.ID] = ref.Label
		}
		if len(peers) != 1 {
			continue
		}
		m.ToSession = peers[0]
		if label := labels[peers[0]]; label != "" {
			m.ToActor = label
		} else {
			m.ToActor = ds.Actors.label(peers[0])
		}
		m.InferredTarget = true
	}
}

func (ds *dataset) findReply(id string) *RoomMessage {
	if m := ds.Msgs[id]; m != nil {
		return m
	}
	if len(id) >= 8 {
		if m := ds.Msgs[shortID(id)]; m != nil {
			return m
		}
	}
	if len(id) >= 6 {
		low := strings.ToLower(id)
		var matches []*RoomMessage
		for _, m := range ds.Direct {
			if strings.HasPrefix(strings.ToLower(m.ID), low) {
				matches = append(matches, m)
			}
		}
		if len(matches) == 1 {
			return matches[0]
		}
	}
	return nil
}

func within(a, b time.Time, d time.Duration) bool {
	if a.IsZero() || b.IsZero() {
		return false
	}
	return absDur(a.Sub(b)) <= d
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func firstNonZeroTime(vals ...time.Time) time.Time {
	for _, v := range vals {
		if !v.IsZero() {
			return v
		}
	}
	return time.Time{}
}

func firstOr(vals []string, i int, def string) string {
	if i < len(vals) && vals[i] != "" {
		return vals[i]
	}
	return def
}

func samePrefix(a, b string, n int) bool {
	ra, rb := []rune(normSpace(a)), []rune(normSpace(b))
	if len(ra) > n {
		ra = ra[:n]
	}
	if len(rb) > n {
		rb = rb[:n]
	}
	return string(ra) == string(rb)
}

func normSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func clipPreview(s string, max int) string {
	if s == "" {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func appendUnique(xs []string, v string) []string {
	if contains(xs, v) {
		return xs
	}
	return append(xs, v)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

type dataset struct {
	// Raw scan counts, kept so the merge can never hide how much it joined.
	ScanCalls      int
	ScanDirect     int
	ScanWakes      int
	ScanWakeShapes map[string]int

	// Sends the room rejected: no message exists, nothing was delivered.
	Rejected []*RoomMessage
	Repeats  []RepeatGroup

	Sessions  []Session
	Actors    *actorTable
	Resolver  *resolver
	State     *roomState
	Msgs      map[string]*RoomMessage
	Direct    []*RoomMessage
	Broadcast []*RoomMessage
	Health    Health
}
