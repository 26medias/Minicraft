package hub

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// ── fakes ──

type sent struct {
	bin  bool
	data []byte
}

// fakeSender records every message. full makes Send fail (a slow client). capBytes > 0 models
// the connection's 1 MiB queue with a reader that never drains: Send fails once the queued text
// bytes would pass the cap, and the forced snapshot does not count (re-gate S3/S4).
type fakeSender struct {
	id       int
	mu       sync.Mutex
	msgs     []sent
	kicks    []int
	full     atomic.Bool
	capBytes int
	queued   int
}

var senderIDs atomic.Int64

func newSender() *fakeSender { return &fakeSender{id: int(senderIDs.Add(1))} }

func (f *fakeSender) Send(b []byte) bool {
	if f.full.Load() {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.capBytes > 0 {
		if f.queued+len(b) > f.capBytes {
			return false
		}
		f.queued += len(b)
	}
	f.msgs = append(f.msgs, sent{data: append([]byte(nil), b...)})
	return true
}

func (f *fakeSender) SendSnapshot(b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, sent{bin: true, data: append([]byte(nil), b...)})
}

func (f *fakeSender) Kick(code int, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kicks = append(f.kicks, code)
}

func (f *fakeSender) ID() int { return f.id }

func (f *fakeSender) all() []sent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sent(nil), f.msgs...)
}

func (f *fakeSender) kicked() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.kicks...)
}

func typeOf(b []byte) string {
	var e proto.Envelope
	if err := json.Unmarshal(b, &e); err != nil {
		return "?"
	}
	return e.T
}

// types lists the text message types received, in order, skipping tick and ping.
func (f *fakeSender) types() []string {
	var out []string
	for _, m := range f.all() {
		if m.bin {
			out = append(out, "<snapshot>")
			continue
		}
		if t := typeOf(m.data); t != proto.TTick && t != proto.TPing {
			out = append(out, t)
		}
	}
	return out
}

func (f *fakeSender) count(t string) int {
	n := 0
	for _, m := range f.all() {
		if !m.bin && typeOf(m.data) == t {
			n++
		}
	}
	return n
}

func (f *fakeSender) errors() []proto.ErrorMsg {
	var out []proto.ErrorMsg
	for _, m := range f.all() {
		if !m.bin && typeOf(m.data) == proto.TError {
			var e proto.ErrorMsg
			if err := json.Unmarshal(m.data, &e); err != nil {
				panic(err)
			}
			out = append(out, e)
		}
	}
	return out
}

func (f *fakeSender) edits() []proto.EditOut {
	var out []proto.EditOut
	for _, m := range f.all() {
		if !m.bin && typeOf(m.data) == proto.TEdit {
			var e proto.EditOut
			if err := json.Unmarshal(m.data, &e); err != nil {
				panic(err)
			}
			out = append(out, e)
		}
	}
	return out
}

func (f *fakeSender) welcome(t *testing.T) proto.Welcome {
	t.Helper()
	for _, m := range f.all() {
		if !m.bin && typeOf(m.data) == proto.TWelcome {
			var w proto.Welcome
			if err := json.Unmarshal(m.data, &w); err != nil {
				t.Fatal(err)
			}
			return w
		}
	}
	t.Fatalf("sender %d got no welcome", f.id)
	return proto.Welcome{}
}

type fakeLoader struct {
	mu   sync.Mutex
	rows map[string]store.PlayerRow
}

func (l *fakeLoader) LoadPlayer(wid int64, key string) (store.PlayerRow, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	r, ok := l.rows[key]
	return r, ok, nil
}

// ── helpers ──

var testRow = store.WorldRow{WID: 1, UUID: "w-uuid", Name: "Test", Seed: 42, Gen: 3, Height: 256}

func newTestWorld(t *testing.T, cells map[store.CellKey]proto.Cell, flushCh chan store.FlushBatch, opts ...Option) *World {
	t.Helper()
	if cells == nil {
		cells = map[store.CellKey]proto.Cell{}
	}
	if flushCh == nil {
		flushCh = make(chan store.FlushBatch, 1024)
	}
	w := NewWorld(testRow, cells, &fakeLoader{rows: map[string]store.PlayerRow{}}, flushCh, opts...)
	t.Cleanup(w.Stop)
	return w
}

func hello(name, bid string) proto.Hello {
	return proto.Hello{T: proto.THello, World: testRow.UUID, Name: name, Skin: "skin-" + strings.ToLower(name), Bid: bid, Proto: proto.Proto, Gen: 3}
}

func mustJoin(t *testing.T, w *World, name, bid string, s Sender) int {
	t.Helper()
	r, err := w.Join(hello(name, bid), s)
	if err != nil {
		t.Fatalf("join %s: %v", name, err)
	}
	return r.ID
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func key(x, y, z int32) store.CellKey { return store.CellKey{X: x, Y: y, Z: z} }

func edit(id int, s Sender, cid int64, ops ...proto.Op) CmdEdit {
	return CmdEdit{ID: id, S: s, Cid: cid, Ops: ops}
}

func applyOps(m map[store.CellKey]proto.Cell, ops []proto.Op) {
	for _, o := range ops {
		m[key(o[0], o[1], o[2])] = proto.Cell{X: o[0], Y: o[1], Z: o[2], ID: o[3], Fluid: o[4], Color: o[5]}
	}
}

// ── G1: ordering ──

func TestG1ConcurrentEditsSameOrderEverywhere(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	senders := []*fakeSender{newSender(), newSender(), newSender()}
	ids := make([]int, 3)
	for i, s := range senders {
		ids[i] = mustJoin(t, w, fmt.Sprintf("P%d", i), fmt.Sprintf("bid%d", i), s)
	}
	const per = 100
	var wg sync.WaitGroup
	for i := range senders {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for c := 1; c <= per; c++ {
				w.Submit(edit(ids[i], senders[i], int64(c), proto.Op{int32(i), 10, int32(c), 1, 0, 0}))
			}
		}(i)
	}
	wg.Wait()
	for _, s := range senders {
		waitFor(t, "300 edits", func() bool { return len(s.edits()) == 3*per })
	}
	type key3 struct {
		seq uint32
		by  int
		cid int64
	}
	seqOf := func(s *fakeSender) []key3 {
		var out []key3
		for _, e := range s.edits() {
			out = append(out, key3{e.Seq, e.By, e.Cid})
		}
		return out
	}
	ref := seqOf(senders[0])
	for i, k := range ref {
		if k.seq != uint32(i+1) {
			t.Fatalf("seq %d at position %d, want %d", k.seq, i, i+1)
		}
	}
	for i, s := range senders[1:] {
		if got := seqOf(s); fmt.Sprint(got) != fmt.Sprint(ref) {
			t.Fatalf("sender %d saw a different (seq, by, cid) sequence", i+1)
		}
	}
	for i := range senders {
		var own []int64
		for _, k := range ref {
			if k.by == ids[i] {
				own = append(own, k.cid)
			}
		}
		if len(own) != per {
			t.Fatalf("author %d: %d own echoes, want %d", i, len(own), per)
		}
		for c, cid := range own {
			if cid != int64(c+1) {
				t.Fatalf("author %d: echo %d has cid %d", i, c, cid)
			}
		}
	}
}

// ── G2: snapshot and subscribe are atomic ──

// g2Scenario parks a join between the snapshot build and the subscribe while 50 edits land, then
// checks the joiner against an op log kept in the test. It returns what went wrong.
func g2Scenario(t *testing.T, unsafe bool) []string {
	rnd := rand.New(rand.NewPCG(7, 9))
	initial := map[store.CellKey]proto.Cell{}
	for i := 0; i < 30; i++ {
		c := proto.Cell{X: rnd.Int32N(8), Y: rnd.Int32N(8), Z: rnd.Int32N(8), ID: rnd.Int32N(20)}
		initial[key(c.X, c.Y, c.Z)] = c
	}
	oracle := map[store.CellKey]proto.Cell{}
	for k, c := range initial {
		oracle[k] = c
	}

	var armed atomic.Bool
	parked := make(chan struct{})
	release := make(chan struct{})
	hook := func() {
		if armed.CompareAndSwap(true, false) {
			close(parked)
			<-release
		}
	}
	opts := []Option{withBeforeSubscribe(hook)}
	if unsafe {
		opts = append(opts, withUnsafeSnapshotOutsideRun())
	}
	w := newTestWorld(t, initial, nil, opts...)

	a := newSender()
	aid := mustJoin(t, w, "Alice", "A", a)
	cid := int64(0)
	randOps := func() []proto.Op {
		ops := make([]proto.Op, 1+rnd.IntN(3))
		for i := range ops {
			ops[i] = proto.Op{rnd.Int32N(8), rnd.Int32N(8), rnd.Int32N(8), rnd.Int32N(30), 0, 0}
		}
		return ops
	}
	submit := func(n int) {
		for i := 0; i < n; i++ {
			ops := randOps()
			applyOps(oracle, ops)
			cid++
			w.Submit(edit(aid, a, cid, ops...))
		}
	}
	submit(10)
	waitFor(t, "pre-join edits", func() bool { return len(a.edits()) == 10 })

	armed.Store(true)
	c := newSender()
	joined := make(chan error, 1)
	go func() {
		_, err := w.Join(hello("Carol", "C"), c)
		joined <- err
	}()
	<-parked
	submit(50)
	// With the snapshot inside run(), run() is parked and nothing is broadcast; give an unsafe
	// build the time to broadcast all 50 before the subscribe.
	deadline := time.Now().Add(300 * time.Millisecond)
	for len(a.edits()) < 60 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(release)
	if err := <-joined; err != nil {
		t.Fatalf("join: %v", err)
	}
	submit(5)
	waitFor(t, "all edits at the author", func() bool { return len(a.edits()) == 65 })
	finalSeq := a.edits()[64].Seq
	lastSeq := func() uint32 {
		e := c.edits()
		if len(e) == 0 {
			return 0
		}
		return e[len(e)-1].Seq
	}
	waitFor(t, "the joiner to see the last edit", func() bool { return lastSeq() == finalSeq })

	var problems []string
	wel := c.welcome(t)
	var snap []byte
	var after []proto.EditOut
	seenSnap := false
	for _, m := range c.all() {
		switch {
		case m.bin:
			snap, seenSnap = m.data, true
		case seenSnap && typeOf(m.data) == proto.TEdit:
			var e proto.EditOut
			_ = json.Unmarshal(m.data, &e)
			after = append(after, e)
		}
	}
	if !seenSnap {
		return append(problems, "no snapshot")
	}
	sseq, cells, err := proto.DecodeSnapshot(snap)
	if err != nil {
		return append(problems, "snapshot: "+err.Error())
	}
	if sseq != wel.Seq {
		problems = append(problems, fmt.Sprintf("snapshot seq %d != welcome seq %d", sseq, wel.Seq))
	}
	got := map[store.CellKey]proto.Cell{}
	for _, cl := range cells {
		got[key(cl.X, cl.Y, cl.Z)] = cl
	}
	next := sseq + 1
	for _, e := range after {
		if e.Seq != next {
			problems = append(problems, fmt.Sprintf("after the snapshot (seq %d) expected edit seq %d, got %d", sseq, next, e.Seq))
			break
		}
		next++
		applyOps(got, e.Ops)
	}
	if fmt.Sprint(sortedCells(got)) != fmt.Sprint(sortedCells(oracle)) {
		problems = append(problems, "snapshot + edits != the oracle's final map")
	}
	return problems
}

func sortedCells(m map[store.CellKey]proto.Cell) []proto.Cell {
	out := make([]proto.Cell, 0, len(m))
	for _, c := range m {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.X != b.X {
			return a.X < b.X
		}
		if a.Z != b.Z {
			return a.Z < b.Z
		}
		return a.Y < b.Y
	})
	return out
}

func TestG2SnapshotSubscribeAtomic(t *testing.T) {
	if p := g2Scenario(t, false); len(p) > 0 {
		t.Fatalf("joiner diverged: %v", p)
	}
}

// The instrument's proof (spec §3.1, G1: a snapshot taken outside the world goroutine failed 134
// of 300 trials). With the snapshot built by the joining goroutine, G2 must see the divergence.
func TestG2InstrumentGoesRedOnSnapshotOutsideRun(t *testing.T) {
	if p := g2Scenario(t, true); len(p) == 0 {
		t.Fatal("G2 did not detect the snapshot-outside-run build: the instrument cannot go red")
	} else {
		t.Logf("red build detected: %v", p)
	}
}

// ── G7: takeover (hub part) ──

func TestG7TakeoverSameBid(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a1 := newSender()
	aid := mustJoin(t, w, "Noah", "X", a1)
	third := newSender()
	tid := mustJoin(t, w, "Léa", "L", third)
	w.Submit(CmdPos{ID: aid, S: a1, Pos: proto.Pos{X: 5, Y: 70, Z: 9}})

	a2 := newSender()
	r, err := w.Join(hello("noah", "X"), a2)
	if err != nil {
		t.Fatalf("takeover join: %v", err)
	}
	if r.ID != aid {
		t.Fatalf("takeover got id %d, want the same id %d", r.ID, aid)
	}
	if k := a1.kicked(); len(k) != 1 || k[0] != proto.CloseReplaced {
		t.Fatalf("old sender kicks = %v, want [4001]", k)
	}
	if wel := a2.welcome(t); wel.You != aid {
		t.Fatalf("new welcome you = %d, want %d", wel.You, aid)
	}

	// B1: the old reader's leave arrives after the takeover. It must be ignored.
	w.Submit(CmdLeave{ID: aid, S: a1})
	w.Submit(edit(aid, a2, 1, proto.Op{1, 2, 3, 4, 0, 0}))
	w.Submit(edit(tid, third, 1, proto.Op{1, 2, 4, 4, 0, 0}))
	waitFor(t, "edits after the stale leave", func() bool { return len(a2.edits()) == 2 && len(third.edits()) == 2 })
	if n := a1.count(proto.TEdit); n != 0 {
		t.Fatalf("the replaced sender still got %d edits", n)
	}
	if got := third.types(); fmt.Sprint(got) != "[welcome <snapshot> edit edit]" {
		t.Fatalf("third player saw %v, want no left/join", got)
	}
	for _, s := range []*fakeSender{a1, a2, third} {
		if s.count(proto.TLeft) != 0 {
			t.Fatalf("sender %d got a left", s.id)
		}
	}
	if on := w.Online(); len(on) != 2 {
		t.Fatalf("online = %v, want 2 players", on)
	}
}

// ── G7b: same name, other browser ──

func TestG7bNameTakenOtherBid(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a := newSender()
	aid := mustJoin(t, w, "Noah", "X", a)
	b := newSender()
	_, err := w.Join(hello("NOAH", "Y"), b)
	je, ok := err.(*JoinError)
	if !ok || je.Code != proto.CloseNameTaken {
		t.Fatalf("second Noah got %v, want a 4009 JoinError", err)
	}
	if len(b.all()) != 0 {
		t.Fatalf("the refused sender was sent %v", b.types())
	}
	if k := a.kicked(); len(k) != 0 {
		t.Fatalf("the first Noah was kicked: %v", k)
	}
	w.Submit(edit(aid, a, 1, proto.Op{1, 1, 1, 1, 0, 0}))
	waitFor(t, "A's echo", func() bool { return len(a.edits()) == 1 })
}

func TestJoinBadName(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	_, err := w.Join(hello("a<b", "X"), newSender())
	if je, ok := err.(*JoinError); !ok || je.Code != proto.CloseBadName {
		t.Fatalf("got %v, want a 4008 JoinError", err)
	}
}

// ── G12: invalid batch ──

func TestG12InvalidBatchResync(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	bid := mustJoin(t, w, "B", "b", b)
	w.Submit(edit(aid, a, 1, proto.Op{1, 1, 1, 1, 0, 0}, proto.Op{2, 2, 2, proto.CatalogMax + 1, 0, 0}))
	waitFor(t, "the 4003 kick", func() bool { return len(a.kicked()) == 1 })
	if k := a.kicked(); k[0] != proto.CloseResync {
		t.Fatalf("kick %v, want 4003", k)
	}
	// Spec §5: an `error` with the code comes before the close.
	if e := a.errors(); len(e) != 1 || e[0].Code != proto.CloseResync {
		t.Fatalf("error messages %+v, want one with code 4003", e)
	}
	w.Submit(edit(bid, b, 1, proto.Op{3, 3, 3, 1, 0, 0}))
	waitFor(t, "B's echo", func() bool { return len(b.edits()) == 1 })
	if e := b.edits(); e[0].Seq != 1 || e[0].By != bid {
		t.Fatalf("B's echo %+v: the rejected batch moved seq", e[0])
	}
	if n := a.count(proto.TEdit); n != 0 {
		t.Fatalf("the rejected author got %d edits", n)
	}
}

// ── welcome.players: hasPos, and the skin bound ──

// A player who joined but has not sent `pos` yet is listed with hasPos false, so the client does
// not draw them at (0,0,0); once they have a pose it is true.
func TestWelcomePlayersHasPos(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b, c := newSender(), newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	mustJoin(t, w, "B", "b", b)
	pb := b.welcome(t).Players
	if len(pb) != 1 || pb[0].ID != aid || pb[0].HasPos {
		t.Fatalf("B's welcome players %+v, want A with hasPos false", pb)
	}
	w.Submit(CmdPos{ID: aid, S: a, Pos: proto.Pos{T: proto.TPos, X: 5, Y: 70, Z: 6}})
	mustJoin(t, w, "C", "c", c)
	for _, p := range c.welcome(t).Players {
		if p.ID == aid && (!p.HasPos || p.X != 5) {
			t.Fatalf("C's welcome lists A as %+v, want hasPos true at x 5", p)
		}
	}
}

// hello.skin is bounded: an oversized skin is stored and relayed as "" (the client's default).
func TestJoinBoundsSkin(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b := newSender(), newSender()
	h := hello("A", "a")
	h.Skin = strings.Repeat("x", 1<<20)
	aid, err := w.Join(h, a)
	if err != nil {
		t.Fatal(err)
	}
	mustJoin(t, w, "B", "b", b)
	pb := b.welcome(t).Players
	if len(pb) != 1 || pb[0].ID != aid.ID || pb[0].Skin != "" {
		t.Fatalf("B's welcome players skin len %d, want \"\"", len(pb[0].Skin))
	}
}

// ── G9: a slow sender is dropped, not waited on ──

func TestG9SlowSenderKicked(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b, c := newSender(), newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	bid := mustJoin(t, w, "B", "b", b)
	mustJoin(t, w, "C", "c", c)
	b.full.Store(true)
	w.Submit(edit(aid, a, 1, proto.Op{1, 1, 1, 1, 0, 0}))
	waitFor(t, "the 4002 kick", func() bool { return len(b.kicked()) == 1 })
	if k := b.kicked(); k[0] != proto.CloseSlow {
		t.Fatalf("kick %v, want 4002", k)
	}
	w.Submit(edit(aid, a, 2, proto.Op{1, 1, 2, 1, 0, 0}))
	for _, s := range []*fakeSender{a, c} {
		waitFor(t, "later edits at the others", func() bool { return len(s.edits()) == 2 })
		// Amendment: a 4002 kick removes the player and broadcasts left.
		var left bool
		for _, m := range s.all() {
			var l proto.Left
			if typeOf(m.data) == proto.TLeft && json.Unmarshal(m.data, &l) == nil && l.ID == bid {
				left = true
			}
		}
		if !left {
			t.Fatalf("sender %d got no left for the slow player", s.id)
		}
	}
	if on := w.Online(); len(on) != 2 {
		t.Fatalf("online %v, want the slow player removed", on)
	}
}

// ── G13 (hub part) ──

func TestG13Online(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	if !w.Empty() {
		t.Fatal("a new world is not empty")
	}
	mustJoin(t, w, "Noah", "x", newSender())
	mustJoin(t, w, "Léa", "y", newSender())
	on := w.Online()
	got := []string{}
	for _, p := range on {
		got = append(got, p.Name+"/"+p.Skin)
	}
	sort.Strings(got)
	if fmt.Sprint(got) != "[Léa/skin-léa Noah/skin-noah]" {
		t.Fatalf("online = %v", got)
	}
	if w.Empty() {
		t.Fatal("Empty() with 2 players")
	}
}

// ── snapshot over 1 MiB (amendment: the snapshot frame is exempt from the queue cap) ──

func TestBigSnapshotJoinable(t *testing.T) {
	rnd := rand.New(rand.NewPCG(3, 4))
	cells := map[store.CellKey]proto.Cell{}
	for len(cells) < 250_000 {
		c := proto.Cell{X: rnd.Int32N(512), Y: rnd.Int32N(256), Z: rnd.Int32N(512), ID: rnd.Int32N(proto.CatalogMax), Fluid: rnd.Int32N(2) * 0x83, Color: 0x1000000 | rnd.Int32N(0x1000000)}
		cells[key(c.X, c.Y, c.Z)] = c
	}
	w := newTestWorld(t, cells, nil)
	s := newSender()
	s.capBytes = 1 << 20
	mustJoin(t, w, "Noah", "x", s)
	if k := s.kicked(); len(k) != 0 {
		t.Fatalf("joining a big world kicked %v", k)
	}
	var snap []byte
	for _, m := range s.all() {
		if m.bin {
			snap = m.data
		}
	}
	if len(snap) <= 1<<20 {
		t.Fatalf("precondition: snapshot is %d bytes, want over 1 MiB", len(snap))
	}
	_, got, err := proto.DecodeSnapshot(snap)
	if err != nil || len(got) != len(cells) {
		t.Fatalf("snapshot decode: %d cells, %v", len(got), err)
	}
}

// ── leave, persistence and resume ──

func TestLeaveBroadcastsPersistsAndResumes(t *testing.T) {
	flushCh := make(chan store.FlushBatch, 16)
	w := newTestWorld(t, nil, flushCh, withoutTickers())
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "Noah", "x", a)
	lid := mustJoin(t, w, "Léa", "y", b)
	w.Submit(CmdPos{ID: lid, S: b, Pos: proto.Pos{X: 100, Y: 64, Z: 100}})
	w.Submit(CmdPos{ID: aid, S: a, Pos: proto.Pos{X: 1.5, Y: 70, Z: 2.5, Yaw: 0.5, Pitch: 0.25}})
	w.Submit(CmdExtras{ID: aid, S: a, Data: json.RawMessage(`{"selected":3}`)})
	w.Submit(CmdLeave{ID: aid, S: a})
	waitFor(t, "left", func() bool { return b.count(proto.TLeft) == 1 })
	if row, ok := w.LastPos("noah"); !ok || !row.HasPos || row.X != 1.5 || string(row.Extras) != `{"selected":3}` {
		t.Fatalf("LastPos = %+v, %v", row, ok)
	}
	w.Submit(CmdFlush{})
	batch := <-flushCh
	var noah *store.PlayerRow
	for i := range batch.Players {
		if batch.Players[i].NameKey == "noah" {
			noah = &batch.Players[i]
		}
	}
	if noah == nil || !noah.HasPos || noah.Z != 2.5 || string(noah.Extras) != `{"selected":3}` {
		t.Fatalf("flush players = %+v, want Noah's last pose and extras", batch.Players)
	}
	// resume → return at the live record, even with Léa online.
	a2 := newSender()
	r, err := w.Join(proto.Hello{T: proto.THello, Name: "Noah", Skin: "s", Bid: "x", Proto: 1, Gen: 3, Resume: true}, a2)
	if err != nil {
		t.Fatal(err)
	}
	wel := a2.welcome(t)
	if wel.Spawn != (proto.Spawn{Mode: proto.SpawnReturn, X: 1.5, Y: 70, Z: 2.5, Yaw: 0.5, Pitch: 0.25}) || string(wel.Extras) != `{"selected":3}` {
		t.Fatalf("resume welcome spawn %+v extras %s", wel.Spawn, wel.Extras)
	}
	if r.ID == aid {
		t.Fatal("a rejoin after a real leave reused the id")
	}
	// not resuming, Léa online → near her.
	w.Submit(CmdLeave{ID: r.ID, S: a2})
	a3 := newSender()
	mustJoin(t, w, "Noah", "x", a3)
	if sp := a3.welcome(t).Spawn; sp != (proto.Spawn{Mode: proto.SpawnNear, Target: lid, X: 100, Y: 64, Z: 100}) {
		t.Fatalf("spawn %+v, want near Léa", sp)
	}
}

// ── B4: flushes include online players whose pose or extras changed ──

func TestFlushIncludesChangedOnlinePlayers(t *testing.T) {
	flushCh := make(chan store.FlushBatch, 16)
	w := NewWorld(testRow, map[store.CellKey]proto.Cell{}, &fakeLoader{rows: map[string]store.PlayerRow{}}, flushCh, withoutTickers())
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "Noah", "x", a)
	mustJoin(t, w, "Léa", "y", b)
	w.Submit(CmdPos{ID: aid, S: a, Pos: proto.Pos{X: 3, Y: 4, Z: 5}})
	w.Submit(edit(aid, a, 1, proto.Op{1, 2, 3, 4, 0x83, 0x1FFF5E0}))
	w.Submit(CmdFlush{})
	b1 := <-flushCh
	if len(b1.Players) != 1 || b1.Players[0].NameKey != "noah" || !b1.Players[0].HasPos || b1.Players[0].X != 3 {
		t.Fatalf("flush 1 players = %+v, want only Noah with his pos", b1.Players)
	}
	if len(b1.Cells) != 1 || b1.Cells[0] != (proto.Cell{X: 1, Y: 2, Z: 3, ID: 4, Fluid: 0x83, Color: 0x1FFF5E0}) || b1.LastSeq != 1 || b1.WID != testRow.WID {
		t.Fatalf("flush 1 = %+v", b1)
	}
	// Nothing changed: no batch.
	w.Submit(CmdFlush{})
	_ = w.Online() // a round trip: the flush above has been handled
	select {
	case b := <-flushCh:
		t.Fatalf("an idle flush handed over %+v", b)
	default:
	}
	w.Submit(CmdExtras{ID: aid, S: a, Data: json.RawMessage(`{"hotbar":[1]}`)})
	w.Submit(CmdPos{ID: aid, S: a, Pos: proto.Pos{X: 30, Y: 40, Z: 50}})
	w.Stop()
	b2 := <-flushCh
	if len(b2.Players) != 1 || b2.Players[0].X != 30 || string(b2.Players[0].Extras) != `{"hotbar":[1]}` {
		t.Fatalf("Stop's final flush players = %+v", b2.Players)
	}
}

// The flush hand-off never blocks run(): with nobody reading flushCh, the world keeps serving,
// and the dirty set is kept for the next flush.
func TestFlushHandOffNonBlocking(t *testing.T) {
	flushCh := make(chan store.FlushBatch) // unbuffered, nobody reading yet
	w := NewWorld(testRow, map[store.CellKey]proto.Cell{}, &fakeLoader{rows: map[string]store.PlayerRow{}}, flushCh, withoutTickers())
	a := newSender()
	aid := mustJoin(t, w, "Noah", "x", a)
	w.Submit(edit(aid, a, 1, proto.Op{1, 1, 1, 1, 0, 0}))
	w.Submit(CmdFlush{})
	w.Submit(edit(aid, a, 2, proto.Op{2, 2, 2, 2, 0, 0}))
	done := make(chan []proto.PlayerInfo)
	go func() { done <- w.Online() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run() blocked on the flush hand-off")
	}
	// Now the writer is back: a later flush hands over the kept dirty set. The hand-off is
	// non-blocking, so retry until the receiver is parked on the channel.
	var b store.FlushBatch
	deadline := time.Now().Add(5 * time.Second)
	for received := false; !received; {
		if time.Now().After(deadline) {
			t.Fatal("no flush was ever handed over")
		}
		w.Submit(CmdFlush{})
		select {
		case b = <-flushCh:
			received = true
		case <-time.After(10 * time.Millisecond):
		}
	}
	if len(b.Cells) != 2 {
		t.Fatalf("flush after a missed hand-off has %d cells, want 2 (dirty set kept)", len(b.Cells))
	}
	go func() {
		for range flushCh {
		}
	}()
	w.Stop()
}

func TestSubmitAfterStopIsNoop(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a := newSender()
	aid := mustJoin(t, w, "Noah", "x", a)
	w.Stop()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 10_000; i++ { // more than the inbox holds
			w.Submit(edit(aid, a, int64(i+1), proto.Op{1, 1, 1, 1, 0, 0}))
		}
		w.Stop()
		if on := w.Online(); on != nil {
			t.Errorf("Online after Stop = %v", on)
		}
		if _, err := w.Join(hello("Léa", "y"), newSender()); err == nil {
			t.Error("Join after Stop succeeded")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Submit/Stop/Online/Join after Stop hung")
	}
}

// ── tick and ping ──

func TestTickSendsOthersPoses(t *testing.T) {
	w := newTestWorld(t, nil, nil, withoutTickers())
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	bid := mustJoin(t, w, "B", "b", b)
	w.Submit(CmdPos{ID: aid, S: a, Pos: proto.Pos{X: 1.23456, Y: 2, Z: 3, Yaw: 0.123456, Pitch: -0.5}})
	w.Submit(CmdPos{ID: bid, S: b, Pos: proto.Pos{X: 9, Y: 8, Z: 7}})
	w.Submit(CmdTick{})
	lastTick := func(s *fakeSender) (proto.Tick, bool) {
		var tk proto.Tick
		ok := false
		for _, m := range s.all() {
			if !m.bin && typeOf(m.data) == proto.TTick {
				_ = json.Unmarshal(m.data, &tk)
				ok = true
			}
		}
		return tk, ok
	}
	waitFor(t, "ticks", func() bool {
		ta, oka := lastTick(a)
		tb, okb := lastTick(b)
		return oka && okb && len(ta.Poses) == 1 && len(tb.Poses) == 1 && ta.Poses[0][1] == 9 && tb.Poses[0][1] > 1
	})
	ta, _ := lastTick(a)
	tb, _ := lastTick(b)
	if ta.Poses[0] != [6]float64{float64(bid), 9, 8, 7, 0, 0} {
		t.Fatalf("A's tick %v", ta.Poses)
	}
	if tb.Poses[0] != [6]float64{float64(aid), 1.23, 2, 3, 0.123, -0.5} {
		t.Fatalf("B's tick %v (x/y/z to 0.01, yaw/pitch to 0.001)", tb.Poses)
	}
}

func TestLonePlayerGetsPingsNotTicks(t *testing.T) {
	w := newTestWorld(t, nil, nil, withoutTickers())
	a := newSender()
	mustJoin(t, w, "A", "a", a)
	for i := 0; i < pingEveryTicks; i++ {
		w.Submit(CmdTick{})
	}
	waitFor(t, "a ping", func() bool { return a.count(proto.TPing) >= 1 })
	if n := a.count(proto.TTick); n != 0 {
		t.Fatalf("a lone player got %d ticks", n)
	}
}

// ── fx, leaving: relayed with by, not echoed ──

func TestFxAndLeavingRelayed(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	mustJoin(t, w, "B", "b", b)
	w.Submit(CmdFx{ID: aid, S: a, Fx: proto.Fx{T: proto.TFx, Kind: "boom", X: 1, Y: 2, Z: 3, Tier: 2}})
	w.Submit(CmdLeaving{ID: aid, S: a, SecondsLeft: 60})
	waitFor(t, "relays", func() bool { return b.count(proto.TFx) == 1 && b.count(proto.TLeaving) == 1 })
	for _, m := range b.all() {
		switch typeOf(m.data) {
		case proto.TFx:
			var f proto.Fx
			_ = json.Unmarshal(m.data, &f)
			if f.By != aid || f.Kind != "boom" || f.Tier != 2 || f.X != 1 {
				t.Fatalf("fx %+v", f)
			}
		case proto.TLeaving:
			var l proto.Leaving
			_ = json.Unmarshal(m.data, &l)
			if l.By != aid || l.SecondsLeft != 60 {
				t.Fatalf("leaving %+v", l)
			}
		}
	}
	_ = w.Online()
	if a.count(proto.TFx) != 0 || a.count(proto.TLeaving) != 0 {
		t.Fatal("fx/leaving echoed to the author")
	}
}

// ── idle timer: the world asks to be unloaded 60 s (here: a short delay) after its last leave ──

func TestIdleCallback(t *testing.T) {
	var fired atomic.Int32
	w := newTestWorld(t, nil, nil, WithOnIdle(30*time.Millisecond, func() { fired.Add(1) }))
	a := newSender()
	aid := mustJoin(t, w, "A", "a", a)
	time.Sleep(80 * time.Millisecond)
	if fired.Load() != 0 {
		t.Fatal("idle fired while a player was online")
	}
	w.Submit(CmdLeave{ID: aid, S: a})
	waitFor(t, "idle", func() bool { return fired.Load() == 1 })
	if !w.Empty() {
		t.Fatal("not empty after the last leave")
	}
}

// Mining cracks: a `mine` fx carries its duration; the relay must keep it (the server re-encodes the struct,
// so a field it does not know is silently dropped).
func TestFxMineRelaysDur(t *testing.T) {
	w := newTestWorld(t, nil, nil)
	a, b := newSender(), newSender()
	aid := mustJoin(t, w, "A", "a", a)
	mustJoin(t, w, "B", "b", b)
	w.Submit(CmdFx{ID: aid, S: a, Fx: proto.Fx{T: proto.TFx, Kind: "mine", X: 4, Y: 5, Z: 6, Tier: 1, Dur: 1500}})
	waitFor(t, "relay", func() bool { return b.count(proto.TFx) == 1 })
	for _, m := range b.all() {
		if typeOf(m.data) != proto.TFx {
			continue
		}
		var f proto.Fx
		_ = json.Unmarshal(m.data, &f)
		if f.Kind != "mine" || f.Dur != 1500 || f.Tier != 1 || f.By != aid {
			t.Fatalf("fx %+v", f)
		}
	}
}
