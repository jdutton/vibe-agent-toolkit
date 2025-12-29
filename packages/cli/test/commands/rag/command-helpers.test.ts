import { describe, expect, it } from 'vitest';

import { resolveDbPath, formatDuration } from '../../../src/commands/rag/command-helpers.js';

describe('RAG command helpers', () => {
  describe('resolveDbPath', () => {
    it('should return explicit db path when provided', () => {
      const result = resolveDbPath('./my-db', undefined);
      expect(result).toBe('./my-db');
    });

    it('should return default path when no db specified', () => {
      const result = resolveDbPath(undefined, './project');
      expect(result).toBe('./project/.rag-db');
    });

    it('should throw when no db and no project root', () => {
      expect(() => resolveDbPath(undefined, undefined)).toThrow(
        'No database path specified and no project root found'
      );
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds < 1000', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds >= 1000ms', () => {
      expect(formatDuration(1500)).toBe('1.5s');
    });

    it('should format minutes >= 60s', () => {
      expect(formatDuration(90000)).toBe('1.5m');
    });
  });
});
