package proto

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"encoding/json"
	"flag"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata/")

const g15Limit = 300_000

func TestSnapshotRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	s := newCellSet(1000)
	for !s.full() {
		s.add(Cell{
			X: int32(r.Intn(512)), Y: int32(r.Intn(256)), Z: int32(r.Intn(512)),
			ID: int32(r.Intn(CatalogMax + 1)), Fluid: int32(r.Intn(256)),
			Color: int32(r.Intn(2)) * int32(0x1000000|r.Intn(0x1000000)),
		})
	}
	want := append([]Cell(nil), s.cells...)
	sortCells(want)
	b := EncodeSnapshot(0xDEADBEEF, s.cells)
	seq, got, err := DecodeSnapshot(b)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 0xDEADBEEF {
		t.Fatalf("seq = %x", seq)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-trip mismatch (len got %d, want %d)", len(got), len(want))
	}
}

func TestSnapshotEmpty(t *testing.T) {
	seq, cells, err := DecodeSnapshot(EncodeSnapshot(7, nil))
	if err != nil || seq != 7 || len(cells) != 0 {
		t.Fatalf("seq=%d cells=%v err=%v", seq, cells, err)
	}
}

func TestSnapshotHeaderIsUncompressed(t *testing.T) {
	b := EncodeSnapshot(1234, []Cell{{X: 1, Y: 2, Z: 3, ID: 4}, {X: 5, Y: 6, Z: 7}})
	if binary.LittleEndian.Uint32(b[0:4]) != 1234 || binary.LittleEndian.Uint32(b[4:8]) != 2 {
		t.Fatalf("header = % x", b[:8])
	}
}

// The first row at (0, 0, 0) must encode dy = 1: prev starts at (0, 0, -1).
func TestSnapshotOriginRowEncodesDyOne(t *testing.T) {
	b := EncodeSnapshot(0, []Cell{{X: 0, Y: 0, Z: 0, ID: 9}})
	raw := inflate(t, b[8:])
	if !bytes.Equal(raw, []byte{0, 0, 1, 9, 0, 0}) {
		t.Fatalf("rows = % x, want 00 00 01 09 00 00", raw)
	}
}

func TestSnapshotRejectsMalformed(t *testing.T) {
	good := EncodeSnapshot(1, []Cell{{X: 1, Y: 1, Z: 1, ID: 1}, {X: 2, Y: 2, Z: 2, ID: 2}})
	cases := map[string][]byte{
		"short header": good[:5],
		"count too big": func() []byte {
			b := append([]byte(nil), good...)
			binary.LittleEndian.PutUint32(b[4:8], 3)
			return b
		}(),
		"count too small": func() []byte {
			b := append([]byte(nil), good...)
			binary.LittleEndian.PutUint32(b[4:8], 1)
			return b
		}(),
		"huge count": func() []byte {
			b := append([]byte(nil), good...)
			binary.LittleEndian.PutUint32(b[4:8], 0xFFFFFFFF)
			return b
		}(),
		"not deflate": append(append([]byte(nil), good[:8]...), 0xFF, 0xFF, 0xFF),
		"duplicate row": append(append([]byte(nil), good[:4]...),
			append([]byte{2, 0, 0, 0}, deflate(t, []byte{1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0})...)...),
	}
	for name, b := range cases {
		if _, _, err := DecodeSnapshot(b); err == nil {
			t.Errorf("%s: decoded without error", name)
		}
	}
}

// G15: the named clustered and tunnel 200k-cell fixtures each encode under 300 KB and round-trip.
func TestG15SnapshotSize(t *testing.T) {
	fixtures := map[string][]Cell{
		"clustered": clusteredFixture(1, 200_000),
		"tunnel":    tunnelFixture(2, 200_000),
	}
	for name, cells := range fixtures {
		if len(cells) != 200_000 {
			t.Fatalf("%s fixture has %d cells", name, len(cells))
		}
		b := EncodeSnapshot(99, cells)
		t.Logf("%s: %d cells → %d bytes", name, len(cells), len(b))
		if len(b) >= g15Limit {
			t.Errorf("%s snapshot is %d bytes, want < %d", name, len(b), g15Limit)
		}
		_, got, err := DecodeSnapshot(b)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := append([]Cell(nil), cells...)
		sortCells(want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: round-trip mismatch", name)
		}
	}
}

// G15 red build: absolute coding of the same clustered fixture must blow the budget, which proves
// the size assertion above can go red (spec §5: ~480 KB).
func TestG15AbsoluteCodingIsTooBig(t *testing.T) {
	cells := clusteredFixture(1, 200_000)
	n := len(encodeAbsolute(99, cells))
	t.Logf("absolute clustered: %d bytes", n)
	if n <= g15Limit {
		t.Fatalf("absolute coding gave %d bytes; the G15 instrument cannot go red", n)
	}
}

func encodeAbsolute(seq uint32, cells []Cell) []byte {
	sorted := append([]Cell(nil), cells...)
	sortCells(sorted)
	var rows []byte
	for _, c := range sorted {
		for _, v := range []int32{c.X, c.Y, c.Z, c.ID, c.Fluid, c.Color} {
			rows = binary.AppendUvarint(rows, uint64(uint32(v)))
		}
	}
	out := binary.LittleEndian.AppendUint32(nil, seq)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(sorted)))
	return append(out, deflateBytes(rows)...)
}

// smallCells is the hand-picked fixture shared with the TS codec (Task C1).
func smallCells() []Cell {
	return []Cell{
		{X: 0, Y: 0, Z: 0, ID: 1},                // origin: dy = 1 from prev (0, 0, -1)
		{X: 0, Y: 1, Z: 0, ID: 2},                // dy = 1
		{X: 0, Y: 255, Z: 0, ID: 3},              // y = 255, dy = 254
		{X: 0, Y: 4, Z: 7, ID: 0},                // dz > 0
		{X: 1, Y: 64, Z: 0, ID: 13, Fluid: 0x80}, // flow at distance 0
		{X: 1, Y: 65, Z: 0, ID: 13, Fluid: 0x83}, // flow at distance 3
		{X: 1, Y: 66, Z: 0, ID: 13, Fluid: 0},    // source
		{X: 2, Y: 70, Z: 3, ID: 1000, Color: 0x1FFF5E0},
		{X: 2, Y: 71, Z: 3, ID: 1000, Color: 0x1000000}, // black lamp, not "no colour"
		{X: 2, Y: 72, Z: 3, ID: 1000, Color: 0x1FFFFFF},
		{X: 3, Y: 10, Z: 511, ID: 5},
		{X: 3, Y: 11, Z: 511, ID: 6},
		{X: 3, Y: 12, Z: 511, ID: 1008},
		{X: 17, Y: 0, Z: 0, ID: 0},
		{X: 17, Y: 0, Z: 1, ID: 0},
		{X: 17, Y: 0, Z: 2, ID: 0},
		{X: 128, Y: 128, Z: 128, ID: 300},
		{X: 200, Y: 30, Z: 200, ID: 4, Fluid: 0x8F},
		{X: 256, Y: 100, Z: 256, ID: 7},
		{X: 300, Y: 5, Z: 10, ID: 8},
		{X: 300, Y: 5, Z: 400, ID: 9},
		{X: 300, Y: 6, Z: 400, ID: 10},
		{X: 511, Y: 0, Z: 0, ID: 11},
		{X: 511, Y: 254, Z: 511, ID: 12},
		{X: 511, Y: 255, Z: 511, ID: 0},
	}
}

type snapshotJSON struct {
	Seq   uint32     `json:"seq"`
	Cells [][6]int32 `json:"cells"` // [x, y, z, id, fluid, color], in row order (x, z, y)
}

const smallSeq = 4242

func TestSnapshotSmallFixture(t *testing.T) {
	cells := smallCells()
	if len(cells) != 25 {
		t.Fatalf("fixture has %d cells, want 25", len(cells))
	}
	bin := EncodeSnapshot(smallSeq, cells)
	sorted := append([]Cell(nil), cells...)
	sortCells(sorted)
	js := snapshotJSON{Seq: smallSeq}
	for _, c := range sorted {
		js.Cells = append(js.Cells, [6]int32{c.X, c.Y, c.Z, c.ID, c.Fluid, c.Color})
	}
	jb, err := json.MarshalIndent(js, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	jb = append(jb, '\n')
	golden(t, "snapshot-small.bin", bin)
	golden(t, "snapshot-small.json", jb)

	seq, got, err := DecodeSnapshot(readTestdata(t, "snapshot-small.bin"))
	if err != nil || seq != smallSeq || !reflect.DeepEqual(got, sorted) {
		t.Fatalf("committed snapshot-small.bin decodes to seq=%d err=%v, cells equal=%v",
			seq, err, reflect.DeepEqual(got, sorted))
	}
}

// golden writes want to testdata/name with -update; otherwise it must equal the committed file.
func golden(t *testing.T, name string, want []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got := readTestdata(t, name)
	if !bytes.Equal(got, want) {
		t.Fatalf("%s differs from the committed golden file (run with -update if intended)", path)
	}
}

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("missing golden file (run go test -update): %v", err)
	}
	return b
}

func inflate(t *testing.T, b []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	if _, err := out.ReadFrom(flate.NewReader(bytes.NewReader(b))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func deflate(t *testing.T, b []byte) []byte {
	t.Helper()
	return deflateBytes(b)
}

func deflateBytes(b []byte) []byte {
	var out bytes.Buffer
	w, _ := flate.NewWriter(&out, 6)
	w.Write(b)
	w.Close()
	return out.Bytes()
}
