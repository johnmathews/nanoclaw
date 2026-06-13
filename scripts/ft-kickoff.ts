/**
 * One-off: kick off the #financial-times agent via the CLI socket.
 * Tells it to (1) schedule the recurring daily 08:00 digest task and
 * (2) run the digest once now as a setup verification.
 */
import net from 'net';
import path from 'path';
import { DATA_DIR } from '../src/config.js';

const PLATFORM_ID = 'slack:C0B9WUU7D7H'; // #financial-times
const SENDER_ID = 'slack:U0AMGE1SNGY'; // John

const TEXT = [
  'System instruction (setup re-run): Your FT reading method has been corrected.',
  'The Bypass Paywalls Clean extension does NOT crack FT article bodies directly — read each article body via archive.today instead, as now documented in /workspace/agent/CLAUDE.local.md and /workspace/agent/tasks/ft-summary.md.',
  '',
  'Re-read BOTH files, then run the digest once NOW following tasks/ft-summary.md end to end:',
  '- Discover headlines + article URLs on ft.com (front page + relevant sections).',
  '- For each kept item, read the FULL body via `agent-browser open "https://archive.ph/newest/<the ft.com article URL>"` (reload once if it is not readable on first load).',
  '- Write bullets from the actual article body (real numbers/names/argument), not just the headline.',
  '- Post ONE digest to this channel.',
  '',
  'The daily 08:00 task is ALREADY scheduled — do NOT schedule another. End your turn after posting, no extra chatter.',
].join('\n');

async function main(): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      err ? reject(err) : resolve();
    };
    socket.once('error', (err) =>
      settle(new Error(`CLI socket at ${sockPath} not reachable: ${err.message}`)),
    );
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text: TEXT,
          senderId: SENDER_ID,
          sender: 'John',
          to: { channelType: 'slack', platformId: PLATFORM_ID, threadId: PLATFORM_ID },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) return settle(err);
        setTimeout(() => settle(null), 100);
      });
    });
  });
  console.log('Kickoff message delivered to #financial-times session.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
