/**
 * Unit tests for common.ts utilities
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  buildJscpdArgs,
  getDirname,
  getFilename,
  isEntrypoint,
  JSCPD_CONFIG,
} from '../src/common.js';

describe('buildJscpdArgs', () => {
  it('should build jscpd arguments with default output directory', () => {
    const args = buildJscpdArgs();

    expect(args).toContain('.');
    expect(args).toContain('--min-lines');
    expect(args).toContain(JSCPD_CONFIG.MIN_LINES);
    expect(args).toContain('--min-tokens');
    expect(args).toContain(JSCPD_CONFIG.MIN_TOKENS);
    expect(args).toContain('--reporters');
    expect(args).toContain('json');
    expect(args).toContain('--format');
    expect(args).toContain(JSCPD_CONFIG.FORMATS);
    expect(args).toContain('--ignore');
    expect(args).toContain(JSCPD_CONFIG.IGNORE_PATTERNS);
    expect(args).toContain('--output');
    expect(args).toContain(JSCPD_CONFIG.OUTPUT_DIR);
  });

  it('should build jscpd arguments with custom output directory', () => {
    const customDir = 'custom-output';
    const args = buildJscpdArgs(customDir);

    expect(args).toContain('--output');
    expect(args).toContain(customDir);
    expect(args).not.toContain(JSCPD_CONFIG.OUTPUT_DIR);
  });

  it('should include all required jscpd configuration', () => {
    const args = buildJscpdArgs();

    // Verify all key configuration options are present
    expect(args).toEqual([
      '.',
      '--min-lines', JSCPD_CONFIG.MIN_LINES,
      '--min-tokens', JSCPD_CONFIG.MIN_TOKENS,
      '--reporters', 'json',
      '--format', JSCPD_CONFIG.FORMATS,
      '--ignore', JSCPD_CONFIG.IGNORE_PATTERNS,
      '--output', JSCPD_CONFIG.OUTPUT_DIR,
    ]);
  });
});

describe('JSCPD_CONFIG', () => {
  it('should have expected configuration values', () => {
    expect(JSCPD_CONFIG.MIN_LINES).toBe('5');
    expect(JSCPD_CONFIG.MIN_TOKENS).toBe('50');
    expect(JSCPD_CONFIG.FORMATS).toBe('typescript,javascript');
    expect(JSCPD_CONFIG.OUTPUT_DIR).toBe('jscpd-report');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('node_modules');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('dist');
    expect(JSCPD_CONFIG.IGNORE_PATTERNS).toContain('coverage');
  });
});

/**
 * `isEntrypoint` exists because `import.meta.main` is NOT available on the Node
 * version this repo declares as its floor.
 *
 * Measured, on the exact version `.github/workflows/node-floor.yml` installs:
 *
 * ```
 * $ node-v22.13.0 --input-type=module -e "console.log(import.meta.main)"  -> undefined
 * $ node-v24.13.1 --input-type=module -e "console.log(import.meta.main)"  -> true
 * ```
 *
 * `import.meta.main` shipped in Node 24.2 / 22.18. Every `if (import.meta.main)`
 * guard in this package was therefore dead on the declared floor. Running
 * `validate-repo-structure.ts` under a real 22.13.0 produced ZERO lines of
 * output and exit 0, so a contributor sitting exactly on the supported floor got
 * a green pre-commit structure gate that had checked nothing — while the same
 * file, imported and called directly under the SAME interpreter, printed its
 * full report. It was the guard, not the transpile.
 *
 * ⛔ Do not "fix" a recurrence by raising the floor. That hides the defect
 * behind the number the defect is about.
 */
describe('isEntrypoint', () => {
  const HERE = getFilename(import.meta.url);
  const SIBLING = safePath.join(getDirname(import.meta.url), 'not-this-file.ts');

  it('is true when argv[1] is this module', () => {
    expect(isEntrypoint(import.meta.url, HERE)).toBe(true);
  });

  it('is true when argv[1] names this module by a relative path', () => {
    expect(isEntrypoint(import.meta.url, safePath.relative(process.cwd(), HERE))).toBe(true);
  });

  it('is false when argv[1] is a different module', () => {
    expect(isEntrypoint(import.meta.url, SIBLING)).toBe(false);
  });

  it('is false when argv[1] is a test runner, which is how an imported module sees it', () => {
    expect(isEntrypoint(import.meta.url, safePath.join(process.cwd(), 'node_modules/vitest/vitest.mjs'))).toBe(false);
  });

  it('is false when there is no argv[1] at all, as under `node -e`', () => {
    const argv = process.argv;
    try {
      process.argv = [argv[0] ?? 'node'];
      expect(isEntrypoint(import.meta.url)).toBe(false);
    } finally {
      process.argv = argv;
    }
  });

  it('is false for an empty argv[1] rather than resolving it to the cwd', () => {
    expect(isEntrypoint(import.meta.url, '')).toBe(false);
  });

  it('reads argv[1] by default, so an imported module is never the entrypoint', () => {
    // Vitest's argv[1] is the runner, never this file — the property every
    // `if (import.meta.main)` guard in src/ is actually relying on.
    expect(isEntrypoint(import.meta.url)).toBe(false);
  });
});
