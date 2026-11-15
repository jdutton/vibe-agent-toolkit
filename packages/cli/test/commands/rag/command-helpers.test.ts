import { describe, expect, it } from 'vitest';

import { resolveDbPath } from '../../../src/commands/rag/command-helpers.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';

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

    it('refuses the missing --db as the invocation\'s mistake (USAGE_INVALID), not a VAT defect', () => {
      let thrown: unknown;
      try {
        resolveDbPath(undefined, undefined);
      } catch (error) {
        thrown = error;
      }
      expect(refusalCodeOf(thrown)).toBe('USAGE_INVALID');
    });
  });

});
