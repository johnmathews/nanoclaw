/**
 * systemd watchdog integration via the systemd-notify CLI.
 *
 * Ported from v1 (`src/watchdog.ts`). Returns null when NOTIFY_SOCKET is
 * absent (Type=simple unit, dev mode) so the code path is a no-op rather
 * than an error. Uses --pid= so systemd attributes the notification to the
 * main process (required when NotifyAccess=all is set).
 */
import { execFileSync } from 'child_process';

import { log } from './log.js';

export interface Watchdog {
  tick(): void;
  close(): void;
}

export function initWatchdog(): Watchdog | null {
  if (!process.env.NOTIFY_SOCKET) return null;

  const pid = String(process.pid);

  function notify(...args: string[]): void {
    try {
      execFileSync('systemd-notify', [`--pid=${pid}`, ...args], {
        timeout: 5000,
      });
    } catch (err) {
      log.warn('systemd-notify failed', { err, args });
    }
  }

  notify('--ready');
  log.info('sd_notify: READY=1 sent');

  return {
    tick() {
      notify('WATCHDOG=1');
    },
    close() {
      notify('--stopping');
    },
  };
}
