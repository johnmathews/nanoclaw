/**
 * HTTP `/health` endpoint.
 *
 * Ported from v1 (`src/health-server.ts`). Binds 127.0.0.1 only — the
 * webhook server on 0.0.0.0:3000 is what's exposed via Funnel; `/health`
 * stays loopback (probes + `/status` command, no public surface).
 */
import http from 'http';

import type { HealthData } from './health.js';
import { log } from './log.js';

export function startHealthServer(port: number, getHealth: () => HealthData): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try {
        const data = getHealth();
        const status = data.healthy ? 200 : 503;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('Health server listening', { port });
  });

  return server;
}
