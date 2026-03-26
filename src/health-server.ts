import http from 'http';
import type { HealthData } from './health.js';
import { logger } from './logger.js';

/**
 * Start a lightweight HTTP health endpoint.
 * GET /health → 200 (healthy) or 503 (degraded) with JSON body.
 * Binds to 127.0.0.1 only (not exposed to network).
 */
export function startHealthServer(
  port: number,
  getHealth: () => HealthData,
): http.Server {
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
    logger.info({ port }, 'Health server listening');
  });

  return server;
}
