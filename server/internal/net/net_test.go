package net

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	stdnet "net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"minicraft/server/internal/config"
	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

const testToken = "t"

// ── harness ──

type harness struct {
	t   *testing.T
	db  string
	srv *Server
	ts  *httptest.Server
	st  *store.Store
}

func newHarness(t *testing.T) *harness {
	return newHarnessCfg(t, config.Config{})
}

// newHarnessCfg is newHarness with a caller-supplied config (e.g. MinClient); Token and Origins
// default the same way newHarness's did when left unset.
func newHarnessCfg(t *testing.T, cfg config.Config) *harness {
	t.Helper()
	db := filepath.Join(t.TempDir(), "mc.sqlite")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token == "" {
		cfg.Token = testToken
	}
	if cfg.Origins == nil {
		cfg.Origins = strings.Split(config.DefaultOrigins, ",")
	}
	srv := NewServer(cfg, st)
	ts := httptest.NewServer(srv.Handler())
	h := &harness{t: t, db: db, srv: srv, ts: ts, st: st}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
		ts.CloseClientConnections()
		ts.Close()
		st.Close()
	})
	return h
}

func (h *harness) wsURL() string {
	return "ws" + strings.TrimPrefix(h.ts.URL, "http") + "/ws?token=" + testToken
}

func (h *harness) world(name string) store.WorldRow {
	h.t.Helper()
	w, err := h.st.CreateWorld(name, 42, 3, 256, false)
	if err != nil {
		h.t.Fatal(err)
	}
	return w
}

// msg is one frame a test client received. T is the message type read from the frame's prefix
// (every server struct marshals "t" first), so a 40 KB edit is not parsed just to be counted.
type msg struct {
	bin  bool
	t    string
	data []byte
	at   time.Time
}

func msgType(b []byte) string {
	const pre = `{"t":"`
	if !bytes.HasPrefix(b, []byte(pre)) {
		return ""
	}
	rest := b[len(pre):]
	if i := bytes.IndexByte(rest, '"'); i >= 0 {
		return string(rest[:i])
	}
	return ""
}

// client is a test WebSocket client. Its reader goroutine records tick arrival times and passes
// every other frame on msgs; start it late to model a client that stops reading.
type client struct {
	t    *testing.T
	c    *websocket.Conn
	msgs chan msg
	done chan struct{}
	err  error // valid after done

	mu    sync.Mutex
	ticks []time.Time

	stopPing chan struct{}
}

func dialURL(t *testing.T, url string, hdr http.Header) (*client, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(64 << 20)
	cl := &client{t: t, c: c, msgs: make(chan msg, 1<<14), done: make(chan struct{}), stopPing: make(chan struct{})}
	t.Cleanup(func() {
		cl.stopKeepalive()
		c.CloseNow()
	})
	return cl, nil
}

func (h *harness) dial() *client {
	h.t.Helper()
	cl, err := dialURL(h.t, h.wsURL(), nil)
	if err != nil {
		h.t.Fatal(err)
	}
	cl.startReader()
	return cl
}

func (cl *client) startReader() {
	go func() {
		defer close(cl.done)
		for {
			typ, b, err := cl.c.Read(context.Background())
			if err != nil {
				cl.err = err
				return
			}
			m := msg{bin: typ == websocket.MessageBinary, data: b, at: time.Now()}
			if !m.bin {
				m.t = msgType(b)
			}
			if m.t == proto.TTick {
				cl.mu.Lock()
				cl.ticks = append(cl.ticks, m.at)
				cl.mu.Unlock()
				continue
			}
			cl.msgs <- m
		}
	}()
}

// keepalive sends {"t":"ping"} every second, like the real client (spec §3.1).
func (cl *client) keepalive() {
	go func() {
		tk := time.NewTicker(time.Second)
		defer tk.Stop()
		for {
			select {
			case <-cl.stopPing:
				return
			case <-tk.C:
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				cl.c.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`))
				cancel()
			}
		}
	}()
}

var stopOnce sync.Map

func (cl *client) stopKeepalive() {
	if _, loaded := stopOnce.LoadOrStore(cl, true); !loaded {
		close(cl.stopPing)
	}
}

func (cl *client) send(v any) {
	cl.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		cl.t.Fatal(err)
	}
	cl.sendRaw(b)
}

func (cl *client) sendRaw(b []byte) {
	cl.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := cl.c.Write(ctx, websocket.MessageText, b); err != nil {
		cl.t.Fatalf("write: %v", err)
	}
}

func hello(world, name, bid string) proto.Hello {
	return proto.Hello{T: proto.THello, World: world, Name: name, Skin: "red", Bid: bid, Proto: proto.Proto, Gen: 3}
}

// next returns the next non-tick frame, or fails after d.
func (cl *client) next(d time.Duration) (msg, bool) {
	select {
	case m := <-cl.msgs:
		return m, true
	case <-time.After(d):
		return msg{}, false
	}
}

// until skips frames until one of type typ satisfies ok (nil: any), failing after d.
func (cl *client) until(typ string, d time.Duration, ok func(msg) bool) msg {
	cl.t.Helper()
	deadline := time.Now().Add(d)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			cl.t.Fatalf("no %q within %v", typ, d)
		}
		select {
		case m := <-cl.msgs:
			if m.t == typ && (ok == nil || ok(m)) {
				return m
			}
		case <-cl.done:
			cl.t.Fatalf("connection ended waiting for %q: %v", typ, cl.err)
		case <-time.After(left):
			cl.t.Fatalf("no %q within %v", typ, d)
		}
	}
}

// join sends hello and waits for welcome and the snapshot frame.
func (cl *client) join(h proto.Hello) proto.Welcome {
	cl.t.Helper()
	cl.send(h)
	m := cl.until(proto.TWelcome, 5*time.Second, nil)
	var w proto.Welcome
	if err := json.Unmarshal(m.data, &w); err != nil {
		cl.t.Fatal(err)
	}
	if s, ok := cl.next(5 * time.Second); !ok || !s.bin {
		cl.t.Fatalf("no snapshot frame after welcome (got %+v)", s.t)
	}
	return w
}

func (cl *client) waitEcho(cid int64, d time.Duration) proto.EditOut {
	cl.t.Helper()
	m := cl.until(proto.TEdit, d, func(m msg) bool { return bytes.Contains(m.data, []byte(fmt.Sprintf(`"cid":%d,`, cid))) })
	var e proto.EditOut
	if err := json.Unmarshal(m.data, &e); err != nil {
		cl.t.Fatal(err)
	}
	return e
}

// closeCode waits for the connection to end and returns its close status (-1 if none).
func (cl *client) closeCode(d time.Duration) websocket.StatusCode {
	cl.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case <-cl.msgs:
		case <-cl.done:
			return websocket.CloseStatus(cl.err)
		case <-deadline:
			cl.t.Fatalf("connection still open after %v", d)
		}
	}
}

// maxGap returns the longest silence between from and to: between consecutive ticks, and at
// either end of the window (so a stream that stops counts), plus the tick count in the window.
func maxGap(ts []time.Time, from, to time.Time) (time.Duration, int) {
	prev := from
	var gap time.Duration
	n := 0
	for _, t := range ts {
		if t.Before(from) || t.After(to) {
			continue
		}
		if t.Sub(prev) > gap {
			gap = t.Sub(prev)
		}
		prev = t
		n++
	}
	if to.Sub(prev) > gap {
		gap = to.Sub(prev)
	}
	return gap, n
}

func (cl *client) tickTimes() []time.Time {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	return append([]time.Time(nil), cl.ticks...)
}

// editOps builds n valid ops: distinct cells in one column block.
func editOps(n int, id int32) []proto.Op {
	ops := make([]proto.Op, n)
	for i := range ops {
		ops[i] = proto.Op{int32(100 + i%50), int32(10 + (i/50)%100), int32(200 + i/5000), id, 0, 0}
	}
	return ops
}

// ── proxy (G7): forwards TCP both ways until black-holed, then stops forwarding without closing ──

type proxy struct {
	ln    stdnet.Listener
	bh    atomic.Bool
	stop  chan struct{}
	conns []stdnet.Conn
	mu    sync.Mutex
}

func newProxy(t *testing.T, upstream string) *proxy {
	t.Helper()
	ln, err := stdnet.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &proxy{ln: ln, stop: make(chan struct{})}
	go func() {
		for {
			down, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := stdnet.Dial("tcp", upstream)
			if err != nil {
				down.Close()
				return
			}
			p.mu.Lock()
			p.conns = append(p.conns, down, up)
			p.mu.Unlock()
			go p.pipe(down, up)
			go p.pipe(up, down)
		}
	}()
	t.Cleanup(func() {
		close(p.stop)
		ln.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			c.Close()
		}
		p.mu.Unlock()
	})
	return p
}

func (p *proxy) pipe(src, dst stdnet.Conn) {
	buf := make([]byte, 32<<10)
	for {
		if p.bh.Load() {
			<-p.stop
			return
		}
		n, err := src.Read(buf)
		if p.bh.Load() {
			<-p.stop
			return
		}
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// kickLog records the server's kicks by player name (the Server.onKick test hook).
type kickLog struct {
	mu    sync.Mutex
	kicks map[string][]int
	ch    chan string
}

func (h *harness) logKicks() *kickLog {
	k := &kickLog{kicks: map[string][]int{}, ch: make(chan string, 1024)}
	h.srv.onKick = func(name string, code int) {
		k.mu.Lock()
		k.kicks[name] = append(k.kicks[name], code)
		k.mu.Unlock()
		select {
		case k.ch <- fmt.Sprintf("%s:%d", name, code):
		default:
		}
	}
	return k
}

func (k *kickLog) of(name string) []int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]int(nil), k.kicks[name]...)
}

// ── G10: origins and CORS ──

// Red build: websocket.Accept(w, r, nil) (the default same-host origin check) makes the first
// case fail with 403, because the real site's origin is not the server's host (G1).
func TestG10Origins(t *testing.T) {
	h := newHarness(t)

	cl, err := dialURL(t, h.wsURL(), http.Header{"Origin": {"https://noah.leap-forward.ca"}})
	if err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	}
	cl.c.CloseNow()

	if _, err := dialURL(t, h.wsURL(), http.Header{"Origin": {"https://evil.example"}}); err == nil {
		t.Fatal("https://evil.example was accepted")
	}

	req, _ := http.NewRequest(http.MethodOptions, h.ts.URL+"/worlds", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("OPTIONS /worlds = %d, want 204", res.StatusCode)
	}
	want := map[string]string{
		"Access-Control-Allow-Origin":  "http://localhost:5173",
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
	}
	for k, v := range want {
		if got := res.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}

	// A disallowed origin gets no allow header.
	req, _ = http.NewRequest(http.MethodOptions, h.ts.URL+"/worlds", nil)
	req.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("evil origin got Access-Control-Allow-Origin %q", got)
	}
}

// ── G11: read limit ──

// Red build: no SetReadLimit (the 32 KiB default) closes the socket on the 2,000-op edit (G1).
func TestG11BigMessages(t *testing.T) {
	h := newHarness(t)
	w := h.world("big")
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b1"))

	ops := editOps(proto.MaxOpsPerEdit, 1)
	cl.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: ops})

	// One message of 4 MiB - 64 KB: an extras whose data is padded.
	const size = 4<<20 - 64<<10
	head := `{"t":"extras","data":{"pad":"`
	tail := `"}}`
	big := head + strings.Repeat("x", size-len(head)-len(tail)) + tail
	if len(big) != size {
		t.Fatalf("built %d bytes, want %d", len(big), size)
	}
	cl.sendRaw([]byte(big))
	cl.send(proto.Edit{T: proto.TEdit, Cid: 2, Ops: editOps(1, 2)})

	e := cl.waitEcho(1, 5*time.Second)
	if len(e.Ops) != proto.MaxOpsPerEdit {
		t.Fatalf("echo carried %d ops, want %d", len(e.Ops), proto.MaxOpsPerEdit)
	}
	// The edit after the 4 MiB message echoes too: the connection survived it.
	cl.waitEcho(2, 5*time.Second)
}

// ── G8: read deadline ──

// Red build: reads without the 6 s context deadline leave the silent client connected forever.
func TestG8SilentClientDropped(t *testing.T) {
	h := newHarness(t)
	w := h.world("quiet")
	cl := h.dial()
	start := time.Now()
	cl.join(hello(w.UUID, "Noah", "b1"))
	select {
	case <-cl.done:
		if d := time.Since(start); d > 7*time.Second {
			t.Fatalf("dropped after %v, want within 7 s", d)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("silent client still connected after 7 s")
	}
}

// ── G9: slow consumer ──

// Red builds: a Send that blocks when the queue is full stalls the world goroutine, and every
// tick with it; a queue counted in messages lets the stalled client hold megabytes and never
// kicks it within the window.
func TestG9SlowConsumer(t *testing.T) {
	h := newHarness(t)
	kicks := h.logKicks()
	w := h.world("crowd")

	const n = 25
	clients := make([]*client, n)
	for i := range clients {
		cl, err := dialURL(t, h.wsURL(), nil)
		if err != nil {
			t.Fatal(err)
		}
		clients[i] = cl
		cl.keepalive()
		if i == n-1 {
			// The stalled client: it sends hello and pings but never reads.
			cl.send(hello(w.UUID, "stalled", "bs"))
			continue
		}
		cl.startReader()
		cl.join(hello(w.UUID, fmt.Sprintf("p%d", i), fmt.Sprintf("b%d", i)))
	}
	stalled := clients[n-1]
	// Wait for the stalled client to be registered (it shows in the online list).
	deadline := time.Now().Add(5 * time.Second)
	for {
		online := h.srv.reg.onlineOf(w.UUID)
		if len(online) == n {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d players online, want %d", len(online), n)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The stalled client starts reading as soon as the server kicks it, and must then receive
	// the 4002 close frame after its backlog (the writer's 2 s cut leaves time for that).
	go func() {
		<-waitFor(kicks, "stalled:4002")
		stalled.startReader()
	}()

	author := clients[0]
	const window = 5 * time.Second
	start := time.Now()
	var pushed int
	cid := int64(0)
	ops := editOps(proto.MaxOpsPerEdit, 3)
	for time.Since(start) < window-400*time.Millisecond || pushed < 8<<20 {
		cid++
		b, _ := json.Marshal(proto.Edit{T: proto.TEdit, Cid: cid, Ops: ops})
		author.sendRaw(b)
		pushed += len(b)
		time.Sleep(18 * time.Millisecond)
		if time.Since(start) > 3*window {
			t.Fatalf("pushed only %d bytes in %v", pushed, time.Since(start))
		}
	}
	end := start.Add(window)
	if time.Now().Before(end) {
		time.Sleep(time.Until(end))
	}
	if pushed < 8<<20 {
		t.Fatalf("pushed %d bytes, want >= 8 MB", pushed)
	}
	t.Logf("pushed %d bytes in %d edits", pushed, cid)

	for i, cl := range clients[:n-1] {
		gap, count := maxGap(cl.tickTimes(), start, end)
		if count < 30 {
			t.Errorf("client %d: %d ticks in the window", i, count)
		}
		if gap >= 300*time.Millisecond {
			t.Errorf("client %d: max tick gap %v, want < 300 ms", i, gap)
		}
		select {
		case <-cl.done:
			t.Errorf("client %d disconnected: %v", i, cl.err)
		default:
		}
	}

	// The stalled client was kicked 4002 once its queue passed 1 MiB.
	select {
	case <-waitFor(kicks, "stalled:4002"):
	case <-time.After(5 * time.Second):
		t.Fatalf("stalled client not kicked 4002 (kicks: %v)", kicks.of("stalled"))
	}
	if code := stalled.closeCode(10 * time.Second); code != proto.CloseSlow {
		t.Fatalf("stalled client closed with %v, want 4002", code)
	}
	for i := 0; i < n-1; i++ {
		if k := kicks.of(fmt.Sprintf("p%d", i)); len(k) != 0 {
			t.Errorf("p%d kicked %v", i, k)
		}
	}
}

// waitFor returns a channel that fires once the kick log has seen want (name:code).
func waitFor(k *kickLog, want string) <-chan string {
	out := make(chan string, 1)
	go func() {
		name, code, _ := strings.Cut(want, ":")
		for {
			for _, c := range k.of(name) {
				if fmt.Sprint(c) == code {
					out <- want
					return
				}
			}
			select {
			case <-k.ch:
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	return out
}

// ── G7: takeover of a black-holed connection ──

// Red build: a Kick that closes the socket itself (conn.Close on the world goroutine) stalls
// the world about 5 s on the black-holed peer, and the third player's tick gap goes over 300 ms.
func TestG7TakeoverBlackholed(t *testing.T) {
	h := newHarness(t)
	kicks := h.logKicks()
	w := h.world("blip")

	px := newProxy(t, h.ts.Listener.Addr().String())
	aURL := "ws://" + px.ln.Addr().String() + "/ws?token=" + testToken
	a, err := dialURL(t, aURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.startReader()
	a.keepalive()
	wa := a.join(hello(w.UUID, "Noah", "X"))

	c := h.dial()
	c.keepalive()
	c.join(hello(w.UUID, "Friend", "Y"))

	time.Sleep(500 * time.Millisecond)
	start := time.Now()
	px.bh.Store(true)
	a.stopKeepalive()

	time.Sleep(time.Second)
	a2 := h.dial()
	a2.keepalive()
	wa2 := a2.join(hello(w.UUID, "Noah", "X"))
	if wa2.You != wa.You {
		t.Fatalf("takeover got you=%d, want %d", wa2.You, wa.You)
	}
	select {
	case <-waitFor(kicks, "noah:4001"):
	case <-time.After(2 * time.Second):
		t.Fatalf("old connection not kicked 4001 (kicks %v)", kicks.of("noah"))
	}

	// Watch the friend's ticks through the takeover and the old connection's close.
	time.Sleep(3 * time.Second)
	end := time.Now()
	gap, count := maxGap(c.tickTimes(), start, end)
	if count < 20 {
		t.Fatalf("friend got %d ticks", count)
	}
	if gap >= 300*time.Millisecond {
		t.Fatalf("friend's max tick gap %v during the takeover, want < 300 ms", gap)
	}
	// No left/join broadcast for a takeover.
	for {
		m, ok := c.next(10 * time.Millisecond)
		if !ok {
			break
		}
		if m.t == proto.TLeft || m.t == proto.TJoin {
			t.Fatalf("friend saw %s during a takeover: %s", m.t, m.data)
		}
	}
	// The new connection works.
	a2.send(proto.Edit{T: proto.TEdit, Cid: 7, Ops: editOps(1, 1)})
	a2.waitEcho(7, 3*time.Second)
}

// ── G13: /worlds ──

func (h *harness) do(method, path string, body any) (*http.Response, []byte) {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.ts.URL+path, rd)
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, b
}

func TestG13Worlds(t *testing.T) {
	h := newHarness(t)
	var made []proto.WorldListing
	for _, name := range []string{"one", "two", "three"} {
		res, b := h.do(http.MethodPost, "/worlds", map[string]any{"name": name, "seed": 7, "mustMine": name == "two", "gen": 3})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("POST /worlds = %d %s", res.StatusCode, b)
		}
		var row proto.WorldListing
		if err := json.Unmarshal(b, &row); err != nil {
			t.Fatal(err)
		}
		if row.Name != name || row.UUID == "" || row.Online == nil {
			t.Fatalf("POST returned %s", b)
		}
		made = append(made, row)
		time.Sleep(3 * time.Millisecond) // distinct createdAt
	}
	if res, _ := h.do(http.MethodPost, "/worlds", map[string]any{"name": "future", "seed": 1, "gen": 4}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST gen 4 = %d, want 400", res.StatusCode)
	}

	// Join the oldest one: it must list first.
	cl := h.dial()
	cl.join(hello(made[0].UUID, "Noah", "b"))

	res, b := h.do(http.MethodGet, "/worlds", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /worlds = %d", res.StatusCode)
	}
	var rows []proto.WorldListing
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, r := range rows {
		order = append(order, r.Name)
	}
	if strings.Join(order, ",") != "one,three,two" {
		t.Fatalf("order %v, want one,three,two (occupied first, then newest)", order)
	}
	if len(rows[0].Online) != 1 || rows[0].Online[0].Name != "Noah" || rows[0].Online[0].Skin != "red" {
		t.Fatalf("online of the occupied world = %+v", rows[0].Online)
	}
	if rows[1].Online == nil || len(rows[1].Online) != 0 {
		t.Fatalf("an empty world's online must be [] (got %s)", b)
	}
	if !strings.Contains(string(b), `"online":[]`) {
		t.Fatalf("empty online must marshal as []: %s", b)
	}

	if res, _ := h.do(http.MethodDelete, "/worlds/"+made[0].UUID, nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("DELETE occupied = %d, want 409", res.StatusCode)
	}
	if res, _ := h.do(http.MethodDelete, "/worlds/"+made[1].UUID, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE empty = %d, want 204", res.StatusCode)
	}
	if res, _ := h.do(http.MethodDelete, "/worlds/"+made[1].UUID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("DELETE again = %d, want 404", res.StatusCode)
	}
	_, b = h.do(http.MethodGet, "/worlds", nil)
	if strings.Contains(string(b), made[1].UUID) {
		t.Fatalf("deleted world still listed: %s", b)
	}

	// Without the token: 401. The query form of the token works too.
	res, err := http.Get(h.ts.URL + "/worlds")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET without token = %d, want 401", res.StatusCode)
	}
	res, err = http.Get(h.ts.URL + "/worlds?token=" + testToken)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET with ?token = %d, want 200", res.StatusCode)
	}
}

// A world loaded but empty can be deleted: it is unloaded first, and its final flush does not
// resurrect rows after the delete.
func TestDeleteLoadedEmptyWorld(t *testing.T) {
	h := newHarness(t)
	w := h.world("gone")
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: editOps(10, 1)})
	cl.waitEcho(1, 3*time.Second)
	cl.c.Close(websocket.StatusNormalClosure, "")
	waitEmpty(t, h.srv.reg, w.UUID)

	if res, _ := h.do(http.MethodDelete, "/worlds/"+w.UUID, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE = %d", res.StatusCode)
	}
	db, err := sql.Open("sqlite", h.db)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"worlds", "cells", "players"} {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM "+table+" WHERE wid = ?", w.WID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%d %s rows left after delete", n, table)
		}
	}
}

func (r *Registry) onlineOf(uuid string) []proto.PlayerInfo {
	r.mu.Lock()
	e := r.loaded[uuid]
	r.mu.Unlock()
	if e == nil {
		return nil
	}
	return e.w.Online()
}

func waitEmpty(t *testing.T, r *Registry, uuid string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.mu.Lock()
		e := r.loaded[uuid]
		empty := e == nil || e.w.Empty()
		r.mu.Unlock()
		if empty {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("world never became empty")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ── G14: unload race ──

func TestG14UnloadRace(t *testing.T) {
	old := unloadDelay
	unloadDelay = 50 * time.Millisecond
	defer func() { unloadDelay = old }()

	h := newHarness(t)
	w := h.world("race")
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.c.Close(websocket.StatusNormalClosure, "")

	rnd := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < 200; i++ {
		time.Sleep(time.Duration(rnd.IntN(61)) * time.Millisecond)
		cl := h.dial()
		cl.join(hello(w.UUID, "Noah", "b"))
		cid := int64(i + 1)
		cl.send(proto.Edit{T: proto.TEdit, Cid: cid, Ops: editOps(1, int32(1+i%5))})
		cl.waitEcho(cid, 5*time.Second)
		cl.c.Close(websocket.StatusNormalClosure, "")
	}
	t.Logf("loads %d, unloads %d", h.srv.reg.loads.Load(), h.srv.reg.unloads.Load())
	if h.srv.reg.unloads.Load() == 0 {
		t.Fatal("the world never unloaded: the loop did not exercise the unload window")
	}
}

// G14, deterministic (gate-2 B2): the join parks between Get and Join while the unload timer
// fires. Red build: Join called after releasing mu — the unload stops the world under the
// parked join, which then fails.
func TestG14UnloadDuringJoin(t *testing.T) {
	old := unloadDelay
	unloadDelay = 200 * time.Millisecond
	defer func() { unloadDelay = old }()

	h := newHarness(t)
	w := h.world("race")
	// The hooks are installed before any world loads (the timer goroutine reads them) and armed
	// for the second join only.
	var armed, parked atomic.Bool
	unloading := make(chan struct{}, 1)
	h.srv.reg.onTryUnload = func() {
		if armed.Load() {
			select {
			case unloading <- struct{}{}:
			default:
			}
		}
	}
	h.srv.reg.afterGetBeforeJoin = func() {
		if !armed.Load() || !parked.CompareAndSwap(false, true) {
			return
		}
		select {
		case <-unloading:
		case <-time.After(3 * time.Second):
			t.Error("the unload timer never fired while the join was parked")
		}
		time.Sleep(50 * time.Millisecond) // let an unlocked unload run to completion
	}

	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.c.Close(websocket.StatusNormalClosure, "")
	waitEmpty(t, h.srv.reg, w.UUID)
	armed.Store(true)

	cl2 := h.dial()
	cl2.join(hello(w.UUID, "Noah", "b"))
	cl2.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: editOps(1, 1)})
	cl2.waitEcho(1, 3*time.Second)
	if !parked.Load() {
		t.Fatal("the hook never ran")
	}
	if n := h.srv.reg.loads.Load(); n != 1 {
		t.Fatalf("world loaded %d times, want 1 (the parked join must keep the live world)", n)
	}
}

// Edits survive an unload and reload: the final flush reaches the store before a reload reads it.
func TestUnloadReloadKeepsEdits(t *testing.T) {
	old := unloadDelay
	unloadDelay = 20 * time.Millisecond
	defer func() { unloadDelay = old }()

	h := newHarness(t)
	w := h.world("keep")
	for i := 0; i < 20; i++ {
		cl := h.dial()
		cl.join(hello(w.UUID, "Noah", "b"))
		cl.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: []proto.Op{{int32(i), 5, 5, 1, 0, 0}}})
		cl.waitEcho(1, 3*time.Second)
		cl.c.Close(websocket.StatusNormalClosure, "")
		waitEmpty(t, h.srv.reg, w.UUID)
		time.Sleep(time.Duration(i%4) * 15 * time.Millisecond)
	}
	cl := h.dial()
	cl.send(hello(w.UUID, "Noah", "b"))
	cl.until(proto.TWelcome, 5*time.Second, nil)
	snap, _ := cl.next(5 * time.Second)
	_, cells, err := proto.DecodeSnapshot(snap.data)
	if err != nil {
		t.Fatal(err)
	}
	if len(cells) != 20 {
		t.Fatalf("snapshot has %d cells, want 20 (loads %d unloads %d)", len(cells), h.srv.reg.loads.Load(), h.srv.reg.unloads.Load())
	}
}

// Busy drives the hourly backup (spec §9): true while a world is loaded, and once more after a
// world that was loaded between two checks has unloaded; false on an idle server.
func TestBusy(t *testing.T) {
	old := unloadDelay
	unloadDelay = 20 * time.Millisecond
	defer func() { unloadDelay = old }()

	h := newHarness(t)
	w := h.world("busy")
	if h.srv.Busy() {
		t.Fatal("Busy on a server with nothing loaded")
	}
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	if !h.srv.Busy() || !h.srv.Busy() {
		t.Fatal("not Busy while a world is loaded")
	}
	cl.c.Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(5 * time.Second)
	for h.srv.reg.unloads.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("world never unloaded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Loaded and unloaded since the last check: still owed a backup.
	cl = h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.c.Close(websocket.StatusNormalClosure, "")
	for h.srv.reg.unloads.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("world never unloaded again")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !h.srv.Busy() {
		t.Fatal("not Busy after a world was loaded and unloaded between checks")
	}
	if h.srv.Busy() {
		t.Fatal("still Busy on the next check with nothing loaded")
	}
}

// ── refused handshakes ──

func TestRefusals(t *testing.T) {
	h := newHarness(t)
	w := h.world("ok")

	t.Run("bad token", func(t *testing.T) {
		cl, err := dialURL(t, strings.Replace(h.wsURL(), "token="+testToken, "token=nope", 1), nil)
		if err != nil {
			t.Fatal(err)
		}
		cl.startReader()
		if code := cl.closeCode(3 * time.Second); code != proto.CloseBadToken {
			t.Fatalf("close %v, want 4007", code)
		}
	})
	t.Run("bearer token", func(t *testing.T) {
		url := strings.TrimSuffix(h.wsURL(), "?token="+testToken)
		cl, err := dialURL(t, url, http.Header{"Authorization": {"Bearer " + testToken}})
		if err != nil {
			t.Fatal(err)
		}
		cl.startReader()
		cl.join(hello(w.UUID, "Bea", "bb"))
	})
	cases := []struct {
		name string
		h    proto.Hello
		code websocket.StatusCode
	}{
		{"unknown world", hello("no-such-world", "Noah", "b"), proto.CloseUnknownWorld},
		{"proto 2", func() proto.Hello { x := hello(w.UUID, "Noah", "b"); x.Proto = 2; return x }(), proto.CloseProto},
		{"gen 4", func() proto.Hello { x := hello(w.UUID, "Noah", "b"); x.Gen = 4; return x }(), proto.CloseGenUnsupported},
		{"bad name", hello(w.UUID, "No<ah", "b"), proto.CloseBadName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cl := h.dial()
			cl.send(c.h)
			m := cl.until(proto.TError, 3*time.Second, nil)
			var e proto.ErrorMsg
			json.Unmarshal(m.data, &e)
			if websocket.StatusCode(e.Code) != c.code {
				t.Fatalf("error message code %d, want %d", e.Code, c.code)
			}
			if code := cl.closeCode(3 * time.Second); code != c.code {
				t.Fatalf("close %v, want %d", code, c.code)
			}
		})
	}
	t.Run("name taken", func(t *testing.T) {
		a := h.dial()
		a.join(hello(w.UUID, "Sam", "one"))
		b := h.dial()
		b.send(hello(w.UUID, "SAM", "two"))
		if code := b.closeCode(3 * time.Second); code != proto.CloseNameTaken {
			t.Fatalf("close %v, want 4009", code)
		}
		a.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: editOps(1, 1)})
		a.waitEcho(1, 3*time.Second)
	})
	t.Run("first message not hello", func(t *testing.T) {
		cl := h.dial()
		cl.send(proto.Ping{T: proto.TPing})
		if code := cl.closeCode(3 * time.Second); code != websocket.StatusPolicyViolation {
			t.Fatalf("close %v, want 1008", code)
		}
	})
}

// A 4003 kick (invalid op) reaches the client as a close code, and the batch is not applied.
func TestResyncKick(t *testing.T) {
	h := newHarness(t)
	w := h.world("bad")
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: []proto.Op{{0, 0, 0, int32(proto.CatalogMax + 1), 0, 0}}})
	expectErrorThenClose(t, cl, proto.CloseResync)
}

// An edit that is not even valid JSON for its type is a 4003 too, with the same error message.
func TestResyncKickBadEditJSON(t *testing.T) {
	h := newHarness(t)
	w := h.world("badjson")
	cl := h.dial()
	cl.join(hello(w.UUID, "Noah", "b"))
	cl.sendRaw([]byte(`{"t":"edit","cid":1,"ops":"nope"}`))
	expectErrorThenClose(t, cl, proto.CloseResync)
}

// expectErrorThenClose checks spec §5: an `error` message with the code comes before the close.
func expectErrorThenClose(t *testing.T, cl *client, code int) {
	t.Helper()
	m := cl.until(proto.TError, 3*time.Second, nil)
	var e proto.ErrorMsg
	if err := json.Unmarshal(m.data, &e); err != nil {
		t.Fatal(err)
	}
	if e.Code != code {
		t.Fatalf("error message code %d, want %d", e.Code, code)
	}
	if got := cl.closeCode(3 * time.Second); int(got) != code {
		t.Fatalf("close %v, want %d", got, code)
	}
}

// Shutdown kicks every connection with 1001 and returns within about 2 s, even with a
// black-holed peer, after the worlds' final flush is in the store.
func TestShutdown(t *testing.T) {
	h := newHarness(t)
	w := h.world("bye")
	px := newProxy(t, h.ts.Listener.Addr().String())
	a, err := dialURL(t, "ws://"+px.ln.Addr().String()+"/ws?token="+testToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.startReader()
	a.join(hello(w.UUID, "Hole", "h"))
	b := h.dial()
	b.join(hello(w.UUID, "Noah", "b"))
	b.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: editOps(5, 1)})
	b.waitEcho(1, 3*time.Second)
	px.bh.Store(true)

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.srv.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("Shutdown took %v", d)
	}
	// Shutdown returns on its own 2 s timer; the connections must really be gone by then too.
	// Red build: without the 2 s cut armed in Kick, the black-holed one lingers about 5 s.
	if _, ok := h.waitConns(0, 4*time.Second); !ok || time.Since(start) > 2700*time.Millisecond {
		t.Fatalf("connections still tracked %v after Shutdown began, want <= 2.7 s", time.Since(start))
	}
	if code := b.closeCode(3 * time.Second); code != websocket.StatusGoingAway {
		t.Fatalf("close %v, want 1001", code)
	}
	cells, _, err := h.st.LoadCells(w.WID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cells) != 5 {
		t.Fatalf("%d cells in the store after Shutdown, want 5", len(cells))
	}
	// After Shutdown, a new connection is refused with 1001 and loads nothing.
	cl := h.dial()
	cl.send(hello(w.UUID, "Late", "l"))
	if code := cl.closeCode(3 * time.Second); code != websocket.StatusGoingAway {
		t.Fatalf("late join close %v, want 1001", code)
	}
}

// ── the B5 cut: a kicked connection is gone within 2 s ──

// waitConns waits until the server tracks n connections, and returns how long that took.
func (h *harness) waitConns(n int, d time.Duration) (time.Duration, bool) {
	start := time.Now()
	for {
		h.srv.mu.Lock()
		got := len(h.srv.conns)
		h.srv.mu.Unlock()
		if got == n {
			return time.Since(start), true
		}
		if time.Since(start) > d {
			return time.Since(start), false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Red build: without `time.AfterFunc(closeTimeout, c.cut)` in Kick, the connection to the
// black-holed peer stays open about 5 s (the library's own close wait), not 2 s.
func TestKickedBlackholedConnGone(t *testing.T) {
	h := newHarness(t)
	kicks := h.logKicks()
	w := h.world("gone")
	px := newProxy(t, h.ts.Listener.Addr().String())
	a, err := dialURL(t, "ws://"+px.ln.Addr().String()+"/ws?token="+testToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.startReader()
	a.keepalive()
	a.join(hello(w.UUID, "Noah", "X"))
	px.bh.Store(true)
	a.stopKeepalive()

	// The takeover kicks the black-holed connection 4001.
	a2 := h.dial()
	a2.keepalive()
	start := time.Now()
	a2.join(hello(w.UUID, "Noah", "X"))
	select {
	case <-waitFor(kicks, "noah:4001"):
	case <-time.After(2 * time.Second):
		t.Fatalf("old connection not kicked 4001 (kicks %v)", kicks.of("noah"))
	}
	// The kick came after start, so 2.7 s from start leaves the 2 s cut 0.7 s of slack.
	if _, ok := h.waitConns(1, 4*time.Second); !ok || time.Since(start) > 2700*time.Millisecond {
		t.Fatalf("kicked black-holed connection still tracked %v after the takeover began, want <= 2.7 s", time.Since(start))
	}
}

// ── S3/S4 re-gate: forced snapshot bytes do not count toward queuedBytes ──

// Red build: count the snapshot in SendSnapshot (`c.queuedBytes += len(b)`, forced:false): the
// first tick queued behind the 2 MiB snapshot is refused, which the world turns into a 4002.
func TestSnapshotBytesNotCounted(t *testing.T) {
	h := newHarness(t)
	got := make(chan *Conn, 1)
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := newConn(ws, h.srv)
		got <- c
		<-release
		c.Kick(int(websocket.StatusNormalClosure), "")
		<-c.wdone
	}))
	defer ts.Close()
	defer close(release)

	cl, err := dialURL(t, "ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := <-got

	// The client is not reading. A forced frame far larger than the loopback buffers leaves the
	// writer stuck in Write, as a paused client does after its welcome.
	const stuck = 32 << 20
	c.SendSnapshot(make([]byte, stuck))
	for deadline := time.Now().Add(5 * time.Second); ; {
		c.mu.Lock()
		n := len(c.queue)
		c.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("writer never took the first frame")
		}
		time.Sleep(time.Millisecond)
	}

	// The join sequence behind it: welcome, a snapshot over 1 MiB, then a second of ticks.
	if !c.Send([]byte(`{"t":"welcome"}`)) {
		t.Fatal("welcome refused")
	}
	const snap = 2 << 20
	c.SendSnapshot(make([]byte, snap))
	const ticks = 20
	for i := range ticks {
		if !c.Send([]byte(fmt.Sprintf(`{"t":"tick","seq":%d}`, i))) {
			t.Fatalf("tick %d refused behind a %d-byte snapshot: the snapshot was counted toward the 1 MiB cap", i, snap)
		}
	}

	// The client resumes and gets everything, in order.
	cl.startReader()
	want := []struct {
		bin bool
		n   int
		t   string
	}{{true, stuck, ""}, {false, 0, proto.TWelcome}, {true, snap, ""}}
	for i, w := range want {
		m, ok := cl.next(10 * time.Second)
		if !ok {
			t.Fatalf("frame %d missing", i)
		}
		if m.bin != w.bin || (w.bin && len(m.data) != w.n) || m.t != w.t {
			t.Fatalf("frame %d: bin=%v len=%d t=%q, want %+v", i, m.bin, len(m.data), m.t, w)
		}
	}
	for deadline := time.Now().Add(5 * time.Second); len(cl.tickTimes()) < ticks; {
		if time.Now().After(deadline) {
			t.Fatalf("got %d ticks, want %d", len(cl.tickTimes()), ticks)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ── extras size ──

// A stored extras rides in the welcome, a counted Send. Extras over proto.MaxExtrasBytes are
// ignored when received, so a player cannot store one that makes every later welcome fail 4002.
// Red build: drop the size check in the hub's CmdExtras: the rejoin is kicked 4002.
func TestHugeExtrasIgnored(t *testing.T) {
	h := newHarness(t)
	kicks := h.logKicks()
	w := h.world("stash")
	// Keep the world loaded between the two connections.
	keep := h.dial()
	keep.keepalive()
	keep.join(hello(w.UUID, "Friend", "f"))

	a := h.dial()
	a.join(hello(w.UUID, "Noah", "x"))
	a.send(proto.Extras{T: proto.TExtras, Data: json.RawMessage(`{"selected":3}`)})
	pad := strings.Repeat("x", 1100<<10)
	a.send(proto.Extras{T: proto.TExtras, Data: json.RawMessage(`{"pad":"` + pad + `"}`)})
	a.send(proto.Edit{T: proto.TEdit, Cid: 1, Ops: editOps(1, 1)})
	a.waitEcho(1, 5*time.Second) // both extras have been handled
	a.c.Close(websocket.StatusNormalClosure, "")
	keep.until(proto.TLeft, 5*time.Second, nil)

	b := h.dial()
	b.send(hello(w.UUID, "Noah", "x"))
	for {
		m, ok := b.next(5 * time.Second)
		if !ok {
			t.Fatalf("no welcome on rejoin (kicks %v)", kicks.of("noah"))
		}
		if m.t != proto.TWelcome {
			continue
		}
		var wl proto.Welcome
		if err := json.Unmarshal(m.data, &wl); err != nil {
			t.Fatal(err)
		}
		if string(wl.Extras) != `{"selected":3}` {
			t.Fatalf("welcome extras %.60s, want the last extras under the cap", wl.Extras)
		}
		break
	}
	// The first connection's own close is a 1001; nothing else.
	for _, k := range kicks.of("noah") {
		if k != int(websocket.StatusGoingAway) {
			t.Fatalf("noah kicked %v", kicks.of("noah"))
		}
	}
}

// ── client version gate (spec §4) ──

func readErrorMsg(t *testing.T, cl *client, d time.Duration) proto.ErrorMsg {
	t.Helper()
	m := cl.until(proto.TError, d, nil)
	var em proto.ErrorMsg
	if err := json.Unmarshal(m.data, &em); err != nil {
		t.Fatal(err)
	}
	return em
}

func TestVersionGateRefusesOld(t *testing.T) {
	h := newHarnessCfg(t, config.Config{MinClient: 2})
	w := h.world("gate")

	cl := h.dial()
	hl := hello(w.UUID, "Old", "b1")
	hl.Ver = 1
	cl.send(hl)
	em := readErrorMsg(t, cl, 3*time.Second)
	if em.Code != proto.CloseProto || em.Message != "outdated" || em.Min != 2 {
		t.Fatalf("error = %+v, want {code:4004 message:outdated min:2}", em)
	}
	if code := cl.closeCode(3 * time.Second); code != websocket.StatusCode(proto.CloseProto) {
		t.Fatalf("close code = %v, want 4004", code)
	}
}

func TestVersionGateAdmitsAtMinimum(t *testing.T) {
	h := newHarnessCfg(t, config.Config{MinClient: 2})
	w := h.world("gate-ok")
	cl := h.dial()
	hl := hello(w.UUID, "New", "b1")
	hl.Ver = 2
	cl.join(hl) // must not error or close
}

// A missing ver counts as 0, which is refused once the minimum is above 0.
func TestVersionGateMissingVerCountsAsZero(t *testing.T) {
	h := newHarnessCfg(t, config.Config{MinClient: 2})
	w := h.world("gate-missing")
	cl := h.dial()
	hl := hello(w.UUID, "NoVer", "b1")
	// hl.Ver left at its zero value: no `ver` was sent by the client's build.
	cl.send(hl)
	em := readErrorMsg(t, cl, 3*time.Second)
	if em.Message != "outdated" || em.Min != 2 {
		t.Fatalf("error = %+v, want outdated with min:2", em)
	}
}

// With MinClient 0 (the default), a missing ver is admitted.
func TestVersionGateZeroMinimumAdmitsMissingVer(t *testing.T) {
	h := newHarness(t)
	w := h.world("gate-zero")
	cl := h.dial()
	cl.join(hello(w.UUID, "NoVer", "b1")) // Ver left at 0
}

// A negative ver is clamped to 0 by the server, not treated as "very old" or rejected outright.
func TestVersionGateNegativeVerClamped(t *testing.T) {
	h := newHarness(t)
	w := h.world("gate-neg")
	cl := h.dial()
	hl := hello(w.UUID, "Neg", "b1")
	hl.Ver = -5
	cl.join(hl)
}

// A malformed ver or bot (wrong JSON type) fails the hello decode with 1008, the same as a
// malformed proto today (spec §4).
func TestVersionGateMalformedFieldsClose1008(t *testing.T) {
	h := newHarness(t)
	w := h.world("gate-malformed")
	cases := []string{
		`{"t":"hello","world":"` + w.UUID + `","name":"A","skin":"red","bid":"b1","proto":1,"gen":3,"ver":"2"}`,
		`{"t":"hello","world":"` + w.UUID + `","name":"A","skin":"red","bid":"b2","proto":1,"gen":3,"ver":1.5}`,
		`{"t":"hello","world":"` + w.UUID + `","name":"A","skin":"red","bid":"b3","proto":1,"gen":3,"ver":1,"bot":1}`,
	}
	for _, raw := range cases {
		cl := h.dial()
		cl.sendRaw([]byte(raw))
		if code := cl.closeCode(3 * time.Second); code != websocket.StatusPolicyViolation {
			t.Fatalf("case %s: close = %v, want 1008", raw, code)
		}
	}
}

// A wrong proto still gets message "proto", with no min, even when the server has a minimum set.
func TestVersionGateProtoRefusalHasNoMin(t *testing.T) {
	h := newHarnessCfg(t, config.Config{MinClient: 2})
	w := h.world("gate-proto")
	cl := h.dial()
	hl := hello(w.UUID, "Bad", "b1")
	hl.Proto = 99
	cl.send(hl)
	em := readErrorMsg(t, cl, 3*time.Second)
	if em.Message != "proto" || em.Min != 0 {
		t.Fatalf("error = %+v, want message proto and no min", em)
	}
}

// ── bots (spec §4): relay, /worlds online, and delete rules ──

func botHello(world, name, bid string) proto.Hello {
	h := hello(world, name, bid)
	h.Bot = true
	return h
}

// A bot's welcome.players entry and join relay carry bot:true; /worlds online excludes it.
func TestBotJoinIsHiddenFromOnline(t *testing.T) {
	h := newHarness(t)
	w := h.world("bot-online")
	bot := h.dial()
	bot.join(botHello(w.UUID, "Robo", "b1"))

	_, b := h.do(http.MethodGet, "/worlds", nil)
	var rows []proto.WorldListing
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.UUID == w.UUID && len(r.Online) != 0 {
			t.Fatalf("GET /worlds online = %+v, want the bot excluded", r.Online)
		}
	}
}

// A world with only bots online is not "occupied": DELETE succeeds and the bots are kicked with
// 4006. A world with a human online (bots or not) still 409s, and nobody is kicked by the refused
// attempt.
func TestDeleteBotRules(t *testing.T) {
	h := newHarness(t)
	w := h.world("bots-and-humans")

	human := h.dial()
	human.join(hello(w.UUID, "Noah", "hb"))
	bot := h.dial()
	bot.join(botHello(w.UUID, "Robo", "bb"))

	if res, _ := h.do(http.MethodDelete, "/worlds/"+w.UUID, nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("DELETE with a human and a bot online = %d, want 409", res.StatusCode)
	}
	select {
	case <-bot.done:
		t.Fatalf("the bot was closed by the refused delete: %v", bot.err)
	case <-time.After(300 * time.Millisecond):
	}

	human.c.Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(5 * time.Second)
	for len(h.srv.reg.onlineOf(w.UUID)) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the human never left")
		}
		time.Sleep(5 * time.Millisecond)
	}

	if res, _ := h.do(http.MethodDelete, "/worlds/"+w.UUID, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE with only a bot online = %d, want 204", res.StatusCode)
	}
	if code := bot.closeCode(3 * time.Second); code != websocket.StatusCode(proto.CloseUnknownWorld) {
		t.Fatalf("bot close code = %v, want 4006", code)
	}
}
