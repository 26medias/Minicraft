#!/usr/bin/env bash
#
# Deploys mcserver to the multiplayer VM: cross-compile, copy, restart the unit.
# It runs only on Julien's approval: without --yes it prints what it would do and exits 1.
# It never touches the website or the save API (see ../deploy.sh for the API).
#
#   server/deploy.sh          show the plan
#   server/deploy.sh --yes    do it
#
# Overrides: MC_PROJECT, MC_ZONE, MC_VM.
#
set -euo pipefail

PROJECT="${MC_PROJECT:-qs-trading}"
ZONE="${MC_ZONE:-us-central1-a}"
VM="${MC_VM:-mcserver}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${here}/bin/mcserver-linux-amd64"
GO="${GO:-$(command -v go || echo "${HOME}/.local/go/bin/go")}"

cat <<PLAN
server/deploy.sh will:
	1. build ${out}
	   (GOOS=linux GOARCH=amd64 CGO_ENABLED=0 ${GO} build ./cmd/mcserver)
	2. gcloud compute scp it to ${VM}:/tmp/mcserver (project ${PROJECT}, zone ${ZONE})
	3. over ssh: sudo install it as /usr/local/bin/mcserver, then
	   sudo systemctl restart mcserver
	   (a graceful SIGTERM: players are flushed, disconnected and auto-rejoin)
PLAN

if [[ "${1:-}" != "--yes" ]]; then
	echo "Nothing done. Re-run with --yes to deploy." >&2
	exit 1
fi

echo "==> Building"
(cd "${here}" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 "${GO}" build -trimpath -o "${out}" ./cmd/mcserver)

echo "==> Copying to ${VM}"
gcloud compute scp --project="${PROJECT}" --zone="${ZONE}" "${out}" "${VM}:/tmp/mcserver"

echo "==> Installing and restarting"
gcloud compute ssh --project="${PROJECT}" --zone="${ZONE}" "${VM}" --command \
	"sudo install -m 0755 /tmp/mcserver /usr/local/bin/mcserver && rm /tmp/mcserver && sudo systemctl restart mcserver && sleep 1 && systemctl is-active mcserver && curl -fsS http://127.0.0.1:8080/health && echo"

echo "==> Deployed"
