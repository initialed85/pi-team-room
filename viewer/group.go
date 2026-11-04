package main

import (
	"sort"
	"strings"
	"time"
)

type unionFind struct{ parent map[string]string }

func newUnionFind() *unionFind { return &unionFind{parent: map[string]string{}} }

func (u *unionFind) add(x string) {
	if _, ok := u.parent[x]; !ok {
		u.parent[x] = x
	}
}

func (u *unionFind) find(x string) string {
	u.add(x)
	root := x
	for u.parent[root] != root {
		root = u.parent[root]
	}
	for u.parent[x] != root {
		u.parent[x], x = root, u.parent[x]
	}
	return root
}

func (u *unionFind) union(a, b string) {
	ra, rb := u.find(a), u.find(b)
	if ra != rb {
		u.parent[rb] = ra
	}
}

type groupOptions struct {
	Mode             string        // participants | sessions
	Window           time.Duration // episode gap
	Split            bool          // one chat per episode instead of one per participant set
	Actor            string        // filter: only chats containing this actor
	Search           string
	IncludeBroadcast bool
	AnswerWindow     time.Duration
	Limit            int
}

func defaultOptions() groupOptions {
	return groupOptions{
		Mode:         "participants",
		Window:       90 * time.Minute,
		AnswerWindow: 45 * time.Minute,
		Limit:        400,
	}
}

// actorKey orders the participant labels so a chat's identity does not depend on
// who happened to speak first.
func actorKey(labels []string) string {
	uniq := map[string]bool{}
	var out []string
	for _, l := range labels {
		l = strings.TrimSpace(l)
		if l == "" || uniq[l] {
			continue
		}
		uniq[l] = true
		out = append(out, l)
	}
	sort.Strings(out)
	return strings.Join(out, " | ")
}

func messageActors(m *RoomMessage) []string {
	var out []string
	if m.FromActor != "" {
		out = append(out, m.FromActor)
	}
	if m.ToActor != "" && m.ToActor != m.FromActor {
		out = append(out, m.ToActor)
	}
	return out
}

// badMessageID explains a `messageId` argument that cannot name a message. Agents
// copy ids out of what they were handed and the room accepts any non-empty string,
// so a paragraph or a truncated uuid becomes a reply link that goes nowhere.
func badMessageID(id string) string {
	t := strings.TrimSpace(id)
	if t == "" {
		return ""
	}
	low := strings.ToLower(t)
	if uuidShape.MatchString(low) {
		return ""
	}
	if len(low) >= 6 && len(low) <= 12 && allHex(low) {
		return ""
	}
	if strings.HasPrefix(t, "[") {
		return "quoted the inbox envelope instead of an id"
	}
	if strings.ContainsAny(t, " .") && len([]rune(t)) > 15 {
		return "pasted conversation text into messageId"
	}
	hex := 0
	for _, r := range low {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') {
			hex++
		}
	}
	if strings.Contains(t, "-") && hex >= 12 {
		return "uuid-shaped but the wrong number of hex digits"
	}
	return "not a message id"
}

func allHex(s string) bool {
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

func humanSpan(sec float64) string {
	d := time.Duration(sec * float64(time.Second))
	switch {
	case d < time.Minute:
		return itoa(int(d.Seconds())) + "s"
	case d < time.Hour:
		return itoa(int(d.Minutes())) + "m"
	default:
		h := int(d.Hours())
		m := int(d.Minutes()) % 60
		if m < 10 {
			return itoa(h) + "h0" + itoa(m) + "m"
		}
		return itoa(h) + "h" + itoa(m) + "m"
	}
}

func sortMsgs(ms []*RoomMessage) {
	sort.SliceStable(ms, func(i, j int) bool { return ms[i].SentAt.Before(ms[j].SentAt) })
}

// flagRepeats groups identical text sent repeatedly by the same actor. A transcript
// full of 38 copies of one report is not 38 messages, it is one agent stuck in a
// loop, and a chat client that renders them as separate bubbles hides the loop.
// readKinds are the room actions that only looked something up. They are shown in the
// timeline like anything else, but the same answer coming back twice is the room being
// consistent rather than an agent stuck, so they stay out of repeat detection.
var readKinds = map[string]bool{"pulse": true, "history": true, "inbox": true}

func flagRepeats(ds *dataset) {
	type key struct {
		actor string
		kind  string
		text  string
	}
	groups := map[key][]*RoomMessage{}
	order := []key{}
	// Rejected sends count too: an agent retrying a call the room keeps refusing is
	// the worst loop there is, and it is invisible if you only look at successes.
	all := make([]*RoomMessage, 0, len(ds.Direct)+len(ds.Rejected)+len(ds.Broadcast))
	all = append(all, ds.Direct...)
	all = append(all, ds.Rejected...)
	all = append(all, ds.Broadcast...)
	for _, m := range all {
		// Reads are excluded on purpose. A pulse or a history query that answers with the
		// same text twice is the room being consistent; flagging it would bury the loops
		// that matter, which are an agent pushing the same message at a peer.
		if readKinds[m.Kind] {
			continue
		}
		text := normSpace(m.Text)
		if len([]rune(text)) < 20 {
			continue
		}
		k := key{actor: m.FromActor, kind: m.Kind, text: text}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], m)
	}
	for _, k := range order {
		ms := groups[k]
		if len(ms) < 3 {
			continue
		}
		sortMsgs(ms)
		span := ms[len(ms)-1].SentAt.Sub(ms[0].SentAt)
		sessions := []string{}
		rejected := 0
		for _, m := range ms {
			if m.Rejected {
				rejected++
			}
		}
		for i, m := range ms {
			m.RepeatCount = len(ms)
			m.RepeatIndex = i + 1
			m.RepeatSpanSec = span.Seconds()
			// Carried on the bubble so a timeline can say how much of the loop the room
			// actually turned away, not just that the text repeated.
			m.RepeatRejected = rejected
			sessions = appendUnique(sessions, m.FromSession)
		}
		ds.Repeats = append(ds.Repeats, RepeatGroup{
			Actor:    k.actor,
			Kind:     k.kind,
			Rejected: rejected,
			Text:     clipPreview(k.text, 220),
			Chars:    len([]rune(k.text)),
			Count:    len(ms),
			FirstAt:  ms[0].SentAt,
			LastAt:   ms[len(ms)-1].SentAt,
			SpanSec:  span.Seconds(),
			Sessions: sessions,
		})
	}
	sort.Slice(ds.Repeats, func(i, j int) bool { return ds.Repeats[i].Count > ds.Repeats[j].Count })
}

// flagOutcomes marks the things a chat client needs to show honestly: an ask that
// was never answered, a send that never got a delivery, a loop back to the sender.
func flagOutcomes(ds *dataset, opts groupOptions) {
	answerWindow := opts.AnswerWindow
	if answerWindow <= 0 {
		answerWindow = 45 * time.Minute
	}
	for _, m := range ds.Direct {
		if m.FromActor != "" && m.ToActor != "" && m.FromActor == m.ToActor {
			m.SelfLoop = true
		}
		if m.DeliveredAt.IsZero() && !m.SelfLoop && m.Kind != "steer" {
			m.Pending = true
		}
		if m.ToSession == "" && !m.SelfLoop {
			m.Unresolved = true
		}
		m.BadReplyRef = badMessageID(m.ReplyTo)
	}
	// Answered: something from the intended recipient later appears in the same
	// exchange, either as a linked reply or simply as their next message.
	for i := range ds.Direct {
		m := ds.Direct[i]
		if m.Kind != "ask" && m.Kind != "delegate" || m.Answered {
			continue
		}
		for j := i + 1; j < len(ds.Direct); j++ {
			n := ds.Direct[j]
			if n.SentAt.Sub(m.SentAt) > answerWindow {
				break
			}
			sameExchange := n.ThreadID == m.ThreadID
			samePair := (n.FromActor == m.ToActor && (n.ToActor == m.FromActor || n.ToActor == ""))
			if n.ReplyTo != "" && ds.findReply(n.ReplyTo) == m {
				sameExchange = true
			}
			if !sameExchange && !samePair {
				continue
			}
			if n.Kind == "reply" || n.Kind == "ask" || n.Kind == "delegate" || n.Kind == "update" {
				m.Answered = true
				m.AnsweredBy = appendUnique(m.AnsweredBy, n.FromActor)
				if n.ReplyTo != "" {
					m.LinkedReply = true
				}
				break
			}
		}
	}
}

type bucket struct {
	key      string
	sessions map[string]bool
	actors   map[string]int
	msgs     []*RoomMessage
	first    time.Time
	last     time.Time
}

// buildChats clusters direct messages into chats. In the default participant mode
// a chat is identified by the set of agents in it, so a home-ops / deployed /
// pi-team-room round trip stays one conversation even though it spread over three
// files and many tool calls. In session mode the same messages are grouped by the
// literal session pair, which is what you want when chasing a stale session id.
func buildChats(ds *dataset, opts groupOptions) []Chat {
	buckets := map[string]*bucket{}
	order := []string{}
	combined := make([]*RoomMessage, 0, len(ds.Direct)+len(ds.Rejected))
	combined = append(combined, ds.Direct...)
	for _, m := range ds.Rejected {
		// A rejected send only belongs to a conversation when the peer it named
		// actually exists; otherwise it is a fact about the sender, not a chat.
		if m.ToSession == "" {
			continue
		}
		combined = append(combined, m)
	}
	for _, m := range combined {
		var key string
		var sessions []string
		if opts.Mode == "sessions" {
			pair := []string{m.FromSession, m.ToSession}
			sort.Strings(pair)
			key = strings.Join(pair, " | ")
			sessions = pair
		} else {
			key = actorKey(messageActors(m))
		}
		if key == "" {
			key = "? " + m.FromActor
		}
		b, ok := buckets[key]
		if !ok {
			b = &bucket{key: key, sessions: map[string]bool{}, actors: map[string]int{}, first: m.SentAt}
			buckets[key] = b
			order = append(order, key)
		}
		b.msgs = append(b.msgs, m)
		if opts.Mode != "sessions" {
			for _, s := range []string{m.FromSession, m.ToSession} {
				if s != "" {
					b.sessions[s] = true
				}
			}
		}
		for _, l := range messageActors(m) {
			b.actors[l]++
		}
		for _, s := range sessions {
			if s != "" {
				b.sessions[s] = true
			}
		}
		for _, s := range m.WokenBy {
			b.sessions[s] = true
		}
		if m.SentAt.Before(b.first) {
			b.first = m.SentAt
		}
		if m.SentAt.After(b.last) {
			b.last = m.SentAt
		}
	}

	// Cross-participant merges: a round trip often involves a message whose reply
	// went to a different pair, so buckets whose actor sets overlap get unioned.
	uf := newUnionFind()
	for _, k := range order {
		uf.add(k)
	}
	changed := true
	for pass := 0; changed && pass < 6; pass++ {
		changed = false
		for i := 0; i < len(order); i++ {
			for j := i + 1; j < len(order); j++ {
				a, b := buckets[order[i]], buckets[order[j]]
				if !overlap(a.first, a.last, b.first, b.last, opts.Window) {
					continue
				}
				if uf.find(order[i]) == uf.find(order[j]) {
					continue
				}
				if jaccard(a.actors, b.actors) < 0.34 {
					continue
				}
				uf.union(order[i], order[j])
				changed = true
			}
		}
	}

	merged := map[string]*bucket{}
	var roots []string
	for _, k := range order {
		root := uf.find(k)
		target, ok := merged[root]
		if !ok {
			target = &bucket{key: k, sessions: map[string]bool{}, actors: map[string]int{}, first: buckets[k].first}
			merged[root] = target
			roots = append(roots, root)
		}
		src := buckets[k]
		target.msgs = append(target.msgs, src.msgs...)
		for s := range src.sessions {
			target.sessions[s] = true
		}
		for a, n := range src.actors {
			target.actors[a] += n
		}
		if src.first.Before(target.first) {
			target.first = src.first
		}
		if src.last.After(target.last) {
			target.last = src.last
		}
	}

	out := make([]Chat, 0, len(merged))
	for _, root := range roots {
		b := merged[root]
		sort.SliceStable(b.msgs, func(i, j int) bool { return b.msgs[i].SentAt.Before(b.msgs[j].SentAt) })
		// Episode numbering keeps day/gap dividers visible inside one participant chat.
		episode := 0
		var prev time.Time
		for _, m := range b.msgs {
			if prev.IsZero() || m.SentAt.Sub(prev) > opts.Window {
				episode++
			}
			m.Episode = episode
			prev = m.SentAt
		}
		labels := make([]string, 0, len(b.actors))
		for a := range b.actors {
			labels = append(labels, a)
		}
		sort.Strings(labels)
		chats := []*Chat{}
		if opts.Split {
			grouped := map[int][]*RoomMessage{}
			for _, m := range b.msgs {
				grouped[m.Episode] = append(grouped[m.Episode], m)
			}
			keys := make([]int, 0, len(grouped))
			for e := range grouped {
				keys = append(keys, e)
			}
			sort.Ints(keys)
			for _, e := range keys {
				ms := grouped[e]
				// A split chat is one episode of a longer conversation, so it carries both its
				// own index and how many episodes the pair actually has.
				chats = append(chats, makeChat(b, ms, labels, chatID(labels, ms[0].ID, e), episode, e))
			}
		} else {
			chats = append(chats, makeChat(b, b.msgs, labels, chatID(labels, b.msgs[0].ID, -1), episode, 0))
		}
		for _, c := range chats {
			out = append(out, *c)
		}
	}

	// LastAt alone is not a total order, and the id suffixes below depend on order, so
	// ties fall back to the id itself.
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastAt.Equal(out[j].LastAt) {
			return out[i].LastAt.After(out[j].LastAt)
		}
		return out[i].ID < out[j].ID
	})
	uniqueChatIDs(out)
	if opts.Actor != "" {
		filtered := out[:0]
		want := strings.ToLower(opts.Actor)
		for _, c := range out {
			for _, l := range c.Actors {
				if strings.Contains(strings.ToLower(l), want) {
					filtered = append(filtered, c)
					break
				}
			}
		}
		out = filtered
	}
	if opts.Search != "" {
		filtered := out[:0]
		want := strings.ToLower(opts.Search)
		for _, c := range out {
			if strings.Contains(strings.ToLower(c.Label), want) {
				filtered = append(filtered, c)
				continue
			}
			for _, m := range c.Messages {
				if strings.Contains(strings.ToLower(m.Text), want) {
					filtered = append(filtered, c)
					break
				}
			}
		}
		out = filtered
	}
	if opts.Limit > 0 && len(out) > opts.Limit {
		out = out[:opts.Limit]
	}
	return out
}

// chatID names a conversation by who is in it and where it starts. The participants have
// to be part of the name: one send that woke four peers lands in four participant groups
// that all begin with the same message, and a link that resolves to whichever of them the
// server happens to find first is worse than no link at all.
func chatID(labels []string, firstID string, episode int) string {
	return tokenHash("c:", strings.Join(labels, "+")+"|"+firstID+"|"+itoa(episode))
}

// uniqueChatIDs keeps every chat addressable. The id is derived from real content, so a
// clash means two conversations genuinely share their participants and opening message;
// they still need different links, and the suffix is applied in a fixed order so the same
// data yields the same ids across rebuilds.
func uniqueChatIDs(chats []Chat) {
	seen := map[string]int{}
	for i := range chats {
		n := seen[chats[i].ID]
		seen[chats[i].ID] = n + 1
		if n > 0 {
			chats[i].ID = chats[i].ID + "#" + itoa(n)
		}
	}
}

func makeChat(b *bucket, msgs []*RoomMessage, labels []string, id string, episodes, episode int) *Chat {
	c := &Chat{
		ID:       id,
		Label:    strings.Join(labels, " ↔ "),
		Actors:   labels,
		Mode:     "participants",
		FirstAt:  msgs[0].SentAt,
		LastAt:   msgs[len(msgs)-1].SentAt,
		Messages: msgs,
		Episodes: episodes,
		Episode:  episode,
		Distinct: len(labels),
		Sessions: mapKeys(b.sessions),
	}
	for _, m := range msgs {
		if m.BadReplyRef != "" {
			c.BadReplyRefs++
		}
		// A loop of rejected sends is still a loop, and it is the worse kind: the agent
		// repeated something the room had already said no to.
		if m.RepeatCount > 1 {
			c.RepeatBubbles++
			if m.RepeatCount > c.MaxRepeat {
				c.MaxRepeat = m.RepeatCount
			}
		}
		if m.Rejected {
			c.Rejected++
			continue
		}
		switch m.Kind {
		case "ask":
			c.Asks++
			if !m.Answered {
				c.Unanswered++
			}
		case "delegate":
			c.Delegations++
			if !m.Answered {
				c.Unanswered++
			}
		case "reply":
			c.Replies++
		case "steer":
			c.Steers++
		}
		if m.Pending {
			c.Pending++
		}
		if m.Unresolved {
			c.UnresolvedSend++
		}
		if m.SelfLoop {
			c.SelfLoops++
		}
		if m.WakeCount > 0 {
			c.Wakes++
			if m.WakeCount > c.MaxWakes {
				c.MaxWakes = m.WakeCount
			}
		}
	}
	return c
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func overlap(aFirst, aLast, bFirst, bLast time.Time, window time.Duration) bool {
	if aFirst.IsZero() || bFirst.IsZero() {
		return false
	}
	return !aFirst.After(bLast.Add(window)) && !bFirst.After(aLast.Add(window))
}

func jaccard(a, b map[string]int) float64 {
	inter := 0
	for k := range a {
		if _, ok := b[k]; ok {
			inter++
		}
	}
	union := len(a)
	for k := range b {
		if _, ok := a[k]; !ok {
			union++
		}
	}
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// sessionSummaries merges the transcript-side view of a session with the room's own
// presence record, so "session view" can show both what a session did and whether
// the room thought it was still online.
func sessionSummaries(ds *dataset, opts groupOptions) []SessionSummary {
	stateByID := ds.State.sessionIndex()
	sentBySession := map[string]int{}
	receivedBySession := map[string]int{}
	rejectedBySession := map[string]int{}
	for _, m := range ds.Rejected {
		if m.FromSession != "" {
			rejectedBySession[m.FromSession]++
		}
	}
	chatsBySession := map[string]map[string]bool{}
	for _, m := range ds.Direct {
		if m.FromSession != "" {
			sentBySession[m.FromSession]++
		}
		if m.ToSession != "" {
			receivedBySession[m.ToSession]++
		}
	}
	for i := range ds.Sessions {
		s := &ds.Sessions[i]
		if chatsBySession[s.ID] == nil {
			chatsBySession[s.ID] = map[string]bool{}
		}
	}
	// Chat participation comes from the resolved actor labels.
	for _, m := range ds.Direct {
		for _, label := range messageActors(m) {
			for id, lbl := range ds.Actors.bySession {
				if lbl == label {
					if chatsBySession[id] == nil {
						chatsBySession[id] = map[string]bool{}
					}
					chatsBySession[id][label] = true
				}
			}
		}
	}

	out := make([]SessionSummary, 0, len(ds.Sessions)+len(stateByID))
	seen := map[string]bool{}
	for _, s := range ds.Sessions {
		seen[s.ID] = true
		sum := SessionSummary{
			ID:       s.ID,
			ShortID:  shortID(s.ID),
			Label:    ds.Actors.label(s.ID),
			Name:     s.Name,
			Project:  s.Project,
			Host:     s.Host,
			Cwd:      s.Cwd,
			File:     s.File,
			Dir:      s.Dir,
			Started:  s.Started,
			LastAt:   s.Last,
			Entries:  s.Entries,
			Counts:   s.Counts,
			Calls:    s.TeamRoom,
			Wakes:    s.Wakes,
			Sent:     sentBySession[s.ID],
			Received: receivedBySession[s.ID],
			Rejected: rejectedBySession[s.ID],
			Preview:  s.Preview,
		}
		if st := stateByID[s.ID]; st != nil {
			sum.Status = st.Status
			sum.Connected = st.Connected
			sum.Focus = st.Focus
			sum.LastSeen = parseTime(st.LastSeenAt)
			sum.LastPulse = parseTime(st.LastPulseAt)
			sum.Branch = st.Branch
			if st.Checkpoint != nil {
				sum.Checkpoint = st.Checkpoint.Text
			}
			if sum.Started.IsZero() {
				sum.Started = parseTime(st.StartedAt)
			}
		}
		sum.Participants = len(chatsBySession[s.ID])
		out = append(out, sum)
	}
	for id, st := range stateByID {
		if seen[id] {
			continue
		}
		out = append(out, SessionSummary{
			ID:        id,
			ShortID:   shortID(id),
			Label:     ds.Actors.label(id),
			Name:      st.Name,
			Project:   projectFor(st.Cwd),
			Host:      hostFor(st.Cwd),
			Cwd:       st.Cwd,
			RoomOnly:  true,
			Status:    st.Status,
			Connected: st.Connected,
			Focus:     st.Focus,
			LastSeen:  parseTime(st.LastSeenAt),
			Started:   parseTime(st.StartedAt),
			Sent:      sentBySession[id],
			Received:  receivedBySession[id],
			Rejected:  rejectedBySession[id],
		})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].LastSeen, out[j].LastSeen
		if a.IsZero() {
			a = out[i].LastAt
		}
		if b.IsZero() {
			b = out[j].LastAt
		}
		return a.After(b)
	})
	return out
}

func computeHealth(ds *dataset) Health {
	h := Health{
		Sessions:      len(ds.Sessions),
		TeamRoomCalls: ds.ScanCalls,
		DirectCalls:   ds.ScanDirect,
		Wakes:         ds.ScanWakes,
		WakeShapes:    ds.ScanWakeShapes,
		Messages:      len(ds.State.Messages),
		Updates:       len(ds.State.Updates),
		Journal:       len(ds.State.Journal),
		RoomSessions:  len(ds.State.Sessions),
	}
	threads := map[string]bool{}
	for _, m := range ds.Direct {
		h.Direct++
		threads[m.ThreadID] = true
		if !m.DeliveredAt.IsZero() {
			h.Delivered++
		}
		if !m.ReadAt.IsZero() {
			h.Read++
		}
		if m.RepeatCount > 1 {
			h.RepeatBubbles++
		}
		if m.BadReplyRef != "" {
			h.BadReplyRefs++
			if h.BadReplyReasons == nil {
				h.BadReplyReasons = map[string]int{}
			}
			h.BadReplyReasons[m.BadReplyRef]++
		}
		if m.Unresolved {
			h.UnresolvedSend++
		}
		if m.InferredTarget {
			h.InferredTargets++
		}
		if m.SelfLoop {
			h.SelfLoops++
		}
		if len(m.Sources) > 1 {
			h.Matched++
		}
		if m.Answered {
			h.Answered++
		}
		if m.WakeCount > 1 {
			h.RepeatedWakes++
		}
		h.WakeHits += m.WakeCount
	}
	for range ds.Broadcast {
		h.Broadcast++
	}
	for _, m := range ds.Rejected {
		h.Rejected++
		if m.InferredTarget {
			h.InferredTargets++
		}
		if m.BadReplyRef != "" {
			h.BadReplyRefs++
			if h.BadReplyReasons == nil {
				h.BadReplyReasons = map[string]int{}
			}
			h.BadReplyReasons[m.BadReplyRef]++
		}
		if h.RejectReasons == nil {
			h.RejectReasons = map[string]int{}
		}
		key := m.RejectReason
		if key == "" {
			key = m.ErrorText
		}
		h.RejectReasons[key]++
	}
	h.RepeatGroups = len(ds.Repeats)
	h.Threads = len(threads)
	return h
}
