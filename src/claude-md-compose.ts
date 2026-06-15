/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * See `docs/claude-md-composition.md` for the full design.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig } from './container-config.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const MEMORY_FILE = 'MEMORY.md';
const USER_FILE = 'USER.md';
const MEMORY_FLOOR = 2200;
const SEED_HEADROOM = 1.25;
const LOCAL_MIGRATED_NOTE =
  '<!-- Operational memory now lives in MEMORY.md, curated by the `remember` tool. ' +
  'This file is intentionally left blank to avoid loading the same content twice. -->\n';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 */
export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  seedMemoryFiles(groupDir, group.id);

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const configRow = getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? (JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — every skill that ships an `instructions.md`.
  //
  // TODO (#731): respect `configRow.skills` here. Today this loop is
  // unconditional — every skill in `container/skills/` is wired into every
  // agent's CLAUDE.md. The data shape already exists
  // (`container_configs.skills: string[] | 'all'`) and `syncSkillSymlinks`
  // in container-runner.ts:342 already filters slash-command skills by it,
  // so today the same field drives two systems with two defaults. The
  // MCP-server loop a few lines below is the opt-in precedent. See
  // journal/260528-defer-per-group-skill-selection-in-claudemd.md.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir)) {
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        desired.set(`skill-${skillName}.md`, {
          type: 'symlink',
          content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
        });
      }
    }
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Skip cli.instructions.md when cli_scope is disabled.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Curated memory fragments — MEMORY.md / USER.md injected as a frozen
  // per-session snapshot (Hermes-style, prompt-cache friendly). Inline (not
  // symlink) because the content must be the literal text at compose time, and
  // it lives in the RO-overlaid .claude-fragments so the agent can't edit the
  // live snapshot in place — edits go through the `remember` round-trip.
  for (const [file, fragName, heading] of [
    [MEMORY_FILE, 'memory.md', 'Operational memory (MEMORY.md)'],
    [USER_FILE, 'user.md', 'User profile (USER.md)'],
  ] as const) {
    const p = path.join(groupDir, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8').trim();
    if (text) desired.set(fragName, { type: 'inline', content: `## ${heading}\n\n${text}\n` });
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

/**
 * One-time seed of the curated-memory files (learning & memory feature #1).
 * Keyed on MEMORY.md absence so it runs exactly once per group, on the first
 * compose after the feature ships. If the group already carries per-group
 * memory in CLAUDE.local.md, MOVE it into MEMORY.md (operational bucket), size
 * the budget to fit, and blank CLAUDE.local.md so the same text isn't loaded
 * twice (Claude Code auto-loads CLAUDE.local.md separately from the injected
 * fragment). Cost-neutral: that content already loads today.
 *
 * Best-effort — a seeding failure must never break composition.
 */
function seedMemoryFiles(groupDir: string, agentGroupId: string): void {
  const memoryFile = path.join(groupDir, MEMORY_FILE);
  if (fs.existsSync(memoryFile)) return; // already seeded

  try {
    const localFile = path.join(groupDir, 'CLAUDE.local.md');
    const local = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8').trim() : '';

    if (local) {
      writeAtomic(memoryFile, `${local}\n`);
      const budget = Math.max(MEMORY_FLOOR, Math.ceil(local.length * SEED_HEADROOM));
      updateContainerConfigScalars(agentGroupId, { memory_budget_chars: budget });
      writeAtomic(localFile, LOCAL_MIGRATED_NOTE);
      log.info('Seeded MEMORY.md from CLAUDE.local.md', { group: agentGroupId, chars: local.length, budget });
    } else {
      writeAtomic(memoryFile, '');
    }

    const userFile = path.join(groupDir, USER_FILE);
    if (!fs.existsSync(userFile)) writeAtomic(userFile, '');
  } catch (err) {
    log.warn('Memory seed failed', { group: agentGroupId, error: String(err) });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
