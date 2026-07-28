/**
 * Unit tests for test-input.ts — the rule that a skill's DECLARED test input never
 * ships. Pure path logic; no filesystem.
 */

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  checkPackagedTestInput,
  packagedFileEntries,
  partitionTestInputFileEntries,
  resolveTestInputDirs,
  testInputExcludeRules,
  testInputFileEntryIssues,
  testInputLinkIssues,
} from '../src/test-input.js';

/**
 * Absolute-path fixtures are rooted through `safePath.resolve` so they carry a
 * drive letter on Windows, matching what the production path helpers return.
 * A bare '/repo' literal would compare against 'D:/repo' there and fail.
 */
const PROJECT_ROOT = toForwardSlash(safePath.resolve('/repo'));
const SKILL_DIR = `${PROJECT_ROOT}/skills/demo`;
const OUTPUT = `${PROJECT_ROOT}/dist/skills/demo`;
/** The default suite dir `resolveTestInputDirs` derives from SKILL_DIR. */
const DEFAULT_EVALS_DIR = `${SKILL_DIR}/evals`;
/** A skill-relative href pointing INTO the declared suite — the link VAT must drop. */
const NOTES_HREF = 'evals/notes.md';
/** A `files:` dest that points INTO the declared suite — the entry VAT must drop. */
const FIXTURE_DEST = 'fixtures/input.md';
/** A `files:` dest whose source is OUTSIDE test input — the entry VAT must keep. */
const KEPT_DEST = 'cli-reference.md';
/** The declared eval suite itself, as a project-root-relative `files:` source. */
const SUITE_SOURCE = 'skills/demo/evals/evals.json';

describe('resolveTestInputDirs', () => {
  it('resolves the default suite dir for a skill that declares test: with no evals path', () => {
    expect(resolveTestInputDirs({ test: {} }, SKILL_DIR)).toEqual([DEFAULT_EVALS_DIR]);
  });

  it('resolves a custom, skill-relative evals path to its containing dir', () => {
    // VAT's own layout: several skills share one source dir, each with its own suite.
    expect(resolveTestInputDirs({ test: { evals: 'evals/demo/evals.json' } }, SKILL_DIR))
      .toEqual([`${SKILL_DIR}/evals/demo`]);
  });

  it('resolves a suite kept OUTSIDE the skill dir (a layout that never leaked in the first place)', () => {
    expect(resolveTestInputDirs({ test: { evals: '../../evals/demo/evals.json' } }, SKILL_DIR))
      .toEqual([`${PROJECT_ROOT}/evals/demo`]);
  });

  it('returns nothing when the skill declares no test: block', () => {
    // No declaration, no rule. VAT does not guess that a dir named evals/ is test input.
    expect(resolveTestInputDirs({}, SKILL_DIR)).toEqual([]);
  });

  it('returns nothing for a suite at the skill root — the "dir" would be the skill itself', () => {
    expect(resolveTestInputDirs({ test: { evals: 'evals.json' } }, SKILL_DIR)).toEqual([]);
  });
});

describe('testInputExcludeRules', () => {
  it('emits project-relative patterns for the dir and everything under it', () => {
    expect(testInputExcludeRules([DEFAULT_EVALS_DIR], PROJECT_ROOT)).toEqual([
      { patterns: ['skills/demo/evals', 'skills/demo/evals/**'] },
    ]);
  });

  it('emits no rule for a dir outside the project root (the walker already refuses those)', () => {
    expect(testInputExcludeRules([toForwardSlash(safePath.resolve('/elsewhere/evals'))], PROJECT_ROOT)).toEqual([]);
  });

  it('emits nothing when there is no declared test input', () => {
    expect(testInputExcludeRules([], PROJECT_ROOT)).toEqual([]);
  });
});

describe('partitionTestInputFileEntries', () => {
  const testInputDirs = [DEFAULT_EVALS_DIR];

  it('DROPS a files: entry pointing into test input — declaring it is the instruction', () => {
    // No config edit, no waiver, no failed build: `test.evals` already said "this is
    // test input", so VAT simply does not package it.
    const { kept, dropped } = partitionTestInputFileEntries(
      [
        { source: 'skills/demo/evals/fixtures/input.md', dest: FIXTURE_DEST },
        { source: 'build-output/cli.md', dest: KEPT_DEST },
      ],
      PROJECT_ROOT,
      testInputDirs,
    );

    expect(dropped.map((e) => e.dest)).toEqual([FIXTURE_DEST]);
    expect(kept.map((e) => e.dest)).toEqual([KEPT_DEST]);
  });

  it('matches a GLOB entry by its static base, without expanding it', () => {
    const { kept, dropped } = partitionTestInputFileEntries(
      [{ source: 'skills/demo/evals/**/*.md', dest: 'evals-copy' }],
      PROJECT_ROOT,
      testInputDirs,
    );

    expect(dropped).toHaveLength(1);
    expect(kept).toEqual([]);
  });

  it('keeps every entry when the skill declares no test input', () => {
    const entries = [{ source: SUITE_SOURCE, dest: 'evals.json' }];
    expect(partitionTestInputFileEntries(entries, PROJECT_ROOT, [])).toEqual({
      kept: entries,
      dropped: [],
    });
  });
});

describe('packagedFileEntries', () => {
  it('returns only what the packager will copy, so a validator lane cannot defer a dropped dest', () => {
    const kept = packagedFileEntries(
      {
        test: { evals: 'evals/evals.json' },
        files: [
          { source: SUITE_SOURCE, dest: 'evals-copy.json' },
          { source: 'build-output/cli.md', dest: KEPT_DEST },
        ],
      },
      SKILL_DIR,
      PROJECT_ROOT,
    );

    expect(kept.map((e) => e.dest)).toEqual([KEPT_DEST]);
  });

  it('keeps every entry when the skill declares no test: block', () => {
    const files = [{ source: SUITE_SOURCE, dest: 'evals-copy.json' }];
    expect(packagedFileEntries({ files }, SKILL_DIR, PROJECT_ROOT)).toEqual(files);
  });

  it('returns [] for a skill with no files: config at all', () => {
    expect(packagedFileEntries({}, SKILL_DIR, PROJECT_ROOT)).toEqual([]);
  });
});

describe('testInputFileEntryIssues', () => {
  it('emits a WARNING receipt per dropped entry — the build already did the right thing', () => {
    const issues = testInputFileEntryIssues([
      { source: 'skills/demo/evals/fixtures/input.md', dest: FIXTURE_DEST },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_TEST_INPUT');
    // Warning, not error: nothing is broken — a `files:` entry just did nothing, and
    // silently doing nothing is the only outcome worth reporting here.
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.location).toBe(FIXTURE_DEST);
  });

  it('emits nothing when no entry was dropped', () => {
    expect(testInputFileEntryIssues([])).toEqual([]);
  });
});

describe('checkPackagedTestInput (backstop)', () => {
  const testInputDirs = [DEFAULT_EVALS_DIR];

  it('flags a bundled file whose SOURCE came from declared test input', () => {
    // Silent in normal operation — both routes are closed upstream. If this ever
    // fires, an exclusion regressed and the artifact would otherwise carry the key.
    const issues = checkPackagedTestInput({
      pathMap: new Map([[`${SKILL_DIR}/evals/evals.json`, `${OUTPUT}/resources/evals.json`]]),
      outputPath: OUTPUT,
      testInputDirs,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_TEST_INPUT');
    expect(issues[0]?.location).toBe('resources/evals.json');
  });

  it('is silent for ordinary bundled files', () => {
    expect(
      checkPackagedTestInput({
        pathMap: new Map([[`${SKILL_DIR}/references/guide.md`, `${OUTPUT}/resources/guide.md`]]),
        outputPath: OUTPUT,
        testInputDirs,
      }),
    ).toEqual([]);
  });

  it('is silent when the skill declares no test input at all', () => {
    expect(
      checkPackagedTestInput({
        pathMap: new Map([[`${SKILL_DIR}/evals/evals.json`, `${OUTPUT}/evals.json`]]),
        outputPath: OUTPUT,
        testInputDirs: [],
      }),
    ).toEqual([]);
  });
});

describe('testInputLinkIssues', () => {
  const testInputDirs = [DEFAULT_EVALS_DIR];

  it('emits one receipt for a link that pointed into declared test input', () => {
    const issues = testInputLinkIssues(
      [{ path: `${DEFAULT_EVALS_DIR}/notes.md`, linkHref: NOTES_HREF }],
      testInputDirs,
      PROJECT_ROOT,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_TEST_INPUT');
    expect(issues[0]?.location).toBe('skills/demo/evals/notes.md');
    // The authored href, so the author can find the link they need to remove.
    expect(issues[0]?.message).toContain(NOTES_HREF);
  });

  it('is silent for a link to an ordinary resource', () => {
    expect(
      testInputLinkIssues(
        [{ path: `${SKILL_DIR}/references/guide.md`, linkHref: 'references/guide.md' }],
        testInputDirs,
        PROJECT_ROOT,
      ),
    ).toEqual([]);
  });

  it('is silent when the skill declares no test input at all', () => {
    expect(
      testInputLinkIssues(
        [{ path: `${DEFAULT_EVALS_DIR}/notes.md`, linkHref: NOTES_HREF }],
        [],
        PROJECT_ROOT,
      ),
    ).toEqual([]);
  });

  it('is silent for test input OUTSIDE the project root — that drop is not VAT\'s', () => {
    // `testInputExcludeRules` generates no rule for an outside-project dir, so the
    // link is dropped by the walker's own outside-project check, which already
    // reports LINK_OUTSIDE_PROJECT. Claiming credit here double-reported one link
    // under two codes whose advice contradicts: "no action needed" beside "move the
    // target inside the project or remove the link".
    const outsideEvals = toForwardSlash(safePath.resolve('/elsewhere/evals'));
    expect(
      testInputLinkIssues(
        [{ path: `${outsideEvals}/notes.md`, linkHref: '../../../elsewhere/evals/notes.md' }],
        [outsideEvals],
        PROJECT_ROOT,
      ),
    ).toEqual([]);
  });

  it('reports one receipt per target, not per link that reached it', () => {
    const issues = testInputLinkIssues(
      [
        { path: `${DEFAULT_EVALS_DIR}/notes.md`, linkHref: NOTES_HREF },
        { path: `${DEFAULT_EVALS_DIR}/notes.md`, linkHref: './evals/notes.md' },
      ],
      testInputDirs,
      PROJECT_ROOT,
    );

    expect(issues).toHaveLength(1);
  });

  it('falls back to the location when a link has no recorded href', () => {
    const issues = testInputLinkIssues(
      [{ path: `${DEFAULT_EVALS_DIR}/fixtures/a.txt` }],
      testInputDirs,
      PROJECT_ROOT,
    );

    expect(issues[0]?.message).toContain('skills/demo/evals/fixtures/a.txt');
  });
});
