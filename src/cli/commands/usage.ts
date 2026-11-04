/**
 * `ncl usage` — Anthropic subscription rate-limit utilization.
 *
 * Wraps src/usage.ts. The same renderer also feeds the in-chat `/usage`
 * command via command-gate's `respond` branch (see src/command-gate.ts).
 *
 * Marked hidden=false / access=open so any caller (host, agent) can read it —
 * no secrets are returned, just utilization percentages. Restricting to the
 * host transport is not needed because the data is already aggregate.
 */
import { getUsageText } from '../../usage.js';
import { register } from '../registry.js';

register({
  name: 'usage',
  description: 'Show Anthropic subscription rate-limit utilization (five_hour, seven_day, ...).',
  access: 'open',
  parseArgs: () => ({}),
  handler: async () => getUsageText(),
});
