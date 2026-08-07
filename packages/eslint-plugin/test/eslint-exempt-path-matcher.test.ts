/**
 * Tests for the shared exemption matcher used by the local ESLint rule factories.
 *
 * Both factories previously exempted files with `filename.includes('path-utils.ts')`.
 * A bare substring means ANY file in this repo — or in a consumer repo running a
 * fork of these rules — whose path merely CONTAINS the string silently opts out.
 * A private `tools/hooks/path-utils.ts` calling raw `tmpdir()` linted clean.
 *
 * The matcher must therefore anchor at a path-segment boundary, and must do so on
 * forward slashes: a rule pack whose entire purpose is cross-platform path handling
 * must not itself be `\` vs `/` dependent.
 */

import { describe, expect, it } from 'vitest';

import { loadLocalRuleModule } from './eslint-rule-test-harness.js';

interface ExemptPathMatcherModule {
  createExemptPathMatcher(exemptPaths: readonly string[]): (filename: string) => boolean;
  createExemptDirectoryMatcher(exemptDirs: readonly string[]): (filename: string) => boolean;
  isTestFile(filename: string): boolean;
}

const { createExemptPathMatcher, createExemptDirectoryMatcher, isTestFile } =
  loadLocalRuleModule<ExemptPathMatcherModule>('exempt-path-matcher.cjs');

const PATH_CORE = 'packages/utils/src/path-core.ts';
const PATH_UTILS = 'packages/utils/src/path-utils.ts';
const EXEMPT_PATHS = [PATH_CORE, PATH_UTILS];

describe('createExemptPathMatcher', () => {
  const isExempt = createExemptPathMatcher(EXEMPT_PATHS);

  it('matches an exact repo-relative path', () => {
    expect(isExempt(PATH_CORE)).toBe(true);
    expect(isExempt(PATH_UTILS)).toBe(true);
  });

  it('matches an absolute path ending at a segment boundary', () => {
    expect(isExempt(`/Users/dev/work/vat/${PATH_CORE}`)).toBe(true);
  });

  it('matches a backslash-separated (Windows) path', () => {
    expect(isExempt(String.raw`C:\work\vat\packages\utils\src\path-utils.ts`)).toBe(true);
  });

  it('tolerates a leading ./ on either side', () => {
    expect(createExemptPathMatcher([`./${PATH_CORE}`])(PATH_CORE)).toBe(true);
    expect(isExempt(`./${PATH_CORE}`)).toBe(true);
  });

  it('does NOT match a decoy with the same basename in another directory', () => {
    // The exact shape that shipped a raw-tmpdir() file past the linter in a
    // consumer repo running a fork of these rules.
    expect(isExempt('tools/hooks/path-utils.ts')).toBe(false);
    expect(isExempt('packages/other/src/path-core.ts')).toBe(false);
    expect(isExempt('packages/utils/dist/path-core.ts')).toBe(false);
    expect(isExempt('/Users/dev/work/vat/tools/hooks/path-utils.ts')).toBe(false);
  });

  it('does NOT match when the exempt string appears mid-segment', () => {
    expect(isExempt('packages/utils/src/my-path-utils.ts')).toBe(false);
    expect(isExempt('packages/resources/src/types/resource-path-utils.ts')).toBe(false);
  });

  it('does NOT match when the exempt path is only a prefix of the filename', () => {
    expect(isExempt(`${PATH_UTILS}.bak`)).toBe(false);
    expect(isExempt(`${PATH_CORE}/index.ts`)).toBe(false);
  });

  it('does NOT match a directory boundary faked by a longer segment name', () => {
    expect(isExempt('vendor/copy-packages/utils/src/path-utils.ts')).toBe(false);
  });

  it('does NOT match ESLint placeholder or empty filenames', () => {
    expect(isExempt('<input>')).toBe(false);
    expect(isExempt('')).toBe(false);
  });

  it('never matches when the exempt list is empty', () => {
    const matchNothing = createExemptPathMatcher([]);
    expect(matchNothing(PATH_CORE)).toBe(false);
  });
});

describe('createExemptDirectoryMatcher', () => {
  // `no-command-direct-factory` exempts the package that OWNS the centralized
  // wrapper, so the exemption is a directory, not a file. It used to be spelled
  // `filename.includes('packages/git/')`.
  const isExempt = createExemptDirectoryMatcher(['packages/git/']);

  it('matches any file under the exempt directory', () => {
    expect(isExempt('packages/git/src/index.ts')).toBe(true);
    expect(isExempt('packages/git/src/nested/deep/exec.ts')).toBe(true);
    expect(isExempt('/Users/dev/work/vat/packages/git/src/index.ts')).toBe(true);
  });

  it('matches a backslash-separated (Windows) path', () => {
    expect(isExempt(String.raw`C:\work\vat\packages\git\src\index.ts`)).toBe(true);
  });

  it('accepts the directory spelled with or without a trailing slash', () => {
    expect(createExemptDirectoryMatcher(['packages/git'])('packages/git/src/x.ts')).toBe(true);
    expect(createExemptDirectoryMatcher(['./packages/git/'])('packages/git/src/x.ts')).toBe(true);
  });

  it('does NOT match a directory whose name merely ENDS WITH the exempt one', () => {
    // The load-bearing decoy: `includes('packages/git/')` accepted both of these,
    // silently opting a vendored copy out of the ban it exists to enforce.
    expect(isExempt('vendor/copy-packages/git/src/index.ts')).toBe(false);
    expect(isExempt('tools/my-packages/git/exec.ts')).toBe(false);
  });

  it('does NOT match a sibling directory that shares a prefix', () => {
    expect(isExempt('packages/github/src/index.ts')).toBe(false);
    expect(isExempt('packages/git-utils/src/index.ts')).toBe(false);
  });

  it('does NOT match the directory path itself or an empty filename', () => {
    expect(isExempt('packages/git')).toBe(false);
    expect(isExempt('<input>')).toBe(false);
    expect(isExempt('')).toBe(false);
  });

  it('never matches when the exempt list is empty', () => {
    expect(createExemptDirectoryMatcher([])('packages/git/src/index.ts')).toBe(false);
  });
});

describe('isTestFile', () => {
  // A CATEGORY check ("is this a test file?"), not a specific-path exemption —
  // so it anchors on the BASENAME's extension rather than on a path segment.
  // `no-unix-shell-commands` used to spell it `filename.includes('.test.ts')`.

  it('matches this repo\'s test-file convention', () => {
    expect(isTestFile('packages/cli/test/example.test.ts')).toBe(true);
    expect(isTestFile('packages/cli/test/integration/x.integration.test.ts')).toBe(true);
    expect(isTestFile('packages/cli/test/system/x.system.test.ts')).toBe(true);
    expect(isTestFile('/Users/dev/work/vat/packages/cli/test/example.test.ts')).toBe(true);
    expect(isTestFile(String.raw`C:\work\vat\packages\cli\test\example.test.ts`)).toBe(true);
  });

  it('matches the JavaScript and module-flavored spellings', () => {
    expect(isTestFile('tools/example.test.js')).toBe(true);
    expect(isTestFile('tools/example.test.mjs')).toBe(true);
    expect(isTestFile('tools/example.test.cjs')).toBe(true);
    expect(isTestFile('tools/example.test.mts')).toBe(true);
    expect(isTestFile('tools/example.test.tsx')).toBe(true);
  });

  it('does NOT match a file whose name merely CONTAINS a test extension', () => {
    // Every one of these was exempted by the old `includes()` check.
    expect(isTestFile('packages/cli/src/example.test.ts.bak')).toBe(false);
    expect(isTestFile('docs/notes-about-.test.ts-files.md')).toBe(false);
    // A REAL tracked file in this repo: `tsconfig.test.json` contains `.test.js`.
    expect(isTestFile('packages/resources/tsconfig.test.json')).toBe(false);
  });

  it('does NOT match a DIRECTORY that carries a test extension in its name', () => {
    expect(isTestFile('packages/cli/src/.test.ts-helpers/impl.ts')).toBe(false);
    expect(isTestFile('packages/cli/example.test.ts/index.ts')).toBe(false);
  });

  it('does NOT match ordinary source files', () => {
    expect(isTestFile('packages/cli/src/example.ts')).toBe(false);
    expect(isTestFile('packages/cli/src/testing.ts')).toBe(false);
    expect(isTestFile('packages/cli/test/helpers.ts')).toBe(false);
    expect(isTestFile('<input>')).toBe(false);
    expect(isTestFile('')).toBe(false);
  });
});
