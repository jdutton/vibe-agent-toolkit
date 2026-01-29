import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from '../../src/observability/console-logger.js';

const ERROR_MESSAGE = 'error occurred';
const ERROR_LOG_PREFIX = '[ERROR] error occurred';

/**
 * Test suite helper for ConsoleLogger tests
 * Manages spy setup/teardown to eliminate duplication
 */
function setupConsoleLoggerTests() {
  const suite = {
    logger: null as unknown as ConsoleLogger,
    errorSpy: null as unknown as ReturnType<typeof vi.spyOn>,
    warnSpy: null as unknown as ReturnType<typeof vi.spyOn>,

    beforeEach: () => {
      suite.errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      suite.warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      suite.logger = new ConsoleLogger();
    },

    afterEach: () => {
      suite.errorSpy.mockRestore();
      suite.warnSpy.mockRestore();
    },
  };

  return suite;
}

describe('ConsoleLogger', () => {
  const suite = setupConsoleLoggerTests();

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should log info messages to stderr', () => {
    suite.logger.info('test message');
    expect(suite.errorSpy).toHaveBeenCalledWith('[INFO] test message');
  });

  it('should log with context to stderr', () => {
    suite.logger.info('test', { key: 'value' });
    expect(suite.errorSpy).toHaveBeenCalledWith('[INFO] test', { key: 'value' });
  });

  it('should log errors with message only', () => {
    suite.logger.error(ERROR_MESSAGE);
    expect(suite.errorSpy).toHaveBeenCalledWith(ERROR_LOG_PREFIX);
  });

  it('should log errors with error object', () => {
    const error = new Error('test error');
    suite.logger.error(ERROR_MESSAGE, error);
    expect(suite.errorSpy).toHaveBeenCalledWith(ERROR_LOG_PREFIX, error);
  });

  it('should log errors with context only', () => {
    suite.logger.error(ERROR_MESSAGE, undefined, { userId: 123 });
    expect(suite.errorSpy).toHaveBeenCalledWith(ERROR_LOG_PREFIX, { userId: 123 });
  });

  it('should log errors with both error and context', () => {
    const error = new Error('test error');
    suite.logger.error(ERROR_MESSAGE, error, { userId: 123 });
    expect(suite.errorSpy).toHaveBeenCalledWith(ERROR_LOG_PREFIX, error, { userId: 123 });
  });

  it('should log warnings without context', () => {
    suite.logger.warn('warning message');
    expect(suite.warnSpy).toHaveBeenCalledWith('[WARN] warning message');
  });

  it('should log warnings with context', () => {
    suite.logger.warn('warning message', { code: 'WARN_001' });
    expect(suite.warnSpy).toHaveBeenCalledWith('[WARN] warning message', { code: 'WARN_001' });
  });

  it('should log debug messages without context', () => {
    suite.logger.debug('debug message');
    expect(suite.errorSpy).toHaveBeenCalledWith('[DEBUG] debug message');
  });

  it('should log debug messages with context', () => {
    suite.logger.debug('debug message', { requestId: 'abc123' });
    expect(suite.errorSpy).toHaveBeenCalledWith('[DEBUG] debug message', { requestId: 'abc123' });
  });
});
