/**
 * Delivery-error taxonomy.
 *
 * The classification decides whether a message is retried forever, retried a
 * bounded number of times, or given up on — so a misclassification either
 * buries a good message (treating an offline channel as permanent) or hammers
 * a platform API forever (treating a bad scope as transient).
 */
import { describe, expect, it } from 'vitest';

import { ChannelDisconnectedError, PermanentDeliveryError, classifyDeliveryError } from './delivery-errors.js';
import { MissingChannelAdapterError } from './channel-registry.js';

describe('classifyDeliveryError', () => {
  it('classifies the explicit error types', () => {
    expect(classifyDeliveryError(new ChannelDisconnectedError('socket down'))).toBe('disconnected');
    expect(classifyDeliveryError(new PermanentDeliveryError('bad scope', 'missing_scope'))).toBe('permanent');
  });

  it('leaves a missing adapter on the bounded retry path', () => {
    // Deliberately NOT 'disconnected'. An unregistered adapter means a factory
    // returned null at startup (missing credentials), which is a configuration
    // fault that must surface as a failure rather than defer forever behind a
    // growing queue — upstream's decision, with its own regression test
    // (delivery.test.ts "#2995"). Asserted here so a future reclassification
    // has to confront it.
    expect(classifyDeliveryError(new MissingChannelAdapterError('slack'))).toBe('transient');
  });

  it('recognizes known-permanent platform codes inside a plain Error', () => {
    // Adapters surface platform failures as Errors embedding the platform's
    // own code, e.g. Slack's "An API error occurred: missing_scope".
    for (const code of ['missing_scope', 'channel_not_found', 'message_not_found', 'is_archived', 'msg_too_long']) {
      expect(classifyDeliveryError(new Error(`An API error occurred: ${code}`)), code).toBe('permanent');
    }
  });

  it('matches those codes case-insensitively', () => {
    expect(classifyDeliveryError(new Error('MISSING_SCOPE'))).toBe('permanent');
  });

  it('defaults to transient for anything else', () => {
    expect(classifyDeliveryError(new Error('socket hang up'))).toBe('transient');
    expect(classifyDeliveryError(new Error('503 Service Unavailable'))).toBe('transient');
    expect(classifyDeliveryError('a bare string')).toBe('transient');
    expect(classifyDeliveryError(undefined)).toBe('transient');
  });

  it('carries a machine-readable reason on a permanent error', () => {
    const err = new PermanentDeliveryError('no such channel', 'channel_not_found');
    expect(err.reason).toBe('channel_not_found');
    expect(err.name).toBe('PermanentDeliveryError');
  });
});
