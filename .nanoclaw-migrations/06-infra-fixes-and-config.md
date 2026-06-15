# Section 06 — Infra Fixes & Config

> Recover bodies with `git show 971239a:<path>`.

---

## 6.1 `<internal>` tag stripping in all outbound paths

**Origin:** fork-original. **Commits:** `e30f4a8` (send_message/send_file), `ea1c4b4` (result-text
+ edit_message). **Files:** `container/agent-runner/src/mcp-tools/core.ts`, `core.instructions.md`,
`poll-loop.ts`, `integration.test.ts`, `core.test.ts`.

Intent: agents mark scratchpad with `<internal>...</internal>`; without stripping it leaks to the
channel. Strip in every outbound path; if a body is entirely internal, send nothing (don't blank
the message / don't post empty).

Apply (`stripInternalTags` already exists in `formatter.ts` on upstream — verify with
`git show upstream/main:container/agent-runner/src/formatter.ts | grep stripInternalTags`):
1. `mcp-tools/core.ts`: `import { stripInternalTags } from '../formatter.js';`. In `send_message`:
   `const body = stripInternalTags(text); if (!body) return ok('Nothing sent — entirely <internal>
   scratchpad.');` then use `body`. In `send_file`: wrap text with `stripInternalTags(...)`. In
   `edit_message`: same guard ("Nothing edited …"), use `body`.
2. `poll-loop.ts` `dispatchResultText`: in the `MESSAGE_RE` loop, `const body =
   stripInternalTags(match[2]);` then `if (!body) { log(...); continue; }`.
3. `core.instructions.md`: update the `### Internal thoughts` section (stripping applies to
   `<message to="...">` blocks + send_message/send_file/edit_message; "don't send status
   confirmations").
4. Add the two integration tests + `core.test.ts` strip coverage.

---

## 6.2 container-runner — replace shadow dirs in skill symlink sync

**Origin:** fork-original. **Commits:** `5fdcea6`, `8c48db4`. **File:** `src/container-runner.ts`.

Intent: `syncSkillSymlinks` previously skipped any existing path (`lstatSync`); a real dir/file
shadowing the intended symlink silently ignored edits to the shared skill source. Fix: if the path
exists but is NOT a symlink, remove it and recreate the symlink. Also export
`_syncSkillSymlinksForTesting`. (Load-bearing for the `learn-skill` self-authoring feature, §1.4.)

Apply: in the skill-creation loop use `fs.lstatSync` → if `stat && !stat.isSymbolicLink()` then
`fs.rmSync(linkPath, {recursive:true, force:true})` and recreate via `fs.symlinkSync('/app/skills/
${skill}', linkPath)`. Add `export function _syncSkillSymlinksForTesting(claudeDir, containerConfig)
{ syncSkillSymlinks(claudeDir, containerConfig); }`. **High merge-risk file** — upstream refactored
container-runner heavily (egress lockdown, `buildMounts` export, separate `selectedSkillNames`).
Read upstream's current `syncSkillSymlinks` before editing; the fork inlined `selectedSkillNames`
into it. Reconcile rather than blind-apply.

---

## 6.3 install-slug — drop "v2" from identifiers

**Origin:** fork-original. **Commits:** `430ffd4`, `97abc95`. **Files:** `setup/lib/install-slug.sh`,
`src/install-slug.ts`, `src/container-runner.ts`.

Intent: remove the `-v2-` infix from systemd unit / launchd label / Docker image names (v1 is gone).

Apply: in `setup/lib/install-slug.sh` change the three printf formats `com.nanoclaw-v2-%s` →
`com.nanoclaw-%s`, `nanoclaw-v2-%s` → `nanoclaw-%s`, `nanoclaw-agent-v2-%s` → `nanoclaw-agent-%s`.
In `src/install-slug.ts` change the matching three return template literals. In
`src/container-runner.ts` change the running-container name to `nanoclaw-${agentGroup.folder}-
${Date.now()}`. **This install already uses the renamed slug** (`nanoclaw-583cc1c4`) — on a
clean-upstream REBUILD of THIS install the names already match; no service migration needed. (On a
brand-new install it's just the naming convention.)

---

## 6.4 mount-security test port (audit W4.4)

**Origin:** fork-original. **Commit:** `9d7fea3`. **File:** `src/modules/mount-security/index.test.ts`.
Apply: create the test verbatim (no production change). Covers `loadMountAllowlist`, `validateMount`
(path traversal, symlink escape, blocked patterns, RW enforcement, colon injection),
`validateAdditionalMounts`, `generateAllowlistTemplate`. Uses `vi.resetModules()` + dynamic imports;
mocks `fs` and `../../config.js` at module level (order matters). Adjust destructured names if
upstream's `mount-security/index.ts` exports changed.

---

## 6.5 update-nanoclaw skill — diagnostics/telemetry opt-out

**Origin:** fork-original. **Commit:** `726ba7e`. **Files:** `.claude/skills/update-nanoclaw/SKILL.md`,
`.claude/skills/update-nanoclaw/diagnostics.md`.
Apply: replace `diagnostics.md` contents with the single line `# Diagnostics — opted out`. In
`SKILL.md` remove: the `# Step 0a: Refresh this skill first` section, the Step-0 preflight line
about the Step-0a self-refresh exception, the `Proceed to Step 7.9.` line + the entire `# Step 7.9:
Stamp the upgrade marker` section, and the bottom `## Diagnostics` section. **Caveat:** removing
Step 0a means the skill won't self-update from upstream; removing Step 7.9 means it won't stamp the
upgrade marker — but since the 2.1.0 tripwire is being handled explicitly during this migration's
Phase 2, that's acceptable. Re-evaluate if you later rely on `/update-nanoclaw` for tripwire stamping.

---

## 6.6 package.json — channel adapter deps

**Origin:** fork-original. **Commit:** `b952767`. **Files:** `package.json`, `pnpm-lock.yaml`.
The `/add-slack` / `/add-whatsapp` / `/add-resend` skills (§02) add these automatically. Manual
pins for reference: `@chat-adapter/slack@4.26.0`, `@resend/chat-sdk-adapter@0.1.1`,
`@whiskeysockets/baileys@7.0.0-rc.9`, `pino@9.6.0`, `qrcode@1.5.4`, `@types/qrcode@1.5.6`.
**`@onecli-sh/sdk`: use upstream's 2.2.1 (decision #2) — do NOT carry the fork's 0.5.0.** Regenerate
`pnpm-lock.yaml` with `pnpm install` (NOT `--frozen-lockfile`) after the skills run.
**pnpm-workspace.yaml = identical to upstream; preserve verbatim, never loosen** (`minimumReleaseAge:
4320`, `onlyBuiltDependencies: [better-sqlite3, esbuild, protobufjs, sharp]`).

---

## 6.7 Misc config (port selectively)

- **`.gitignore`** (commits `c212b90`/`c727439`/`7d0a2a4`/`e3f9250`/`84ff8ed`): port only the
  portable patterns — `screenshots/`, `.stfolder`, `.engineering-team/`. Do NOT port v1-migration
  artifacts (`nanoclaw-v1-backup-*.tar.gz`, `nanoclaw-v1-archive/`, `journal/.pages`) or the
  install-specific FT confidentiality comment block.
- **`.husky/pre-commit`** (commit `2bae1b7`): make executable —
  `chmod +x .husky/pre-commit && git update-index --chmod=+x .husky/pre-commit`.
- **`.claude/settings.json`** (commit `405c74d`): the `Bash(gh run watch *)` allow entry is a local
  convenience permission — port only if wanted (borderline install-specific).

---

## 6.8 Paul Graham essay scripts (reusable companion tooling)

**Origin:** fork-original. **Commit:** `cc330ea`. **Files:** `scripts/pg-download-essays.sh`,
`scripts/pg-essay-to-text.py`.
Reusable IF the `#paul-graham-essays` agent group is set up with the same folder convention. Copy
both (mark the `.sh` executable). `pg-download-essays.sh` reads
`groups/slack_paul-graham-essays/essays/_manifest.tsv` (lives under `groups/`, not in repo — must
exist) and calls `python3 scripts/pg-essay-to-text.py` (Python 3 stdlib + curl only). Skip if not
recreating that agent.

---

## 6.9 Docs (content — copy as-is, low risk)

Fork-authored docs to carry forward (informational, no code impact): `docs/proposal-learning-and-
memory.md`, `docs/plan-learning-and-memory.md`, `docs/research-paywall-browser.md` (also §4.1),
`docs/templates/weekly-reflection.md` (§1.4), plus fork edits to `docs/architecture*.md`,
`docs/db*.md`, `docs/agent-runner-details.md`, `docs/isolation-model.md`, `docs/operational-
gotchas.md`, `docs/setup-wiring.md`, `docs/migration-dev.md`, `docs/archive/v2-*`. `CLAUDE.md` and
`README.md` are fork-customized user content — re-apply the fork's versions on top of upstream
(expect prose conflicts; the fork's content is authoritative for this install). `README_ja.md` /
`README_zh.md` were removed by the fork — leave removed.
