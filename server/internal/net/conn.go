// Package net is mcserver's network layer: the WebSocket connection (the hub's Sender), the HTTP
// API and the registry of loaded worlds with its persistence writer (spec §3, §3.1, §5).
package net

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	stdnet "net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"minicraft/server/internal/hub"
	"minicraft/server/internal/proto"
)

// Limits and timing (spec §5).
const (
	readLimit    = 4 << 20 // G1: the 32 KiB default closed the socket at 3,000 ops
	queueCap     = 1 << 20 // bytes of queued text frames per connection (RG: not messages)
	readSilence  = 6 * time.Second
	closeTimeout = 2 * time.Second // a kicked connection is gone within this, close frame or not
)

var connIDs atomic.Int64

type frame struct {
	typ    websocket.MessageType
	data   []byte
	forced bool // the snapshot: exempt from the cap and not counted
}

// Conn is one WebSocket connection: a reader goroutine (serve) and a writer goroutine
// (writeLoop). It implements hub.Sender; none of its Sender methods block.
//
// Closing (spec §3.1, gate-2 B5): Kick only records the code and cancels kicked. The writer
// goroutine then sends what is still queued and performs Close. Kick also arms a 2 s
// time.AfterFunc that cancels hard, the context every read and write runs under; cancelling it
// makes the library drop the TCP connection, so a black-holed or stalled peer holds nothing
// open for more than 2 s. Nothing ever waits on Close.
type Conn struct {
	id     int
	ws     *websocket.Conn
	srv    *Server
	kicked context.Context
	kick   context.CancelFunc
	hard   context.Context
	cut    context.CancelFunc
	notify chan struct{}
	wdone  chan struct{}

	mu          sync.Mutex
	queue       []frame
	queuedBytes int
	code        int
	reason      string
	name        string
}

func newConn(ws *websocket.Conn, srv *Server) *Conn {
	c := &Conn{
		id:     int(connIDs.Add(1)),
		ws:     ws,
		srv:    srv,
		notify: make(chan struct{}, 1),
		wdone:  make(chan struct{}),
	}
	c.kicked, c.kick = context.WithCancel(context.Background())
	c.hard, c.cut = context.WithCancel(context.Background())
	ws.SetReadLimit(readLimit)
	go c.writeLoop()
	return c
}

// ── hub.Sender ──

func (c *Conn) ID() int { return c.id }

// Send queues a text frame. It returns false when the queued bytes would pass 1 MiB; the world
// then kicks 4002. After a kick it drops the frame and returns true: the world has already let
// this connection go.
func (c *Conn) Send(msg []byte) bool {
	c.mu.Lock()
	if c.code != 0 {
		c.mu.Unlock()
		return true
	}
	if c.queuedBytes+len(msg) > queueCap {
		c.mu.Unlock()
		return false
	}
	c.queuedBytes += len(msg)
	c.queue = append(c.queue, frame{typ: websocket.MessageText, data: msg})
	c.mu.Unlock()
	c.wake()
	return true
}

// SendSnapshot queues the binary snapshot, exempt from the cap and not counted toward it.
func (c *Conn) SendSnapshot(b []byte) {
	c.mu.Lock()
	if c.code != 0 {
		c.mu.Unlock()
		return
	}
	c.queue = append(c.queue, frame{typ: websocket.MessageBinary, data: b, forced: true})
	c.mu.Unlock()
	c.wake()
}

// Kick signals the connection to close with code. The first code wins. It never blocks.
func (c *Conn) Kick(code int, reason string) {
	c.mu.Lock()
	if c.code != 0 {
		c.mu.Unlock()
		return
	}
	c.code, c.reason = code, reason
	name := c.name
	c.mu.Unlock()
	time.AfterFunc(closeTimeout, c.cut)
	c.kick()
	if f := c.srv.onKick; f != nil {
		f(name, code)
	}
}

func (c *Conn) wake() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// ── writer goroutine ──

func (c *Conn) pop() (frame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queue) == 0 {
		return frame{}, false
	}
	f := c.queue[0]
	c.queue[0] = frame{}
	c.queue = c.queue[1:]
	if !f.forced {
		c.queuedBytes -= len(f.data)
	}
	return f, true
}

// drain writes every queued frame. A write error is logged and the rest of the queue dropped;
// the loop goes on (gate-2 S4), and the reader, which sees the same dead socket, ends the
// connection.
func (c *Conn) drain() {
	for {
		f, ok := c.pop()
		if !ok {
			return
		}
		if err := c.ws.Write(c.hard, f.typ, f.data); err != nil {
			if c.kicked.Err() == nil && !errors.Is(err, stdnet.ErrClosed) {
				log.Printf("conn %d: write: %v", c.id, err)
			}
			for {
				if _, ok := c.pop(); !ok {
					break
				}
			}
			return
		}
	}
}

func (c *Conn) writeLoop() {
	defer close(c.wdone)
	for {
		select {
		case <-c.notify:
			c.drain()
		case <-c.kicked.Done():
			c.drain()
			c.mu.Lock()
			code, reason := c.code, c.reason
			c.mu.Unlock()
			c.ws.Close(websocket.StatusCode(code), reason) // bounded by the 2 s cut armed in Kick
			c.cut()
			return
		}
	}
}

// ── reader goroutine ──

// read reads one message under the 6 s silence deadline.
func (c *Conn) read() (websocket.MessageType, []byte, error) {
	ctx, cancel := context.WithTimeout(c.hard, readSilence)
	defer cancel()
	return c.ws.Read(ctx)
}

// refuse sends an error message and kicks with the same code.
func (c *Conn) refuse(code int, message string) {
	b, _ := json.Marshal(proto.ErrorMsg{T: proto.TError, Code: code, Message: message})
	c.Send(b)
	c.Kick(code, message)
}

// refuseOutdated sends the "outdated" error message with Min set, then kicks with the same code
// (spec §4: a client build below the server's minimum).
func (c *Conn) refuseOutdated(min int) {
	b, _ := json.Marshal(proto.ErrorMsg{T: proto.TError, Code: proto.CloseProto, Message: "outdated", Min: min})
	c.Send(b)
	c.Kick(proto.CloseProto, "outdated")
}

// serve runs the reader: hello, the join, then routing to the world until the socket ends.
// It returns once the writer has finished too.
func (c *Conn) serve(token bool) {
	defer func() {
		<-c.wdone
	}()
	defer c.Kick(int(websocket.StatusGoingAway), "")
	if !token {
		c.refuse(proto.CloseBadToken, "bad_token")
		c.readUntilClosed()
		return
	}
	w, id, ok := c.hello()
	if !ok {
		c.readUntilClosed()
		return
	}
	defer w.Submit(hub.CmdLeave{ID: id, S: c})
	for {
		typ, b, err := c.read()
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		c.route(w, id, b)
	}
}

// readUntilClosed keeps reading after a refusal so the close handshake can complete.
func (c *Conn) readUntilClosed() {
	for {
		if _, _, err := c.read(); err != nil {
			return
		}
	}
}

func (c *Conn) hello() (*hub.World, int, bool) {
	typ, b, err := c.read()
	if err != nil {
		return nil, 0, false
	}
	var h proto.Hello
	if typ != websocket.MessageText || json.Unmarshal(b, &h) != nil || h.T != proto.THello {
		c.Kick(int(websocket.StatusPolicyViolation), "hello expected")
		return nil, 0, false
	}
	if h.Proto < proto.MinProto || h.Proto > proto.MaxProto {
		c.refuse(proto.CloseProto, "proto")
		return nil, 0, false
	}
	if min := c.srv.cfg.MinClient; max(h.Ver, 0) < min {
		c.refuseOutdated(min)
		return nil, 0, false
	}
	if !supportedGen[h.Gen] {
		c.refuse(proto.CloseGenUnsupported, "gen_unsupported")
		return nil, 0, false
	}
	key, err := proto.NameKey(h.Name)
	if err != nil {
		c.refuse(proto.CloseBadName, "bad_name")
		return nil, 0, false
	}
	c.mu.Lock()
	c.name = key
	c.mu.Unlock()
	w, res, err := c.srv.reg.Join(h.World, h, c)
	if err != nil {
		var je *hub.JoinError
		switch {
		case errors.Is(err, errUnknownWorld):
			c.refuse(proto.CloseUnknownWorld, "unknown_world")
		case errors.Is(err, errClosed):
			c.refuse(int(websocket.StatusGoingAway), "shutting down")
		case errors.As(err, &je):
			c.refuse(je.Code, je.Message)
		default:
			log.Printf("conn %d: join %s: %v", c.id, h.World, err)
			c.refuse(int(websocket.StatusTryAgainLater), "try again")
		}
		return nil, 0, false
	}
	return w, res.ID, true
}

func (c *Conn) route(w *hub.World, id int, b []byte) {
	var env proto.Envelope
	if json.Unmarshal(b, &env) != nil {
		return
	}
	switch env.T {
	case proto.TEdit:
		var m proto.Edit
		if json.Unmarshal(b, &m) != nil {
			c.refuse(proto.CloseResync, "resync")
			return
		}
		w.Submit(hub.CmdEdit{ID: id, S: c, Cid: m.Cid, Ops: m.Ops})
	case proto.TPos:
		var m proto.Pos
		if json.Unmarshal(b, &m) == nil {
			w.Submit(hub.CmdPos{ID: id, S: c, Pos: m})
		}
	case proto.TFx:
		var m proto.Fx
		if json.Unmarshal(b, &m) == nil {
			w.Submit(hub.CmdFx{ID: id, S: c, Fx: m})
		}
	case proto.TExtras:
		var m proto.Extras
		if json.Unmarshal(b, &m) == nil {
			w.Submit(hub.CmdExtras{ID: id, S: c, Data: m.Data})
		}
	case proto.TLeaving:
		var m proto.Leaving
		if json.Unmarshal(b, &m) == nil {
			w.Submit(hub.CmdLeaving{ID: id, S: c, SecondsLeft: m.SecondsLeft})
		}
	}
	// ping and anything unknown: the read itself renewed the deadline.
}
