/**
 * Unit tests for the pure helpers extracted from validateLocalFileLink.
 *
 * These cover the union branches and case-mismatch paths that integration
 * tests exercise end-to-end but that vitest coverage instrumentation only
 * counts for unit tests.
 */

import { describe, expect, it } from 'vitest';

import {
  checkAnchor,
  fileExistenceIssue,
  gitIgnoreSafetyIssue,
  resolutionFailureIssue,
  type ValidateLinkOptions,
} from '../src/link-validator.js';
import type { ResourceLink } from '../src/types.js';

function makeLink(href: string, line = 1): ResourceLink {
  return { type: 'local_file', href, text: 'link', line };
}

const PROJECT_ROOT = '/project';
const SOURCE = `${PROJECT_ROOT}/docs/page.md`;
const TARGET_FOO = `${PROJECT_ROOT}/foo.md`;
const TARGET_SECRET = `${PROJECT_ROOT}/secret.md`;
const LINK_FOO = 'foo.md';
const LINK_ABSOLUTE_NO_ROOT = '/foo.md';

function makeGitTrackerOptions(
  tracker: { isIgnoredByActiveSet: (p: string) => boolean },
  overrides: Partial<ValidateLinkOptions> = {},
): ValidateLinkOptions {
  return {
    projectRoot: PROJECT_ROOT,
    gitTracker: tracker as unknown as ValidateLinkOptions['gitTracker'],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ValidateLinkOptions> = {}): ValidateLinkOptions {
  return { projectRoot: PROJECT_ROOT, ...overrides };
}

describe('resolutionFailureIssue', () => {
  it('returns broken_file with documented absolute_no_root message', () => {
    const issue = resolutionFailureIssue(
      { kind: 'absolute_no_root', href: LINK_ABSOLUTE_NO_ROOT, anchor: undefined },
      makeLink(LINK_ABSOLUTE_NO_ROOT),
      SOURCE,
    );
    expect(issue?.code).toBe('LINK_BROKEN_FILE');
    expect(issue?.message).toContain('requires a configured projectRoot');
    expect(issue?.suggestion).toContain('Rewrite as a source-relative link');
  });

  it('returns broken_file with documented absolute_escapes_root message', () => {
    const issue = resolutionFailureIssue(
      { kind: 'absolute_escapes_root', href: '/../etc/passwd', anchor: undefined },
      makeLink('/../etc/passwd'),
      SOURCE,
    );
    expect(issue?.code).toBe('LINK_BROKEN_FILE');
    expect(issue?.message).toContain('escapes the project root via path traversal');
  });

  it('returns null for resolved kind (caller continues)', () => {
    expect(
      resolutionFailureIssue(
        { kind: 'resolved', resolvedPath: '/project/foo.md', anchor: undefined },
        makeLink('foo.md'),
        SOURCE,
      ),
    ).toBeNull();
  });

  it('returns null for anchor_only kind (defensive no-op)', () => {
    expect(
      resolutionFailureIssue({ kind: 'anchor_only' }, makeLink('#section'), SOURCE),
    ).toBeNull();
  });

  it('preserves the original href in the broken_file message', () => {
    const issue = resolutionFailureIssue(
      { kind: 'absolute_no_root', href: '/some/path.md', anchor: undefined },
      makeLink('/some/path.md'),
      SOURCE,
    );
    expect(issue?.message).toContain('"/some/path.md"');
  });
});

describe('fileExistenceIssue', () => {
  it('returns null when file exists', () => {
    expect(
      fileExistenceIssue(
        { exists: true, resolvedPath: '/project/foo.md' },
        makeLink('foo.md'),
        SOURCE,
      ),
    ).toBeNull();
  });

  it('returns broken_file with "File not found" when missing and no case match', () => {
    const issue = fileExistenceIssue(
      { exists: false, resolvedPath: '/project/missing.md' },
      makeLink('missing.md'),
      SOURCE,
    );
    expect(issue?.code).toBe('LINK_BROKEN_FILE');
    expect(issue?.message).toBe('File not found: /project/missing.md');
  });

  it('returns broken_file with case-mismatch hint when actualName differs', () => {
    const issue = fileExistenceIssue(
      { exists: false, resolvedPath: '/project/readme.md', actualName: 'README.md' },
      makeLink('readme.md'),
      SOURCE,
    );
    expect(issue?.code).toBe('LINK_BROKEN_FILE');
    expect(issue?.message).toContain('case mismatch');
    expect(issue?.message).toContain('"readme.md"');
    expect(issue?.message).toContain('"README.md"');
    expect(issue?.suggestion).toBe('Use "README.md" instead of "readme.md"');
  });
});

describe('checkAnchor', () => {
  const GUIDE_MD = '/abs/guide.md';
  const PAGE_HTML = '/abs/page.html';
  const index = new Map<string, Set<string>>([
    [GUIDE_MD, new Set(['my-heading'])],
    [PAGE_HTML, new Set(['Intro', 'legacy'])],
  ]);

  it('skips targets that are not indexed', () => {
    expect(checkAnchor('anything', '/abs/not-indexed.md', index)).toBe('skip');
  });

  it('matches markdown slugs case-insensitively', () => {
    expect(checkAnchor('My-Heading', GUIDE_MD, index)).toBe('valid');
    expect(checkAnchor('missing', GUIDE_MD, index)).toBe('broken');
  });

  it('matches HTML ids case-sensitively', () => {
    expect(checkAnchor('Intro', PAGE_HTML, index)).toBe('valid');
    expect(checkAnchor('intro', PAGE_HTML, index)).toBe('broken');
  });
});

describe('gitIgnoreSafetyIssue', () => {
  it('returns null when skipGitIgnoreCheck is true', () => {
    expect(
      gitIgnoreSafetyIssue(
        makeLink(LINK_FOO),
        SOURCE,
        TARGET_FOO,
        makeOptions({ skipGitIgnoreCheck: true }),
      ),
    ).toBeNull();
  });

  it('returns null when projectRoot is undefined', () => {
    expect(
      gitIgnoreSafetyIssue(makeLink(LINK_FOO), SOURCE, TARGET_FOO, { skipGitIgnoreCheck: false }),
    ).toBeNull();
  });

  it('returns null when target is outside the project root', () => {
    expect(
      gitIgnoreSafetyIssue(
        makeLink('/other.md'),
        SOURCE,
        '/elsewhere/other.md',
        makeOptions(),
      ),
    ).toBeNull();
  });

  it('returns null when source is itself gitignored (ignored→anything is fine)', () => {
    const tracker = { isIgnoredByActiveSet: (p: string): boolean => p === SOURCE };
    expect(
      gitIgnoreSafetyIssue(makeLink(LINK_FOO), SOURCE, TARGET_FOO, makeGitTrackerOptions(tracker)),
    ).toBeNull();
  });

  it('returns null when target is not gitignored', () => {
    const tracker = { isIgnoredByActiveSet: (): boolean => false };
    expect(
      gitIgnoreSafetyIssue(makeLink(LINK_FOO), SOURCE, TARGET_FOO, makeGitTrackerOptions(tracker)),
    ).toBeNull();
  });

  it('returns link_to_gitignored when non-ignored source links to gitignored target', () => {
    const tracker = { isIgnoredByActiveSet: (p: string): boolean => p === TARGET_SECRET };
    const issue = gitIgnoreSafetyIssue(
      makeLink('secret.md'),
      SOURCE,
      TARGET_SECRET,
      makeGitTrackerOptions(tracker),
    );
    expect(issue?.code).toBe('LINK_TO_GITIGNORED');
    expect(issue?.message).toContain('Non-ignored file links to gitignored file');
    expect(issue?.message).toContain(TARGET_SECRET);
  });
});
