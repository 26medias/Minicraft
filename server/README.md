# mcserver — runbook

`mcserver` is the multiplayer relay: one Go binary with a SQLite database. It orders, stores and
relays block edits and player poses. It never generates terrain. The design is
`docs/superpowers/specs/2026-09-24-multiplayer-design.md` (§3 and §9).

```
browser ──wss──▶ Cloudflare (mc.leap-forward.ca) ──tunnel──▶ VM: cloudflared ──▶ mcserver 127.0.0.1:8080
                                                                              └── /var/lib/mcserver/mc.sqlite
```

The VM has **no inbound ports**. Cloudflare Tunnel is the only way in. Julien starts the VM by
hand before a play session and stops it afterwards.

Every command below is run by Julien. Nothing here runs from a test or from an agent.

## Local development

```bash
export PATH=$HOME/.local/go/bin:$PATH
cd server
go run ./cmd/mcserver -db ./mc.sqlite -addr :8080 -token dev
go test -race ./...
```

In the site's `.env.local`, set `VITE_MINICRAFT_MP_URL=http://localhost:8080` and
`VITE_MINICRAFT_MP_TOKEN=dev`.

### Flags

| Flag | Default | |
|---|---|---|
| `-addr` | `:8080` | listen address (`127.0.0.1:8080` on the VM) |
| `-db` | `./mc.sqlite` | database |
| `-token` | env `MC_TOKEN` | shared access token, required |
| `-origins` | the site, `localhost:5173`, `localhost:4173` | allowed browser origins |
| `-backup-dir` | the `-db` directory | where `backup.sqlite` is written |
| `-gcs-bucket` | env `MC_GCS_BUCKET` | backup upload bucket; empty disables the upload |

## First-time setup

The project is `qs-trading` and the zone is `us-central1-a`.

### 1. Service account

The VM backs up to `gs://minicraft-worlds/mp-backups/`. Give it its own account with object
access to that bucket only:

```bash
gcloud iam service-accounts create mcserver --project=qs-trading \
	--display-name="Minicraft multiplayer VM"
gcloud storage buckets add-iam-policy-binding gs://minicraft-worlds --project=qs-trading \
	--member=serviceAccount:mcserver@qs-trading.iam.gserviceaccount.com \
	--role=roles/storage.objectAdmin
```

### 2. The VM

The VM is an e2-micro (free tier in us-central1) with a 10 GB disk and Debian 12. It keeps its
ephemeral external IPv4 for outbound traffic only. No firewall rule is added.

```bash
gcloud compute instances create mcserver --project=qs-trading --zone=us-central1-a \
	--machine-type=e2-micro \
	--image-family=debian-12 --image-project=debian-cloud \
	--boot-disk-size=10GB --boot-disk-type=pd-standard \
	--service-account=mcserver@qs-trading.iam.gserviceaccount.com \
	--scopes=cloud-platform
```

`--scopes=cloud-platform` is safe here. The service account's IAM roles are what limit it.

### 3. The Cloudflare Tunnel

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel**.
   Choose the **Cloudflared** type and name it `mcserver`.
2. Copy the **tunnel token** (the long string after `--token` in the install command). Do not
   run Cloudflare's install command; `vm-setup.sh` does that part.
3. Under **Public hostnames**, add `mc.leap-forward.ca` with service `HTTP` and URL
   `localhost:8080`. Cloudflare creates the DNS record. WebSockets work through tunnels without
   any extra setting.

### 4. Pick the game token

`MC_TOKEN` is the shared secret that the site sends. The site build reads it as
`VITE_MINICRAFT_MP_TOKEN`, so it is not a real secret. It keeps strangers out, but it does not
stop someone who reads the bundle.

```bash
openssl rand -hex 16
```

### 5. Run vm-setup.sh on the VM

```bash
gcloud compute scp --project=qs-trading --zone=us-central1-a --recurse \
	server/vm-setup.sh server/systemd mcserver:~
gcloud compute ssh mcserver --project=qs-trading --zone=us-central1-a -- \
	sudo ./vm-setup.sh --token <MC_TOKEN> --tunnel-token <TUNNEL_TOKEN> --bucket minicraft-worlds
```

The script is idempotent. Run it again to change a token. It installs cloudflared (and the
Google Cloud CLI, if the image lacks it), creates the `mcserver` user and `/var/lib/mcserver`, and
writes `/etc/mcserver.env` and `/etc/cloudflared.env`. It then installs and enables
`mcserver.service` and `cloudflared.service`.

### 6. Deploy the binary

See [Deploying](#deploying). Then check it from anywhere:

```bash
curl https://mc.leap-forward.ca/health    # ok
```

### 7. Build the site with multiplayer

In `.env.local`, set:

```
VITE_MINICRAFT_MP_URL=https://mc.leap-forward.ca
VITE_MINICRAFT_MP_TOKEN=<MC_TOKEN>
```

Then build and upload the site by hand, as usual. Without `VITE_MINICRAFT_MP_URL`, the
Multiplayer button is hidden.

## Starting and stopping

```bash
gcloud compute instances start mcserver --project=qs-trading --zone=us-central1-a
gcloud compute instances stop  mcserver --project=qs-trading --zone=us-central1-a
```

Both units start on boot. After about a minute the menu stops saying "The multiplayer server is
sleeping". The client retries on its own.

Stopping the VM sends `SIGTERM`. mcserver then shuts down in this order:

1. It stops accepting connections.
2. It writes every world's final flush.
3. It closes the sockets, taking 2 s at most.
4. It takes a backup: an upload of up to 20 s, and a prune of up to 5 s.
5. It exits.

The unit allows 30 s. Players in the middle of a game see "Reconnecting…", and they rejoin by
themselves once the VM is back.

Logs:

```bash
gcloud compute ssh mcserver --project=qs-trading --zone=us-central1-a -- \
	sudo journalctl -u mcserver -n 100 --no-pager
```

## Deploying

```bash
server/deploy.sh          # prints the plan, deploys nothing, exits 1
server/deploy.sh --yes    # build linux/amd64, scp, install, systemctl restart
```

The restart is a graceful `SIGTERM`, as above. `MC_PROJECT`, `MC_ZONE` and `MC_VM` override the
defaults.

## Backups

mcserver takes a backup on every `SIGTERM`, and every hour while any world is loaded. Each
backup:

- runs `VACUUM INTO /var/lib/mcserver/backup.sqlite`, a consistent copy that is safe while the
  server runs;
- uploads it to `gs://minicraft-worlds/mp-backups/<UTC timestamp>.sqlite`;
- keeps the newest 48 uploads and deletes the rest.

A failed upload is logged and does not stop the server.

```bash
gcloud storage ls gs://minicraft-worlds/mp-backups/
```

### Restoring a backup

Stop the unit, copy the file back, then start the unit:

```bash
gcloud compute ssh mcserver --project=qs-trading --zone=us-central1-a
# on the VM:
sudo systemctl stop mcserver
sudo -u mcserver cp /var/lib/mcserver/mc.sqlite /var/lib/mcserver/mc.sqlite.before-restore
sudo rm -f /var/lib/mcserver/mc.sqlite-wal /var/lib/mcserver/mc.sqlite-shm
sudo -u mcserver env CLOUDSDK_CONFIG=/var/lib/mcserver/.gcloud \
	gcloud storage cp gs://minicraft-worlds/mp-backups/<timestamp>.sqlite /var/lib/mcserver/mc.sqlite
sudo systemctl start mcserver
```

To restore the latest local snapshot, use `/var/lib/mcserver/backup.sqlite` as the source instead.

Always remove the `-wal` and `-shm` files. They belong to the old database.

## Costs

| Item | Cost |
|---|---|
| e2-micro in us-central1 | free tier (one per billing account) |
| 10 GB standard persistent disk | free tier (30 GB) |
| Ephemeral external IPv4 | about $0.005 per hour, billed only while the VM runs |
| Egress | mostly the 10 Hz pose `tick`. At 10 players that is about 150 MB/h, so a few cents per play session |
| Backups in `minicraft-worlds` | 48 small files: pennies |
| Cloudflare Tunnel | free |

A stopped VM costs only its disk, which the free tier covers.
