import { describe, expect, it } from 'vitest';

import { resolveAssetReference, safePath, toForwardSlash } from '../src/index.js';

const REPO_ROOT = safePath.resolve(import.meta.dirname, '..', '..', '..');
const PACKAGE_JSON = 'package.json';

describe('resolveAssetReference', () => {
  describe('bare specifiers', () => {
    it('resolves a scoped package + subpath via exports map', () => {
      const resolved = resolveAssetReference(
        '@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json',
        REPO_ROOT,
      );
      expect(toForwardSlash(resolved)).toMatch(/agent-skills\/schemas\/skill-frontmatter\.json$/);
    });

    it('throws MODULE_NOT_FOUND when package is not installed', () => {
      let err: unknown;
      try {
        resolveAssetReference('@nonexistent/never-published/schemas/foo.json', REPO_ROOT);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('@nonexistent/never-published/schemas/foo.json');
      const cause = (err as { cause?: { code?: string } }).cause;
      expect(cause?.code).toBe('MODULE_NOT_FOUND');
    });

    it('throws ERR_PACKAGE_PATH_NOT_EXPORTED when subpath is not in exports', () => {
      let err: unknown;
      try {
        resolveAssetReference(
          '@vibe-agent-toolkit/agent-skills/this-subpath-is-not-exported.json',
          REPO_ROOT,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const cause = (err as { cause?: { code?: string } }).cause;
      // Node 22+ emits ERR_PACKAGE_PATH_NOT_EXPORTED for these
      expect(cause?.code).toMatch(/PATH_NOT_EXPORTED|MODULE_NOT_FOUND/);
    });
  });

  describe('paths', () => {
    it('resolves an absolute path unchanged', () => {
      const abs = safePath.resolve(REPO_ROOT, PACKAGE_JSON);
      expect(resolveAssetReference(abs, REPO_ROOT)).toBe(abs);
    });

    it('resolves a relative path against baseDir', () => {
      expect(toForwardSlash(resolveAssetReference('./package.json', REPO_ROOT))).toBe(
        toForwardSlash(safePath.resolve(REPO_ROOT, PACKAGE_JSON)),
      );
    });

    it('treats a single-segment value (no subpath) as a path', () => {
      // "foo.json" is ambiguous; default to filesystem-path semantics.
      expect(toForwardSlash(resolveAssetReference(PACKAGE_JSON, REPO_ROOT))).toBe(
        toForwardSlash(safePath.resolve(REPO_ROOT, PACKAGE_JSON)),
      );
    });

    it('falls back to path resolution for an unscoped bare specifier that does not resolve', () => {
      // No installed package "made-up-package"; treat the value as a relative path.
      expect(toForwardSlash(resolveAssetReference('made-up-package/foo.json', REPO_ROOT))).toBe(
        toForwardSlash(safePath.resolve(REPO_ROOT, 'made-up-package/foo.json')),
      );
    });
  });
});
