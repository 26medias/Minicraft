package config

import (
	"reflect"
	"testing"
)

func TestTokenRequired(t *testing.T) {
	t.Setenv("MC_TOKEN", "")
	if _, err := FromFlags(nil); err == nil {
		t.Fatal("expected an error when -token is missing and MC_TOKEN is unset")
	}
}

func TestTokenFromEnv(t *testing.T) {
	t.Setenv("MC_TOKEN", "envtok")
	c, err := FromFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != "envtok" {
		t.Fatalf("Token = %q, want envtok", c.Token)
	}
}

func TestTokenFlagBeatsEnv(t *testing.T) {
	t.Setenv("MC_TOKEN", "envtok")
	c, err := FromFlags([]string{"-token", "flagtok"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != "flagtok" {
		t.Fatalf("Token = %q, want flagtok", c.Token)
	}
}

func TestDefaults(t *testing.T) {
	t.Setenv("MC_TOKEN", "")
	c, err := FromFlags([]string{"-token", "t"})
	if err != nil {
		t.Fatal(err)
	}
	// Same list as api/src/handlers.ts ALLOWED_ORIGINS.
	want := []string{
		"https://noah.leap-forward.ca",
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"http://localhost:4173",
		"http://127.0.0.1:4173",
	}
	if !reflect.DeepEqual(c.Origins, want) {
		t.Fatalf("Origins = %q, want %q", c.Origins, want)
	}
	if c.Addr != ":8080" {
		t.Fatalf("Addr = %q, want :8080", c.Addr)
	}
	if c.DB != "./mc.sqlite" {
		t.Fatalf("DB = %q, want ./mc.sqlite", c.DB)
	}
	if c.GCSBucket != "" {
		t.Fatalf("GCSBucket = %q, want empty (upload disabled)", c.GCSBucket)
	}
}

func TestOriginsFlag(t *testing.T) {
	c, err := FromFlags([]string{"-token", "t", "-origins", "a,b"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a", "b"}; !reflect.DeepEqual(c.Origins, want) {
		t.Fatalf("Origins = %q, want %q", c.Origins, want)
	}
}

func TestAllFlags(t *testing.T) {
	c, err := FromFlags([]string{
		"-token", "t", "-addr", ":9000", "-db", "/tmp/x.sqlite",
		"-backup-dir", "/var/b", "-gcs-bucket", "bkt",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Addr: ":9000", DB: "/tmp/x.sqlite", Token: "t", Origins: c.Origins,
		BackupDir: "/var/b", GCSBucket: "bkt",
	}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("got %+v, want %+v", c, want)
	}
}

func TestBadFlag(t *testing.T) {
	if _, err := FromFlags([]string{"-token", "t", "-nope"}); err == nil {
		t.Fatal("expected an error for an unknown flag")
	}
}
