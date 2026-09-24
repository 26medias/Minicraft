package proto

import (
	"bufio"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"slices"
)

// Cell is one edited cell of a world's overlay: the latest value written there.
type Cell struct {
	X, Y, Z, ID, Fluid, Color int32
}

// Snapshot format (spec §5, normative):
//
//	header  u32le seq, u32le count          (8 bytes, uncompressed)
//	body    raw DEFLATE (level 6) of count rows, sorted by (x, z, y)
//
// Each row is unsigned LEB128 varints, delta-coded against the previous row; prev starts at
// (0, 0, -1) so a first row at the origin still has dy = 1:
//
//	dx = x - prevX                → uvarint(dx)
//	if dx > 0:                    → uvarint(z), uvarint(y)
//	else: dz = z - prevZ          → uvarint(dz)
//	      if dz > 0:              → uvarint(y)
//	      else:                   → uvarint(y - prevY)   (≥ 1: rows are unique)
//	then uvarint(id), uvarint(fluid), uvarint(color)
const snapshotHeader = 8

func cellLess(a, b Cell) int {
	switch {
	case a.X != b.X:
		return int(a.X) - int(b.X)
	case a.Z != b.Z:
		return int(a.Z) - int(b.Z)
	default:
		return int(a.Y) - int(b.Y)
	}
}

// EncodeSnapshot encodes cells as of seq. Cells must be unique by (x, y, z) with non-negative
// coordinates and values (ValidateOps guarantees both for anything the server stores); the input
// slice is not modified.
func EncodeSnapshot(seq uint32, cells []Cell) []byte {
	sorted := slices.Clone(cells)
	slices.SortFunc(sorted, cellLess)

	rows := make([]byte, 0, len(sorted)*8)
	var px, pz, py int32 = 0, 0, -1
	for _, c := range sorted {
		dx := c.X - px
		rows = binary.AppendUvarint(rows, uint64(uint32(dx)))
		if dx > 0 {
			rows = binary.AppendUvarint(rows, uint64(uint32(c.Z)))
			rows = binary.AppendUvarint(rows, uint64(uint32(c.Y)))
		} else {
			dz := c.Z - pz
			rows = binary.AppendUvarint(rows, uint64(uint32(dz)))
			if dz > 0 {
				rows = binary.AppendUvarint(rows, uint64(uint32(c.Y)))
			} else {
				rows = binary.AppendUvarint(rows, uint64(uint32(c.Y-py)))
			}
		}
		rows = binary.AppendUvarint(rows, uint64(uint32(c.ID)))
		rows = binary.AppendUvarint(rows, uint64(uint32(c.Fluid)))
		rows = binary.AppendUvarint(rows, uint64(uint32(c.Color)))
		px, pz, py = c.X, c.Z, c.Y
	}

	var out bytes.Buffer
	out.Grow(snapshotHeader + len(rows)/4)
	var hdr [snapshotHeader]byte
	binary.LittleEndian.PutUint32(hdr[0:4], seq)
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(sorted)))
	out.Write(hdr[:])
	w, err := flate.NewWriter(&out, 6)
	if err != nil {
		panic(err) // only for an invalid level
	}
	w.Write(rows) // writes to a bytes.Buffer cannot fail
	w.Close()
	return out.Bytes()
}

var errSnapshot = errors.New("malformed snapshot")

// DecodeSnapshot decodes a snapshot. It rejects a short header, a body that is not raw DEFLATE,
// a row count that disagrees with the body, a non-increasing row order, and values that do not
// fit an int32.
func DecodeSnapshot(b []byte) (uint32, []Cell, error) {
	if len(b) < snapshotHeader {
		return 0, nil, fmt.Errorf("%w: %d-byte header", errSnapshot, len(b))
	}
	seq := binary.LittleEndian.Uint32(b[0:4])
	count := binary.LittleEndian.Uint32(b[4:8])

	fr := flate.NewReader(bytes.NewReader(b[snapshotHeader:]))
	defer fr.Close()
	r := bufio.NewReader(fr)

	// Don't trust count for the allocation: grow with the rows actually present.
	cells := make([]Cell, 0, min(int(count), 1<<16))
	next := func() (int32, error) {
		v, err := binary.ReadUvarint(r)
		if err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return 0, fmt.Errorf("%w: row %d: %v", errSnapshot, len(cells), err)
		}
		if v > 0x7FFFFFFF {
			return 0, fmt.Errorf("%w: row %d: value %d overflows int32", errSnapshot, len(cells), v)
		}
		return int32(v), nil
	}

	var px, pz, py int32 = 0, 0, -1
	for i := uint32(0); i < count; i++ {
		var c Cell
		dx, err := next()
		if err != nil {
			return 0, nil, err
		}
		c.X = px + dx
		if dx > 0 {
			if c.Z, err = next(); err != nil {
				return 0, nil, err
			}
			if c.Y, err = next(); err != nil {
				return 0, nil, err
			}
		} else {
			dz, err := next()
			if err != nil {
				return 0, nil, err
			}
			c.Z = pz + dz
			if dz > 0 {
				if c.Y, err = next(); err != nil {
					return 0, nil, err
				}
			} else {
				dy, err := next()
				if err != nil {
					return 0, nil, err
				}
				if dy == 0 {
					return 0, nil, fmt.Errorf("%w: row %d repeats a cell", errSnapshot, i)
				}
				c.Y = py + dy
			}
		}
		if c.ID, err = next(); err != nil {
			return 0, nil, err
		}
		if c.Fluid, err = next(); err != nil {
			return 0, nil, err
		}
		if c.Color, err = next(); err != nil {
			return 0, nil, err
		}
		if c.X < 0 || c.Y < 0 || c.Z < 0 {
			return 0, nil, fmt.Errorf("%w: row %d coordinate overflow", errSnapshot, i)
		}
		cells = append(cells, c)
		px, pz, py = c.X, c.Z, c.Y
	}
	// The body must end exactly after count rows.
	if _, err := r.ReadByte(); err != io.EOF {
		if err == nil {
			return 0, nil, fmt.Errorf("%w: data after %d rows", errSnapshot, count)
		}
		return 0, nil, fmt.Errorf("%w: %v", errSnapshot, err)
	}
	return seq, cells, nil
}
