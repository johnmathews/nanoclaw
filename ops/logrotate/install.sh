#!/usr/bin/env bash
# Install (or refresh) the user-level log rotation for NanoClaw host logs.
# Idempotent. No root needed: systemd --user timer + logrotate with a user state file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir" "$HOME/.local/state"
install -m 0644 "$here/nanoclaw-logrotate.service" "$here/nanoclaw-logrotate.timer" "$unit_dir/"
# Validate the config (debug = dry run); show the output only on failure.
if ! out=$(/usr/sbin/logrotate --debug --state "$HOME/.local/state/nanoclaw-logrotate.status" "$here/nanoclaw.conf" 2>&1); then
  echo "$out" >&2; exit 1
fi
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-logrotate.timer
systemctl --user list-timers nanoclaw-logrotate.timer --no-pager
