#!/usr/bin/env bash
# Copy the chat UI out of a llama.cpp checkout into this repo.
# Usage: ./scripts/sync-ui.sh [path-to-llama.cpp]
set -euo pipefail

src="${1:-../llama.cpp}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$src/ui/apps/chat" ]; then
	echo "no ui/apps/chat under $src" >&2
	exit 1
fi

rm -rf "$root/ui"
cp -a "$src/ui" "$root/ui"
rm -rf "$root/ui/apps/chat/dist" "$root/ui/apps/chat/.svelte-kit" "$root/ui/apps/chat/node_modules"

echo "synced ui from $src"
