import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { _syncSkillSymlinksForTesting, resolveProviderName } from './container-runner.js';

function makeConfig(skills: string[] | 'all'): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills,
  };
}

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

// Feature 4 (self-authored skills as procedural memory): lock in the invariant
// that a non-symlink directory the agent authors under a UNIQUE name survives
// the spawn-time reconciliation in syncSkillSymlinks, while shared symlinks
// still reconcile. If this breaks, agent procedural memory silently vanishes.
describe('syncSkillSymlinks — agent-authored skill survival', () => {
  let claudeDir: string;
  let skillsDir: string;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-skills-'));
    skillsDir = path.join(claudeDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it('preserves a non-symlink (agent-authored) dir with a unique name', () => {
    // Agent authored a real skill directory under a name not in `desired`.
    const authored = path.join(skillsDir, 'deploy-static-site');
    fs.mkdirSync(authored);
    fs.writeFileSync(path.join(authored, 'SKILL.md'), '# authored');

    _syncSkillSymlinksForTesting(claudeDir, makeConfig(['welcome', 'status']));

    // Authored dir survives both loops, contents intact.
    expect(fs.existsSync(authored)).toBe(true);
    expect(fs.lstatSync(authored).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(authored, 'SKILL.md'), 'utf8')).toBe('# authored');
    // Desired shared skills are symlinked in alongside it.
    expect(fs.lstatSync(path.join(skillsDir, 'welcome')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'status')).isSymbolicLink()).toBe(true);
  });

  it('removes a stale symlink no longer in the desired set', () => {
    // A previously-desired shared skill, now dropped from config.
    fs.symlinkSync('/app/skills/reactions', path.join(skillsDir, 'reactions'));

    _syncSkillSymlinksForTesting(claudeDir, makeConfig(['welcome']));

    expect(fs.existsSync(path.join(skillsDir, 'reactions'))).toBe(false);
    expect(fs.lstatSync(path.join(skillsDir, 'welcome')).isSymbolicLink()).toBe(true);
  });

  it('clobbers a real dir ONLY when its name collides with a desired skill', () => {
    // Agent mistakenly authored under a shared skill's name — the documented
    // caveat. This dir is destroyed; the SKILL.md must teach unique names.
    const colliding = path.join(skillsDir, 'welcome');
    fs.mkdirSync(colliding);
    fs.writeFileSync(path.join(colliding, 'SKILL.md'), '# clobbered');

    _syncSkillSymlinksForTesting(claudeDir, makeConfig(['welcome']));

    expect(fs.lstatSync(colliding).isSymbolicLink()).toBe(true);
  });
});

describe('learn-skill SKILL.md presence', () => {
  it('exists and declares the required Pitfalls + Verification sections', () => {
    const skillPath = path.join(process.cwd(), 'container', 'skills', 'learn-skill', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const body = fs.readFileSync(skillPath, 'utf8');
    expect(body).toMatch(/^## Pitfalls$/m);
    expect(body).toMatch(/^## Verification$/m);
    // Teaches the load-bearing rule.
    expect(body.toLowerCase()).toContain('unique');
  });
});
