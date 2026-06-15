/**
 * Resend (email) channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createResendAdapter } from '@resend/chat-sdk-adapter';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('resend', {
  factory: () => {
    const env = readEnvFile(['RESEND_API_KEY', 'RESEND_FROM_ADDRESS', 'RESEND_FROM_NAME', 'RESEND_WEBHOOK_SECRET']);
    if (!env.RESEND_API_KEY) return null;
    const resendAdapter = createResendAdapter({
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_ADDRESS,
      fromName: env.RESEND_FROM_NAME,
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });
    return createChatSdkBridge({ adapter: resendAdapter, concurrency: 'queue', supportsThreads: false });
  },
});
