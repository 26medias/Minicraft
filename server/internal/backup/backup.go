// Package backup takes the mandatory backups of spec §9: a VACUUM INTO snapshot of the database,
// uploaded to gs://<bucket>/mp-backups/<timestamp>.sqlite with the VM's service account, keeping
// the newest 48. It runs on SIGTERM and every hour while any world is loaded.
package backup

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// FileName is the local snapshot, overwritten by each backup.
	FileName = "backup.sqlite"
	// Keep is how many uploaded backups Prune leaves.
	Keep = 48
	// UploadTimeout bounds one `gcloud storage cp`.
	UploadTimeout = 20 * time.Second
	// PruneTimeout bounds the listing and the deletes. On SIGTERM the upload and the prune
	// together stay inside the unit's TimeoutStopSec=30.
	PruneTimeout = 5 * time.Second
	// Every is the period of the backup ticker.
	Every = time.Hour

	prefix = "mp-backups/"
	stamp  = "20060102T150405Z"
)

// run executes an external command; tests replace it.
var run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// now is the clock for object names; tests replace it.
var now = time.Now

// Snapshot writes a consistent copy of db to path with VACUUM INTO. It writes a temp file next
// to path and renames it, so path is always either the previous backup or the new one.
func Snapshot(db *sql.DB, path string) error {
	tmp := path + ".tmp"
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("backup: %w", err)
	}
	if _, err := db.Exec(`VACUUM INTO ?`, tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("backup: vacuum into %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	return nil
}

func bucketURL(bucket string) string {
	return "gs://" + strings.TrimSuffix(strings.TrimPrefix(bucket, "gs://"), "/") + "/" + prefix
}

// Upload copies path to gs://<bucket>/mp-backups/<UTC timestamp>.sqlite with `gcloud storage cp`,
// bounded at 20 s. An empty bucket skips it.
func Upload(ctx context.Context, path, bucket string) error {
	if bucket == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, UploadTimeout)
	defer cancel()
	dst := bucketURL(bucket) + now().UTC().Format(stamp) + ".sqlite"
	if out, err := run(ctx, "gcloud", "storage", "cp", "--quiet", path, dst); err != nil {
		return fmt.Errorf("backup: upload to %s: %v: %s", dst, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Prune deletes all but the newest keep backups under gs://<bucket>/mp-backups/. The names are
// UTC timestamps, so their sort order is their age. An empty bucket skips it.
func Prune(ctx context.Context, bucket string, keep int) error {
	if bucket == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, PruneTimeout)
	defer cancel()
	dir := bucketURL(bucket)
	out, err := run(ctx, "gcloud", "storage", "ls", dir)
	if err != nil {
		return fmt.Errorf("backup: list %s: %v: %s", dir, err, strings.TrimSpace(string(out)))
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, dir) && strings.HasSuffix(line, ".sqlite") {
			names = append(names, line)
		}
	}
	if len(names) <= keep {
		return nil
	}
	sort.Strings(names)
	old := names[:len(names)-keep]
	args := append([]string{"storage", "rm", "--quiet"}, old...)
	if out, err := run(ctx, "gcloud", args...); err != nil {
		return fmt.Errorf("backup: prune: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Take runs one full backup: the snapshot into dir, then the upload and the prune. Failures are
// logged; the snapshot's failure skips the upload.
func Take(ctx context.Context, db *sql.DB, dir, bucket string) {
	path := filepath.Join(dir, FileName)
	start := time.Now()
	if err := Snapshot(db, path); err != nil {
		log.Print(err)
		return
	}
	if err := Upload(ctx, path, bucket); err != nil {
		log.Print(err)
		return
	}
	if err := Prune(ctx, bucket, Keep); err != nil {
		log.Print(err)
	}
	log.Printf("backup: %s in %v", path, time.Since(start).Round(time.Millisecond))
}

// Loop calls take every period while busy() reports that a world is (or was, since the last
// check) loaded. It returns when ctx is done.
func Loop(ctx context.Context, every time.Duration, busy func() bool, take func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if busy() {
				take()
			}
		}
	}
}
