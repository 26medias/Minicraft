package net

import (
	"errors"
	"log"
	"sync"
	"sync/atomic"

	"minicraft/server/internal/hub"
	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// unloadDelay is how long an empty world stays loaded (spec §3.1: 60 s). Tests shorten it.
var unloadDelay = hub.UnloadDelay

const flushQueue = 64

var (
	errUnknownWorld = errors.New("unknown world")
	errClosed       = errors.New("server shutting down")
	errOccupied     = errors.New("world has players online")
)

type entry struct{ w *hub.World }

// Registry holds the loaded worlds and the single persistence writer.
//
// Every load, join and unload happens under mu (spec §3.1, gate-2 B2): Join holds it from the
// lookup until the world's run() has registered the player, and tryUnload re-checks Empty under
// it, so a join either finds the live world or reloads it from the store. run() never takes mu:
// the unload timer is the world's time.AfterFunc goroutine.
type Registry struct {
	st      *store.Store
	flushCh chan store.FlushBatch
	syncCh  chan chan struct{}
	wdone   chan struct{}

	mu     sync.Mutex
	loaded map[string]*entry
	closed bool

	// Test hooks and counters.
	afterGetBeforeJoin func()
	onTryUnload        func()
	loads, unloads     atomic.Int64

	// used is set on every load; Busy reads and clears it.
	used atomic.Bool
}

func newRegistry(st *store.Store) *Registry {
	r := &Registry{
		st:      st,
		flushCh: make(chan store.FlushBatch, flushQueue),
		syncCh:  make(chan chan struct{}),
		wdone:   make(chan struct{}),
		loaded:  map[string]*entry{},
	}
	go r.writer()
	return r
}

// writer is the one goroutine that writes world state to the store. A failed flush is logged;
// the loop never exits until flushCh is closed.
func (r *Registry) writer() {
	defer close(r.wdone)
	for {
		select {
		case b, ok := <-r.flushCh:
			if !ok {
				return
			}
			r.write(b)
		case ack := <-r.syncCh:
			// Everything handed over before the sync request is in flushCh's buffer (a batch
			// being written was received before this case ran).
			for drained := false; !drained; {
				select {
				case b, ok := <-r.flushCh:
					if !ok {
						close(ack)
						return
					}
					r.write(b)
				default:
					drained = true
				}
			}
			close(ack)
		}
	}
}

func (r *Registry) write(b store.FlushBatch) {
	if _, err := r.st.Flush(b); err != nil {
		log.Printf("registry: flush world %d: %v", b.WID, err)
	}
}

// sync waits until every batch handed to the writer so far is in the store.
func (r *Registry) sync() {
	ack := make(chan struct{})
	select {
	case r.syncCh <- ack:
		<-ack
	case <-r.wdone:
	}
}

// getLocked returns the loaded world, loading it from the store if needed. r.mu is held.
func (r *Registry) getLocked(uuid string) (*entry, error) {
	if r.closed {
		return nil, errClosed
	}
	if e := r.loaded[uuid]; e != nil {
		return e, nil
	}
	row, ok, err := r.st.GetWorld(uuid)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errUnknownWorld
	}
	cells, lastSeq, err := r.st.LoadCells(row.WID)
	if err != nil {
		return nil, err
	}
	row.LastSeq = lastSeq
	e := &entry{}
	e.w = hub.NewWorld(row, cells, r.st, r.flushCh, hub.WithOnIdle(unloadDelay, func() { r.tryUnload(uuid, e) }))
	r.loaded[uuid] = e
	r.loads.Add(1)
	r.used.Store(true)
	return e, nil
}

// Join finds or loads the world and joins s to it, all under mu.
func (r *Registry) Join(uuid string, h proto.Hello, s hub.Sender) (*hub.World, hub.JoinResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.getLocked(uuid)
	if err != nil {
		return nil, hub.JoinResult{}, err
	}
	if r.afterGetBeforeJoin != nil {
		r.afterGetBeforeJoin()
	}
	res, err := e.w.Join(h, s)
	if err != nil {
		return nil, hub.JoinResult{}, err
	}
	return e.w, res, nil
}

// tryUnload runs on the world's idle timer. Under mu it re-checks that e is still the loaded
// world and still empty, stops it (its final flush included), and waits for that flush to reach
// the store, so a reload reads it.
func (r *Registry) tryUnload(uuid string, e *entry) {
	if r.onTryUnload != nil {
		r.onTryUnload()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.loaded[uuid] != e || !e.w.Empty() {
		return
	}
	r.unloadLocked(uuid, e)
}

func (r *Registry) unloadLocked(uuid string, e *entry) {
	e.w.Stop()
	delete(r.loaded, uuid)
	r.sync()
	r.unloads.Add(1)
}

// Busy reports whether a world is loaded now or was loaded since the last call: the hourly
// backup runs "while any world is loaded" (spec §9), including one played between two ticks.
func (r *Registry) Busy() bool {
	used := r.used.Swap(false)
	r.mu.Lock()
	n := len(r.loaded)
	r.mu.Unlock()
	return used || n > 0
}

// Online returns the online players of each loaded world, by uuid.
func (r *Registry) Online() map[string][]proto.PlayerInfo {
	r.mu.Lock()
	ws := make(map[string]*hub.World, len(r.loaded))
	for uuid, e := range r.loaded {
		ws[uuid] = e.w
	}
	r.mu.Unlock()
	out := make(map[string][]proto.PlayerInfo, len(ws))
	for uuid, w := range ws {
		out[uuid] = w.Online()
	}
	return out
}

// Delete removes a world and its rows. A loaded world with players is refused; a loaded empty
// one is unloaded first, so its final flush lands before the rows go.
func (r *Registry) Delete(uuid string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errClosed
	}
	if e := r.loaded[uuid]; e != nil {
		if !e.w.Empty() {
			return errOccupied
		}
		r.unloadLocked(uuid, e)
	}
	row, ok, err := r.st.GetWorld(uuid)
	if err != nil {
		return err
	}
	if !ok {
		return errUnknownWorld
	}
	return r.st.DeleteWorld(row.WID)
}

// StopAll stops every loaded world (each hands over its final flush) and refuses any later
// load. It then closes the writer and waits for it to finish writing.
func (r *Registry) StopAll() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		<-r.wdone
		return
	}
	r.closed = true
	var wg sync.WaitGroup
	for uuid, e := range r.loaded {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.w.Stop()
		}()
		delete(r.loaded, uuid)
	}
	wg.Wait()
	r.mu.Unlock()
	close(r.flushCh)
	<-r.wdone
}
