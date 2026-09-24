#!/usr/bin/env bash
#
# One-time (and idempotent) setup of the multiplayer VM. Run it ON the VM, as root:
#
#   sudo ./vm-setup.sh --token <MC_TOKEN> --tunnel-token <CLOUDFLARE_TUNNEL_TOKEN> [--bucket minicraft-worlds]
#
# It expects systemd/mcserver.service and systemd/cloudflared.service next to it (copy the
# script and the systemd/ directory together; see server/README.md). It:
#   - installs cloudflared (Cloudflare's apt repo) and, if missing, the Google Cloud CLI;
#   - creates the mcserver system user and /var/lib/mcserver;
#   - writes /etc/mcserver.env (MC_TOKEN, MC_GCS_BUCKET) and /etc/cloudflared.env (TUNNEL_TOKEN);
#   - installs and enables both units, and (re)starts them.
# The mcserver binary itself is installed by server/deploy.sh; until then mcserver stays down.
#
set -euo pipefail

MC_TOKEN=""
TUNNEL_TOKEN=""
BUCKET="minicraft-worlds"

usage() {
	sed -n '3,6p' "$0" >&2
	exit 2
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--token) MC_TOKEN="${2:-}"; shift 2 ;;
		--tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
		--bucket) BUCKET="${2:-}"; shift 2 ;;
		*) usage ;;
	esac
done
[[ -n "${MC_TOKEN}" && -n "${TUNNEL_TOKEN}" ]] || usage
if [[ "${EUID}" -ne 0 ]]; then
	echo "vm-setup.sh: run it with sudo" >&2
	exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for unit in mcserver.service cloudflared.service; do
	[[ -f "${here}/systemd/${unit}" ]] || { echo "vm-setup.sh: missing ${here}/systemd/${unit}" >&2; exit 1; }
done

export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg sqlite3
if ! command -v cloudflared >/dev/null; then
	install -d -m 0755 /usr/share/keyrings
	curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
	echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
		> /etc/apt/sources.list.d/cloudflared.list
	apt-get update -q
	apt-get install -y -q cloudflared
fi
if ! command -v gcloud >/dev/null; then
	curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
		| gpg --dearmor --yes -o /usr/share/keyrings/cloud.google.gpg
	echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
		> /etc/apt/sources.list.d/google-cloud-sdk.list
	apt-get update -q
	apt-get install -y -q google-cloud-cli
fi

echo "==> User and data directory"
if ! id mcserver >/dev/null 2>&1; then
	useradd --system --home-dir /var/lib/mcserver --shell /usr/sbin/nologin mcserver
fi
install -d -m 0750 -o mcserver -g mcserver /var/lib/mcserver

echo "==> Secrets"
umask 077
printf 'MC_TOKEN=%s\nMC_GCS_BUCKET=%s\n' "${MC_TOKEN}" "${BUCKET}" > /etc/mcserver.env
chown root:mcserver /etc/mcserver.env
chmod 0640 /etc/mcserver.env
printf 'TUNNEL_TOKEN=%s\n' "${TUNNEL_TOKEN}" > /etc/cloudflared.env
chown root:root /etc/cloudflared.env
chmod 0600 /etc/cloudflared.env
umask 022

echo "==> systemd units"
install -m 0644 "${here}/systemd/mcserver.service" /etc/systemd/system/mcserver.service
install -m 0644 "${here}/systemd/cloudflared.service" /etc/systemd/system/cloudflared.service
systemctl daemon-reload
systemctl enable cloudflared.service mcserver.service
systemctl restart cloudflared.service
if [[ -x /usr/local/bin/mcserver ]]; then
	systemctl restart mcserver.service
	echo "mcserver: $(systemctl is-active mcserver.service)"
else
	echo "mcserver: no binary yet; run server/deploy.sh --yes from the dev machine"
fi
echo "cloudflared: $(systemctl is-active cloudflared.service)"
echo "==> Done"
