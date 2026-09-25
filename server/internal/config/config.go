// Package config parses mcserver's command-line flags.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultOrigins is the same list as api/src/handlers.ts ALLOWED_ORIGINS.
const DefaultOrigins = "https://noah.leap-forward.ca,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"

type Config struct {
	Addr    string
	DB      string
	Token   string
	Origins []string
	// BackupDir holds backup.sqlite; it defaults to the database's directory.
	BackupDir string
	// GCSBucket is where backups are uploaded (env MC_GCS_BUCKET); empty disables the upload.
	GCSBucket string
	// MinClient is the lowest client build version admitted (spec §4); 0 admits all. Set by
	// -min-client or MC_MIN_CLIENT; the flag wins only when it is explicitly passed.
	MinClient int
}

// FromFlags parses args (without the program name). -token falls back to the
// MC_TOKEN environment variable and is required.
func FromFlags(args []string) (Config, error) {
	fs := flag.NewFlagSet("mcserver", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c Config
	var origins string
	fs.StringVar(&c.Addr, "addr", ":8080", "listen address")
	fs.StringVar(&c.DB, "db", "./mc.sqlite", "SQLite database path")
	fs.StringVar(&c.Token, "token", "", "shared access token (env MC_TOKEN)")
	fs.StringVar(&origins, "origins", DefaultOrigins, "comma-separated allowed origins")
	fs.StringVar(&c.BackupDir, "backup-dir", "", "directory for backup.sqlite (default: the -db directory)")
	fs.StringVar(&c.GCSBucket, "gcs-bucket", "", "GCS bucket for backups (env MC_GCS_BUCKET; empty disables upload)")
	fs.IntVar(&c.MinClient, "min-client", 0, "lowest client build version admitted (env MC_MIN_CLIENT; 0 admits all)")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() > 0 {
		return Config{}, errors.New("unexpected arguments: " + strings.Join(fs.Args(), " "))
	}
	if c.Token == "" {
		c.Token = os.Getenv("MC_TOKEN")
	}
	if c.Token == "" {
		return Config{}, errors.New("-token (or MC_TOKEN) is required")
	}
	if c.GCSBucket == "" {
		c.GCSBucket = os.Getenv("MC_GCS_BUCKET")
	}
	if c.BackupDir == "" {
		c.BackupDir = filepath.Dir(c.DB)
	}
	// -min-client wins only when explicitly passed; otherwise MC_MIN_CLIENT, else the default 0.
	minClientSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "min-client" {
			minClientSet = true
		}
	})
	if !minClientSet {
		if v := os.Getenv("MC_MIN_CLIENT"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				return Config{}, fmt.Errorf("MC_MIN_CLIENT must be a non-negative integer, got %q", v)
			}
			c.MinClient = n
		}
	}
	if c.MinClient < 0 {
		return Config{}, errors.New("-min-client must be non-negative")
	}
	c.Origins = splitList(origins)
	return c, nil
}

func splitList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
