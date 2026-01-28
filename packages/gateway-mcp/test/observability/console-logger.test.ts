import { describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from '../../src/observability/console-logger.js';

describe('ConsoleLogger', () => {
  it('should log info messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info('test message');
    expect(spy).toHaveBeenCalledWith('[INFO] test message');

    spy.mockRestore();
  });

  it('should log with context', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info('test', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[INFO] test', { key: 'value' });

    spy.mockRestore();
  });

  it('should log errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const error = new Error('test error');

    logger.error('error occurred', error);
    expect(spy).toHaveBeenCalledWith('[ERROR] error occurred', error);

    spy.mockRestore();
  });
});
