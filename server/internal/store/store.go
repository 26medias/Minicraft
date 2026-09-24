// Package store persists worlds, their edited cells and their players in SQLite (spec §4).
//
// A Store is safe for exactly one writer goroutine (the persistence writer, which calls Flush)
// plus concurrent reads and the occasional world create or delete from HTTP handlers. WAL mode
// keeps readers off the writer's back; busy_timeout covers the rare write/write overlap.
package store

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"minicraft/server/internal/proto"
)

// Schema is spec §4, verbatim.
const schema = `
CREATE TABLE IF NOT EXISTS worlds (
	wid INTEGER PRIMARY KEY,
	uuid TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
	seed INTEGER NOT NULL, gen_version INTEGER NOT NULL, height INTEGER NOT NULL,
	must_mine INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cells (
	wid INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
	id INTEGER NOT NULL, fluid INTEGER NOT NULL, color INTEGER NOT NULL, seq INTEGER NOT NULL,
	PRIMARY KEY (wid, x, z, y)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS players (
	wid INTEGER NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, skin TEXT NOT NULL,
	x REAL, y REAL, z REAL, yaw REAL, pitch REAL,
	extras TEXT NOT NULL DEFAULT '{}',
	last_seen INTEGER NOT NULL,
	PRIMARY KEY (wid, name_key)
);
`

// CellKey addresses one cell of a world.
type CellKey struct{ X, Y, Z int32 }

// WorldRow is one row of the worlds table. CreatedAt is Unix milliseconds.
type WorldRow struct {
	WID       int64
	UUID      string
	Name      string
	Seed      int64
	Gen       int
	Height    int
	MustMine  bool
	CreatedAt int64
	LastSeq   uint32
}

// PlayerRow is one row of the players table. HasPos is false until the player's first leave or
// flush with a position, and the coordinates are stored as NULL while it is false. Extras is the
// raw JSON of the client's PlayerSave extras; empty means '{}'. LastSeen is Unix milliseconds.
type PlayerRow struct {
	NameKey, Name, Skin string
	X, Y, Z, Yaw, Pitch float64
	HasPos              bool
	Extras              []byte
	LastSeen            int64
}

// FlushBatch is what the world goroutine hands the persistence writer: a copy of the cells and
// players dirtied since the last flush, and the world's seq as of the copy.
type FlushBatch struct {
	WID     int64
	LastSeq uint32
	Cells   []proto.Cell
	Players []PlayerRow
}

// Store is an open SQLite database.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path, in WAL mode with a 5 s busy timeout.
func Open(path string) (*Store, error) {
	// _txlock=immediate: every transaction here writes, so take the write lock up front and let
	// busy_timeout wait for it, instead of failing on a deferred read-to-write upgrade.
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: schema: %w", err)
	}
	return &Store{db: db}, nil
}

// DB returns the underlying database, for the backup's VACUUM INTO.
func (s *Store) DB() *sql.DB { return s.db }

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// CreateWorld inserts a new world with a fresh UUID.
func (s *Store) CreateWorld(name string, seed int64, gen, height int, mustMine bool) (WorldRow, error) {
	id, err := newUUID()
	if err != nil {
		return WorldRow{}, err
	}
	w := WorldRow{UUID: id, Name: name, Seed: seed, Gen: gen, Height: height, MustMine: mustMine, CreatedAt: time.Now().UnixMilli()}
	res, err := s.db.Exec(
		`INSERT INTO worlds (uuid, name, seed, gen_version, height, must_mine, created_at, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		w.UUID, w.Name, w.Seed, w.Gen, w.Height, boolInt(w.MustMine), w.CreatedAt)
	if err != nil {
		return WorldRow{}, fmt.Errorf("store: create world: %w", err)
	}
	if w.WID, err = res.LastInsertId(); err != nil {
		return WorldRow{}, err
	}
	return w, nil
}

const worldCols = `wid, uuid, name, seed, gen_version, height, must_mine, created_at, last_seq`

type scanner interface{ Scan(dest ...any) error }

func scanWorld(r scanner) (WorldRow, error) {
	var w WorldRow
	var mustMine int
	var lastSeq int64
	err := r.Scan(&w.WID, &w.UUID, &w.Name, &w.Seed, &w.Gen, &w.Height, &mustMine, &w.CreatedAt, &lastSeq)
	w.MustMine = mustMine != 0
	w.LastSeq = uint32(lastSeq)
	return w, err
}

// ListWorlds returns every world, newest first. (The /worlds ordering by online count is the
// registry's job; it knows who is online.)
func (s *Store) ListWorlds() ([]WorldRow, error) {
	rows, err := s.db.Query(`SELECT ` + worldCols + ` FROM worlds ORDER BY created_at DESC, wid DESC`)
	if err != nil {
		return nil, fmt.Errorf("store: list worlds: %w", err)
	}
	defer rows.Close()
	var out []WorldRow
	for rows.Next() {
		w, err := scanWorld(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// GetWorld looks a world up by UUID. A missing world is (zero, false, nil).
func (s *Store) GetWorld(uuid string) (WorldRow, bool, error) {
	w, err := scanWorld(s.db.QueryRow(`SELECT `+worldCols+` FROM worlds WHERE uuid = ?`, uuid))
	if errors.Is(err, sql.ErrNoRows) {
		return WorldRow{}, false, nil
	}
	if err != nil {
		return WorldRow{}, false, fmt.Errorf("store: get world: %w", err)
	}
	return w, true, nil
}

// DeleteWorld removes a world's rows from all three tables in one transaction.
func (s *Store) DeleteWorld(wid int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: delete world: %w", err)
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM cells WHERE wid = ?`,
		`DELETE FROM players WHERE wid = ?`,
		`DELETE FROM worlds WHERE wid = ?`,
	} {
		if _, err := tx.Exec(q, wid); err != nil {
			return fmt.Errorf("store: delete world: %w", err)
		}
	}
	return tx.Commit()
}

// LoadCells returns every stored cell of a world and the world's last flushed seq.
func (s *Store) LoadCells(wid int64) (map[CellKey]proto.Cell, uint32, error) {
	var lastSeq int64
	err := s.db.QueryRow(`SELECT last_seq FROM worlds WHERE wid = ?`, wid).Scan(&lastSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, fmt.Errorf("store: load cells: no world %d", wid)
	}
	if err != nil {
		return nil, 0, fmt.Errorf("store: load cells: %w", err)
	}
	rows, err := s.db.Query(`SELECT x, y, z, id, fluid, color FROM cells WHERE wid = ?`, wid)
	if err != nil {
		return nil, 0, fmt.Errorf("store: load cells: %w", err)
	}
	defer rows.Close()
	out := make(map[CellKey]proto.Cell)
	for rows.Next() {
		var c proto.Cell
		if err := rows.Scan(&c.X, &c.Y, &c.Z, &c.ID, &c.Fluid, &c.Color); err != nil {
			return nil, 0, err
		}
		out[CellKey{c.X, c.Y, c.Z}] = c
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, uint32(lastSeq), nil
}

// LoadPlayer returns a world's saved player by name key. A missing player is (zero, false, nil).
func (s *Store) LoadPlayer(wid int64, nameKey string) (PlayerRow, bool, error) {
	var p PlayerRow
	var x, y, z, yaw, pitch sql.NullFloat64
	var extras string
	err := s.db.QueryRow(
		`SELECT name_key, name, skin, x, y, z, yaw, pitch, extras, last_seen FROM players WHERE wid = ? AND name_key = ?`,
		wid, nameKey).Scan(&p.NameKey, &p.Name, &p.Skin, &x, &y, &z, &yaw, &pitch, &extras, &p.LastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return PlayerRow{}, false, nil
	}
	if err != nil {
		return PlayerRow{}, false, fmt.Errorf("store: load player: %w", err)
	}
	if x.Valid && y.Valid && z.Valid {
		p.HasPos = true
		p.X, p.Y, p.Z, p.Yaw, p.Pitch = x.Float64, y.Float64, z.Float64, yaw.Float64, pitch.Float64
	}
	p.Extras = []byte(extras)
	return p, true, nil
}

// Flush upserts exactly b.Cells, b.Players and worlds.last_seq in one transaction, and returns
// the number of cell rows written. It never touches cells outside the batch (the differential
// rule, spec §4). Each cell row records b.LastSeq as its seq: the batch does not carry per-cell
// seqs, and the batch's seq is an upper bound on each cell's last write.
func (s *Store) Flush(b FlushBatch) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("store: flush: %w", err)
	}
	defer tx.Rollback()

	upserts := 0
	if len(b.Cells) > 0 {
		st, err := tx.Prepare(`INSERT INTO cells (wid, x, y, z, id, fluid, color, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(wid, x, z, y) DO UPDATE SET id = excluded.id, fluid = excluded.fluid, color = excluded.color, seq = excluded.seq`)
		if err != nil {
			return 0, fmt.Errorf("store: flush: %w", err)
		}
		defer st.Close()
		for _, c := range b.Cells {
			res, err := st.Exec(b.WID, c.X, c.Y, c.Z, c.ID, c.Fluid, c.Color, int64(b.LastSeq))
			if err != nil {
				return 0, fmt.Errorf("store: flush cell: %w", err)
			}
			n, err := res.RowsAffected()
			if err != nil {
				return 0, err
			}
			upserts += int(n)
		}
	}

	if len(b.Players) > 0 {
		st, err := tx.Prepare(`INSERT INTO players (wid, name_key, name, skin, x, y, z, yaw, pitch, extras, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(wid, name_key) DO UPDATE SET name = excluded.name, skin = excluded.skin,
				x = excluded.x, y = excluded.y, z = excluded.z, yaw = excluded.yaw, pitch = excluded.pitch,
				extras = excluded.extras, last_seen = excluded.last_seen`)
		if err != nil {
			return 0, fmt.Errorf("store: flush: %w", err)
		}
		defer st.Close()
		for _, p := range b.Players {
			var x, y, z, yaw, pitch any
			if p.HasPos {
				x, y, z, yaw, pitch = p.X, p.Y, p.Z, p.Yaw, p.Pitch
			}
			extras := string(p.Extras)
			if extras == "" {
				extras = "{}"
			}
			if _, err := st.Exec(b.WID, p.NameKey, p.Name, p.Skin, x, y, z, yaw, pitch, extras, p.LastSeen); err != nil {
				return 0, fmt.Errorf("store: flush player: %w", err)
			}
		}
	}

	res, err := tx.Exec(`UPDATE worlds SET last_seq = ? WHERE wid = ?`, int64(b.LastSeq), b.WID)
	if err != nil {
		return 0, fmt.Errorf("store: flush last_seq: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		return 0, fmt.Errorf("store: flush: no world %d", b.WID)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: flush commit: %w", err)
	}
	return upserts, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
