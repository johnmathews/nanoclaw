/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /**
   * Extra environment variables injected into the container as `-e` flags at
   * spawn time. Reserved keys (TZ/HOME/proxy/cert) are filtered by the runner
   * so this can never clobber the OneCLI credential proxy. See migration 019.
   */
  env?: Record<string, string>;
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}

/**
 * Env keys an operator may NOT set via per-group `config.env`. These are wired
 * by the host (TZ, HOME) or the OneCLI credential gateway (HTTPS_PROXY + CA
 * certs); letting a per-group entry override them could silently route the
 * agent's API calls around the credential proxy. Matched case-insensitively,
 * with prefix matching for the proxy family.
 */
// The proxy/cert vars node + curl read to route the container's *own* network
// + TLS trust. Overriding these could send the agent's API traffic around the
// OneCLI credential proxy, so they're rejected. Matched by exact name — NOT by
// substring — so namespaced tool vars like AGENT_BROWSER_PROXY (which only
// proxies the in-tool browser, e.g. to route research browsing through a VPN)
// remain settable.
const RESERVED_ENV_EXACT = new Set([
  'TZ',
  'HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
]);
const RESERVED_ENV_SUBSTRINGS = ['CURL_CA', 'REQUESTS_CA'];

export function isReservedContainerEnv(key: string): boolean {
  const upper = key.toUpperCase();
  if (RESERVED_ENV_EXACT.has(upper)) return true;
  return RESERVED_ENV_SUBSTRINGS.some((s) => upper.includes(s));
}

/**
 * Build `docker run` `-e` flags from a per-group env map, skipping reserved
 * keys (returned separately so the caller can warn). Pure + side-effect free
 * so it can be unit-tested without spawning a container.
 */
export function containerEnvArgs(env: Record<string, string> | undefined): {
  args: string[];
  skipped: string[];
} {
  const args: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isReservedContainerEnv(key)) {
      skipped.push(key);
      continue;
    }
    args.push('-e', `${key}=${value}`);
  }
  return { args, skipped };
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    env: JSON.parse(row.env ?? '{}') as Record<string, string>,
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
