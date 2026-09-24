package proto

import (
	"math/rand"
	"sort"
)

// Fixture generators for G15 (spec §5, §10). The worlds are generated at test time and never
// committed. Each returns exactly `n` unique cells.

type cellKey struct{ x, y, z int32 }

type cellSet struct {
	seen  map[cellKey]bool
	cells []Cell
	limit int
}

func newCellSet(limit int) *cellSet {
	return &cellSet{seen: make(map[cellKey]bool, limit), limit: limit}
}

func (s *cellSet) full() bool { return len(s.cells) >= s.limit }

func (s *cellSet) add(c Cell) {
	if s.full() || c.X < 0 || c.X >= 512 || c.Z < 0 || c.Z >= 512 || c.Y < 0 || c.Y > 255 {
		return
	}
	k := cellKey{c.X, c.Y, c.Z}
	if s.seen[k] {
		return
	}
	s.seen[k] = true
	s.cells = append(s.cells, c)
}

// clusteredFixture: 20 houses inside 100×100×20 boxes near random (x, z) centres, mixed ids
// (floor, walls, roof, an interior cross wall, glass windows and doorway air). 200k cells.
func clusteredFixture(seed int64, n int) []Cell {
	r := rand.New(rand.NewSource(seed))
	s := newCellSet(n)
	for house := 0; !s.full(); house++ {
		cx := int32(60 + r.Intn(392))
		cz := int32(60 + r.Intn(392))
		y0 := int32(60 + r.Intn(20))
		wall := int32(5 + r.Intn(40))
		floor := int32(1 + r.Intn(4))
		roof := int32(50 + r.Intn(40))
		// The box is 100×100×20; the house fills as much of it as it needs to reach its share.
		const w, d, h = 100, 100, 20
		share := len(s.cells) + n/20
		if house >= 19 {
			share = n
		}
		for x := int32(0); x < w && len(s.cells) < share; x++ {
			for z := int32(0); z < d && len(s.cells) < share; z++ {
				for y := int32(0); y < h && len(s.cells) < share; y++ {
					edge := x == 0 || x == w-1 || z == 0 || z == d-1
					cross := x == w/2 || z == d/2
					var id int32
					switch {
					case y == 0:
						id = floor
					case y == h-1:
						id = roof
					case edge || (cross && y < h/2):
						id = wall
						if y%5 == 2 && (x+z)%7 == 0 {
							id = 20 // glass window
						}
						if y < 3 && (x == w/2 || z == d/2) {
							id = 0 // doorway
						}
					default:
						continue
					}
					if s.full() || len(s.cells) >= share {
						break
					}
					s.add(Cell{X: cx - w/2 + x, Y: y0 + y, Z: cz - d/2 + z, ID: id})
				}
			}
		}
	}
	return s.cells
}

// tunnelFixture: 200k air cells along 40 random-walk tunnels, 3 wide (a 3×3×3 brush).
func tunnelFixture(seed int64, n int) []Cell {
	r := rand.New(rand.NewSource(seed))
	s := newCellSet(n)
	for t := 0; !s.full(); t++ {
		target := len(s.cells) + n/40
		if t >= 39 {
			target = n
		}
		x, y, z := int32(20+r.Intn(472)), int32(20+r.Intn(40)), int32(20+r.Intn(472))
		dir := r.Intn(4)
		for steps := 0; len(s.cells) < target && steps < 200_000; steps++ {
			for dx := int32(-1); dx <= 1; dx++ {
				for dz := int32(-1); dz <= 1; dz++ {
					for dy := int32(-1); dy <= 1; dy++ {
						if len(s.cells) < target {
							s.add(Cell{X: x + dx, Y: y + dy, Z: z + dz})
						}
					}
				}
			}
			if r.Intn(8) == 0 {
				dir = (dir + 1 + 2*r.Intn(2)) % 4 // turn left or right
			}
			switch dir {
			case 0:
				x++
			case 1:
				z++
			case 2:
				x--
			case 3:
				z--
			}
			if r.Intn(6) == 0 {
				y += int32(r.Intn(3) - 1)
			}
			// Bounce off the world edge.
			if x < 2 || x > 509 || z < 2 || z > 509 {
				dir = (dir + 2) % 4
				x, z = clamp(x, 2, 509), clamp(z, 2, 509)
			}
			y = clamp(y, 2, 250)
		}
	}
	return s.cells
}

func clamp(v, lo, hi int32) int32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func sortCells(cells []Cell) {
	sort.Slice(cells, func(i, j int) bool {
		a, b := cells[i], cells[j]
		if a.X != b.X {
			return a.X < b.X
		}
		if a.Z != b.Z {
			return a.Z < b.Z
		}
		return a.Y < b.Y
	})
}
