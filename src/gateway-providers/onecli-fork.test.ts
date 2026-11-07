/**
 * OneCLI fork behaviour (CLAUDE.md fork convention #9).
 *
 * Lives on main only, on purpose. onecli.ts and onecli.test.ts are copied in
 * from .claude/skills/add-onecli/payload/. If an update ever replaces both
 * with upstream's copy, the fork code and its payload assertions vanish
 * together and every test stays green. This file is not a payload, so it
 * survives and fails the staged test run instead.
 *
 * What it pins: a newly created OneCLI agent is switched to secret mode
 * `all` (the gateway creates it `selective` with nothing assigned, so the
 * first credentialed call 401s), and an existing agent is never touched.
 * Source-level on purpose — the behaviour itself is exercised in
 * onecli.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(new URL(import.meta.url).pathname);
const files = [
  path.join(here, 'onecli.ts'),
  path.resolve(here, '../../.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts'),
];

describe.each(files)('OneCLI fork patch in %s', (file) => {
  const src = fs.readFileSync(file, 'utf8');

  it('creates agents through ensureAgentWithSecretMode, not the bare SDK ensureAgent', () => {
    expect(src).toMatch(/export async function ensureAgentWithSecretMode\(/);
    expect(src).toMatch(/await ensureAgentWithSecretMode\(input\.groupName, input\.key\.agentGroupId\)/);
    expect(src).not.toMatch(/onecli\.ensureAgent\(/);
  });

  it('sets secret mode all only on create, and treats 409 as leave-alone', () => {
    expect(src).toMatch(/'set-secret-mode', '--id', agentId, '--mode', 'all'/);
    expect(src).toMatch(/statusCode === 409\) return;/);
  });
});
