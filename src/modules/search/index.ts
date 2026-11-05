/**
 * Search module — the host side of the `search_history` round-trip tool.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';

import { handleSearchHistory } from './handler.js';

registerDeliveryAction(
  'search_history',
  handleSearchHistory,
  // Read-only, and the one query path is hard-scoped to the calling session's
  // own agent_group_id inside searchHistory() — a group can only ever read its
  // own conversation history, and no credential or other group's data is
  // reachable through it.
  unguarded('read-only; results hard-scoped to the calling agent group'),
);
