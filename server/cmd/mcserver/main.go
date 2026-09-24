// Command mcserver is the Minicraft multiplayer relay server.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"minicraft/server/internal/config"
)

func main() {
	cfg, err := config.FromFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "mcserver:", err)
		os.Exit(2)
	}
	log.Printf("mcserver listening on %s", cfg.Addr)
	log.Fatal(http.ListenAndServe(cfg.Addr, newMux(cfg)))
}

func newMux(_ config.Config) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok"))
	})
	return mux
}
