// Package hub runs one goroutine per loaded world (spec §3.1). That goroutine, run(), owns the
// world's cell map, its players and its seq counter. Joins, leaves, edits, the snapshot build and
// the subscribe all happen inside it, as messages on its inbox (G1: 0 of 300 trials failed; a
// variant that took the snapshot in the HTTP handler failed 134 of 300).
//
// run() never blocks on a client and never calls the store's writer: sends go through each
// connection's bounded queue (Sender), kicks only signal, and every flush hands a copy of the dirty
// state to the persistence writer over a non-blocking channel send.
package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/text/unicode/norm"

	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// Timing (spec §5 constants).
const (
	TickInterval  = 100 * time.Millisecond
	FlushInterval = time.Second
	// UnloadDelay is how long an empty world waits before asking to be unloaded.
	UnloadDelay = 60 * time.Second
	// With fewer than 2 players online, a {"t":"ping"} goes out every pingEveryTicks ticks (2 s).
	pingEveryTicks = 20
	// replyTimeout bounds every wait on run() (re-gate S3/S4: Join and Online select on the
	// world's done channel and a 5 s timeout).
	replyTimeout = 5 * time.Second
	inboxSize    = 4096
)

// CloseInternal is the WebSocket close code for a server-side failure (RFC 6455 1011).
const CloseInternal = 1011

// Sender is one connection as the world sees it. S4's connection layer implements it; tests fake
// it. None of its methods may block.
type Sender interface {
	// Send queues a JSON text frame. False means the queue is full; the world then kicks 4002.
	Send(msg []byte) bool
	// SendSnapshot queues the binary snapshot frame. It is the forced variant of Send: exempt
	// from the 1 MiB queue cap and not counted toward it (gate-2 S3, re-gate S3/S4), so a world
	// whose snapshot is over 1 MiB stays joinable.
	SendSnapshot(frame []byte)
	// Kick only signals: it sets the close code and cancels the connection's context. The
	// connection's own writer goroutine performs the close (spec §3.1).
	Kick(code int, reason string)
	// ID identifies the connection, for logs.
	ID() int
}

// PlayerLoader reads a saved player (store.Store implements it).
type PlayerLoader interface {
	LoadPlayer(wid int64, nameKey string) (store.PlayerRow, bool, error)
}

// Player is one online player. The exported fields are its identity and live pose; run() owns it.
type Player struct {
	ID                  int
	NameKey, Name, Skin string
	Bid                 string
	X, Y, Z, Yaw, Pitch float64
	HasPos              bool
	Extras              []byte
	// Bot marks a bot connection (spec §4), set from the hello at join. A bot behaves like any
	// other player except: it is excluded from /worlds online, from ChooseSpawn's near targets,
	// and from the delete-occupied check (it is kicked with 4006 instead).
	Bot bool

	sender Sender
	dirty  bool // pose or extras changed since the last flush (gate-2 B4)
}

// JoinResult is a successful join. Takeover is true when the connection replaced this browser's
// previous one (same name, same bid) and kept its player id.
type JoinResult struct {
	ID       int
	Takeover bool
}

// JoinError is a refused join; the connection sends an error message with Code and closes.
type JoinError struct {
	Code    int
	Message string
}

func (e *JoinError) Error() string { return fmt.Sprintf("join refused: %d %s", e.Code, e.Message) }

var (
	ErrStopped = errors.New("hub: world stopped")
	ErrTimeout = errors.New("hub: world did not answer in time")
)

// ── commands (S4's reader goroutine submits these; every per-player command carries its Sender,
// and run() ignores a command whose Sender is not the player's current one: gate-2 B1) ──

type CmdLeave struct {
	ID int
	S  Sender
}

type CmdEdit struct {
	ID  int
	S   Sender
	Cid int64
	Ops []proto.Op
}

type CmdPos struct {
	ID  int
	S   Sender
	Pos proto.Pos
}

type CmdFx struct {
	ID int
	S  Sender
	Fx proto.Fx
}

type CmdExtras struct {
	ID   int
	S    Sender
	Data json.RawMessage
}

type CmdLeaving struct {
	ID          int
	S           Sender
	SecondsLeft int
}

// CmdTick and CmdFlush do what run()'s own tickers do; tests submit them to step the clock.
type CmdTick struct{}
type CmdFlush struct{}

// CmdKickBots kicks every online bot with Code/Reason (spec §4: deleting a world kicks its bots
// with 4006). Queued like any other command, so a caller that submits it just before Stop is
// guaranteed (FIFO on the inbox) that it runs before the final flush.
type CmdKickBots struct {
	Code   int
	Reason string
}

type cmdJoin struct {
	hello proto.Hello
	key   string
	s     Sender
	pre   *preSnapshot // only in the unsafe test build
	reply chan joinReply
}

type joinReply struct {
	res JoinResult
	err error
}

type cmdStop struct{}

type cmdOnline struct{ reply chan []proto.PlayerInfo }

type cmdLastPos struct {
	key   string
	reply chan lastPos
}

type lastPos struct {
	row store.PlayerRow
	ok  bool
}

type cmdSnapshotCopy struct{ reply chan preSnapshot }

type preSnapshot struct {
	seq   uint32
	frame []byte
}

// World is one loaded world.
type World struct {
	row     store.WorldRow
	loader  PlayerLoader
	flushCh chan<- store.FlushBatch
	inbox   chan any
	done    chan struct{}
	count   atomic.Int32
	// humanCount is count minus the online bots (gate-2 engine note: players is owned by run(),
	// so Delete needs its own atomic counter, updated on join, on remove, and on a takeover that
	// changes the bot flag).
	humanCount atomic.Int32

	// owned by run()
	cells      map[store.CellKey]proto.Cell
	dirty      map[store.CellKey]struct{}
	players    map[int]*Player
	byName     map[string]int
	known      map[string]store.PlayerRow // players who left while the world was loaded: their latest record
	leftDirty  map[string]struct{}        // known records not yet handed to the writer
	seq        uint32
	flushedSeq uint32
	nextID     int
	ticks      int
	rnd        *rand.Rand
	idleTimer  *time.Timer

	// options
	onIdle    func()
	idleDelay time.Duration
	tickers   bool
	// beforeSubscribe is a test hook, nil in production, called between the snapshot build and
	// the subscribe.
	beforeSubscribe func()
	// unsafeSnapshotOutsideRun is the G2 instrument's red build, kept on purpose: the joining
	// goroutine takes the snapshot, then subscribes in a second step, the way an HTTP handler
	// would. (It asks run() for the copy, so the race detector stays quiet and G2 fails on the
	// gap itself, not on a data race.)
	unsafeSnapshotOutsideRun bool
}

// Option configures a World at construction.
type Option func(*World)

// WithOnIdle calls f (on its own goroutine, via time.AfterFunc) once the world has had no players
// for delay. run() never calls it synchronously; the registry's f re-checks Empty() under its lock.
func WithOnIdle(delay time.Duration, f func()) Option {
	return func(w *World) { w.idleDelay, w.onIdle = delay, f }
}

func withBeforeSubscribe(f func()) Option { return func(w *World) { w.beforeSubscribe = f } }

func withUnsafeSnapshotOutsideRun() Option {
	return func(w *World) { w.unsafeSnapshotOutsideRun = true }
}

// withoutTickers leaves ticks and flushes to CmdTick/CmdFlush, for deterministic tests.
func withoutTickers() Option { return func(w *World) { w.tickers = false } }

// NewWorld starts the world goroutine. cells is taken over by the world. flushCh is the
// persistence writer's channel.
func NewWorld(row store.WorldRow, cells map[store.CellKey]proto.Cell, st PlayerLoader, flushCh chan<- store.FlushBatch, opts ...Option) *World {
	w := &World{
		row:        row,
		loader:     st,
		flushCh:    flushCh,
		inbox:      make(chan any, inboxSize),
		done:       make(chan struct{}),
		cells:      cells,
		dirty:      map[store.CellKey]struct{}{},
		players:    map[int]*Player{},
		byName:     map[string]int{},
		known:      map[string]store.PlayerRow{},
		leftDirty:  map[string]struct{}{},
		seq:        row.LastSeq,
		flushedSeq: row.LastSeq,
		nextID:     proto.FirstPlayerID,
		rnd:        rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), uint64(row.WID))),
		idleDelay:  UnloadDelay,
		tickers:    true,
	}
	for _, o := range opts {
		o(w)
	}
	w.startIdle() // a world loaded for a join that never registers must still unload
	go w.run()
	return w
}

// ── public API (any goroutine) ──

// Submit queues a command. After Stop it is a no-op; it never panics.
func (w *World) Submit(cmd any) { w.send(cmd) }

func (w *World) send(cmd any) bool {
	select {
	case <-w.done:
		return false
	default:
	}
	select {
	case w.inbox <- cmd:
		return true
	case <-w.done:
		return false
	}
}

func await[T any](w *World, ch <-chan T) (T, error) {
	var zero T
	t := time.NewTimer(replyTimeout)
	defer t.Stop()
	select {
	case v := <-ch:
		return v, nil
	case <-w.done:
		select {
		case v := <-ch:
			return v, nil
		default:
			return zero, ErrStopped
		}
	case <-t.C:
		return zero, ErrTimeout
	}
}

// Join registers a player (spec §3.1 takeover rules). On success, the welcome and the snapshot
// have already been queued on s, and s receives every edit after the snapshot's seq.
func (w *World) Join(h proto.Hello, s Sender) (JoinResult, error) {
	key, err := proto.NameKey(h.Name)
	if err != nil {
		return JoinResult{}, &JoinError{Code: proto.CloseBadName, Message: err.Error()}
	}
	c := cmdJoin{hello: h, key: key, s: s, reply: make(chan joinReply, 1)}
	if w.unsafeSnapshotOutsideRun {
		snap := make(chan preSnapshot, 1)
		if !w.send(cmdSnapshotCopy{reply: snap}) {
			return JoinResult{}, ErrStopped
		}
		pre, err := await(w, snap)
		if err != nil {
			return JoinResult{}, err
		}
		if w.beforeSubscribe != nil {
			w.beforeSubscribe()
		}
		c.pre = &pre
	}
	if !w.send(c) {
		return JoinResult{}, ErrStopped
	}
	r, err := await(w, c.reply)
	if err != nil {
		return JoinResult{}, err
	}
	return r.res, r.err
}

// Online lists the online players. It returns nil once the world has stopped.
func (w *World) Online() []proto.PlayerInfo {
	c := cmdOnline{reply: make(chan []proto.PlayerInfo, 1)}
	if !w.send(c) {
		return nil
	}
	r, _ := await(w, c.reply)
	return r
}

// Empty reports whether no player is online. It never waits on run().
func (w *World) Empty() bool { return w.count.Load() == 0 }

// HumanCount reports the number of online non-bot players. It never waits on run() (like Empty).
func (w *World) HumanCount() int { return int(w.humanCount.Load()) }

// KickBots queues a kick of every online bot with code/reason (spec §4). It never waits on run();
// a caller that needs the kick to have run first (Delete, before Stop) relies on inbox FIFO order.
func (w *World) KickBots(code int, reason string) { w.Submit(CmdKickBots{Code: code, Reason: reason}) }

// LastPos returns the live record of a player, online or left while this world was loaded; the
// pose follows pos messages. False if the world holds no record (the store may still have one).
func (w *World) LastPos(nameKey string) (store.PlayerRow, bool) {
	c := cmdLastPos{key: nameKey, reply: make(chan lastPos, 1)}
	if !w.send(c) {
		return store.PlayerRow{}, false
	}
	r, _ := await(w, c.reply)
	return r.row, r.ok
}

// Stop stops run() and blocks until it has exited, after it hands the final flush batch to
// flushCh. That hand-off may block, but only after run() has stopped accepting commands. Stop is
// idempotent.
func (w *World) Stop() {
	w.send(cmdStop{})
	<-w.done
}

// Done is closed when run() has exited.
func (w *World) Done() <-chan struct{} { return w.done }

// ── run() and everything it owns ──

func (w *World) run() {
	defer close(w.done)
	var tickC, flushC <-chan time.Time
	if w.tickers {
		tk := time.NewTicker(TickInterval)
		defer tk.Stop()
		fl := time.NewTicker(FlushInterval)
		defer fl.Stop()
		tickC, flushC = tk.C, fl.C
	}
	for {
		select {
		case <-tickC:
			w.tick()
		case <-flushC:
			w.flush()
		case cmd := <-w.inbox:
			if _, ok := cmd.(cmdStop); ok {
				w.final()
				return
			}
			w.handle(cmd)
		}
	}
}

func (w *World) handle(cmd any) {
	switch c := cmd.(type) {
	case cmdJoin:
		w.join(c)
	case CmdLeave:
		if p := w.current(c.ID, c.S); p != nil {
			w.remove(p)
			w.broadcast(enc(proto.Left{T: proto.TLeft, ID: p.ID}), 0)
		}
	case CmdEdit:
		w.edit(c)
	case CmdPos:
		if p := w.current(c.ID, c.S); p != nil {
			p.X, p.Y, p.Z, p.Yaw, p.Pitch = c.Pos.X, c.Pos.Y, c.Pos.Z, c.Pos.Yaw, c.Pos.Pitch
			p.HasPos, p.dirty = true, true
		}
	case CmdExtras:
		if p := w.current(c.ID, c.S); p != nil && len(c.Data) <= proto.MaxExtrasBytes && json.Valid(c.Data) {
			p.Extras = append([]byte(nil), c.Data...)
			p.dirty = true
		}
	case CmdFx:
		if p := w.current(c.ID, c.S); p != nil {
			f := c.Fx
			// A Face that isn't one of the six values never reaches other clients; its Tool goes with it,
			// so a receiver never sees a Tool without a Face it can compute an area from.
			if !proto.ValidFxFace(f.Face) {
				f.Face, f.Tool = "", 0
			}
			f.T, f.By = proto.TFx, p.ID
			w.broadcast(enc(f), p.ID)
		}
	case CmdLeaving:
		if p := w.current(c.ID, c.S); p != nil {
			w.broadcast(enc(proto.Leaving{T: proto.TLeaving, SecondsLeft: c.SecondsLeft, By: p.ID}), p.ID)
		}
	case CmdTick:
		w.tick()
	case CmdFlush:
		w.flush()
	case CmdKickBots:
		w.kickBots(c.Code, c.Reason)
	case cmdOnline:
		c.reply <- w.humanInfos()
	case cmdLastPos:
		c.reply <- w.lastPos(c.key)
	case cmdSnapshotCopy:
		c.reply <- preSnapshot{seq: w.seq, frame: proto.EncodeSnapshot(w.seq, w.cellSlice())}
	}
}

// current returns the player if s is its current connection, else nil (a stale reader after a
// takeover, or a player already removed).
func (w *World) current(id int, s Sender) *Player {
	p := w.players[id]
	if p == nil || p.sender != s {
		return nil
	}
	return p
}

func (w *World) join(c cmdJoin) {
	if id, online := w.byName[c.key]; online {
		p := w.players[id]
		if p.Bid != c.hello.Bid {
			c.reply <- joinReply{err: &JoinError{Code: proto.CloseNameTaken, Message: "name_taken"}}
			return
		}
		// Takeover: same player id, no left/join broadcast (spec §3.1).
		p.sender.Kick(proto.CloseReplaced, "replaced")
		row := w.rowOf(p)
		spawn := ChooseSpawn(&row, c.hello.Resume, w.others(p.ID), w.rnd)
		if !w.welcome(p, c.s, spawn, c.pre) {
			// The new connection could not take the welcome: drop the player entirely.
			p.sender = c.s
			w.drop(p, proto.CloseSlow, "slow")
			c.reply <- joinReply{err: &JoinError{Code: proto.CloseSlow, Message: "slow"}}
			return
		}
		p.sender = c.s // subscribe
		if p.Bot != c.hello.Bot {
			// A takeover can change the bot flag; humanCount must follow it (gate-2 engine note).
			if p.Bot {
				w.humanCount.Add(1)
			} else {
				w.humanCount.Add(-1)
			}
			p.Bot = c.hello.Bot
		}
		c.reply <- joinReply{res: JoinResult{ID: p.ID, Takeover: true}}
		return
	}

	var row *store.PlayerRow
	if r, ok := w.known[c.key]; ok {
		row = &r
	} else {
		r, ok, err := w.loader.LoadPlayer(w.row.WID, c.key)
		if err != nil {
			c.reply <- joinReply{err: &JoinError{Code: CloseInternal, Message: err.Error()}}
			return
		}
		if ok {
			row = &r
		}
	}
	spawn := ChooseSpawn(row, c.hello.Resume, w.others(0), w.rnd)
	p := &Player{
		ID:      w.nextID,
		NameKey: c.key,
		Name:    norm.NFC.String(strings.TrimSpace(c.hello.Name)),
		Skin:    proto.SkinOf(c.hello.Skin),
		Bid:     c.hello.Bid,
		Bot:     c.hello.Bot,
		sender:  c.s,
	}
	w.nextID++
	if row != nil {
		p.Extras = row.Extras
		if row.HasPos {
			p.X, p.Y, p.Z, p.Yaw, p.Pitch, p.HasPos = row.X, row.Y, row.Z, row.Yaw, row.Pitch, true
		}
	}
	if _, pending := w.leftDirty[c.key]; pending {
		// The left record was not flushed yet; the live player now carries it.
		delete(w.leftDirty, c.key)
		p.dirty = true
	}
	delete(w.known, c.key)

	w.broadcast(enc(proto.Join{T: proto.TJoin, ID: p.ID, Name: p.Name, Skin: p.Skin, Bot: p.Bot}), 0)
	if !w.welcome(p, c.s, spawn, c.pre) {
		c.s.Kick(proto.CloseSlow, "slow")
		w.known[c.key] = w.rowOf(p)
		w.leftDirty[c.key] = struct{}{}
		w.broadcast(enc(proto.Left{T: proto.TLeft, ID: p.ID}), 0)
		c.reply <- joinReply{err: &JoinError{Code: proto.CloseSlow, Message: "slow"}}
		return
	}
	// subscribe
	w.players[p.ID] = p
	w.byName[c.key] = p.ID
	w.count.Add(1)
	if !p.Bot {
		w.humanCount.Add(1)
	}
	w.stopIdle()
	c.reply <- joinReply{res: JoinResult{ID: p.ID}}
}

// welcome queues the welcome and the snapshot on s, both built here in run(), then calls the
// beforeSubscribe hook. The caller subscribes right after, in the same step.
func (w *World) welcome(p *Player, s Sender, spawn proto.Spawn, pre *preSnapshot) bool {
	seq := w.seq
	var frame []byte
	if pre != nil {
		seq, frame = pre.seq, pre.frame
	} else {
		frame = proto.EncodeSnapshot(w.seq, w.cellSlice())
	}
	extras := json.RawMessage(p.Extras)
	if len(extras) == 0 || !json.Valid(extras) {
		extras = json.RawMessage(`{}`)
	}
	msg := enc(proto.Welcome{
		T:   proto.TWelcome,
		You: p.ID,
		World: proto.WorldInfo{
			UUID: w.row.UUID, Name: w.row.Name, Seed: w.row.Seed,
			Gen: w.row.Gen, Height: w.row.Height, MustMine: w.row.MustMine,
		},
		Spawn:      spawn,
		Extras:     extras,
		Players:    w.infos(p.ID),
		Seq:        seq,
		CatalogMax: proto.CatalogMax,
	})
	if !s.Send(msg) {
		return false
	}
	s.SendSnapshot(frame)
	if pre == nil && w.beforeSubscribe != nil {
		w.beforeSubscribe()
	}
	return true
}

func (w *World) edit(c CmdEdit) {
	p := w.current(c.ID, c.S)
	if p == nil {
		return
	}
	if err := proto.ValidateOps(c.Ops, w.row.Height, proto.CatalogMax); err != nil {
		// The author's screen is already wrong; it reconnects and resyncs (spec §5).
		w.drop(p, proto.CloseResync, "resync")
		return
	}
	w.seq++
	for _, o := range c.Ops {
		k := store.CellKey{X: o[0], Y: o[1], Z: o[2]}
		w.cells[k] = proto.Cell{X: o[0], Y: o[1], Z: o[2], ID: o[3], Fluid: o[4], Color: o[5]}
		w.dirty[k] = struct{}{}
	}
	w.broadcast(enc(proto.EditOut{T: proto.TEdit, Seq: w.seq, By: p.ID, Cid: c.Cid, Ops: c.Ops}), 0)
}

// broadcast sends msg to every player except the one with id except (0: nobody excepted). A
// player whose queue is full is kicked 4002, removed, and its left broadcast.
func (w *World) broadcast(msg []byte, except int) {
	var slow []*Player
	for id, p := range w.players {
		if id != except && !p.sender.Send(msg) {
			slow = append(slow, p)
		}
	}
	w.dropAll(slow)
}

func (w *World) dropAll(ps []*Player) {
	for _, p := range ps {
		if w.players[p.ID] == p {
			w.drop(p, proto.CloseSlow, "slow")
		}
	}
}

// drop kicks a player's connection, removes the player and tells everyone else. The `error`
// message comes first (spec §5); for a 4002 the queue is full and it is simply not delivered.
func (w *World) drop(p *Player, code int, reason string) {
	p.sender.Send(enc(proto.ErrorMsg{T: proto.TError, Code: code, Message: reason}))
	p.sender.Kick(code, reason)
	w.remove(p)
	w.broadcast(enc(proto.Left{T: proto.TLeft, ID: p.ID}), 0)
}

// remove unsubscribes a player and persists its last pose and extras (as dirty).
func (w *World) remove(p *Player) {
	delete(w.players, p.ID)
	delete(w.byName, p.NameKey)
	w.known[p.NameKey] = w.rowOf(p)
	w.leftDirty[p.NameKey] = struct{}{}
	w.count.Add(-1)
	if !p.Bot {
		w.humanCount.Add(-1)
	}
	if len(w.players) == 0 {
		w.startIdle()
	}
}

// kickBots drops every online bot with code/reason, the same way a slow or resynced connection is
// dropped (spec §4: deleting a world kicks its bots with 4006).
func (w *World) kickBots(code int, reason string) {
	var bots []*Player
	for _, p := range w.players {
		if p.Bot {
			bots = append(bots, p)
		}
	}
	for _, p := range bots {
		w.drop(p, code, reason)
	}
}

func (w *World) startIdle() {
	if w.onIdle == nil {
		return
	}
	w.stopIdle()
	w.idleTimer = time.AfterFunc(w.idleDelay, w.onIdle)
}

func (w *World) stopIdle() {
	if w.idleTimer != nil {
		w.idleTimer.Stop()
		w.idleTimer = nil
	}
}

func (w *World) tick() {
	w.ticks++
	if len(w.players) >= 2 {
		poses := make([][6]float64, 0, len(w.players))
		for _, p := range w.players {
			if p.HasPos {
				poses = append(poses, [6]float64{float64(p.ID), round(p.X, 100), round(p.Y, 100), round(p.Z, 100), round(p.Yaw, 1000), round(p.Pitch, 1000)})
			}
		}
		var slow []*Player
		for id, p := range w.players {
			others := make([][6]float64, 0, len(poses))
			for _, ps := range poses {
				if int(ps[0]) != id {
					others = append(others, ps)
				}
			}
			if !p.sender.Send(enc(proto.Tick{T: proto.TTick, Poses: others})) {
				slow = append(slow, p)
			}
		}
		w.dropAll(slow)
		return
	}
	if w.ticks%pingEveryTicks == 0 {
		var slow []*Player
		for _, p := range w.players {
			if !p.sender.Send(pingMsg) {
				slow = append(slow, p)
			}
		}
		w.dropAll(slow)
	}
}

var pingMsg = []byte(`{"t":"ping"}`)

func round(v, scale float64) float64 { return math.Round(v*scale) / scale }

// batch copies the cells and players dirtied since the last flush. ok is false when there is
// nothing to write.
func (w *World) batch() (store.FlushBatch, bool) {
	now := time.Now().UnixMilli()
	var players []store.PlayerRow
	for _, p := range w.players {
		if p.dirty {
			r := w.rowOf(p)
			r.LastSeen = now
			players = append(players, r)
		}
	}
	for k := range w.leftDirty {
		players = append(players, w.known[k])
	}
	if len(w.dirty) == 0 && len(players) == 0 && w.seq == w.flushedSeq {
		return store.FlushBatch{}, false
	}
	cells := make([]proto.Cell, 0, len(w.dirty))
	for k := range w.dirty {
		cells = append(cells, w.cells[k])
	}
	return store.FlushBatch{WID: w.row.WID, LastSeq: w.seq, Cells: cells, Players: players}, true
}

func (w *World) flushed(b store.FlushBatch) {
	w.dirty = map[store.CellKey]struct{}{}
	w.leftDirty = map[string]struct{}{}
	for _, p := range w.players {
		p.dirty = false
	}
	w.flushedSeq = b.LastSeq
}

// flush hands the dirty state to the writer without ever blocking; if the writer is busy, the
// dirty set is kept for the next flush (gate-2 S3).
func (w *World) flush() {
	b, ok := w.batch()
	if !ok || w.flushCh == nil {
		return
	}
	select {
	case w.flushCh <- b:
		w.flushed(b)
	default:
	}
}

// final runs after run() has stopped accepting commands: it may block on the writer.
func (w *World) final() {
	w.stopIdle()
	if b, ok := w.batch(); ok && w.flushCh != nil {
		w.flushCh <- b
		w.flushed(b)
	}
}

func (w *World) rowOf(p *Player) store.PlayerRow {
	return store.PlayerRow{
		NameKey: p.NameKey, Name: p.Name, Skin: p.Skin,
		X: p.X, Y: p.Y, Z: p.Z, Yaw: p.Yaw, Pitch: p.Pitch, HasPos: p.HasPos,
		Extras: p.Extras, LastSeen: time.Now().UnixMilli(),
	}
}

func (w *World) lastPos(key string) lastPos {
	if id, ok := w.byName[key]; ok {
		return lastPos{row: w.rowOf(w.players[id]), ok: true}
	}
	r, ok := w.known[key]
	return lastPos{row: r, ok: ok}
}

func (w *World) others(except int) []*Player {
	out := make([]*Player, 0, len(w.players))
	for id, p := range w.players {
		if id != except {
			out = append(out, p)
		}
	}
	return out
}

func (w *World) infos(except int) []proto.PlayerInfo {
	out := make([]proto.PlayerInfo, 0, len(w.players))
	for id, p := range w.players {
		if id != except {
			out = append(out, proto.PlayerInfo{ID: p.ID, Name: p.Name, Skin: p.Skin, X: p.X, Y: p.Y, Z: p.Z, Yaw: p.Yaw, Pitch: p.Pitch, HasPos: p.HasPos, Bot: p.Bot})
		}
	}
	return out
}

// humanInfos lists only non-bot players (spec §4: GET /worlds online excludes bots).
func (w *World) humanInfos() []proto.PlayerInfo {
	all := w.infos(0)
	out := make([]proto.PlayerInfo, 0, len(all))
	for _, pi := range all {
		if !pi.Bot {
			out = append(out, pi)
		}
	}
	return out
}

func (w *World) cellSlice() []proto.Cell {
	out := make([]proto.Cell, 0, len(w.cells))
	for _, c := range w.cells {
		out = append(out, c)
	}
	return out
}

// enc marshals a server message. Every type is fixed and every RawMessage is validated before it
// gets here, so an error is a programming error.
func enc(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("hub: marshal %T: %v", v, err))
	}
	return b
}
