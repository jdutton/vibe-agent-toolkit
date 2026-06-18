import { describe, expect, it } from 'vitest';

import { generateIdFromPath } from '../src/resource-registry.js';

// ── Shared path constants (avoid duplicate-string lint errors) ─────────────
const PROJECT_ROOT = '/project';
const PROJECT_DOCS = '/project/docs';
const GUIDE_HTML_ID = 'guide-html';
const GUIDE_MD = '/project/guide.md';
const GUIDE_HTML = '/project/guide.html';
const GUIDE_HTM = '/project/guide.htm';
const MAKEFILE = '/project/Makefile';
const MY_CONFIG_MD = '/project/my.config.md';
const README_MD = '/project/README.md';
const USER_GUIDE_MD = '/project/User Guide.md';
const DOCS_GUIDE_MD = '/project/docs/guide.md';
const DEEP_OVERVIEW_MD = '/project/docs/concepts/core/overview.md';

describe('generateIdFromPath', () => {
  describe('without baseDir (filename stem fallback)', () => {
    it('should generate ID from filename stem with extension suffix', () => {
      expect(generateIdFromPath(README_MD)).toBe('readme-md');
    });

    it('should convert underscores to hyphens', () => {
      expect(generateIdFromPath('/project/API_v2.md')).toBe('api-v2-md');
    });

    it('should convert spaces to hyphens', () => {
      expect(generateIdFromPath(USER_GUIDE_MD)).toBe('user-guide-md');
    });

    it('should remove special characters', () => {
      expect(generateIdFromPath('/project/doc@v1.0.md')).toBe('docv10-md');
    });

    it('should collapse multiple hyphens', () => {
      expect(generateIdFromPath('/project/my--doc.md')).toBe('my-doc-md');
    });

    it('should trim leading hyphens', () => {
      expect(generateIdFromPath('/project/-prefixed.md')).toBe('prefixed-md');
    });

    it('should trim trailing hyphens from stem (ext suffix still appended)', () => {
      expect(generateIdFromPath('/project/suffixed-.md')).toBe('suffixed-md');
    });

    it('should handle numeric filenames', () => {
      expect(generateIdFromPath('/project/03-overview.md')).toBe('03-overview-md');
    });

    it('should append -html suffix for .html extension', () => {
      expect(generateIdFromPath(GUIDE_HTML)).toBe(GUIDE_HTML_ID);
    });

    it('should append -htm suffix for .htm extension', () => {
      expect(generateIdFromPath(GUIDE_HTM)).toBe('guide-htm');
    });

    it('should not append a trailing hyphen for extensionless files', () => {
      expect(generateIdFromPath(MAKEFILE)).toBe('makefile');
    });

    it('should strip interior dots before appending extension suffix', () => {
      // my.config.md: stem = 'my.config', ext = '.md'
      // stem through kebab pipeline strips the dot → 'myconfig', suffix → 'myconfig-md'
      expect(generateIdFromPath(MY_CONFIG_MD)).toBe('myconfig-md');
    });
  });

  describe('with baseDir (relative path)', () => {
    it('should generate ID from relative path with extension suffix', () => {
      expect(generateIdFromPath(DEEP_OVERVIEW_MD, PROJECT_DOCS))
        .toBe('concepts-core-overview-md');
    });

    it('should handle file at baseDir root', () => {
      expect(generateIdFromPath(DOCS_GUIDE_MD, PROJECT_DOCS))
        .toBe('guide-md');
    });

    it('should handle deeply nested paths', () => {
      expect(generateIdFromPath('/project/a/b/c/d/file.md', PROJECT_ROOT))
        .toBe('a-b-c-d-file-md');
    });

    it('should convert underscores in path segments', () => {
      expect(generateIdFromPath('/project/my_dir/my_file.md', PROJECT_ROOT))
        .toBe('my-dir-my-file-md');
    });

    it('should handle spaces in directory names', () => {
      expect(generateIdFromPath('/project/My Docs/User Guide.md', PROJECT_ROOT))
        .toBe('my-docs-user-guide-md');
    });

    it('should handle numbered path segments', () => {
      expect(generateIdFromPath('/project/01-concepts/02-advanced/03-details.md', PROJECT_ROOT))
        .toBe('01-concepts-02-advanced-03-details-md');
    });

    it('should append -html suffix for .html files under baseDir', () => {
      expect(generateIdFromPath('/project/docs/guide.html', PROJECT_DOCS))
        .toBe(GUIDE_HTML_ID);
    });
  });

  describe('canonical examples from spec', () => {
    it('guide.md → guide-md', () => {
      expect(generateIdFromPath(GUIDE_MD)).toBe('guide-md');
    });

    it('README.md → readme-md', () => {
      expect(generateIdFromPath(README_MD)).toBe('readme-md');
    });

    it('User Guide.md → user-guide-md', () => {
      expect(generateIdFromPath(USER_GUIDE_MD)).toBe('user-guide-md');
    });

    it('docs/guide.md with baseDir docs → guide-md', () => {
      expect(generateIdFromPath(DOCS_GUIDE_MD, PROJECT_DOCS)).toBe('guide-md');
    });

    it('docs/concepts/core/overview.md with baseDir docs → concepts-core-overview-md', () => {
      expect(generateIdFromPath(DEEP_OVERVIEW_MD, PROJECT_DOCS))
        .toBe('concepts-core-overview-md');
    });

    it('guide.html → guide-html', () => {
      expect(generateIdFromPath(GUIDE_HTML)).toBe(GUIDE_HTML_ID);
    });

    it('guide.htm → guide-htm', () => {
      expect(generateIdFromPath(GUIDE_HTM)).toBe('guide-htm');
    });

    it('Makefile (extensionless) → makefile (no trailing hyphen)', () => {
      expect(generateIdFromPath(MAKEFILE)).toBe('makefile');
    });

    it('my.config.md → myconfig-md', () => {
      expect(generateIdFromPath(MY_CONFIG_MD)).toBe('myconfig-md');
    });
  });
});
