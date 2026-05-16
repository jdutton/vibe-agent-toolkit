/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, resolveAssetReference, safePath, toForwardSlash } from '../src/index.js';

const REPO_ROOT = safePath.resolve(import.meta.dirname, '..', '..', '..');
const PACKAGE_JSON = 'package.json';
const MISSING_PKG_SPECIFIER = '@nonexistent/never-published/schemas/foo.json';
const FIXTURE_PKG_SPECIFIER = '@vat-test/missing-file-mock/schemas/foo.json';

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
        resolveAssetReference(MISSING_PKG_SPECIFIER, REPO_ROOT);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(MISSING_PKG_SPECIFIER);
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

    it('error message distinguishes "package not installed" from generic failures', () => {
      let err: unknown;
      try {
        resolveAssetReference(MISSING_PKG_SPECIFIER, REPO_ROOT);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // Headline still names the specifier
      expect(message).toContain(MISSING_PKG_SPECIFIER);
      // For Mode 3 (package missing) we point adopters at install / exports
      expect(message).toMatch(/run install|"exports" field/);
    });

    it('error message for ERR_PACKAGE_PATH_NOT_EXPORTED names the exports map', () => {
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
      const message = (err as Error).message;
      const cause = (err as { cause?: { code?: string } }).cause;
      // Only assert the improved wording when Node actually reports
      // ERR_PACKAGE_PATH_NOT_EXPORTED (some Node versions emit MODULE_NOT_FOUND).
      if (cause?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        expect(message).toContain('does not expose this subpath');
      }
    });

    // Mode 1 (exports map → file missing on disk) — the most confusing
    // failure for adopters and the one that motivated the actionable-error
    // refactor. Inline tmp fixture to exercise the branch under the unit-
    // test coverage glob (the integration test covers the same path but
    // doesn't count toward patch coverage).
    describe('exports map resolves but target file is missing on disk', () => {
      let fixtureDir: string;

      beforeAll(() => {
        fixtureDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-asset-mode1-'));
        // Consumer package.json — anchors createRequire lookup
        writeFileSync(
          safePath.join(fixtureDir, PACKAGE_JSON),
          JSON.stringify({ name: 'consumer', type: 'module' }),
        );
        // Synthetic package: exports map points at dist/schemas/*.json, but
        // we deliberately do NOT write any files into dist/schemas (mirrors
        // a publisher whose build step never ran).
        const pkgDir = safePath.join(fixtureDir, 'node_modules', '@vat-test', 'missing-file-mock');
        mkdirSyncReal(safePath.join(pkgDir, 'dist', 'schemas'), { recursive: true });
        writeFileSync(
          safePath.join(pkgDir, PACKAGE_JSON),
          JSON.stringify({
            name: '@vat-test/missing-file-mock',
            version: '0.0.0',
            type: 'module',
            exports: { './schemas/*.json': './dist/schemas/*.json' },
          }),
        );
      });

      afterAll(() => {
        rmSync(fixtureDir, { recursive: true, force: true });
      });

      it('error message names the missing file and points at the publisher build', () => {
        let err: unknown;
        try {
          resolveAssetReference(FIXTURE_PKG_SPECIFIER, fixtureDir);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        // Names the original specifier so adopters can find the offending config line
        expect(message).toContain(FIXTURE_PKG_SPECIFIER);
        // Names the resolved on-disk path so adopters can verify it's missing
        expect(toForwardSlash(message)).toMatch(/dist\/schemas\/foo\.json/);
        // Explains that the file is missing on disk
        expect(message).toMatch(/does not exist on disk/);
        // Points at the publisher's build, not the consumer's install
        expect(message).toMatch(/Rebuild|build step|"exports" subpath/);
        // Does NOT push the user toward running install in baseDir
        expect(message).not.toMatch(/run install in/);
      });
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
