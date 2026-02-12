import { describe, expect, it } from 'vitest';

import { generateIdFromPath } from '../src/resource-registry.js';

describe('generateIdFromPath', () => {
  describe('without baseDir (filename stem fallback)', () => {
    it('should generate ID from filename stem', () => {
      expect(generateIdFromPath('/project/docs/README.md')).toBe('readme');
    });

    it('should convert underscores to hyphens', () => {
      expect(generateIdFromPath('/project/API_v2.md')).toBe('api-v2');
    });

    it('should convert spaces to hyphens', () => {
      expect(generateIdFromPath('/project/User Guide.md')).toBe('user-guide');
    });

    it('should remove special characters', () => {
      expect(generateIdFromPath('/project/doc@v1.0.md')).toBe('docv10');
    });

    it('should collapse multiple hyphens', () => {
      expect(generateIdFromPath('/project/my--doc.md')).toBe('my-doc');
    });

    it('should trim leading hyphens', () => {
      expect(generateIdFromPath('/project/-prefixed.md')).toBe('prefixed');
    });

    it('should trim trailing hyphens', () => {
      expect(generateIdFromPath('/project/suffixed-.md')).toBe('suffixed');
    });

    it('should handle numeric filenames', () => {
      expect(generateIdFromPath('/project/03-overview.md')).toBe('03-overview');
    });
  });

  describe('with baseDir (relative path)', () => {
    it('should generate ID from relative path', () => {
      expect(generateIdFromPath('/project/docs/concepts/core/overview.md', '/project/docs'))
        .toBe('concepts-core-overview');
    });

    it('should handle file at baseDir root', () => {
      expect(generateIdFromPath('/project/docs/guide.md', '/project/docs'))
        .toBe('guide');
    });

    it('should handle deeply nested paths', () => {
      expect(generateIdFromPath('/project/a/b/c/d/file.md', '/project'))
        .toBe('a-b-c-d-file');
    });

    it('should convert underscores in path segments', () => {
      expect(generateIdFromPath('/project/my_dir/my_file.md', '/project'))
        .toBe('my-dir-my-file');
    });

    it('should handle spaces in directory names', () => {
      expect(generateIdFromPath('/project/My Docs/User Guide.md', '/project'))
        .toBe('my-docs-user-guide');
    });

    it('should handle numbered path segments', () => {
      expect(generateIdFromPath('/project/01-concepts/02-advanced/03-details.md', '/project'))
        .toBe('01-concepts-02-advanced-03-details');
    });
  });
});
