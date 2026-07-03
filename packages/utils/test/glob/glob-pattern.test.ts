import { describe, expect, it } from 'vitest';

import {
  globMagicRemainder,
  isGlob,
  staticGlobBase,
} from '../../src/glob/glob-pattern.js';

/** Sentinel returned when the first path segment is glob-magic. */
const CURRENT_DIR = '.';

/** Non-glob literal path used as a non-magic input across multiple test suites. */
const PLAIN_PATH = 'foo/bar.txt';

describe('glob-pattern', () => {
  describe('isGlob', () => {
    describe('star wildcard (*)', () => {
      it('detects * in a filename', () => {
        expect(isGlob('a/b/*.mjs')).toBe(true);
      });

      it('detects ** (globstar)', () => {
        expect(isGlob('packs/**/*')).toBe(true);
      });

      it('detects standalone *', () => {
        expect(isGlob('*')).toBe(true);
      });

      it('detects * in an extension', () => {
        expect(isGlob('dist/*.js')).toBe(true);
      });
    });

    describe('question mark wildcard (?)', () => {
      it('detects ? in a filename', () => {
        expect(isGlob('x?.txt')).toBe(true);
      });

      it('detects ? mid-path', () => {
        expect(isGlob('foo/?ar.ts')).toBe(true);
      });
    });

    describe('bracket expression ([ ])', () => {
      it('detects bracket in a filename', () => {
        expect(isGlob('files[1].txt')).toBe(true);
      });

      it('detects bracket at start', () => {
        expect(isGlob('[abc].txt')).toBe(true);
      });
    });

    describe('non-glob literals', () => {
      it('returns false for a plain filename', () => {
        expect(isGlob('foo.txt')).toBe(false);
      });

      it('returns false for a plain relative path', () => {
        expect(isGlob(PLAIN_PATH)).toBe(false);
      });

      it('returns false for an absolute-style path', () => {
        expect(isGlob('/absolute/path/to/file.ts')).toBe(false);
      });

      it('returns false for a path with parent-dir references', () => {
        expect(isGlob('../mycli/dist/modules/index.js')).toBe(false);
      });

      it('returns false for empty string', () => {
        expect(isGlob('')).toBe(false);
      });
    });

    describe('escaped metacharacters', () => {
      it('treats escaped star as non-magic', () => {
        // backslash-escaped star is NOT a glob wildcard
        expect(isGlob(String.raw`foo\*.txt`)).toBe(false);
      });

      it('treats escaped ? as non-magic', () => {
        expect(isGlob(String.raw`foo\?.txt`)).toBe(false);
      });

      it('treats escaped [ as non-magic', () => {
        expect(isGlob(String.raw`foo\[1].txt`)).toBe(false);
      });

      it('unescaped star after escaped star is still magic', () => {
        // String.raw`foo\**` contains an escaped star followed by an unescaped star
        expect(isGlob(String.raw`foo\**.txt`)).toBe(true);
      });
    });
  });

  describe('staticGlobBase', () => {
    it('returns directory prefix for simple glob', () => {
      expect(staticGlobBase('a/b/*.mjs')).toBe('a/b');
    });

    it('returns multi-level prefix for globstar pattern', () => {
      expect(staticGlobBase('modules/packs/**/*')).toBe('modules/packs');
    });

    it('returns "." when first segment is magic', () => {
      expect(staticGlobBase('*.mjs')).toBe(CURRENT_DIR);
    });

    it('returns prefix for relative path with leading segments', () => {
      expect(staticGlobBase('../mycli/dist/modules/*.mjs')).toBe('../mycli/dist/modules');
    });

    it('returns whole pattern unchanged for non-glob path', () => {
      expect(staticGlobBase(PLAIN_PATH)).toBe(PLAIN_PATH);
    });

    it('returns "." for standalone * pattern', () => {
      expect(staticGlobBase('*')).toBe(CURRENT_DIR);
    });

    it('returns the absolute root "/" (not "") for a leading-slash magic-first pattern', () => {
      // '/*.mjs' splits to ['', '*.mjs']; the only static segment is the empty
      // leading one. Joining yields '' — an empty base misbehaves as a runner cwd.
      // The correct base is the absolute root '/'.
      expect(staticGlobBase('/*.mjs')).toBe('/');
    });

    it('preserves a deeper absolute static prefix', () => {
      expect(staticGlobBase('/abs/dir/*.mjs')).toBe('/abs/dir');
    });

    it('returns "." for standalone ** pattern', () => {
      expect(staticGlobBase('**/*')).toBe(CURRENT_DIR);
    });

    it('handles a single non-magic segment', () => {
      expect(staticGlobBase('foo')).toBe('foo');
    });

    it('handles deep prefix before bracket magic', () => {
      expect(staticGlobBase('a/b/c/[abc].txt')).toBe('a/b/c');
    });

    it('handles ? magic in first segment of two-segment path', () => {
      expect(staticGlobBase('fo?/bar.txt')).toBe(CURRENT_DIR);
    });

    it('handles leading dot-slash followed by glob', () => {
      // '.' and 'packs' are non-magic; '**' is the first magic segment
      expect(staticGlobBase('./packs/**')).toBe('./packs');
    });

    it('returns forward slashes on all platforms', () => {
      const result = staticGlobBase('a/b/*.mjs');
      expect(result).not.toContain('\\');
    });
  });

  describe('globMagicRemainder', () => {
    it('returns the glob portion after the static base for *.mjs', () => {
      expect(globMagicRemainder('a/b/*.mjs')).toBe('*.mjs');
    });

    it('returns the glob portion for globstar pattern', () => {
      expect(globMagicRemainder('modules/packs/**/*')).toBe('**/*');
    });

    it('returns the full pattern when base is "." (first segment is magic)', () => {
      expect(globMagicRemainder('*.mjs')).toBe('*.mjs');
    });

    it('returns glob suffix for leading ../ path', () => {
      expect(globMagicRemainder('../mycli/dist/modules/*.mjs')).toBe('*.mjs');
    });

    it('returns the magic suffix for a leading-slash magic-first pattern (root base)', () => {
      // base is '/' — the leading slash IS the base, so only it is stripped.
      expect(globMagicRemainder('/*.mjs')).toBe('*.mjs');
    });

    it('returns the magic suffix for a deeper absolute pattern', () => {
      expect(globMagicRemainder('/abs/dir/*.mjs')).toBe('*.mjs');
    });

    it('returns ** for bare globstar', () => {
      expect(globMagicRemainder('a/b/**')).toBe('**');
    });

    it('returns nested glob for deep magic', () => {
      expect(globMagicRemainder('src/**/*.test.ts')).toBe('**/*.test.ts');
    });

    it('returns forward slashes on all platforms', () => {
      const result = globMagicRemainder('a/b/*.mjs');
      expect(result).not.toContain('\\');
    });
  });
});
