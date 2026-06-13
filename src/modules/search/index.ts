/**
 * Search module — the `search_history` tool (learning & memory feature #2).
 *
 * Registers one delivery action: `search_history`. The container's
 * search_history MCP tool (container/agent-runner/src/mcp-tools/search_history.ts)
 * writes a `search_history` system message and polls for the reply; the host
 * runs the FTS5 query scoped to the session's agent group and writes the
 * results back to inbound.db.
 *
 * The index itself (data/v2-index.db) is populated incrementally in the 60s
 * host sweep (src/search-index.ts) and queried only through the searchHistory
 * chokepoint in src/db/search-index-db.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleSearchHistory } from './handler.js';

registerDeliveryAction('search_history', handleSearchHistory);
