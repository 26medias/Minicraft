#!/usr/bin/env bash
# Install the newest stable Go 1.25.x into ~/.local/go, without sudo.
#
# Idempotent: if ~/.local/go already holds a go1.25.x toolchain, it does nothing.
# Override the version with GO_VERSION=go1.25.N, or the target dir with GO_ROOT_DIR.
#
# Afterwards: export PATH=$HOME/.local/go/bin:$PATH
set -euo pipefail

SERIES="go1.25."
DEST="${GO_ROOT_DIR:-$HOME/.local/go}"
DL_INDEX="https://go.dev/dl/?mode=json&include=all"

if [ -x "$DEST/bin/go" ]; then
	current="$("$DEST/bin/go" env GOVERSION 2>/dev/null || true)"
	if [[ "$current" == ${SERIES}* ]] && { [ -z "${GO_VERSION:-}" ] || [ "$current" = "$GO_VERSION" ]; }; then
		echo "Go $current already installed in $DEST"
		exit 0
	fi
fi

case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/index.json" "$DL_INDEX"

# The index is pretty-printed JSON, newest first: each file object lists
# "filename" and, a few lines later, "sha256".
pick() {
	awk -v series="$SERIES" -v want="${GO_VERSION:-}" -v suffix=".$os-$arch.tar.gz" '
		/"filename":/ {
			match($0, /"filename": *"[^"]*"/)
			f = substr($0, RSTART, RLENGTH)
			sub(/^"filename": *"/, "", f); sub(/"$/, "", f)
			cand = ""
			if (substr(f, length(f) - length(suffix) + 1) == suffix) {
				v = substr(f, 1, length(f) - length(suffix))
				if ((want == "" && index(v, series) == 1 && v !~ /(rc|beta)/) || v == want) cand = f
			}
			next
		}
		cand != "" && /"sha256":/ {
			match($0, /[0-9a-f]{64}/)
			print cand, substr($0, RSTART, RLENGTH)
			exit
		}
	' "$tmp/index.json"
}

read -r file sum < <(pick) || true
if [ -z "${file:-}" ] || [ -z "${sum:-}" ]; then
	echo "no ${GO_VERSION:-${SERIES}x} build found for $os-$arch" >&2
	exit 1
fi

echo "Downloading $file"
curl -fsSL -o "$tmp/$file" "https://go.dev/dl/$file"
echo "$sum  $tmp/$file" | sha256sum -c - >/dev/null

mkdir -p "$(dirname "$DEST")"
tar -C "$tmp" -xzf "$tmp/$file"
rm -rf "$DEST"
mv "$tmp/go" "$DEST"

echo "Installed $("$DEST/bin/go" env GOVERSION) in $DEST"
echo "Add to PATH: export PATH=\$HOME/.local/go/bin:\$PATH"
