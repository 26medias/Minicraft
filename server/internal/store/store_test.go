package store

import (
	"path/filepath"
	"reflect"
	"testing"

	"minicraft/server/internal/proto"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mc.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func mustCreate(t *testing.T, s *Store, name string) WorldRow {
	t.Helper()
	w, err := s.CreateWorld(name, 12345, 3, 256, true)
	if err != nil {
		t.Fatalf("CreateWorld: %v", err)
	}
	return w
}

func TestOpenPragmas(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	var mode string
	if err := s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}
	var busy int
	if err := s.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busy); err != nil {
		t.Fatal(err)
	}
	if busy != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", busy)
	}
}

func TestWorldsCRUD(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	a := mustCreate(t, s, "Castle")
	b := mustCreate(t, s, "Island")
	if a.UUID == "" || a.UUID == b.UUID || a.WID == b.WID {
		t.Fatalf("world ids not distinct: %+v %+v", a, b)
	}
	if a.Name != "Castle" || a.Seed != 12345 || a.Gen != 3 || a.Height != 256 || !a.MustMine || a.CreatedAt == 0 || a.LastSeq != 0 {
		t.Fatalf("bad row %+v", a)
	}
	got, ok, err := s.GetWorld(a.UUID)
	if err != nil || !ok || !reflect.DeepEqual(got, a) {
		t.Fatalf("GetWorld = %+v %v %v, want %+v", got, ok, err, a)
	}
	if _, ok, err := s.GetWorld("nope"); ok || err != nil {
		t.Fatalf("GetWorld(nope) = %v %v", ok, err)
	}
	list, err := s.ListWorlds()
	if err != nil || len(list) != 2 {
		t.Fatalf("ListWorlds = %v %v", list, err)
	}
}

// G3: a flushed world survives close and reopen, cells, lastSeq and player alike.
func TestG3FlushSurvivesReopen(t *testing.T) {
	s, path := openTemp(t)
	w := mustCreate(t, s, "Home")
	cells := []proto.Cell{
		{X: 1, Y: 2, Z: 3, ID: 5, Fluid: 0, Color: 0},
		{X: 511, Y: 255, Z: 0, ID: 9, Fluid: 0x83, Color: 0},
		{X: 0, Y: 0, Z: 511, ID: 12, Fluid: 0, Color: 0x1FFF5E0},
	}
	player := PlayerRow{
		NameKey: "noé", Name: "Noé", Skin: "fox",
		X: 10.5, Y: 70, Z: -3.25, Yaw: 1.5, Pitch: -0.25, HasPos: true,
		Extras: []byte(`{"hotbar":[1,2,3]}`), LastSeen: 1700000000000,
	}
	n, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 42, Cells: cells, Players: []PlayerRow{player}})
	if err != nil || n != 3 {
		t.Fatalf("Flush = %d %v", n, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, lastSeq, err := s.LoadCells(w.WID)
	if err != nil {
		t.Fatal(err)
	}
	if lastSeq != 42 {
		t.Fatalf("lastSeq = %d, want 42", lastSeq)
	}
	if len(got) != 3 {
		t.Fatalf("LoadCells gave %d cells, want 3", len(got))
	}
	for _, c := range cells {
		if got[CellKey{c.X, c.Y, c.Z}] != c {
			t.Fatalf("cell %+v loaded as %+v", c, got[CellKey{c.X, c.Y, c.Z}])
		}
	}
	p, ok, err := s.LoadPlayer(w.WID, "noé")
	if err != nil || !ok {
		t.Fatalf("LoadPlayer = %v %v", ok, err)
	}
	if !reflect.DeepEqual(p, player) {
		t.Fatalf("player = %+v, want %+v", p, player)
	}
	wr, _, _ := s.GetWorld(w.UUID)
	if wr.LastSeq != 42 {
		t.Fatalf("worlds.last_seq = %d, want 42", wr.LastSeq)
	}
	if _, ok, err := s.LoadPlayer(w.WID, "nobody"); ok || err != nil {
		t.Fatalf("LoadPlayer(nobody) = %v %v", ok, err)
	}
}

// A player with no position yet (HasPos false) stores NULL coordinates and empty extras as '{}'.
func TestPlayerWithoutPos(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	w := mustCreate(t, s, "Home")
	in := PlayerRow{NameKey: "mia", Name: "Mia", Skin: "red", LastSeen: 5}
	if _, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 1, Players: []PlayerRow{in}}); err != nil {
		t.Fatal(err)
	}
	var nulls int
	if err := s.db.QueryRow(`SELECT count(*) FROM players WHERE wid=? AND x IS NULL AND yaw IS NULL`, w.WID).Scan(&nulls); err != nil || nulls != 1 {
		t.Fatalf("null pos rows = %d %v", nulls, err)
	}
	p, ok, err := s.LoadPlayer(w.WID, "mia")
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if p.HasPos || string(p.Extras) != "{}" || p.Name != "Mia" || p.Skin != "red" || p.LastSeen != 5 {
		t.Fatalf("player = %+v", p)
	}
	// A later flush with a position overwrites the row.
	in.HasPos, in.X, in.Y, in.Z = true, 1, 2, 3
	in.Extras = []byte(`{"a":1}`)
	if _, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 2, Players: []PlayerRow{in}}); err != nil {
		t.Fatal(err)
	}
	p, _, _ = s.LoadPlayer(w.WID, "mia")
	if !reflect.DeepEqual(p, in) {
		t.Fatalf("player = %+v, want %+v", p, in)
	}
}

func cellsBox(n int, id int32) []proto.Cell {
	out := make([]proto.Cell, 0, n)
	for i := 0; len(out) < n; i++ {
		out = append(out, proto.Cell{X: int32(i % 10), Y: int32(i / 100), Z: int32((i / 10) % 10), ID: id})
	}
	return out
}

// G4: a flush writes only the batch it is given (dirty-only), and upserts overlapping cells.
func TestG4DirtyOnlyFlush(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	w := mustCreate(t, s, "Home")
	a := cellsBox(1000, 1)
	n, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 1000, Cells: a})
	if err != nil || n != 1000 {
		t.Fatalf("Flush(A) = %d %v", n, err)
	}
	b := []proto.Cell{
		a[0], a[999], // overlap A
		{X: 100, Y: 1, Z: 1, ID: 2},
		{X: 101, Y: 1, Z: 1, ID: 2},
		{X: 102, Y: 1, Z: 1, ID: 2},
	}
	b[0].ID, b[1].ID, b[1].Fluid = 7, 0, 0x80
	n, err = s.Flush(FlushBatch{WID: w.WID, LastSeq: 1005, Cells: b})
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("Flush(B) upserts = %d, want 5", n)
	}
	got, lastSeq, err := s.LoadCells(w.WID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1003 || lastSeq != 1005 {
		t.Fatalf("LoadCells = %d cells, lastSeq %d; want 1003, 1005", len(got), lastSeq)
	}
	if got[CellKey{b[0].X, b[0].Y, b[0].Z}] != b[0] || got[CellKey{b[1].X, b[1].Y, b[1].Z}] != b[1] {
		t.Fatal("overlapping cells were not updated")
	}
	// B's untouched A rows keep their seq: only B's rows were written.
	var rewritten int
	if err := s.db.QueryRow(`SELECT count(*) FROM cells WHERE wid=? AND seq=1005`, w.WID).Scan(&rewritten); err != nil {
		t.Fatal(err)
	}
	if rewritten != 5 {
		t.Fatalf("%d rows carry B's seq, want 5", rewritten)
	}
}

// Worlds are isolated from each other in cells and players.
func TestWorldIsolationAndDelete(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	w1 := mustCreate(t, s, "One")
	w2 := mustCreate(t, s, "Two")
	p := PlayerRow{NameKey: "a", Name: "A", Skin: "s", LastSeen: 1}
	for _, w := range []WorldRow{w1, w2} {
		if _, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 3, Cells: cellsBox(3, 4), Players: []PlayerRow{p}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeleteWorld(w1.WID); err != nil {
		t.Fatal(err)
	}
	count := func(q string, wid int64) int {
		var n int
		if err := s.db.QueryRow(q, wid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for _, q := range []string{
		`SELECT count(*) FROM cells WHERE wid=?`,
		`SELECT count(*) FROM players WHERE wid=?`,
		`SELECT count(*) FROM worlds WHERE wid=?`,
	} {
		if n := count(q, w1.WID); n != 0 {
			t.Fatalf("%s for deleted world = %d, want 0", q, n)
		}
		if n := count(q, w2.WID); n == 0 {
			t.Fatalf("%s for the other world = 0", q)
		}
	}
	if _, ok, _ := s.GetWorld(w1.UUID); ok {
		t.Fatal("deleted world still found")
	}
}

// Flush is one transaction: a batch that fails part-way leaves nothing behind.
func TestFlushIsAtomic(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	w := mustCreate(t, s, "Home")
	// Force the players insert to fail after the cells were written.
	if _, err := s.db.Exec(`CREATE TRIGGER boom BEFORE INSERT ON players BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}
	_, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: 9, Cells: cellsBox(10, 1), Players: []PlayerRow{{NameKey: "a", Name: "A", Skin: "s"}}})
	if err == nil {
		t.Fatal("Flush should fail")
	}
	got, lastSeq, err := s.LoadCells(w.WID)
	if err != nil || len(got) != 0 || lastSeq != 0 {
		t.Fatalf("after failed flush: %d cells, lastSeq %d, err %v", len(got), lastSeq, err)
	}
}

// One writer plus concurrent readers: reads during a big flush neither fail nor block for long.
func TestConcurrentReadsDuringFlush(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	w := mustCreate(t, s, "Home")
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 5; i++ {
			if _, err := s.Flush(FlushBatch{WID: w.WID, LastSeq: uint32(i + 1), Cells: cellsBox(5000, int32(i))}); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
			return
		default:
		}
		if _, err := s.ListWorlds(); err != nil {
			t.Fatalf("ListWorlds during flush: %v", err)
		}
		if _, _, err := s.LoadCells(w.WID); err != nil {
			t.Fatalf("LoadCells during flush: %v", err)
		}
	}
}
