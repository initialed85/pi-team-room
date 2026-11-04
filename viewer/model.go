package main

import "time"

// Session is what a JSONL file under ~/.pi/agent/sessions looks like after the
// bulk scan. Names come from the optional session_info entry; the rest is counts.
type Session struct {
	ID        string         `json:"id"`
	Name      string         `json:"name,omitempty"`
	Cwd       string         `json:"cwd,omitempty"`
	Project   string         `json:"project,omitempty"`
	Host      string         `json:"host,omitempty"`
	Dir       string         `json:"dir,omitempty"`
	File      string         `json:"file,omitempty"`
	Started   time.Time      `json:"started,omitempty"`
	Last      time.Time      `json:"last,omitempty"`
	Entries   int            `json:"entries"`
	TeamRoom  int            `json:"teamRoomCalls"`
	Wakes     int            `json:"wakes"`
	Preview   string         `json:"preview,omitempty"`
	Counts    map[string]int `json:"counts,omitempty"`
	IndexedAt time.Time      `json:"-"`
}

// CallRec is one team_room tool call, paired with its tool result.
type CallRec struct {
	SessionID       string      `json:"sessionId"`
	EntryID         string      `json:"entryId"`
	CallID          string      `json:"callId,omitempty"`
	ResultID        string      `json:"resultId,omitempty"`
	At              time.Time   `json:"at,omitempty"`
	ResultAt        time.Time   `json:"resultAt,omitempty"`
	DurationMs      float64     `json:"durationMs,omitempty"`
	Action          string      `json:"action"`
	Agent           string      `json:"agent,omitempty"`
	Text            string      `json:"text,omitempty"`
	ReplyTo         string      `json:"replyTo,omitempty"`
	DeliveryReq     string      `json:"deliveryRequested,omitempty"`
	Confirmation    string      `json:"confirmation,omitempty"`
	MessageShort    string      `json:"messageShort,omitempty"`
	DeliveryUsed    string      `json:"deliveryUsed,omitempty"`
	DeliveryAuto    bool        `json:"deliveryAuto,omitempty"`
	RecipientStatus string      `json:"recipientStatus,omitempty"`
	Error           bool        `json:"error,omitempty"`
	ErrorText       string      `json:"errorText,omitempty"`
	RejectReason    string      `json:"rejectReason,omitempty"`
	MissingRef      string      `json:"missingRef,omitempty"`
	Delegation      *Delegation `json:"delegation,omitempty"`
}

type Delegation struct {
	Target            string `json:"target,omitempty"`
	Scope             string `json:"scope,omitempty"`
	UserAuthorization string `json:"userAuthorization,omitempty"`
	AcceptanceChecks  string `json:"acceptanceChecks,omitempty"`
	ExpectedArtifact  string `json:"expectedArtifact,omitempty"`
}

// Wake is a pi-team-room-wake custom message: proof that the room delivered work to
// a session, in that session's own file.
type Wake struct {
	SessionID   string    `json:"sessionId"`
	EntryID     string    `json:"entryId"`
	At          time.Time `json:"at,omitempty"`
	MessageIDs  []string  `json:"messageIds,omitempty"`
	From        []string  `json:"from,omitempty"`
	Kinds       []string  `json:"kinds,omitempty"`
	Delivery    string    `json:"delivery,omitempty"`
	Body        string    `json:"-"`
	BodyChars   int       `json:"bodyChars,omitempty"`
	Delegations int       `json:"delegations,omitempty"`
	Shape       string    `json:"shape,omitempty"`
}

// RoomMessage is the merged lifecycle of one teammate message: the send (sender's
// transcript), the room's stored record (state.json), and the delivery (recipient's
// transcript). Missing pieces are shown as gaps instead of being papered over.
type RoomMessage struct {
	ID          string      `json:"id"`
	ShortID     string      `json:"shortId,omitempty"`
	ThreadID    string      `json:"threadId,omitempty"`
	Episode     int         `json:"episode,omitempty"`
	Kind        string      `json:"kind"`
	FromSession string      `json:"fromSession,omitempty"`
	ToSession   string      `json:"toSession,omitempty"`
	FromActor   string      `json:"fromActor,omitempty"`
	ToActor     string      `json:"toActor,omitempty"`
	Text        string      `json:"text,omitempty"`
	TextChars   int         `json:"textChars,omitempty"`
	Truncated   bool        `json:"truncated,omitempty"`
	ReplyTo     string      `json:"replyTo,omitempty"`
	Delegation  *Delegation `json:"delegation,omitempty"`

	SentAt      time.Time `json:"sentAt,omitempty"`
	DeliveredAt time.Time `json:"deliveredAt,omitempty"`
	ReadAt      time.Time `json:"readAt,omitempty"`

	DeliveryReq     string  `json:"deliveryRequested,omitempty"`
	DeliveryUsed    string  `json:"deliveryUsed,omitempty"`
	DeliveryAuto    bool    `json:"deliveryAuto,omitempty"`
	RecipientStatus string  `json:"recipientStatus,omitempty"`
	DurationMs      float64 `json:"durationMs,omitempty"`
	Confirmation    string  `json:"confirmation,omitempty"`
	Error           bool    `json:"error,omitempty"`
	ErrorText       string  `json:"errorText,omitempty"`

	WakeEntry    string   `json:"wakeEntry,omitempty"`
	WakeDelivery string   `json:"wakeDelivery,omitempty"`
	WokenBy      []string `json:"wokenBy,omitempty"`
	WakeCount    int      `json:"wakeCount,omitempty"`

	RejectReason   string   `json:"rejectReason,omitempty"`
	MissingRef     string   `json:"missingRef,omitempty"`
	Pending        bool     `json:"pending,omitempty"`
	Broadcast      bool     `json:"broadcast,omitempty"`
	Unresolved     bool     `json:"unresolvedTarget,omitempty"`
	Rejected       bool     `json:"rejected,omitempty"`
	RepeatCount    int      `json:"repeatCount,omitempty"`
	RepeatIndex    int      `json:"repeatIndex,omitempty"`
	RepeatSpanSec  float64  `json:"repeatSpanSeconds,omitempty"`
	RepeatRejected int      `json:"repeatRejected,omitempty"`
	RoomIDs        []string `json:"roomIds,omitempty"`
	BadReplyRef    string   `json:"badReplyReason,omitempty"`
	SelfLoop       bool     `json:"selfLoop,omitempty"`
	Answered       bool     `json:"answered,omitempty"`
	InferredTarget bool     `json:"targetInferred,omitempty"`
	LinkedReply    bool     `json:"linkedReply,omitempty"`
	AnsweredBy     []string `json:"answeredBy,omitempty"`

	Sources []string `json:"sources,omitempty"`

	// Internal bookkeeping, not shipped to the UI.
	CallEntry string `json:"-"`
	indexed   bool
}

// Chat is a group of direct messages that belong to one conversation.
type Chat struct {
	ID             string         `json:"id"`
	Label          string         `json:"label"`
	Actors         []string       `json:"actors"`
	Mode           string         `json:"mode"`
	Distinct       int            `json:"distinct"`
	FirstAt        time.Time      `json:"firstAt,omitempty"`
	LastAt         time.Time      `json:"lastAt,omitempty"`
	Episodes       int            `json:"episodes,omitempty"`
	Episode        int            `json:"episode,omitempty"`
	Sessions       []string       `json:"sessions,omitempty"`
	Messages       []*RoomMessage `json:"messages"`
	Asks           int            `json:"asks"`
	Replies        int            `json:"replies"`
	Delegations    int            `json:"delegations"`
	Steers         int            `json:"steers"`
	Wakes          int            `json:"wakes"`
	MaxWakes       int            `json:"maxWakesOnOneMessage,omitempty"`
	Unanswered     int            `json:"unanswered"`
	Pending        int            `json:"pending"`
	Rejected       int            `json:"rejected"`
	RepeatBubbles  int            `json:"repeatBubbles"`
	MaxRepeat      int            `json:"maxRepeat"`
	BadReplyRefs   int            `json:"badReplyRefs"`
	SelfLoops      int            `json:"selfLoops"`
	UnresolvedSend int            `json:"unresolvedSends"`
}

// RepeatGroup is one piece of text the same actor sent over and over: the shape a runaway
// loop leaves in a transcript. Rejected counts how many of those attempts the room would
// not accept, which is the difference between an agent restating itself and an agent
// hammering something the room already said no to.
type RepeatGroup struct {
	Actor    string    `json:"actor"`
	Kind     string    `json:"kind"`
	Text     string    `json:"text"`
	Chars    int       `json:"chars"`
	Count    int       `json:"count"`
	Rejected int       `json:"rejected,omitempty"`
	FirstAt  time.Time `json:"firstAt,omitempty"`
	LastAt   time.Time `json:"lastAt,omitempty"`
	SpanSec  float64   `json:"spanSeconds"`
	Sessions []string  `json:"sessions,omitempty"`
}

type SessionSummary struct {
	ID           string         `json:"id"`
	ShortID      string         `json:"shortId"`
	Label        string         `json:"label"`
	Name         string         `json:"name,omitempty"`
	Project      string         `json:"project,omitempty"`
	Host         string         `json:"host,omitempty"`
	Cwd          string         `json:"cwd,omitempty"`
	File         string         `json:"file,omitempty"`
	Dir          string         `json:"dir,omitempty"`
	Status       string         `json:"status,omitempty"`
	Connected    bool           `json:"connected,omitempty"`
	RoomOnly     bool           `json:"roomOnly,omitempty"`
	Focus        string         `json:"focus,omitempty"`
	Checkpoint   string         `json:"checkpoint,omitempty"`
	Branch       string         `json:"branch,omitempty"`
	Started      time.Time      `json:"started,omitempty"`
	LastAt       time.Time      `json:"lastAt,omitempty"`
	LastSeen     time.Time      `json:"lastSeen,omitempty"`
	LastPulse    time.Time      `json:"lastPulse,omitempty"`
	Entries      int            `json:"entries"`
	Calls        int            `json:"teamRoomCalls"`
	Wakes        int            `json:"wakes"`
	Sent         int            `json:"sent"`
	Received     int            `json:"received"`
	Participants int            `json:"chats"`
	Rejected     int            `json:"rejectedCalls"`
	Preview      string         `json:"preview,omitempty"`
	Counts       map[string]int `json:"counts,omitempty"`
}

type Health struct {
	Sessions        int            `json:"sessions"`
	TeamRoomCalls   int            `json:"teamRoomCalls"`
	DirectCalls     int            `json:"directCalls"`
	Files           int            `json:"files"`
	RoomSessions    int            `json:"roomSessions"`
	Direct          int            `json:"directMessages"`
	Broadcast       int            `json:"broadcastCalls"`
	Wakes           int            `json:"wakes"`
	WakeShapes      map[string]int `json:"wakeDetailShapes,omitempty"`
	WakeHits        int            `json:"wakeDeliveryHits"`
	Messages        int            `json:"stateMessages"`
	Updates         int            `json:"stateUpdates"`
	Journal         int            `json:"stateJournal"`
	Matched         int            `json:"matchedSendAndState"`
	Delivered       int            `json:"delivered"`
	Read            int            `json:"read"`
	Answered        int            `json:"answered"`
	Threads         int            `json:"threads"`
	Rejected        int            `json:"rejectedSends"`
	RejectReasons   map[string]int `json:"rejectReasons,omitempty"`
	RepeatGroups    int            `json:"repeatGroups"`
	RepeatBubbles   int            `json:"repeatBubbles"`
	BadReplyRefs    int            `json:"badMessageIds"`
	BadReplyReasons map[string]int `json:"badMessageIdReasons,omitempty"`
	UnresolvedSend  int            `json:"unresolvedTargets"`
	// InferredTargets counts the sends whose recipient the viewer worked out for itself
	// (from a reply link or the wake that prompted the send) rather than reading it off a
	// record the room wrote. It is the honest denominator for every link in the UI.
	InferredTargets int     `json:"inferredTargets"`
	SelfLoops       int     `json:"selfLoops"`
	RepeatedWakes   int     `json:"repeatedWakes"`
	ScanSeconds     float64 `json:"scanSeconds,omitempty"`
	IndexedMB       float64 `json:"indexedMB,omitempty"`
}

// view is the built, cacheable answer the HTTP layer serves.
type view struct {
	Generation  int64
	Mode        string
	Options     groupOptions
	Chats       []Chat
	Sessions    []SessionSummary
	Messages    []*RoomMessage
	Broadcast   []*RoomMessage
	Rejected    []*RoomMessage
	Repeats     []RepeatGroup
	Health      Health
	GeneratedAt time.Time
}
