// Command mcserver is the Minicraft multiplayer relay server.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"minicraft/server/internal/config"
	mcnet "minicraft/server/internal/net"
	"minicraft/server/internal/store"
)

func main() {
	cfg, err := config.FromFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "mcserver:", err)
		os.Exit(2)
	}
	st, err := store.Open(cfg.DB)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()
	srv := mcnet.NewServer(cfg, st)
	log.Printf("mcserver listening on %s", cfg.Addr)
	log.Fatal(http.ListenAndServe(cfg.Addr, srv.Handler()))
}
