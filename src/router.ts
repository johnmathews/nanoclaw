import type { Reaction } from './db.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a list of reactions compactly, grouped by emoji.
 * e.g. "👍 Alice, Bob; ❤️ Carol"
 */
function formatReactionAnnotation(reactions: Reaction[]): string {
  // Group by emoji, preserving insertion order
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) {
    const name = r.reactor_name || r.reactor_jid.split('@')[0];
    const names = byEmoji.get(r.emoji);
    if (names) {
      names.push(name);
    } else {
      byEmoji.set(r.emoji, [name]);
    }
  }
  const parts: string[] = [];
  for (const [emoji, names] of byEmoji) {
    parts.push(`${emoji} ${names.map((n) => escapeXml(n)).join(', ')}`);
  }
  return parts.join('; ');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  reactions?: Map<string, Reaction[]>,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const msgReactions = reactions?.get(m.id);
    const reactionSuffix =
      msgReactions && msgReactions.length > 0
        ? `\n  <reactions>${formatReactionAnnotation(msgReactions)}</reactions>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}${reactionSuffix}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
