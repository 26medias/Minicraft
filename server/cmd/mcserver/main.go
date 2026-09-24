// Command mcserver is the Minicraft multiplayer relay server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	stdnet "net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"minicraft/server/internal/backup"
	"minicraft/server/internal/config"
	mcnet "minicraft/server/internal/net"
	"minicraft/server/internal/store"
)

// listenerGrace bounds step 1 of the shutdown. Hijacked WebSocket connections are not the
// http.Server's any more, so Shutdown only waits for plain HTTP requests in flight.
const listenerGrace = time.Second

func main() {
	cfg, err := config.FromFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "mcserver:", err)
		os.Exit(2)
	}
	if err := serve(cfg); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

// serve runs until SIGTERM (what a GCE stop sends) or SIGINT, then shuts down in the order of
// spec §3.1: stop accepting, stop the worlds and write their final flush, close every socket in
// parallel within 2 s, back up, return. Everything is flushed before any close, so half-open
// peers cannot push the flush past the unit's TimeoutStopSec.
func serve(cfg config.Config) error {
	st, err := store.Open(cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	ln, err := stdnet.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}
	srv := mcnet.NewServer(cfg, st)
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	log.Printf("mcserver listening on %s", ln.Addr())

	// The hourly backup, while any world is loaded (spec §9).
	var bg sync.WaitGroup
	bctx, stopBackups := context.WithCancel(context.Background())
	bg.Go(func() {
		backup.Loop(bctx, backup.Every, srv.Busy, func() {
			backup.Take(bctx, st.DB(), cfg.BackupDir, cfg.GCSBucket)
		})
	})

	select {
	case <-ctx.Done():
	case err := <-served:
		stopBackups()
		bg.Wait()
		return fmt.Errorf("serve: %w", err)
	}
	stop() // a second signal kills the process outright
	start := time.Now()
	log.Print("shutting down")

	// 1. Stop accepting.
	lctx, cancel := context.WithTimeout(context.Background(), listenerGrace)
	if err := hs.Shutdown(lctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		log.Printf("shutdown: listener: %v", err)
	}
	cancel()
	// 2-4. Stop the worlds, write the final flush, then signal every socket 1001 and wait for
	// them at most 2 s.
	srv.Shutdown(context.Background())
	log.Printf("shutdown: flushed and closed in %v", time.Since(start).Round(time.Millisecond))

	// 5. Backup. An hourly one in progress finishes first (it shares backup.sqlite).
	stopBackups()
	bg.Wait()
	backup.Take(context.Background(), st.DB(), cfg.BackupDir, cfg.GCSBucket)
	log.Printf("shutdown: done in %v", time.Since(start).Round(time.Millisecond))
	// 6. Exit 0.
	return nil
}
