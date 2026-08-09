/**
 * Unit tests for the pure helpers extracted from validateLocalFileLink.
 *
 * These cover the union branches and case-mismatch paths that integration
 * tests exercise end-to-end but that vitest coverage instrumentation only
 * counts for unit tests.
 */

import type { RealpathTable } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { DeferredArtifacts } from '../src/deferred-artifacts.js';
import {
  checkAnchor,
  fileExistenceIssue,
  fragmentIndex,
  gitIgnoreSafetyIssue,
  resolutionFailureIssue,
  type GitIgnoreCheckOptions,
} from '../src/link-validator.js';
import type { ResourceLink } from '../src/types.js';

function makeLink(href: string, line = 1): ResourceLink {
  return { type: 'local_file', href, text: 'link', line };
}

const PROJECT_ROOT = '/project';
const SOURCE = `${PROJECT_ROOT}/docs/page.md`;
const TARGET_FOO = `${PROJECT_ROOT}/foo.md`;
const TARGET_SECRET = `${PROJECT_ROOT}/secret.md`;
const TARGET_OUTSIDE = '/elsewhere/other.md';
const LINK_FOO = 'foo.md';
const LINK_ABSOLUTE_NO_ROOT = '/foo.md';

/**
 * The filled realpath column `gitIgnoreSafetyIssue` reads — hand-written, and
 * covering the project root as well as every target these tests judge.
 *
 * Identity rows: none of these paths exist on disk, and the production fill
 * answers a path it cannot canonicalize with `safePath.resolve()`, which is the
 * identity for an already-absolute POSIX path. Writing the table by hand instead
 * of calling `fillRealpaths` keeps these unit tests free of both I/O and a
 * platform-dependent root — which is exactly what `realpathFrom` taking a table
 * rather than a cache is for.
 *
 * ⚠️ A missing row THROWS, so every target below must be listed here.
 */
const REALPATHS: RealpathTable = new Map(
  [PROJECT_ROOT, TARGET_FOO, TARGET_SECRET, TARGET_OUTSIDE].map((p) => [p, p]),
);

function makeOptions(overrides: Partial<GitIgnoreCheckOptions> = {}): GitIgnoreCheckOptions {
  return { projectRoot: PROJECT_ROOT, realpaths: REALPATHS, ...overrides };
}

function makeGitTrackerOptions(
  tracker: { isIgnoredByActiveSet: (p: string) => boolean },
  overrides: Partial<GitIgnoreCheckOptions> = {},
): GitIgnoreCheckOptions {
  return makeOptions({
    gitTracker: tracker as unknown as GitIgnoreCheckOptions['gitTracker'],
    ...overrides,
  });
}

/** A DeferredArtifacts model whose only entry's `dest` is `relPath` (project-root-relative). */
function makeDeferredArtifactsCovering(relPath: string): DeferredArtifacts {
  return DeferredArtifacts.from(
    [{ files: [{ source: '__unused-source__', dest: relPath }], skillDir: PROJECT_ROOT }],
    PROJECT_ROOT,
  );
}

/** A DeferredArtifacts model whose only entry's `source` is `relPath` (project-root-relative). */
function makeDeferredArtifactsCoveringAsSource(relPath: string): DeferredArtifacts {
  return DeferredArtifacts.from(
    [{ files: [{ source: relPath, dest: '__unused-dest__' }], skillDir: PROJECT_ROOT }],
    PROJECT_ROOT,
  );
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

  it('keeps the absolute path out of the message when projectRoot is known', () => {
    // `location` is project-relative per the issue anchor contract; a message
    // that spells the same file absolutely leaks the developer's home directory
    // into every CI log and contradicts its own sibling field.
    const issue = fileExistenceIssue(
      { exists: false, resolvedPath: '/project/docs/missing.md' },
      makeLink('docs/missing.md'),
      SOURCE,
      '/project',
    );
    expect(issue?.message).toBe('File not found: docs/missing.md');
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
  const PAGE_HTM = '/abs/legacy.htm';
  const index = fragmentIndex([
    [GUIDE_MD, new Set(['my-heading'])],
    [PAGE_HTML, new Set(['Intro', 'legacy'])],
    [PAGE_HTM, new Set(['Section'])],
  ]);

  it('skips targets that are not indexed', () => {
    expect(checkAnchor('anything', '/abs/not-indexed.md', index)).toBe('skip');
  });

  it('matches markdown slugs case-insensitively', () => {
    expect(checkAnchor('My-Heading', GUIDE_MD, index)).toBe('valid');
    expect(checkAnchor('missing', GUIDE_MD, index)).toBe('broken');
  });

  it('skips HTML fragment anchors by default (runtime-defined ids are not statically authoritative)', () => {
    expect(checkAnchor('planning', PAGE_HTML, index)).toBe('skip');
    expect(checkAnchor('planning', PAGE_HTML, index, false)).toBe('skip');
  });

  it('matches HTML ids case-sensitively when checkHtmlAnchors is true', () => {
    expect(checkAnchor('Intro', PAGE_HTML, index, true)).toBe('valid');
    expect(checkAnchor('intro', PAGE_HTML, index, true)).toBe('broken');
  });

  it('still reports a genuinely missing HTML id as broken when checkHtmlAnchors is true', () => {
    // Guards against over-correcting the false-positive fix into a blanket skip.
    expect(checkAnchor('missing', PAGE_HTML, index, true)).toBe('broken');
  });

  it('treats SPA route fragments as skip even with checkHtmlAnchors=true', () => {
    // "#/route" is never a literal element id.
    expect(checkAnchor('/pipeline', PAGE_HTML, index, true)).toBe('skip');
  });

  it('treats hash-param-string fragments as skip even with checkHtmlAnchors=true', () => {
    // "#id=abc123&mode=client" is a hash-encoded param string, never an id.
    expect(checkAnchor('id=abc123&mode=client', PAGE_HTML, index, true)).toBe('skip');
  });

  it('treats the empty fragment and "top" (case-insensitive) as valid on HTML targets', () => {
    // HTML spec: `#` and `#top` always navigate to the top of the document,
    // valid even though neither id is in the index.
    expect(checkAnchor('', PAGE_HTML, index)).toBe('valid');
    expect(checkAnchor('top', PAGE_HTML, index)).toBe('valid');
    expect(checkAnchor('TOP', PAGE_HTML, index)).toBe('valid');
    expect(checkAnchor('Top', PAGE_HTML, index)).toBe('valid');
  });

  it('does not special-case empty/"top" for markdown targets', () => {
    // Markdown behavior is untouched: neither is a real heading slug here.
    expect(checkAnchor('', GUIDE_MD, index)).toBe('broken');
    expect(checkAnchor('top', GUIDE_MD, index)).toBe('broken');
  });

  it('applies the HTML matching rules to the .htm extension too', () => {
    // .htm is HTML: case-sensitive ids + empty/top navigation, same as .html.
    // Fragment resolution is opt-in (checkHtmlAnchors=true); empty/top are
    // always valid regardless of the flag.
    expect(checkAnchor('Section', PAGE_HTM, index, true)).toBe('valid');
    expect(checkAnchor('section', PAGE_HTM, index, true)).toBe('broken');
    expect(checkAnchor('Section', PAGE_HTM, index)).toBe('skip');
    expect(checkAnchor('', PAGE_HTM, index)).toBe('valid');
    expect(checkAnchor('top', PAGE_HTM, index)).toBe('valid');
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
    // An EMPTY realpath table on purpose: with no project root the check must
    // return before it reads the column, which is exactly what lets the fill
    // leave it empty in this configuration. A throw here would mean the gate and
    // the fill had drifted apart.
    expect(
      gitIgnoreSafetyIssue(makeLink(LINK_FOO), SOURCE, TARGET_FOO, {
        skipGitIgnoreCheck: false,
        realpaths: new Map(),
      }),
    ).toBeNull();
  });

  it('returns null when target is outside the project root', () => {
    // The table holds rows for BOTH the out-of-root target and the root — the
    // containment answer is read, not recomputed, so both must be filled.
    expect(
      gitIgnoreSafetyIssue(makeLink('/other.md'), SOURCE, TARGET_OUTSIDE, makeOptions()),
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

  // A files:-declared target that already exists on disk and is gitignored is
  // the expected post-build state of a materialized build artifact, not a
  // leak — same exemption as the agent-skills walker's gitignore branch.
  it('returns LINK_DEFERRED_ARTIFACT instead of LINK_TO_GITIGNORED when target is covered by deferredArtifacts', () => {
    const tracker = { isIgnoredByActiveSet: (p: string): boolean => p === TARGET_SECRET };
    const issue = gitIgnoreSafetyIssue(
      makeLink('secret.md'),
      SOURCE,
      TARGET_SECRET,
      makeGitTrackerOptions(tracker, { deferredArtifacts: makeDeferredArtifactsCovering('secret.md') }),
    );
    expect(issue?.code).toBe('LINK_DEFERRED_ARTIFACT');
    expect(issue?.message).toContain(TARGET_SECRET);
  });

  // The gitignore exemption is DEST-only: a files: SOURCE that is materialized and
  // gitignored must NOT be exempted — only a dest gets the "expected
  // post-build state" downgrade. A source is a real file the author pointed
  // at; the leak signal must survive.
  it('still returns LINK_TO_GITIGNORED when the target is covered only as a files: source, not a dest', () => {
    const tracker = { isIgnoredByActiveSet: (p: string): boolean => p === TARGET_SECRET };
    const issue = gitIgnoreSafetyIssue(
      makeLink('secret.md'),
      SOURCE,
      TARGET_SECRET,
      makeGitTrackerOptions(tracker, { deferredArtifacts: makeDeferredArtifactsCoveringAsSource('secret.md') }),
    );
    expect(issue?.code).toBe('LINK_TO_GITIGNORED');
  });

  // Negative control: the exemption is scoped to covered paths only. A
  // deferredArtifacts model that covers a DIFFERENT path must not suppress the
  // leak signal for this target.
  it('still returns LINK_TO_GITIGNORED when deferredArtifacts is present but does not cover the target', () => {
    const tracker = { isIgnoredByActiveSet: (p: string): boolean => p === TARGET_SECRET };
    const issue = gitIgnoreSafetyIssue(
      makeLink('secret.md'),
      SOURCE,
      TARGET_SECRET,
      makeGitTrackerOptions(tracker, { deferredArtifacts: makeDeferredArtifactsCovering('other-file.md') }),
    );
    expect(issue?.code).toBe('LINK_TO_GITIGNORED');
  });
});
