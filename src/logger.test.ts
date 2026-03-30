import { describe, it, expect } from 'vitest';
import { logger } from './logger.js';

describe('logger', () => {
  it('has all required log methods', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.trace).toBe('function');
  });

  it('has child() method for pino compatibility', () => {
    expect(typeof logger.child).toBe('function');
    const child = logger.child({ component: 'test' });
    expect(typeof child.debug).toBe('function');
    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
  });

  it('child loggers can be nested', () => {
    const child = logger.child({ a: 1 });
    const grandchild = child.child({ b: 2 });
    expect(typeof grandchild.info).toBe('function');
    expect(typeof grandchild.child).toBe('function');
  });

  it('has a level property', () => {
    expect(typeof logger.level).toBe('string');
  });
});
