import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import { createLogger } from '../../src/utils/logger.js';

describe('createLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('should write info messages to stderr', () => {
    const logger = createLogger();
    logger.info('test message');
    expect(stderrSpy).toHaveBeenCalledWith('test message\n');
  });

  it('should write error messages to stderr', () => {
    const logger = createLogger();
    logger.error('error message');
    expect(stderrSpy).toHaveBeenCalledWith('error message\n');
  });

  it('should write debug messages only when debug enabled', () => {
    const logger = createLogger({ debug: true });
    logger.debug('debug message');
    expect(stderrSpy).toHaveBeenCalledWith('[DEBUG] debug message\n');
  });

  it('should not write debug messages when debug disabled', () => {
    const logger = createLogger({ debug: false });
    logger.debug('debug message');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
