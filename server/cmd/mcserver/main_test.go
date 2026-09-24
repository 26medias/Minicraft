package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"minicraft/server/internal/config"
)

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(newMux(config.Config{}))
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
