import { execFileSync } from 'child_process';
import { logger } from './logger.js';

export interface Watchdog {
  tick(): void;
  close(): void;
}

/**
 * Initialize systemd watchdog integration via systemd-notify CLI.
 * Returns null if NOTIFY_SOCKET is not set (not running under systemd watchdog).
 *
 * Uses --pid= to ensure systemd attributes the notification to the main process,
 * which is required when NotifyAccess=all is set.
 */
export function initWatchdog(): Watchdog | null {
  if (!process.env.NOTIFY_SOCKET) return null;

  const pid = String(process.pid);

  function notify(...args: string[]): void {
    try {
      execFileSync('systemd-notify', [`--pid=${pid}`, ...args], {
        timeout: 5000,
      });
    } catch (err) {
      logger.warn({ err, args }, 'systemd-notify failed');
    }
  }

  notify('--ready');
  logger.info('sd_notify: READY=1 sent');

  return {
    tick() {
      notify('WATCHDOG=1');
    },
    close() {
      notify('--stopping');
    },
  };
}
