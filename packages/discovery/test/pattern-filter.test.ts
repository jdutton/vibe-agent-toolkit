import { describe, it, expect } from 'vitest';

import { createPatternFilter } from '../src/filters/pattern-filter.js';

describe('createPatternFilter', () => {
  describe('include patterns', () => {
    it('should include files matching pattern', () => {
      const filter = createPatternFilter({ include: ['*.md'] });

      expect(filter('test.md')).toBe(true);
      expect(filter('docs/guide.md')).toBe(true);
      expect(filter('test.ts')).toBe(false);
    });

    it('should support glob patterns', () => {
      const filter = createPatternFilter({ include: ['**/*.test.ts'] });

      expect(filter('src/utils.test.ts')).toBe(true);
      expect(filter('test/unit/parser.test.ts')).toBe(true);
      expect(filter('src/utils.ts')).toBe(false);
    });

    it('should support multiple include patterns', () => {
      const filter = createPatternFilter({
        include: ['*.md', '*.yaml']
      });

      expect(filter('README.md')).toBe(true);
      expect(filter('config.yaml')).toBe(true);
      expect(filter('index.ts')).toBe(false);
    });
  });

  describe('exclude patterns', () => {
    it('should exclude files matching pattern', () => {
      const filter = createPatternFilter({ exclude: ['node_modules'] });

      expect(filter('node_modules/pkg/index.js')).toBe(false);
      expect(filter('src/index.ts')).toBe(true);
    });

    it('should support glob patterns', () => {
      const filter = createPatternFilter({
        exclude: ['**/dist/**', '**/*.test.ts']
      });

      expect(filter('packages/cli/dist/index.js')).toBe(false);
      expect(filter('src/utils.test.ts')).toBe(false);
      expect(filter('src/utils.ts')).toBe(true);
    });
  });

  describe('include + exclude patterns', () => {
    it('should apply exclude after include', () => {
      const filter = createPatternFilter({
        include: ['**/*.md'],
        exclude: ['**/node_modules/**'],
      });

      expect(filter('README.md')).toBe(true);
      expect(filter('docs/guide.md')).toBe(true);
      expect(filter('node_modules/pkg/README.md')).toBe(false);
    });
  });

  describe('no patterns', () => {
    it('should include all files when no patterns specified', () => {
      const filter = createPatternFilter({});

      expect(filter('any-file.txt')).toBe(true);
      expect(filter('path/to/file.js')).toBe(true);
    });
  });
});
