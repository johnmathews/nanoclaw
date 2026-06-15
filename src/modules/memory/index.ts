/**
 * Memory module — the budgeted `remember` tool (learning & memory feature #1).
 *
 * Registers one delivery action: `remember`. The container's remember MCP tool
 * (container/agent-runner/src/mcp-tools/remember.ts) writes a `remember` system
 * message and polls for the reply; the host applies the edit to the group's
 * MEMORY.md / USER.md, enforces the per-group char budget, recomposes CLAUDE.md,
 * and writes the response back to inbound.db.
 *
 * Budget columns live on container_configs (migration 021); MEMORY.md/USER.md
 * are injected as frozen snapshots by src/claude-md-compose.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleRemember } from './actions.js';

registerDeliveryAction('remember', handleRemember);
