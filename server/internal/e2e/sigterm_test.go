// Package e2e execs the real mcserver binary. G5 (spec §10): SIGTERM with black-holed clients
// connected must flush every acknowledged edit and exit 0 in under 4 s (gate-2 S5).
package e2e

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	stdnet "net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	_ "modernc.org/sqlite"

	"minicraft/server/internal/proto"
)

const token = "t"

// buildServer builds cmd/mcserver into a temp dir once per test binary.
var (
	buildOnce sync.Once
	binPath   string
	buildErr  error
)

func goTool() string {
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	return filepath.Join(runtime.GOROOT(), "bin", "go")
}

func mcserver(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "mcserver-e2e-")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "mcserver")
		out, err := exec.Command(goTool(), "build", "-o", binPath, "minicraft/server/cmd/mcserver").CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binPath
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := stdnet.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

// proc is one running mcserver.
type proc struct {
	cmd  *exec.Cmd
	addr string
	out  *bytes.Buffer
	done chan struct{}
	err  error // valid after done
}

func start(t *testing.T, db, backupDir string) *proc {
	t.Helper()
	addr := freePort(t)
	p := &proc{addr: addr, out: &bytes.Buffer{}, done: make(chan struct{})}
	p.cmd = exec.Command(mcserver(t), "-db", db, "-token", token, "-addr", addr, "-backup-dir", backupDir)
	p.cmd.Env = append(os.Environ(), "MC_TOKEN=", "MC_GCS_BUCKET=") // never upload from a test
	p.cmd.Stdout = p.out
	p.cmd.Stderr = p.out
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		p.err = p.cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		select {
		case <-p.done:
		default:
			p.cmd.Process.Kill()
			<-p.done
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := http.Get("http://" + addr + "/health")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return p
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("mcserver did not come up on %s: %v\n%s", addr, err, p.out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (p *proc) createWorld(t *testing.T) string {
	t.Helper()
	body := strings.NewReader(`{"name":"G5","seed":42,"mustMine":false,"gen":3}`)
	res, err := http.Post("http://"+p.addr+"/worlds?token="+token, "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var l proto.WorldListing
	if err := json.NewDecoder(res.Body).Decode(&l); err != nil || l.UUID == "" {
		t.Fatalf("POST /worlds: %d %v", res.StatusCode, err)
	}
	return l.UUID
}

// ── black-holing proxy: forwards TCP both ways until black-holed, then forwards nothing and
// closes nothing (a peer that vanished without a FIN) ──

type proxy struct {
	ln    stdnet.Listener
	bh    atomic.Bool
	stop  chan struct{}
	mu    sync.Mutex
	conns []stdnet.Conn
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

// ── client ──

type frame struct {
	bin  bool
	t    string
	data []byte
}

type client struct {
	c    *websocket.Conn
	msgs chan frame
}

func dial(t *testing.T, addr string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws?token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(64 << 20)
	cl := &client{c: c, msgs: make(chan frame, 4096)}
	t.Cleanup(func() { c.CloseNow() })
	go func() {
		defer close(cl.msgs)
		for {
			typ, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			f := frame{bin: typ == websocket.MessageBinary, data: b}
			if !f.bin {
				var env proto.Envelope
				json.Unmarshal(b, &env)
				f.t = env.T
			}
			select {
			case cl.msgs <- f:
			default: // ticks nobody reads
			}
		}
	}()
	return cl
}

func (cl *client) send(t *testing.T, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := cl.c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

// next returns the next frame that is not a tick or a ping.
func (cl *client) next(t *testing.T, d time.Duration) frame {
	t.Helper()
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case f, ok := <-cl.msgs:
			if !ok {
				t.Fatal("connection closed")
			}
			if f.t == proto.TTick || f.t == proto.TPing || f.t == proto.TJoin {
				continue
			}
			return f
		case <-timer.C:
			t.Fatal("timed out waiting for a frame")
		}
	}
}

// join sends hello and returns the decoded snapshot cells.
func (cl *client) join(t *testing.T, world, name string) []proto.Cell {
	t.Helper()
	cl.send(t, proto.Hello{T: proto.THello, World: world, Name: name, Skin: "red", Bid: "bid-" + name, Proto: proto.Proto, Gen: 3})
	if f := cl.next(t, 5*time.Second); f.t != proto.TWelcome {
		t.Fatalf("%s: got %q (%s), want welcome", name, f.t, f.data)
	}
	f := cl.next(t, 5*time.Second)
	if !f.bin {
		t.Fatalf("%s: got %q, want the binary snapshot", name, f.t)
	}
	_, cells, err := proto.DecodeSnapshot(f.data)
	if err != nil {
		t.Fatal(err)
	}
	return cells
}

func g5Op(i int) proto.Op { return proto.Op{int32(10 + i), 70, 20, 1, 0, 0} }

// TestSigtermFlushesAndExits is G5. Red builds: no signal handler (exit status is "terminated"
// and the unflushed edits are lost), and closing each socket synchronously before the flush (two
// black-holed peers hold Close about 5 s each, so exit passes the 4 s bound).
func TestSigtermFlushesAndExits(t *testing.T) {
	if testing.Short() {
		t.Skip("execs the binary")
	}
	dir := t.TempDir()
	db := filepath.Join(dir, "mc.sqlite")
	backupDir := filepath.Join(dir, "backup")
	if err := os.Mkdir(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := start(t, db, backupDir)
	world := srv.createWorld(t)

	// Two joined players whose links then vanish without a FIN.
	for i := range 2 {
		px := newProxy(t, srv.addr)
		cl := dial(t, px.ln.Addr().String())
		cl.join(t, world, fmt.Sprintf("hole%d", i))
		px.bh.Store(true)
	}

	// The author: 10 edits, all echoed, then SIGTERM straight away. The flush ticker is 1 s,
	// so without a final flush on the signal path these edits are not in the store yet.
	a := dial(t, srv.addr)
	a.join(t, world, "author")
	for i := range 10 {
		a.send(t, proto.Edit{T: proto.TEdit, Cid: int64(i + 1), Ops: []proto.Op{g5Op(i)}})
	}
	for echoes := 0; echoes < 10; {
		f := a.next(t, 2*time.Second)
		if f.t == proto.TEdit {
			echoes++
		}
	}
	sent := time.Now()
	if err := srv.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(sent); d > 300*time.Millisecond {
		t.Fatalf("SIGTERM sent %v after the echoes, want within 300 ms", d)
	}
	select {
	case <-srv.done:
	case <-time.After(15 * time.Second):
		t.Fatalf("mcserver still running 15 s after SIGTERM\n%s", srv.out)
	}
	took := time.Since(sent)
	if srv.err != nil {
		t.Errorf("mcserver exited with %v, want status 0\n%s", srv.err, srv.out)
	}
	if took >= 4*time.Second {
		t.Errorf("mcserver took %v to exit after SIGTERM, want under 4 s\n%s", took, srv.out)
	}
	t.Logf("exited in %v", took)

	want := map[[3]int32]bool{}
	for i := range 10 {
		o := g5Op(i)
		want[[3]int32{o[0], o[1], o[2]}] = true
	}
	check := func(what string, cells []proto.Cell) {
		t.Helper()
		got := 0
		for _, c := range cells {
			if want[[3]int32{c.X, c.Y, c.Z}] && c.ID == 1 {
				got++
			}
		}
		if got != 10 {
			t.Errorf("%s holds %d of the 10 edits (cells %v)", what, got, cells)
		}
	}

	// The backup taken on the way out has them too (spec §9).
	check("backup.sqlite", backupCells(t, filepath.Join(backupDir, "backup.sqlite")))

	// A restart on the same DB serves all 10 to a fresh join.
	srv2 := start(t, db, backupDir)
	b := dial(t, srv2.addr)
	check("the snapshot after restart", b.join(t, world, "fresh"))
}

func backupCells(t *testing.T, path string) []proto.Cell {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Errorf("no backup: %v", err)
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT x, y, z, id FROM cells`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []proto.Cell
	for rows.Next() {
		var c proto.Cell
		if err := rows.Scan(&c.X, &c.Y, &c.Z, &c.ID); err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
	return out
}
