/**
 * Dependency guard for the Google Calendar MCP server (host/vitest tree).
 *
 * `@cocal/google-calendar-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never
 * sees it. The only in-tree footprint is the install declaration, so the guard
 * is structural: drop it and this goes red.
 *
 * Rewritten for upstream v2026.10.0: global installs are no longer a
 * hand-written Dockerfile RUN layer with a pinned ARG. They are data in
 * `container/cli-tools.json`, which install-cli-tools.sh installs via
 * `pnpm install -g` pinned to each entry's version. Asserting the manifest is
 * both the current truth and a stronger check — it verifies the pin itself,
 * not just that an ARG is referenced somewhere.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

interface CliTool {
  name: string;
  version: string;
  onlyBuilt?: boolean;
}

function manifest(): CliTool[] {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'container/cli-tools.json'), 'utf8')) as CliTool[];
}

describe('the agent image installs @cocal/google-calendar-mcp', () => {
  it('declares the package in the CLI manifest', () => {
    expect(manifest().map((t) => t.name)).toContain('@cocal/google-calendar-mcp');
  });

  it('pins it to an exact version, as the supply-chain policy requires', () => {
    const entry = manifest().find((t) => t.name === '@cocal/google-calendar-mcp');
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
