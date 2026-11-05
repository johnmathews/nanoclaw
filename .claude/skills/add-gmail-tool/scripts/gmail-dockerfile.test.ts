/**
 * Dependency guard for the Gmail MCP server (host/vitest tree).
 *
 * See the sibling gcal guard for why this is structural rather than
 * behavioral, and why it now asserts `container/cli-tools.json` instead of a
 * Dockerfile ARG + RUN layer (upstream v2026.10.0 data-drives global installs).
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

describe('the agent image installs @gongrzhe/server-gmail-autoauth-mcp', () => {
  it('declares the package in the CLI manifest', () => {
    expect(manifest().map((t) => t.name)).toContain('@gongrzhe/server-gmail-autoauth-mcp');
  });

  it('pins it to an exact version', () => {
    const entry = manifest().find((t) => t.name === '@gongrzhe/server-gmail-autoauth-mcp');
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('holds zod-to-json-schema at the 3.22.5 workaround pin', () => {
    // gmail-mcp@1.1.11 leaves this unpinned; pnpm then resolves >=3.25, which
    // imports `zod/v3` — a subpath absent from the zod 3.24.x resolved
    // alongside it, so the MCP server fails to start. Installing it globally
    // at 3.22.5 holds the resolution back. Re-check if the Gmail MCP is bumped.
    const entry = manifest().find((t) => t.name === 'zod-to-json-schema');
    expect(entry?.version).toBe('3.22.5');
  });
});
