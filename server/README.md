# mcserver — runbook

`mcserver` is the multiplayer relay: one Go binary with a SQLite database. It orders, stores and
relays block edits and player poses. It never generates terrain. The design is
`docs/superpowers/specs/2026-09-24-multiplayer-design.md` (§3 and §9).

**Live since 2026-09-24:** it runs at home, on Julien's desktop ("Beast"), behind a Cloudflare
Tunnel. The VM setup further down is an alternative that is not in use.

```
browser ──wss──▶ Cloudflare (minicraft-server.leap-forward.ca) ──tunnel──▶ Beast: cloudflared ──▶ mcserver 127.0.0.1:8080
                                                                                            └── ~/minicraft-mp/mc.sqlite
```

The machine has **no inbound ports**. The tunnel is an outbound connection, so the router needs
no changes, and Cloudflare handles HTTPS and WebSockets.

Every command below is run by Julien. Nothing here runs from a test or from an agent.

## Current setup: at home, behind a Cloudflare Tunnel

### What is where

| Thing | Where |
|---|---|
| Public address | `https://minicraft-server.leap-forward.ca` (DNS CNAME to the tunnel) |
| Tunnel | Cloudflare Tunnel `minicraft-server`, id `38f8b798-e322-4123-9166-ce068040dbe6`; credentials in `~/.cloudflared/38f8b798-….json` |
| `cloudflared` login | `~/.cloudflared/cert.pem`, for the **leap-forward.ca** zone (only needed to create tunnels and DNS records, not to run) |
| Binary | `~/minicraft-mp/mcserver` |
| Worlds | `~/minicraft-mp/mc.sqlite` (plus its `-wal`/`-shm` files while running) |
| Backup | `~/minicraft-mp/backup.sqlite` (see [Backups at home](#backups-at-home)) |
| Token | `~/minicraft-mp/token` and `~/minicraft-mp/env` (`MC_TOKEN=…`, mode 600) |
| Services | `~/.config/systemd/user/minicraft-server.service` and `minicraft-tunnel.service` |

Both services are systemd **user** units: no sudo. They start with Julien's login session and
restart on failure. When the machine sleeps or he logs out, the server is gone. The kids then see
"The multiplayer server is sleeping", and Single Player keeps working.

### Status, start, stop, logs

```bash
systemctl --user status minicraft-server minicraft-tunnel
systemctl --user stop minicraft-tunnel minicraft-server     # SIGTERM: the server flushes and backs up first
systemctl --user start minicraft-server minicraft-tunnel
journalctl --user -u minicraft-server -f                    # server log
journalctl --user -u minicraft-tunnel -n 20                 # tunnel: look for "Registered tunnel connection … location=yyz"
curl -s https://minicraft-server.leap-forward.ca/health     # → ok
```

To stop them starting at login: `systemctl --user disable minicraft-server minicraft-tunnel`.
Never stop the server with `kill -9` or `fuser -k` (SIGKILL): it skips the final flush, and up to
1 s of edits is lost.

### Updating the server

```bash
cd ~/Projects/Minicraft/server
~/.local/go/bin/go test -race ./...
~/.local/go/bin/go build -o ~/minicraft-mp/mcserver ./cmd/mcserver
systemctl --user restart minicraft-server
```

The kids' clients reconnect on their own and come back where they were.

### Building and deploying the site for it

Pass the URL and token on the command line. **Do not put them in `.env.local`**: `npm run dev`
would then talk to the live server, and tests must never do that.

```bash
cd ~/Projects/Minicraft
VITE_MINICRAFT_MP_URL=https://minicraft-server.leap-forward.ca \
VITE_MINICRAFT_MP_TOKEN=$(cat ~/minicraft-mp/token) npm run build
grep -l minicraft-server.leap-forward.ca dist/assets/index-*.js   # must print the bundle
```

Then upload as for any site release (see the deploy notes: assets first, `index.html` last,
`CLOUDSDK_CORE_ACCOUNT=julien@leap-forward.ca`):

```bash
export CLOUDSDK_CORE_ACCOUNT=julien@leap-forward.ca
gcloud storage cp --cache-control="public, max-age=31536000, immutable" dist/assets/* gs://noah.leap-forward.ca/minicraft/assets/
gcloud storage cp --cache-control="no-cache, must-revalidate" dist/index.html gs://noah.leap-forward.ca/minicraft/index.html
curl -s https://noah.leap-forward.ca/minicraft/ | grep -o 'index-[A-Za-z0-9_]*\.js'
```

Deploy the site and the server together. A new site on an old server works, but it misses
fields the server adds (`welcome.hasPos`, the mining `fx` `dur`).

**Changing the token:** write the new one to `~/minicraft-mp/token` and `~/minicraft-mp/env`,
restart the server, then rebuild and redeploy the site. Clients built with the old token get
`4007 bad_token`.

### Forcing a client update

`docs/protocol.md` §6 (Versioning): a cached bundle from before a breaking change (in practice,
mostly the bot SDK falling behind the game) needs to be refused rather than let it desync from
the server. This is what `CLIENT_VERSION`/`ver` and `MC_MIN_CLIENT`/`MinClient` are for — kept
separate from `proto`, which only moves for an actual wire-shape change.

1. **Bump `CLIENT_VERSION`** in `src/net/protocol.ts`.
2. **Build and deploy the site** — see [Building and deploying the site for
   it](#building-and-deploying-the-site-for-it) above.
3. **Check that the bare `/minicraft/` URL serves the new bundle hash:**
   ```bash
   curl -s https://noah.leap-forward.ca/minicraft/ | grep -o 'index-[A-Za-z0-9_]*\.js'
   ```
4. **Rebuild the bots** — anyone running `minicraft-bot` needs `npm run build:bot` again
   (see [`packages/minicraft-bot/README.md`](../packages/minicraft-bot/README.md)); an old build
   now gets `OutdatedClientError`.
5. **Set `MC_MIN_CLIENT=<new>`** in `~/minicraft-mp/env`, alongside the existing `MC_TOKEN` line.
6. **`systemctl --user restart minicraft-server`.**

A client below `MC_MIN_CLIENT` gets the `error {code: 4004, message: "outdated", min}` refusal
then a matching close. The game client gets one guarded automatic reload if its cached bundle was
already rebuilt (a stale one still shows the click-to-reload screen); a bot gets
`OutdatedClientError` and has to be rebuilt by hand — see `docs/protocol.md` for exactly which
close codes and messages this involves.

On the VM path (below, not in use), `vm-setup.sh` writes `/etc/mcserver.env` with only `MC_TOKEN`
and `MC_GCS_BUCKET`: **`MC_MIN_CLIENT` has to be added to that file by hand** if the VM setup is
ever brought back into use. This has no effect on the live Beast unit above.

### Backups at home

The server writes `~/minicraft-mp/backup.sqlite` (a consistent `VACUUM INTO` copy) every hour
while anyone is playing, and on every stop. There is no GCS upload here (`-gcs-bucket` is not set)
and **only one copy is kept**, so copy it somewhere dated now and then:

```bash
cp ~/minicraft-mp/backup.sqlite ~/minicraft-mp-backups/mc-$(date +%F).sqlite
```

To restore:

```bash
systemctl --user stop minicraft-server
cp <the backup> ~/minicraft-mp/mc.sqlite && rm -f ~/minicraft-mp/mc.sqlite-wal ~/minicraft-mp/mc.sqlite-shm
systemctl --user start minicraft-server
```

### Recreating the tunnel from scratch

Only needed on a new machine, or if the tunnel is deleted. `cloudflared tunnel login` must pick
the **leap-forward.ca** zone: a certificate for another zone cannot create this hostname.

```bash
cloudflared tunnel login
cloudflared tunnel create minicraft-server
cloudflared tunnel route dns minicraft-server minicraft-server.leap-forward.ca
```

Then put the new tunnel id in `minicraft-tunnel.service`, where it appears twice: in
`--credentials-file` and as the tunnel to run. Then run
`systemctl --user daemon-reload && systemctl --user restart minicraft-tunnel`.

### The unit files

`~/.config/systemd/user/minicraft-server.service`:

```ini
[Unit]
Description=Minicraft multiplayer server (mcserver)

[Service]
EnvironmentFile=%h/minicraft-mp/env
ExecStart=%h/minicraft-mp/mcserver -db %h/minicraft-mp/mc.sqlite -addr 127.0.0.1:8080
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/minicraft-tunnel.service`:

```ini
[Unit]
Description=Cloudflare Tunnel for minicraft-server.leap-forward.ca
After=minicraft-server.service

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --credentials-file %h/.cloudflared/38f8b798-e322-4123-9166-ce068040dbe6.json --url http://127.0.0.1:8080 38f8b798-e322-4123-9166-ce068040dbe6
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

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
| `-min-client` | env `MC_MIN_CLIENT`, else `0` | lowest client build (`hello.ver`) admitted; the flag wins only when explicitly passed (see [Forcing a client update](#forcing-a-client-update)) |
| `-backup-dir` | the `-db` directory | where `backup.sqlite` is written |
| `-gcs-bucket` | env `MC_GCS_BUCKET` | backup upload bucket; empty disables the upload |

## Alternative: on a VM (not in use)

Everything below is the original VM plan (spec §9). It works, but the live setup is the home one
above. On the VM the hostname was planned as `mc.leap-forward.ca`, and the worlds would live in
`/var/lib/mcserver`.

### First-time setup

The project is `qs-trading` and the zone is `us-central1-a`.

#### 1. Service account

The VM backs up to `gs://minicraft-worlds/mp-backups/`. Give it its own account with object
access to that bucket only:

```bash
gcloud iam service-accounts create mcserver --project=qs-trading \
	--display-name="Minicraft multiplayer VM"
gcloud storage buckets add-iam-policy-binding gs://minicraft-worlds --project=qs-trading \
	--member=serviceAccount:mcserver@qs-trading.iam.gserviceaccount.com \
	--role=roles/storage.objectAdmin
```

#### 2. The VM

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

#### 3. The Cloudflare Tunnel

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel**.
   Choose the **Cloudflared** type and name it `mcserver`.
2. Copy the **tunnel token** (the long string after `--token` in the install command). Do not
   run Cloudflare's install command; `vm-setup.sh` does that part.
3. Under **Public hostnames**, add `mc.leap-forward.ca` with service `HTTP` and URL
   `localhost:8080`. Cloudflare creates the DNS record. WebSockets work through tunnels without
   any extra setting.

#### 4. Pick the game token

`MC_TOKEN` is the shared secret that the site sends. The site build reads it as
`VITE_MINICRAFT_MP_TOKEN`, so it is not a real secret. It keeps strangers out, but it does not
stop someone who reads the bundle.

```bash
openssl rand -hex 16
```

#### 5. Run vm-setup.sh on the VM

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

#### 6. Deploy the binary

See [Deploying](#deploying). Then check it from anywhere:

```bash
curl https://mc.leap-forward.ca/health    # ok
```

#### 7. Build the site with multiplayer

In `.env.local`, set:

```
VITE_MINICRAFT_MP_URL=https://mc.leap-forward.ca
VITE_MINICRAFT_MP_TOKEN=<MC_TOKEN>
```

Then build and upload the site by hand, as usual. Without `VITE_MINICRAFT_MP_URL`, the
Multiplayer button is hidden.

### Starting and stopping

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

### Deploying

```bash
server/deploy.sh          # prints the plan, deploys nothing, exits 1
server/deploy.sh --yes    # build linux/amd64, scp, install, systemctl restart
```

The restart is a graceful `SIGTERM`, as above. `MC_PROJECT`, `MC_ZONE` and `MC_VM` override the
defaults.

### Backups

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

#### Restoring a backup

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

### Costs

| Item | Cost |
|---|---|
| e2-micro in us-central1 | free tier (one per billing account) |
| 10 GB standard persistent disk | free tier (30 GB) |
| Ephemeral external IPv4 | about $0.005 per hour, billed only while the VM runs |
| Egress | mostly the 10 Hz pose `tick`. At 10 players that is about 150 MB/h, so a few cents per play session |
| Backups in `minicraft-worlds` | 48 small files: pennies |
| Cloudflare Tunnel | free |

A stopped VM costs only its disk, which the free tier covers.
