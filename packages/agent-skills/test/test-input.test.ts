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
/** That kept entry's source: an ordinary build artifact, no skill's test input. */
const KEPT_SOURCE = 'build-output/cli.md';
/** The declared eval suite itself, as a project-root-relative `files:` source. */
const SUITE_SOURCE = 'skills/demo/evals/evals.json';
/** A SECOND skill in the same project, with an eval suite of its own. */
const OTHER_SKILL_DIR = `${PROJECT_ROOT}/skills/csv-summarizer`;
const OTHER_EVALS_DIR = `${OTHER_SKILL_DIR}/evals`;
/** That second skill's suite, as a project-root-relative `files:` source. */
const OTHER_SUITE_SOURCE = 'skills/csv-summarizer/evals/evals.json';
/**
 * A dest for it whose BASENAME differs from the packaged skill's own suite. A
 * filename collision is reported, not thrown, and the copy still happens — so a
 * colliding fixture would pass with or without the cross-skill rule and could not
 * tell the two apart.
 */
const OTHER_SUITE_DEST = 'other-evals.json';
/**
 * Both skills as the project declares them. `test: {}` (rather than no `test:`
 * block) keeps every assertion pure path math — the conventional-suite fallback is
 * the module's one filesystem touch and is covered by the integration test.
 */
const PROJECT_SKILLS = [
  { skillDir: SKILL_DIR, config: { test: {} } },
  { skillDir: OTHER_SKILL_DIR, config: { test: {} } },
];

describe('resolveTestInputDirs', () => {
  it('resolves the default suite dir for a skill that declares test: with no evals path', () => {
    expect(resolveTestInputDirs({ test: {} }, SKILL_DIR, [])).toEqual([DEFAULT_EVALS_DIR]);
  });

  it('resolves a custom, skill-relative evals path to its containing dir', () => {
    // VAT's own layout: several skills share one source dir, each with its own suite.
    expect(resolveTestInputDirs({ test: { evals: 'evals/demo/evals.json' } }, SKILL_DIR, []))
      .toEqual([`${SKILL_DIR}/evals/demo`]);
  });

  it('resolves a suite kept OUTSIDE the skill dir (a layout that never leaked in the first place)', () => {
    expect(resolveTestInputDirs({ test: { evals: '../../evals/demo/evals.json' } }, SKILL_DIR, []))
      .toEqual([`${PROJECT_ROOT}/evals/demo`]);
  });

  it('returns nothing when the skill declares no test: block', () => {
    // No declaration, no rule. VAT does not guess that a dir named evals/ is test input.
    expect(resolveTestInputDirs({}, SKILL_DIR, [])).toEqual([]);
  });

  it('returns nothing for a suite at the skill root — the "dir" would be the skill itself', () => {
    expect(resolveTestInputDirs({ test: { evals: 'evals.json' } }, SKILL_DIR, [])).toEqual([]);
  });
});

describe('resolveTestInputDirs — CROSS-skill declarations', () => {
  it('returns every skill\'s declared suite dir, not just the one being packaged', () => {
    // The bug this covers: a SKILL.md links a doc that cites ANOTHER skill's eval
    // suite as a worked example. Keyed to the packaged skill alone, the walker
    // followed that citation and bundled the other skill's suite with no receipt.
    expect(resolveTestInputDirs({ test: {} }, SKILL_DIR, PROJECT_SKILLS)).toEqual([
      DEFAULT_EVALS_DIR,
      OTHER_EVALS_DIR,
    ]);
  });

  it('reports the packaged skill\'s own suite exactly once when it also appears in the project list', () => {
    const dirs = resolveTestInputDirs({ test: {} }, SKILL_DIR, PROJECT_SKILLS);
    expect(dirs.filter((d) => d === DEFAULT_EVALS_DIR)).toHaveLength(1);
  });

  it('still resolves the packaged skill\'s own suite when the project list is empty', () => {
    expect(resolveTestInputDirs({ test: {} }, SKILL_DIR, [])).toEqual([DEFAULT_EVALS_DIR]);
  });

  it('does NOT export another skill\'s suite dir when that dir sits outside the declaring skill', () => {
    // Issue #166: `test.evals` pointing into a SHARED directory strips that whole
    // directory. That already happens in the declaring skill's own build; letting one
    // skill's declaration strip a shared dir from EVERY other skill's bundle would
    // widen a known bug into a project-wide one.
    const dirs = resolveTestInputDirs({ test: {} }, SKILL_DIR, [
      { skillDir: OTHER_SKILL_DIR, config: { test: { evals: '../../shared/evals.json' } } },
    ]);

    expect(dirs).toEqual([DEFAULT_EVALS_DIR]);
  });

  it('still strips a shared suite dir from the build of the skill that DECLARED it', () => {
    expect(
      resolveTestInputDirs({ test: { evals: '../../shared/evals.json' } }, OTHER_SKILL_DIR, PROJECT_SKILLS),
    ).toContain(`${PROJECT_ROOT}/shared`);
  });

  it('matches the declared suite dir precisely, never an ancestor that merely contains one', () => {
    const dirs = resolveTestInputDirs({ test: {} }, SKILL_DIR, PROJECT_SKILLS);
    // `skills/` contains both suites but is not itself declared test input.
    expect(dirs).not.toContain(`${PROJECT_ROOT}/skills`);

    const { kept, dropped } = partitionTestInputFileEntries(
      [
        { source: 'skills/csv-summarizer/README.md', dest: 'other-readme.md' },
        { source: OTHER_SUITE_SOURCE, dest: OTHER_SUITE_DEST },
      ],
      PROJECT_ROOT,
      dirs,
    );

    expect(kept.map((e) => e.dest)).toEqual(['other-readme.md']);
    expect(dropped.map((e) => e.dest)).toEqual([OTHER_SUITE_DEST]);
  });

  it('drops a files: entry pointing into ANOTHER skill\'s suite, via packagedFileEntries', () => {
    const kept = packagedFileEntries(
      {
        test: {},
        files: [
          { source: OTHER_SUITE_SOURCE, dest: OTHER_SUITE_DEST },
          { source: KEPT_SOURCE, dest: KEPT_DEST },
        ],
      },
      SKILL_DIR,
      PROJECT_ROOT,
      PROJECT_SKILLS,
    );

    expect(kept.map((e) => e.dest)).toEqual([KEPT_DEST]);
  });

  it('emits a PACKAGED_TEST_INPUT receipt for a link into ANOTHER skill\'s suite', () => {
    const dirs = resolveTestInputDirs({ test: {} }, SKILL_DIR, PROJECT_SKILLS);
    const issues = testInputLinkIssues(
      [{ path: `${OTHER_EVALS_DIR}/evals.json`, linkHref: '../csv-summarizer/evals/evals.json' }],
      dirs,
      PROJECT_ROOT,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_TEST_INPUT');
    expect(issues[0]?.location).toBe(OTHER_SUITE_SOURCE);
  });

  it('excludes and backstops another skill\'s suite the same way it does its own', () => {
    const dirs = resolveTestInputDirs({ test: {} }, SKILL_DIR, PROJECT_SKILLS);

    expect(testInputExcludeRules(dirs, PROJECT_ROOT)).toEqual([
      {
        patterns: [
          'skills/demo/evals',
          'skills/demo/evals/**',
          'skills/csv-summarizer/evals',
          'skills/csv-summarizer/evals/**',
        ],
      },
    ]);

    const issues = checkPackagedTestInput({
      pathMap: new Map([[`${OTHER_EVALS_DIR}/evals.json`, `${OUTPUT}/resources/other-evals.json`]]),
      outputPath: OUTPUT,
      testInputDirs: dirs,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('resources/other-evals.json');
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
        { source: KEPT_SOURCE, dest: KEPT_DEST },
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
          { source: KEPT_SOURCE, dest: KEPT_DEST },
        ],
      },
      SKILL_DIR,
      PROJECT_ROOT,
      [],
    );

    expect(kept.map((e) => e.dest)).toEqual([KEPT_DEST]);
  });

  it('keeps every entry when the skill declares no test: block', () => {
    const files = [{ source: SUITE_SOURCE, dest: 'evals-copy.json' }];
    expect(packagedFileEntries({ files }, SKILL_DIR, PROJECT_ROOT, [])).toEqual(files);
  });

  it('returns [] for a skill with no files: config at all', () => {
    expect(packagedFileEntries({}, SKILL_DIR, PROJECT_ROOT, [])).toEqual([]);
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
