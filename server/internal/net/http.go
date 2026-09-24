package net

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"minicraft/server/internal/config"
	"minicraft/server/internal/proto"
	"minicraft/server/internal/store"
)

// supportedGen is the set of generator versions the server hosts, with each one's world height
// (src/engine/world/generation.ts worldProfile).
var supportedGen = map[int]bool{3: true}

var genHeight = map[int]int{3: 256}

// Server is the HTTP and WebSocket front of mcserver.
type Server struct {
	cfg     config.Config
	reg     *Registry
	allowed map[string]bool
	mux     *http.ServeMux

	mu      sync.Mutex
	conns   map[*Conn]struct{}
	wg      sync.WaitGroup // tracked connections; none are added once closing is set
	closing bool

	shutdownOnce sync.Once

	// onKick is a test hook: called on every kick with the player's name key ("" before hello).
	onKick func(name string, code int)
}

// NewServer builds the server over an open store.
func NewServer(cfg config.Config, st *store.Store) *Server {
	s := &Server{
		cfg:     cfg,
		reg:     newRegistry(st),
		allowed: map[string]bool{},
		mux:     http.NewServeMux(),
		conns:   map[*Conn]struct{}{},
	}
	for _, o := range cfg.Origins {
		s.allowed[o] = true
	}
	s.mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok"))
	})
	s.mux.HandleFunc("GET /ws", s.handleWS)
	s.mux.HandleFunc("GET /worlds", s.api(s.listWorlds))
	s.mux.HandleFunc("POST /worlds", s.api(s.createWorld))
	s.mux.HandleFunc("DELETE /worlds/{uuid}", s.api(s.deleteWorld))
	s.mux.HandleFunc("OPTIONS /worlds", s.preflight)
	s.mux.HandleFunc("OPTIONS /worlds/{uuid}", s.preflight)
	return s
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler { return s.mux }

// Shutdown stops every world (each hands its final flush to the writer), waits for the writer to
// write it, then signals every connection to close with 1001 and waits for them at most 2 s
// (spec §3.1 steps 2-4; the caller stops the listener first). Closing comes after the flush, so
// a half-open peer cannot delay it. Calls after the first return at once.
func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() {
		s.reg.StopAll()
		s.mu.Lock()
		s.closing = true
		for c := range s.conns {
			c.Kick(int(websocket.StatusGoingAway), "server shutting down")
		}
		s.mu.Unlock()
		done := make(chan struct{})
		go func() {
			s.wg.Wait()
			close(done)
		}()
		t := time.NewTimer(closeTimeout)
		defer t.Stop()
		select {
		case <-done:
		case <-t.C:
		case <-ctx.Done():
		}
	})
	return nil
}

// ── auth and CORS ──

func (s *Server) tokenOK(r *http.Request) bool {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		if a, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
			tok = a
		}
	}
	return tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.Token)) == 1
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" && s.allowed[o] {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", o)
		h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Add("Vary", "Origin")
	}
}

func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) api(f http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.cors(w, r)
		if !s.tokenOK(r) {
			http.Error(w, "bad token", http.StatusUnauthorized)
			return
		}
		f(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// ── /worlds ──

func listing(row store.WorldRow, online []proto.PlayerInfo) proto.WorldListing {
	l := proto.WorldListing{UUID: row.UUID, Name: row.Name, MustMine: row.MustMine, CreatedAt: row.CreatedAt, Online: []proto.OnlinePlayer{}}
	for _, p := range online {
		l.Online = append(l.Online, proto.OnlinePlayer{Name: p.Name, Skin: p.Skin})
	}
	return l
}

func (s *Server) listWorlds(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.reg.st.ListWorlds()
	if err != nil {
		log.Printf("GET /worlds: %v", err)
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	online := s.reg.Online()
	out := make([]proto.WorldListing, 0, len(rows))
	for _, row := range rows {
		out = append(out, listing(row, online[row.UUID]))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if a, b := len(out[i].Online), len(out[j].Online); a != b {
			return a > b
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	writeJSON(w, out)
}

type createReq struct {
	Name     string `json:"name"`
	Seed     int64  `json:"seed"`
	MustMine bool   `json:"mustMine"`
	Gen      int    `json:"gen"`
}

func (s *Server) createWorld(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 40 {
		http.Error(w, "name must be 1-40 characters", http.StatusBadRequest)
		return
	}
	if !supportedGen[req.Gen] {
		http.Error(w, "unsupported gen", http.StatusBadRequest)
		return
	}
	row, err := s.reg.st.CreateWorld(req.Name, req.Seed, req.Gen, genHeight[req.Gen], req.MustMine)
	if err != nil {
		log.Printf("POST /worlds: %v", err)
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, listing(row, nil))
}

func (s *Server) deleteWorld(w http.ResponseWriter, r *http.Request) {
	err := s.reg.Delete(r.PathValue("uuid"))
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errOccupied):
		http.Error(w, "players online", http.StatusConflict)
	case errors.Is(err, errUnknownWorld):
		http.Error(w, "no such world", http.StatusNotFound)
	case errors.Is(err, errClosed):
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
	default:
		log.Printf("DELETE /worlds: %v", err)
		http.Error(w, "store error", http.StatusInternalServerError)
	}
}

// ── /ws ──

// originPatterns turns the allowed origins into coder/websocket patterns. A pattern with a
// scheme is matched against "scheme://host", so http://noah.leap-forward.ca is not let in by
// the https entry (G1: without OriginPatterns, the default Accept returned 403 for the real site).
func (s *Server) originPatterns() []string {
	return append([]string(nil), s.cfg.Origins...)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.originPatterns()})
	if err != nil {
		return // Accept has written the error response
	}
	c := newConn(ws, s)
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		// Too late: the registry refuses the join with 1001.
		c.serve(s.tokenOK(r))
		return
	}
	s.conns[c] = struct{}{}
	s.wg.Add(1)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		s.wg.Done()
	}()
	// The token is checked after the upgrade: a browser only sees close codes, not HTTP statuses.
	c.serve(s.tokenOK(r))
}
