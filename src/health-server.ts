/**
 * HTTP `/health` endpoint.
 *
 * Ported from v1 (`src/health-server.ts`). Binds 127.0.0.1 only — the
 * webhook server (loopback :3000 by default, forwarded by Funnel) is the public one; `/health`
 * stays loopback (probes + `/status` command, no public surface).
 */
import http from 'http';

import type { HealthData } from './health.js';
import { log } from './log.js';

export function startHealthServer(port: number, getHealth: () => HealthData | Promise<HealthData>): http.Server {
  // The handler is async (snapshotHealth awaits the DbDriver) and catches
  // everything itself, so the void wrapper drops a promise that never rejects.
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/health') {
      try {
        // snapshotHealth is async since the DbDriver port (stage 4c).
        const data = await getHealth();
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
  };
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  // A bind failure (port taken) must not crash the host: without a listener,
  // 'error' is thrown as an uncaught exception and takes messaging down with
  // a loopback-only diagnostics endpoint.
  server.on('error', (err) => {
    log.error('Health server failed', { port, err });
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('Health server listening', { port });
  });

  return server;
}
