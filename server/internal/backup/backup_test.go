package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func openDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func count(t *testing.T, path string) int {
	t.Helper()
	db := openDB(t, path)
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM cells`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Snapshot copies the live database (WAL content included) and overwrites the previous backup.
func TestSnapshot(t *testing.T) {
	dir := t.TempDir()
	db := openDB(t, filepath.Join(dir, "mc.sqlite"))
	if _, err := db.Exec(`CREATE TABLE cells (x INTEGER)`); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, FileName)
	for round, rows := range []int{3, 7} {
		for range rows - []int{0, 3}[round] {
			if _, err := db.Exec(`INSERT INTO cells VALUES (1)`); err != nil {
				t.Fatal(err)
			}
		}
		if err := Snapshot(db, out); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if n := count(t, out); n != rows {
			t.Fatalf("round %d: backup has %d rows, want %d", round, n, rows)
		}
	}
	if _, err := os.Stat(out + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temp file left behind: %v", err)
	}
}

type call struct {
	name string
	args []string
	dl   time.Duration
}

func fake(t *testing.T, reply func(c call) ([]byte, error)) *[]call {
	t.Helper()
	var calls []call
	oldRun, oldNow := run, now
	t.Cleanup(func() { run, now = oldRun, oldNow })
	now = func() time.Time { return time.Date(2026, 9, 24, 13, 5, 9, 0, time.FixedZone("x", -4*3600)) }
	run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		c := call{name: name, args: args}
		if d, ok := ctx.Deadline(); ok {
			c.dl = time.Until(d)
		}
		calls = append(calls, c)
		return reply(c)
	}
	return &calls
}

func TestUploadSkippedWithoutBucket(t *testing.T) {
	calls := fake(t, func(call) ([]byte, error) { return nil, nil })
	if err := Upload(context.Background(), "/x/backup.sqlite", ""); err != nil {
		t.Fatal(err)
	}
	if err := Prune(context.Background(), "", Keep); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("ran %v with no bucket", *calls)
	}
}

func TestUpload(t *testing.T) {
	calls := fake(t, func(call) ([]byte, error) { return nil, nil })
	if err := Upload(context.Background(), "/x/backup.sqlite", "gs://minicraft-worlds/"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %v", *calls)
	}
	c := (*calls)[0]
	got := c.name + " " + strings.Join(c.args, " ")
	want := "gcloud storage cp --quiet /x/backup.sqlite gs://minicraft-worlds/mp-backups/20260924T170509Z.sqlite"
	if got != want {
		t.Fatalf("ran %q, want %q", got, want)
	}
	if c.dl <= 19*time.Second || c.dl > UploadTimeout {
		t.Fatalf("upload deadline %v, want 20 s", c.dl)
	}

	fake(t, func(call) ([]byte, error) { return []byte("denied"), errors.New("exit 1") })
	if err := Upload(context.Background(), "/x/backup.sqlite", "b"); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("err = %v, want the gcloud output", err)
	}
}

// Prune keeps the newest 48 by name (UTC timestamps sort by age) and deletes the rest in one rm.
func TestPrune(t *testing.T) {
	dir := "gs://minicraft-worlds/mp-backups/"
	var listing []string
	for i := range 51 {
		// Out of order, plus a foreign object that must be ignored.
		listing = append(listing, fmt.Sprintf("%s20260%03dT000000Z.sqlite", dir, (i*37)%51))
	}
	listing = append(listing, dir+"README.txt", "")
	calls := fake(t, func(c call) ([]byte, error) {
		if c.args[1] == "ls" {
			return []byte(strings.Join(listing, "\n")), nil
		}
		return nil, nil
	})
	if err := Prune(context.Background(), "minicraft-worlds", Keep); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %v", *calls)
	}
	if got := strings.Join((*calls)[0].args, " "); got != "storage ls "+dir {
		t.Fatalf("list = %q", got)
	}
	rm := (*calls)[1].args
	if strings.Join(rm[:3], " ") != "storage rm --quiet" {
		t.Fatalf("rm = %v", rm)
	}
	want := []string{dir + "20260000T000000Z.sqlite", dir + "20260001T000000Z.sqlite", dir + "20260002T000000Z.sqlite"}
	if strings.Join(rm[3:], " ") != strings.Join(want, " ") {
		t.Fatalf("deleted %v, want the 3 oldest %v", rm[3:], want)
	}

	// 48 or fewer: nothing is deleted.
	calls = fake(t, func(c call) ([]byte, error) { return []byte(strings.Join(listing[:48], "\n")), nil })
	if err := Prune(context.Background(), "minicraft-worlds", Keep); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %v, want only the listing", *calls)
	}
}

// Loop backs up on each tick while busy, skips idle ticks and stops with its context.
func TestLoop(t *testing.T) {
	var busy atomic.Bool
	var takes atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Loop(ctx, 10*time.Millisecond, busy.Load, func() { takes.Add(1) })
		close(done)
	}()
	time.Sleep(60 * time.Millisecond)
	if n := takes.Load(); n != 0 {
		t.Fatalf("%d backups while idle", n)
	}
	busy.Store(true)
	time.Sleep(60 * time.Millisecond)
	if n := takes.Load(); n < 2 {
		t.Fatalf("%d backups while busy, want several", n)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Loop did not return after cancel")
	}
}
