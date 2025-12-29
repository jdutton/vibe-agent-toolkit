import { describe, expect, it } from 'vitest';

import { formatDuration } from '../../src/utils/command-error.js';

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
});
