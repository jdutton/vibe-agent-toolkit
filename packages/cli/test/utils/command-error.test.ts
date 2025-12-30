import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDuration, handleCommandError } from '../../src/utils/command-error.js';
import type { Logger } from '../../src/utils/logger.js';

const PROCESS_EXIT_ERROR_MESSAGE = 'process.exit called';

/**
 * Helper to extract YAML output from mock stdout writes
 * writeYamlOutput calls process.stdout.write 3 times
 */
function getYamlOutput(mockStdoutWrite: ReturnType<typeof vi.spyOn>): string {
  return mockStdoutWrite.mock.calls.map((call) => call[0]).join('');
}

describe('command-error utilities', () => {
  describe('formatDuration', () => {
    it('should format milliseconds < 1000', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds >= 1000ms', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(5500)).toBe('5.5s');
      expect(formatDuration(59999)).toBe('60.0s');
    });

    it('should format minutes >= 60s', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(90000)).toBe('1.5m');
      expect(formatDuration(150000)).toBe('2.5m');
    });
  });

  describe('handleCommandError', () => {
    let mockLogger: Logger;
    let mockProcessExit: ReturnType<typeof vi.spyOn>;
    let mockStdoutWrite: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockLogger = {
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((): never => {
          throw new Error(PROCESS_EXIT_ERROR_MESSAGE);
        }) as unknown as ReturnType<typeof vi.spyOn>;
      mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
    });

    afterEach(() => {
      mockProcessExit.mockRestore();
      mockStdoutWrite.mockRestore();
    });

    it('should handle Error instances', () => {
      const error = new Error('Test error message');
      const startTime = Date.now();

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      expect(mockLogger.error).toHaveBeenCalledWith('TestCommand failed: Test error message');
      expect(mockProcessExit).toHaveBeenCalledWith(2);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain('status: error');
      expect(yamlOutput).toContain('error: Test error message');
    });

    it('should handle non-Error values', () => {
      const error = 'String error';
      const startTime = Date.now();

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      expect(mockLogger.error).toHaveBeenCalledWith('TestCommand failed: Unknown error');
      expect(mockProcessExit).toHaveBeenCalledWith(2);

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toContain('status: error');
      expect(yamlOutput).toContain('error: Unknown error');
    });

    it('should include formatted duration in output', () => {
      const error = new Error('Test error');
      const startTime = Date.now() - 1500; // 1.5 seconds ago

      expect(() => handleCommandError(error, mockLogger, startTime, 'TestCommand')).toThrow(
        PROCESS_EXIT_ERROR_MESSAGE
      );

      const yamlOutput = getYamlOutput(mockStdoutWrite);
      expect(yamlOutput).toMatch(/duration: \d+\.\d+s/);
    });
  });
});
