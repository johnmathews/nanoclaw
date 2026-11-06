# Docs freshness audit after the v2026.10.0 cutover

**Date:** 2026-11-06. **Outcome:** the fork-owned docs were re-verified against `dfaabc34` and the
live install. Two live faults that nothing alerts on came to light.

## 1. What was checked

- Every backticked source path in `docs/*.md` was checked for existence at `dfaabc34`.
- Every runtime claim in `docs/operational-gotchas.md` was checked against the live host: the unit
  file, listening ports, `.env` key names and ownership, the mount allowlist, tool paths, `/health`,
  and the log since the last `NanoClaw starting`.

## 2. What changed

- `operational-gotchas.md`: every entry was re-verified. Items 11, 12, 15 and 29 are retired
  (live tree is v2 `main`; no `docs/archive/`; git identity set; the task the entry tracked is
  gone).
- Items 31–33 now open with a note on what v2026.10.0 changed. Silent-turn recovery was
  re-implemented on upstream's turn model. The WhatsApp re-drive and send-timeout fixes are absent.
- New items 36–38: the OneCLI login, WhatsApp, and the paywall mount.
- `research-paywall-browser.md`: status stamp, the old path flagged, and `ncl groups config
  add-mount` instead of a raw `UPDATE`.
- `plan-` and `proposal-learning-and-memory.md`: Status lines now agree with their 2026-11-05
  "historical record" notes.

## 3. Found, not fixed

- **WhatsApp unpaired since 2026-08-02** (gotcha 37). `store/auth/` is empty, the adapter does not
  start, and `/health` omits it. Nothing alerts.
- **Paywall extension mount rejected since 2026-10-23** (gotcha 38). Financial Times and
  HackerNews Summaries run without the extension.
- **No log rotation.** `logs/nanoclaw.error.log` is 2.7 GB.

## 4. Left to upstream

`docs/db.md`, `db-central.md`, `architecture.md` and `setup-flow.md` cite paths that no longer
exist (e.g. `src/db/users.ts`, now `src/modules/permissions/db/users.ts`). They are identical to
upstream and stale there too, so they go to upstream as a PR rather than diverging the fork.
