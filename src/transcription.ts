import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set in .env, transcription unavailable');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    logger.info(
      { model: config.model, audioBytes: audioBuffer.length },
      'Sending audio to OpenAI Whisper API',
    );

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    const result = transcription as unknown as string;
    logger.info(
      { model: config.model, transcriptLength: result?.length ?? 0 },
      'Whisper transcription complete',
    );

    return result;
  } catch (err) {
    logger.error({ err, model: config.model }, 'OpenAI Whisper transcription failed');
    return null;
  }
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 * Channel-agnostic — works with any audio source (Slack, WhatsApp, etc.).
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
): Promise<string | null> {
  if (!buffer || buffer.length === 0) return null;
  const transcript = await transcribeWithOpenAI(buffer, DEFAULT_CONFIG);
  return transcript?.trim() ?? null;
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download WhatsApp audio message');
      return config.fallbackMessage;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded WhatsApp audio message');

    const transcript = await transcribeWithOpenAI(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'WhatsApp transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
