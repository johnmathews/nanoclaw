# Section 04 — Per-Group Container Env, Dockerfile & Container Skills

> Recover bodies with `git show 971239a:<path>`.

---

## 4.1 Per-group container env injection + paywall-bypass browser

**Origin:** fork-original. **Commits:** `100d3a7` (per-group env + paywall recipe), `6fe8490`
(narrow proxy reserved-key guard to exact names). **Files:** migration (fork's `019-container-config-env.ts`
— renumber, see §01/§1.5 ordering), `src/container-config.ts`, `src/types.ts`,
`src/container-runner.ts`, `src/backfill-container-configs.ts`, `src/cli/resources/groups.ts`,
`src/db/container-configs.ts`, `docs/research-paywall-browser.md`.

Intent: inject arbitrary env vars into individual agent containers at spawn via `ncl groups
config set-env/unset-env`. Reserved keys (TZ, HOME, proxy vars, CA-cert vars) are filtered at
set-time AND spawn-time so per-group env can never reroute traffic around the OneCLI proxy.
Matched by EXACT name (commit `6fe8490`) so namespaced tool vars like `AGENT_BROWSER_PROXY` stay
settable.

Apply:
1. Migration: `ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'` (renumber
   to next free; register in `migrations/index.ts`).
2. `src/db/container-configs.ts`: add `env` to `JSON_COLUMNS`; add to `createContainerConfig`
   INSERT (default `{}`); add `'env'` to the `updateContainerConfigJson` column union; ensure
   `configFromDb` parses it.
3. `src/types.ts`: add `env: string;` to `ContainerConfigRow` (JSON `Record<string,string>`).
4. `src/container-config.ts`: add `env?: Record<string,string>` to `ContainerConfig`; add the
   `RESERVED_ENV_EXACT` Set + `RESERVED_ENV_SUBSTRINGS` array; export `isReservedContainerEnv(key)`
   and `containerEnvArgs(env)` (returns `{ args, skipped }`); in `configFromDb` add
   `env: JSON.parse(row.env ?? '{}')`. (Reserved set per CLAUDE.md: `TZ`, `HOME`,
   `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`/`FTP_PROXY`, `NODE_EXTRA_CA_CERTS`,
   `*CURL_CA*`, `*REQUESTS_CA*`, `SSL_CERT_*` — exact-name match.)
5. `src/container-runner.ts`: import `containerEnvArgs`; in `buildContainerArgs` (before the
   OneCLI gateway block) push `containerEnvArgs(containerConfig.env).args` and `log.warn` any
   `skipped`.
6. `src/backfill-container-configs.ts`: add `env: '{}'` (and `DEFAULT_MEMORY_BUDGET`/
   `DEFAULT_USER_BUDGET` imports) to the legacy backfill row.
7. `src/cli/resources/groups.ts`: import `isReservedContainerEnv`; add `env` to `presentConfig`;
   add `config set-env` / `config unset-env` subcommands (~60 lines — recover verbatim).
8. Copy `docs/research-paywall-browser.md` (the paywall-browser recipe: BPC extension + per-group
   `AGENT_BROWSER_PROXY`).

---

## 4.2 Dockerfile — Gmail + Google Calendar MCP servers

**Origin:** fork-original. **Commit:** `1b21950 feat(container): bundle gmail/gcal MCPs + 4 agent skills`.
**File:** `container/Dockerfile`.

Apply: add ARGs `GMAIL_MCP_VERSION=1.1.11` and `CALENDAR_MCP_VERSION=2.6.1`, and a new `RUN`
layer after the `@anthropic-ai/claude-code` install block:
```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```
`zod-to-json-schema@3.22.5` is pinned as a direct dep to hold back a zod-subpath bug in
gmail-mcp@1.1.11 (unpinned, pnpm picks >=3.25 which imports `zod/v3`, absent in the zod 3.24.x
that resolves alongside). Re-verify if `GMAIL_MCP_VERSION` is bumped. **Supply-chain (CLAUDE.md):**
`pnpm install -g` only (never `bun install -g`); do NOT add these to `onlyBuiltDependencies`
without human approval. Ensure `poppler-utils` is in the apt block (for `pdftotext`/`pdfinfo` used
by §03 + the pdf-reader skill). Note upstream may have restructured the CLI-tool install block
(from `cli-tools.json`/`install-cli-tools.sh` to pinned `RUN` layers) — slot the Gmail/GCal layer
in after the claude-code layer regardless of structure.

---

## 4.3 Container skills (copy-as-is)

**Commit:** `1b21950` unless noted. Skill-loader auto-discovers by directory presence; no
registration. Copy each directory from the fork as-is:

- `container/skills/capabilities/SKILL.md` — `/capabilities` read-only report of skills/tools/MCP/
  mounts. Includes bugfix `0d3d16c` (dropped a bogus main-channel gate) — current HEAD has it.
- `container/skills/status/SKILL.md` — `/status` runtime health/mounts/tools/task snapshot.
- `container/skills/pdf-reader/SKILL.md` + `container/skills/pdf-reader/pdf-reader` (bash exec —
  **keep the +x bit**: `chmod +x` after copy). Uses `pdftotext`. Commit `829ce96` points it at the
  `/workspace/inbox/<msgId>/<filename>` spill path — current HEAD has it.
- `container/skills/email-sending/SKILL.md` — RFC 2047 encoded-word rule for non-ASCII email
  headers (commit `b9253f8`). Pure instructions.
- `container/skills/learn-skill/` and `container/skills/reporting/` — see §1.4 (learning layer).
