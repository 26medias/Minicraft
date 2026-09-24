package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"minicraft/server/internal/config"
	mcnet "minicraft/server/internal/net"
	"minicraft/server/internal/store"
)

func TestHealth(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "mc.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	srv := httptest.NewServer(mcnet.NewServer(config.Config{Token: "t"}, st).Handler())
	defer srv.Close()

	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("GET /health = %d %q, want 200 \"ok\"", res.StatusCode, body)
	}

	res, err = http.Post(srv.URL+"/health", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /health = %d, want 405", res.StatusCode)
	}
}
