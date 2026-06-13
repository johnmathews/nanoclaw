import type { ContainerConfigRow } from '../types.js';
import { getDb } from './connection.js';

/**
 * Default model for new agent groups. Quality > speed: every group gets the
 * top Opus tier unless the operator explicitly sets `model` via
 * `ncl groups config update` or the self-mod tooling. NULL is no longer a
 * valid state — leaving model unset would silently fall back to the SDK's
 * default (currently a Sonnet variant), which we don't want.
 */
export const DEFAULT_MODEL = 'claude-opus-4-7';

/** Default per-group memory budgets (chars). Hermes-proven; mirror migration 021. */
export const DEFAULT_MEMORY_BUDGET = 2200;
export const DEFAULT_USER_BUDGET = 1375;

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  'memory_budget_chars',
  'user_budget_chars',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts', 'env']);

export function getContainerConfig(agentGroupId: string): ContainerConfigRow | undefined {
  return getDb().prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
    | ContainerConfigRow
    | undefined;
}

export function getAllContainerConfigs(): ContainerConfigRow[] {
  return getDb().prepare('SELECT * FROM container_configs').all() as ContainerConfigRow[];
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export function createContainerConfig(config: ContainerConfigRow): void {
  getDb()
    .prepare(
      `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, env, memory_budget_chars, user_budget_chars, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @env, @memory_budget_chars, @user_budget_chars, @updated_at
      )`,
    )
    .run(config);
}

/** Create an empty config row with sensible defaults. Idempotent — no-ops if row exists. */
export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, model, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(agentGroupId, DEFAULT_MODEL, new Date().toISOString());
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'memory_budget_chars'
      | 'user_budget_chars'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  getDb()
    .prepare(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`)
    .run(values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts, env. */
export function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts' | 'env',
  value: unknown,
): void {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`)
    .run(JSON.stringify(value), now, agentGroupId);
}

export function deleteContainerConfig(agentGroupId: string): void {
  getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(agentGroupId);
}
