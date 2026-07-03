import { describe, expect, it } from 'vitest';

import { stagedDirName } from '../../src/skill-test/staging.js';

/**
 * Unit tests for stagedDirName — the single-segment sanitizer that fixes the
 * Windows staging bug (issue #132): joining an absolute item name onto the
 * harness root smuggled a drive letter mid-path (`…\harness\C:\Users\…`) and
 * made cpSync throw. The result must always be one safe path segment.
 */
describe('stagedDirName', () => {
  const SEPARATORS = /[/\\:]/;
  const POC_PREFIX = 'poc-skill-';

  it('reduces an absolute POSIX path to a single segment with no separators', () => {
    const out = stagedDirName('/Users/jeff/work/poc-skill');
    expect(out).not.toMatch(SEPARATORS);
    expect(out.startsWith(POC_PREFIX)).toBe(true);
  });

  it('reduces an absolute Windows path (drive letter) to a single safe segment', () => {
    const out = stagedDirName(String.raw`C:\Users\Jeff.Dutton\skills\poc-skill`);
    expect(out).not.toMatch(SEPARATORS);
    expect(out.startsWith(POC_PREFIX)).toBe(true);
  });

  it('keeps a clean dependency name readable (still one segment)', () => {
    const out = stagedDirName('mydep');
    expect(out).not.toMatch(SEPARATORS);
    expect(out.startsWith('mydep-')).toBe(true);
  });

  it('disambiguates equal basenames by hashing the full name', () => {
    const a = stagedDirName('/a/poc-skill');
    const b = stagedDirName('/b/poc-skill');
    expect(a).not.toBe(b);
    expect(a.startsWith(POC_PREFIX)).toBe(true);
    expect(b.startsWith(POC_PREFIX)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(stagedDirName('/x/poc-skill')).toBe(stagedDirName('/x/poc-skill'));
  });

  it('falls back to a pure hash when the basename sanitizes to empty', () => {
    const out = stagedDirName('/path/到/...');
    expect(out).not.toMatch(SEPARATORS);
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });
});
