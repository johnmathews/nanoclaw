/**
 * OneCLI agent-identifier sanitization.
 *
 * OneCLI's `POST /api/agents` requires the identifier to be 1-50 chars, start
 * with a *letter*, and contain only lowercase letters, numbers, and hyphens.
 *
 * We use the agent group id as the identifier. Group ids are lowercase and
 * hyphenated (UUIDs, or legacy `ag-<ts>-<rand>`), so the charset and length are
 * always fine — but a raw UUID starts with a digit ~62% of the time, and OneCLI
 * rejects those with `400 Bad Request`, which silently blocks the container from
 * spawning. Prefix digit-leading ids with `oc-`.
 *
 * The transform must be reversible: approval routing maps a OneCLI agent's
 * identifier back to a group via `getAgentGroup(externalId)`
 * (`modules/approvals/onecli-approvals.ts`). The `oc-` prefix is unambiguous —
 * no UUID (hex-leading) and no `ag-` id starts with `oc-` — so stripping it
 * round-trips cleanly without colliding with any real group id.
 */
const PREFIX = 'oc-';

/** Group id → OneCLI-valid agent identifier (letter-leading). */
export function toOneCliIdentifier(groupId: string): string {
  return /^[a-z]/.test(groupId) ? groupId : PREFIX + groupId;
}

/** OneCLI agent identifier → original group id (inverse of toOneCliIdentifier). */
export function fromOneCliIdentifier(identifier: string): string {
  return identifier.startsWith(PREFIX) ? identifier.slice(PREFIX.length) : identifier;
}
