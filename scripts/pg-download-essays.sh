#!/usr/bin/env bash
# Download every Paul Graham essay listed in the manifest and convert each to
# clean plain text. Idempotent: skips essays already present unless --force.
# Usage: pg-download-essays.sh [--force]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/groups/slack_paul-graham-essays/essays"
MANIFEST="$DEST/_manifest.tsv"
CONVERT="$ROOT/scripts/pg-essay-to-text.py"
FORCE="${1:-}"

mkdir -p "$DEST"
ok=0; skip=0; fail=0
: > "$DEST/_failures.log"

while IFS=$'\t' read -r href title; do
  [ -z "$href" ] && continue
  slug="${href%.html}"
  out="$DEST/$slug.txt"
  if [ -f "$out" ] && [ "$FORCE" != "--force" ]; then
    skip=$((skip+1)); continue
  fi
  tmp="$(mktemp)"
  code="$(curl -sSL -m 30 -w '%{http_code}' -o "$tmp" "http://www.paulgraham.com/$href")"
  if [ "$code" != "200" ] || [ ! -s "$tmp" ]; then
    echo "$href	HTTP $code" >> "$DEST/_failures.log"; fail=$((fail+1)); rm -f "$tmp"
    continue
  fi
  if python3 "$CONVERT" "$tmp" "$title" "http://www.paulgraham.com/$href" > "$out" 2>/dev/null \
     && [ -s "$out" ]; then
    ok=$((ok+1))
  else
    echo "$href	convert-failed" >> "$DEST/_failures.log"; fail=$((fail+1)); rm -f "$out"
  fi
  rm -f "$tmp"
  sleep 0.4
done < "$MANIFEST"

echo "done: ok=$ok skip=$skip fail=$fail"
[ -s "$DEST/_failures.log" ] && { echo "failures:"; cat "$DEST/_failures.log"; }
exit 0
