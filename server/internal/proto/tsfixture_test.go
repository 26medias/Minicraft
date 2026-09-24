package proto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// tsTestdata is the TS client's fixture directory (Task C1). src/net/snapshot.test.ts writes
// ts-ops.bin with the TS encoder (pako deflateRaw) and ts-ops.json with the cells it encoded.
var tsTestdata = filepath.Join("..", "..", "..", "src", "net", "testdata")

// TestDecodeTSFixture: the Go decoder reads what the TS encoder writes. It runs unconditionally
// (gate-2): a missing fixture is a failure, not a skip.
func TestDecodeTSFixture(t *testing.T) {
	bin, err := os.ReadFile(filepath.Join(tsTestdata, "ts-ops.bin"))
	if err != nil {
		t.Fatalf("TS fixture missing (run MC_UPDATE_FIXTURES=1 npx vitest run src/net/): %v", err)
	}
	jb, err := os.ReadFile(filepath.Join(tsTestdata, "ts-ops.json"))
	if err != nil {
		t.Fatalf("TS fixture missing (run MC_UPDATE_FIXTURES=1 npx vitest run src/net/): %v", err)
	}
	var want snapshotJSON
	if err := json.Unmarshal(jb, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Cells) == 0 {
		t.Fatal("ts-ops.json has no cells")
	}

	seq, cells, err := DecodeSnapshot(bin)
	if err != nil {
		t.Fatalf("DecodeSnapshot(ts-ops.bin): %v", err)
	}
	if seq != want.Seq {
		t.Fatalf("seq = %d, want %d", seq, want.Seq)
	}
	got := make([][6]int32, len(cells))
	for i, c := range cells {
		got[i] = [6]int32{c.X, c.Y, c.Z, c.ID, c.Fluid, c.Color}
	}
	if !reflect.DeepEqual(got, want.Cells) {
		t.Fatalf("ts-ops.bin decodes to\n%v\nwant\n%v", got, want.Cells)
	}

	// The rows are the exact bytes Go would write for the same cells: only the DEFLATE stream
	// may differ between pako and compress/flate.
	wantCells := make([]Cell, len(want.Cells))
	for i, c := range want.Cells {
		wantCells[i] = Cell{c[0], c[1], c[2], c[3], c[4], c[5]}
	}
	goBin := EncodeSnapshot(want.Seq, wantCells)
	if string(bin[:snapshotHeader]) != string(goBin[:snapshotHeader]) {
		t.Fatalf("header differs: TS % x, Go % x", bin[:snapshotHeader], goBin[:snapshotHeader])
	}
	if string(inflate(t, bin[snapshotHeader:])) != string(inflate(t, goBin[snapshotHeader:])) {
		t.Fatal("TS and Go row bytes differ before DEFLATE")
	}
}
