# 1. Log rotation for the host logs, and quieter channel-offline deferrals

**Date:** 2026-11-06. **Outcome:** `logs/nanoclaw.{log,error.log}` now rotate. A long channel outage
no longer writes a stacked WARN for every parked message every two minutes.

## 1.1 Why

- `nanoclaw.error.log` had reached 2.6 GB (20.9M lines; ZFS lz4 hid it, since `du` showed 162 MB).
  Nothing rotated it. Root fs is 79% full.
- Most of the volume was `Message delivery deferred — channel offline` for the ~144 messages
  parked behind the logged-out WhatsApp. Each message warned every 120s (the capped backoff) with
  a full stack, about 4.3k warnings an hour. That stopped at a restart before today. The cause
  remains: any long outage of any channel would do the same again.

## 1.2 What changed

- `ops/logrotate/`: logrotate config, systemd user service and timer, `install.sh`. User-level
  (no sudo on this box) with its own state file `~/.local/state/nanoclaw-logrotate.status`.
  Hourly check; rotates daily or at 50 MB; 14 gzipped archives. copytruncate is safe because the
  unit uses `append:` (O_APPEND), so there's no restart and no sparse file.
- The first rotation compressed the 2.6 GB file to 85 MB (`nanoclaw.error.log-20261106-234509.gz`).
- `src/delivery.ts`: `deferDelivery` returns the deferral count. `deferralLogLevel` warns on the
  first deferral, every 30th (about hourly at the capped backoff) and when the count is unknown.
  Every other deferral logs at debug, and repeats carry `err.message` without the stack.
  Regression test in `src/delivery.test.ts`.

## 1.3 Alloy

No change needed. Its container logs are capped by Docker `json-file` 10m×5, the same as cadvisor,
node_exporter, mkdocs and portainer_agent. Alloy's storage is 19K. It doesn't tail the nanoclaw
files, so rotation doesn't affect it. onecli and the agent containers log to journald, which
has default caps (939M in use).
