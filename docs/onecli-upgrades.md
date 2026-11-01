# 1. Upgrading the OneCLI gateway

NanoClaw talks to the OneCLI gateway (credential vault + egress proxy) through `@onecli-sh/sdk`. The gateway is an external component with its own release line, so NanoClaw pins the **sanctioned gateway version** in [`versions.json`](../versions.json) under `onecli-gateway`. When an update moves that pin, the gateway must be upgraded — this doc is the migration path. It is written to be handed to a coding agent verbatim: detect → upgrade → verify → rollback.

There is deliberately **no runtime version check, and setup does not migrate the gateway for you**: the gateway is a separate out-of-band component, and the migrator is your coding agent running `/update-nanoclaw` — it diffs `versions.json` across the update and routes you here when the `onecli-gateway` pin moved. (Setup detects a pre-`/v1` gateway and points at this doc, but never upgrades it.) Run the steps below verbatim.

## 1.1 Detect

Find out what is running and what is required:

```bash
cat versions.json                                   # the sanctioned pin
curl -s http://127.0.0.1:10254/api/health           # reports the running gateway version
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:10254/v1/health
```

If the last command prints `404`, the server predates the `/v1` API that `@onecli-sh/sdk` 2.x requires — every SDK call will fail with 404s that look transient but are permanent. If your gateway is remote, substitute its host for `127.0.0.1` (it's in `.env` as `ONECLI_URL` / `NANOCLAW_ONECLI_API_HOST`).

Why gateways fall behind: the OneCLI installer's docker-compose tracks the `latest` image tag, but Docker never re-pulls a tag — the server freezes at whatever `latest` meant on install day.

## 1.2 Upgrade

The gateway runs as a Docker service in `~/.onecli`. Upgrade just that container to the pinned `onecli-gateway` version — vault data lives in named Docker volumes and survives. This upgrades only the gateway; the CLI binary is pinned separately (see below).

**Take a database dump first — this is not optional.** The image tag is reversible; the database is not. A gateway at 1.42 or later migrates the schema on first start and *drops* columns the older image still queries (1.42 drops `secrets.is_platform`, which 1.36 selects on every proxied request). Re-pinning the old tag afterwards gives you a gateway that boots healthy and fails every credentialed call. The dump is the only real rollback:

```bash
mkdir -p ~/.onecli/backups
docker exec onecli-postgres-1 pg_dump -U onecli -d onecli --clean --if-exists \
  | gzip > ~/.onecli/backups/onecli-pgdump-pre-<target-version>-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

**Local gateway (the common case):**

```bash
cd ~/.onecli && ONECLI_VERSION=<onecli-gateway pin from versions.json> docker compose pull onecli && docker compose up -d
```

**Remote gateway** — run the same command on the gateway's host (NanoClaw can't reach it over SSH).

## 1.3 Verify

Host-side health is necessary but **not sufficient**:

```bash
curl -s http://127.0.0.1:10254/v1/health     # must return {"status":"ok",...}
```

**Verify the bind interface (container reachability).** Agent containers reach the gateway over the docker bridge (`host.docker.internal` → e.g. `172.17.0.1`), so a server bound only to `127.0.0.1` boots clean host-side while every credentialed call from containers dies at the proxy:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  curlimages/curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:10254/v1/health
```

This must print `200`. If it can't connect while the host-side check passed, set the bind address in `~/.onecli/.env` to the docker-bridge IP (or `0.0.0.0` on a host with a closed firewall) and `cd ~/.onecli && docker compose up -d`. Symptom if skipped: host log clean, agents fail all API calls.

**Verify credential injection (the only check that proves the upgrade).** Both health checks can pass while the vault refuses to inject, so exercise the path an agent actually uses. Two things make this probe valid, and it reports a false failure without either: send it through the **proxy port** (10255) with a running agent's token, and include an **`Authorization: Bearer placeholder`** header — the gateway *substitutes* an existing auth header rather than adding one, so a request with no auth header returns `credential_not_found` even on a perfectly healthy gateway. (This is why NanoClaw spawns containers with `CLAUDE_CODE_OAUTH_TOKEN=placeholder`.) A path the credential's injection rule doesn't cover, such as `GET /v1/models`, also returns `credential_not_found` — use `POST /v1/messages`.

```bash
# token + CA from any running agent container
TOK=$(docker inspect <agent-container> -f '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -m1 '^HTTPS_PROXY=' | sed 's|.*//||' | sed 's/host.docker.internal/172.17.0.1/')
curl -s -o /tmp/probe.json -w 'http=%{http_code}\n' \
  --proxy "http://${TOK}" --proxy-insecure --cacert /tmp/onecli-proxy-ca.pem \
  -H 'Authorization: Bearer placeholder' -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  https://api.anthropic.com/v1/messages
docker logs onecli --since 60s 2>&1 | grep 'forward:' | tail -1
```

Must print `http=200`, and the gateway log line must end `status=200 ... injections_applied=1`. `injections_applied=0` or a `credential_not_found` body means the vault is not serving this agent — stop and roll back. Also confirm the MITM CA did not change, or every already-running container's mounted cert is stale: `curl -s "$GW/v1/container-config?identifier=<agent-group-id>"` and compare its `caCertificate` fingerprint with `openssl x509 -in /tmp/onecli-proxy-ca.pem -noout -fingerprint -sha256`.

Finally, restart the NanoClaw service (per-install names — derive with `setup/lib/install-slug.sh`):

```bash
# macOS
source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)
```

## 1.4 Rollback

**Re-pinning the old tag is not a rollback by itself.** Once a 1.42-or-later gateway has started, the schema is migrated and the old image's queries fail against it. Verified symptom when rolling 1.43.3 back to 1.36.0 this way: `/api/health` returns `{"status":"ok"}`, the web API answers `listing secrets: Internal Server Error`, and the proxy rejects every request with

```
WARN CONNECT rejected: internal error host=api.anthropic.com:443
  error=db error: querying secrets by organization_id: column "is_platform" does not exist
```

So restore the dump taken in [1.2](#12-upgrade) alongside the tag:

```bash
cd ~/.onecli
sed -i 's/^ONECLI_VERSION=.*/ONECLI_VERSION=<old-version>/' .env
docker compose --project-directory ~/.onecli stop onecli        # no writers during restore
docker exec onecli-postgres-1 pg_dump -U onecli -d onecli --clean --if-exists \
  | gzip > ~/.onecli/backups/onecli-pgdump-post-<new-version>-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
# A plain --clean restore FAILS here: the newer schema's tables depend on the
# dumped ones, so every DROP is refused and the old columns never come back.
docker exec onecli-postgres-1 psql -U onecli -d onecli \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO onecli; GRANT ALL ON SCHEMA public TO public;"
zcat ~/.onecli/backups/onecli-pgdump-pre-<new-version>-<ts>.sql.gz \
  | docker exec -i onecli-postgres-1 psql -U onecli -d onecli -v ON_ERROR_STOP=1
docker compose --project-directory ~/.onecli up -d
```

Then re-run every check in [1.3](#13-verify), the injection probe included — a restore that leaves the vault unreadable looks identical to a healthy one from `/api/health` alone.

If the NanoClaw update itself is being rolled back, also pin `@onecli-sh/sdk` back to its previous version in `package.json` and run `pnpm install`.

## 1.5 The CLI binary (`onecli-cli` pin)

The `onecli` host CLI is pinned the same way, under `onecli-cli` in `versions.json`. Setup installs exactly that version by direct release download — it never resolves "latest". When an update moves this pin, replace the binary with the pinned release:

```bash
onecli version                                              # detect: what is installed
V=<onecli-cli pin from versions.json>
OS=$(uname -s | tr '[:upper:]' '[:lower:]')                 # darwin | linux
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')   # amd64 | arm64
curl -fsSL -o /tmp/onecli.tgz \
  "https://github.com/onecli/onecli-cli/releases/download/v${V}/onecli_${V}_${OS}_${ARCH}.tar.gz"
tar -xzf /tmp/onecli.tgz -C /tmp
install -m 0755 /tmp/onecli "$(command -v onecli || echo ~/.local/bin/onecli)"
onecli version                                              # verify: must match versions.json
```

To roll back, run the same block after reverting `versions.json` (or checking out the previous NanoClaw version). The CLI is stateless — vault data lives in the gateway, so swapping the binary in either direction loses nothing.

## 1.6 Version ceiling on this install

**The pin is a ceiling, not a floor: go to exactly 1.42.0 and no further.** Upstream's 2026.10.0 release notes are explicit — *"Do not go past 1.42.0: OneCLI 1.43 and later break assigning credentials to agents and are not supported yet"* — and 1.42.0 itself is a `[BREAKING]` security step that **closes a credential-injection bypass**, which `/update-nanoclaw` refuses to proceed without. OneCLI is mid-migration from per-agent **secret modes** to an **agent grants** API, and this install's code (`@onecli-sh/sdk` 2.2.x, no grants callsites) sits on the old side of it.

| Gateway | State here |
|---|---|
| 1.36.0 | Original install, pre-dates the credential-injection bypass fix. `/api/health` reports `version: "unknown"`. |
| **1.42.0** | **The pin.** Closes the injection bypass; first version with the policy API and a real `/api/health` version. Migrates the schema on first start — see [1.4](#14-rollback). Verified here: injection applies (`injections_applied=1`), MITM CA unchanged, vault intact, `onecli agents secrets --id <id>` still reads back. |
| 1.43.x | **Not supported.** Upstream: 1.43+ "break assigning credentials to agents"; `/add-dial-tool` and friends refuse it. Observed here on 1.43.3: `onecli agents secrets --id <id>` answers `getting agent secrets: Gone`, so an agent's secret list can no longer be read back from the CLI. (`set-secret-mode` still answered, and proxy injection still applied — but the version is off-support regardless, so do not land on it.) |
| 1.44.0+ | Needs the grants code ported first. `agents set-secrets`, `agents secrets` and `agents set-secret-mode` all answer `410 Gone`, so the remedy in [CLAUDE.md](../CLAUDE.md) for an auto-created agent group landing in `selective` with no secrets has no replacement in CLI 2.2.x (`agents grants attach-secret` needs CLI 2.6+). First start also runs a one-way conversion that deletes custom project/network/behavioral rules, block **and approval** rules on secrets, drops rate limits on allow rules, and resets a `block` project default to `allow`. Upstream pins 1.45.0 with grants-based code in `.claude/skills/add-onecli/`; adopting it here arrives with `/update-nanoclaw`, not on its own.

Because `~/.onecli/.env` carries `ONECLI_VERSION` explicitly, a later `docker compose up -d` cannot drift the gateway past the pin. Before considering 1.44+, `onecli rules list` must be empty, or each rule's protection has to be given up knowingly.
