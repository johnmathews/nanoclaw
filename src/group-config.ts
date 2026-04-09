import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface GroupConfig {
  model?: string;
  skipImageMultimodal?: boolean;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const DEFAULT_MODEL = 'claude-opus-4-6';

export function resolveModelAlias(alias: string): string {
  const trimmed = alias.trim();
  return MODEL_ALIASES[trimmed.toLowerCase()] || trimmed;
}

export function readGroupConfig(groupFolder: string): GroupConfig {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { model: DEFAULT_MODEL };
    logger.warn({ groupFolder, error: err }, 'Failed to read group config');
    return { model: DEFAULT_MODEL };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ groupFolder, error: err }, 'Invalid JSON in group config');
    return { model: DEFAULT_MODEL };
  }

  const config: GroupConfig = {};
  if (
    parsed &&
    typeof parsed === 'object' &&
    'model' in parsed &&
    typeof (parsed as Record<string, unknown>).model === 'string'
  ) {
    config.model = resolveModelAlias(
      (parsed as Record<string, unknown>).model as string,
    );
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'skipImageMultimodal' in parsed &&
    typeof (parsed as Record<string, unknown>).skipImageMultimodal === 'boolean'
  ) {
    config.skipImageMultimodal = (parsed as Record<string, unknown>)
      .skipImageMultimodal as boolean;
  }

  if (!config.model) config.model = DEFAULT_MODEL;
  return config;
}
