/* eslint-disable security/detect-non-literal-fs-filename -- tests use controlled temp directories */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { EvalInputError, parseEvalSuite, stageEvalWorkspaces } from '../../src/skill-test/eval-inputs.js';

const FIXTURES_DOC = 'fixtures/doc.md';
const DESCRIPTIVE_ID = 'cast-smell-typed-column';
/** A stock expectation string, shared so the duplicate/uniqueness cases read against one literal. */
const DID_THE_THING = 'it did the thing';

// Built with `String.fromCharCode` on purpose: typing an escape into this source
// normalizes it into a literal control byte on the way in, which makes the file
// binary to `grep` and to the editing tools.
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
/** Clears the line vat just wrote, then continues in vat's own green. */
const TERMINAL_PAINT = `${ESC}[2K${CR}${ESC}[32m`;

/**
 * The suite is adopter-authored, but `resolveEvalSuitePath` will harvest one out
 * of a FETCHED npm/url artifact — i.e. out of the skill under test — so its
 * strings are untrusted. `files[]` in particular is `z.array(z.string().min(1))`
 * with no charset constraint (unlike `id`, which is regex-pinned because it names
 * a directory), and these messages reach `process.stdout` through the `Summary:`
 * line, the one channel deliberately kept machine-readable.
 */
function expectNoControlBytes(run: () => unknown): void {
  let message = '';
  try {
    run();
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message, 'the call was expected to throw').not.toBe('');
  expect(message).not.toContain(ESC);
  expect(message).not.toContain(CR);
}

const VALID = JSON.stringify({
  skill_name: 'demo',
  evals: [
    { id: 1, prompt: 'do a thing', expected_output: 'a thing is done', expectations: [DID_THE_THING] },
    { id: 2, prompt: 'fix link', expected_output: 'link fixed', files: [FIXTURES_DOC], expectations: ['link resolves'] },
  ],
});

describe('parseEvalSuite', () => {
  it('parses a valid suite and preserves files', () => {
    const suite = parseEvalSuite(VALID);
    expect(suite.skill_name).toBe('demo');
    expect(suite.evals).toHaveLength(2);
    expect(suite.evals[1]?.files).toEqual([FIXTURES_DOC]);
  });

  it('tolerates an optional top-level _comment', () => {
    const withComment = JSON.stringify({ _comment: ['note'], skill_name: 'demo', evals: [{ id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] }] });
    expect(() => parseEvalSuite(withComment)).not.toThrow();
  });

  it('throws EvalInputError on invalid JSON', () => {
    expect(() => parseEvalSuite('{not json')).toThrow(EvalInputError);
  });

  it('sanitizes the V8 parse message, which quotes the offending bytes verbatim', () => {
    // The message V8 builds embeds a raw slice of the input, so a suite file of
    // nothing but control bytes reaches the operator's terminal unescaped.
    expectNoControlBytes(() => parseEvalSuite(`${TERMINAL_PAINT}vat: suite ok.`));
  });

  it('tolerates adopter-owned extra fields (passthrough): per-eval category and top-level _category_note', () => {
    const extended = JSON.stringify({
      _category_note: 'three categories: recognition / guidance / recovery',
      skill_name: 'demo',
      evals: [{ id: 1, category: 'guidance-correctness', prompt: 'p', expected_output: 'o', expectations: ['e'] }],
    });
    const suite = parseEvalSuite(extended);
    // Unknown fields pass through untouched rather than erroring.
    expect((suite as Record<string, unknown>)._category_note).toBe('three categories: recognition / guidance / recovery');
    expect((suite.evals[0] as Record<string, unknown>).category).toBe('guidance-correctness');
  });

  it('accepts a descriptive string id (skill-creator encourages descriptive eval names)', () => {
    const stringId = JSON.stringify({ skill_name: 'demo', evals: [
      { id: DESCRIPTIVE_ID, prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] });
    const suite = parseEvalSuite(stringId);
    expect(suite.evals[0]?.id).toBe(DESCRIPTIVE_ID);
  });

  it('still errors when a load-bearing field is missing (passthrough only relaxes unknown fields)', () => {
    const missingExpectations = JSON.stringify({ skill_name: 'demo', evals: [{ id: 1, prompt: 'p', expected_output: 'o' }] });
    expect(() => parseEvalSuite(missingExpectations)).toThrow(EvalInputError);
  });

  it('accepts an eval with no expected_output (graded on expectations alone — real adopter-suite shape)', () => {
    const noExpectedOutput = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 'anti-re-parse', prompt: 'p', expectations: ['e'] },
    ] });
    const suite = parseEvalSuite(noExpectedOutput);
    expect(suite.evals[0]?.expected_output).toBeUndefined();
    expect(suite.evals[0]?.expectations).toEqual(['e']);
  });

  it('accepts a suite that mixes numeric and descriptive string ids (real adopter-suite shape)', () => {
    const mixed = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
      { id: DESCRIPTIVE_ID, prompt: 'p2', expected_output: 'o2', expectations: ['e2'] },
    ] });
    const suite = parseEvalSuite(mixed);
    expect(suite.evals.map((e) => e.id)).toEqual([1, DESCRIPTIVE_ID]);
  });

  it('throws EvalInputError on duplicate eval ids', () => {
    const dup = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
      { id: 1, prompt: 'p2', expected_output: 'o2', expectations: ['e2'] },
    ] });
    expect(() => parseEvalSuite(dup)).toThrow(/unique/i);
  });

  /**
   * Every number vat reports is counted over `fragment.expectations`, and
   * `runGraderForEval` fails the run when that count differs from the DECLARED
   * one. A suite declaring the same expectation string twice hands the grader
   * "1. x / 2. x" and gets one entry back — a plausible grader response, and one
   * that destroys a fully-billed treatment run with an InternalHarnessError
   * mid-flight. Caught at parse instead: same class as the duplicate-id check
   * above, same exit code (2, user-correctable), before anything is spawned.
   */
  it('throws EvalInputError on a duplicate expectation within one eval', () => {
    const dup = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: [DID_THE_THING, DID_THE_THING] },
    ] });
    expect(() => parseEvalSuite(dup)).toThrow(EvalInputError);
    expect(() => parseEvalSuite(dup)).toThrow(/duplicate expectation/i);
  });

  it('allows the SAME expectation text in two DIFFERENT evals (each is graded on its own)', () => {
    const shared = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expectations: [DID_THE_THING] },
      { id: 2, prompt: 'p2', expectations: [DID_THE_THING] },
    ] });
    expect(() => parseEvalSuite(shared)).not.toThrow();
  });

  it('sanitizes the duplicated expectation quoted into the message (suite text is untrusted)', () => {
    const painted = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expectations: [`${TERMINAL_PAINT}ok`, `${TERMINAL_PAINT}ok`] },
    ] });
    expectNoControlBytes(() => parseEvalSuite(painted));
  });

  it('treats numeric 1 and string "1" as colliding ids (both name the same workspace dir)', () => {
    const collide = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
      { id: '1', prompt: 'p2', expected_output: 'o2', expectations: ['e2'] },
    ] });
    expect(() => parseEvalSuite(collide)).toThrow(/unique/i);
  });

  it('rejects a string id with filesystem-illegal characters (it names a working dir)', () => {
    const colon = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 'year:extraction', prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] });
    expect(() => parseEvalSuite(colon)).toThrow(EvalInputError);
    const slash = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 'docs/parse', prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] });
    expect(() => parseEvalSuite(slash)).toThrow(EvalInputError);
  });

  it('flags a near-miss typo of the optional `files` field (would otherwise be silently swallowed)', () => {
    const typo = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'], filez: ['fixtures/doc.md'] },
    ] });
    expect(() => parseEvalSuite(typo)).toThrow(/did you mean.*files/i);
  });

  it('does NOT flag legitimately distinct adopter keys (name, category, notes) as typos', () => {
    const customKeys = JSON.stringify({ skill_name: 'demo', notes: 'top-level note', evals: [
      { id: 1, name: 'happy path', category: 'recognition', prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] });
    expect(() => parseEvalSuite(customKeys)).not.toThrow();
  });

  it('parses tier + toolExpectations (mustRun/mustNotRun/sequence) and surfaces them on EvalEntry', () => {
    const withToolExpectations = JSON.stringify({ skill_name: 'demo', evals: [
      {
        id: 1,
        prompt: 'p',
        expected_output: 'o',
        expectations: ['e'],
        tier: 2,
        toolExpectations: {
          mustRun: ['Read', 'Grep'],
          mustNotRun: ['Bash'],
          sequence: ['Read', 'Grep'],
        },
      },
    ] });
    const suite = parseEvalSuite(withToolExpectations);
    expect(suite.evals[0]?.tier).toBe(2);
    expect(suite.evals[0]?.toolExpectations).toEqual({
      mustRun: ['Read', 'Grep'],
      mustNotRun: ['Bash'],
      sequence: ['Read', 'Grep'],
    });
  });

  it('parses a mustSucceed tool-expectation (feature #148) and surfaces it on EvalEntry', () => {
    const withMustSucceed = JSON.stringify({ skill_name: 'demo', evals: [
      {
        id: 1,
        prompt: 'p',
        expectations: ['e'],
        toolExpectations: { mustRun: ['csvsum'], mustSucceed: ['csvsum'] },
      },
    ] });
    const suite = parseEvalSuite(withMustSucceed);
    expect(suite.evals[0]?.toolExpectations).toEqual({ mustRun: ['csvsum'], mustSucceed: ['csvsum'] });
  });

  it('rejects an empty mustSucceed executable name (each must be a non-empty name)', () => {
    const badName = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expectations: ['e'], toolExpectations: { mustSucceed: [''] } },
    ] });
    expect(() => parseEvalSuite(badName)).toThrow(EvalInputError);
  });

  it('rejects an unknown key inside toolExpectations (the sub-object is VAT-defined, so it is strict)', () => {
    const badSubKey = JSON.stringify({ skill_name: 'demo', evals: [
      {
        id: 1,
        prompt: 'p',
        expected_output: 'o',
        expectations: ['e'],
        toolExpectations: { mustRun: ['Read'], mustRunTypo: ['Grep'] },
      },
    ] });
    expect(() => parseEvalSuite(badSubKey)).toThrow(EvalInputError);
  });

  it('flags a near-miss typo of `toolExpectations` at the entry level', () => {
    const typo = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'], toolExpectation: { mustRun: ['Read'] } },
    ] });
    expect(() => parseEvalSuite(typo)).toThrow(/did you mean.*toolExpectations/i);
  });

  it('flags a near-miss typo of `tier` at the entry level', () => {
    const typo = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'], tiers: 1 },
    ] });
    expect(() => parseEvalSuite(typo)).toThrow(/did you mean.*tier/i);
  });

  /**
   * The zod `.strict()`/schema failure text was the one suite-derived string
   * reaching stderr with NO sanitizer on it, and it is not an obscure corner: the
   * issue paths it lists ARE suite-authored keys, and `toolExpectations` is
   * `.strict()`, so an adopter typo inside it is the normal way to see this
   * message.
   *
   * ⚠️ THE CHARACTER CLASS MATTERS, and the obvious probe proves nothing.
   * `ZodError.message` is `JSON.stringify`d, which escapes everything BELOW U+0020
   * — so a 7-bit `ESC[2K` arrives as the harmless literal text `[2K` and a
   * test built from it passes with no sanitizer at all (verified: it did). What
   * `JSON.stringify` leaves ALONE is everything at or above U+0020: the 8-bit C1
   * CSI introducer U+009B (`CSI 31m` in one byte — a real terminal attack), DEL,
   * and the bidi overrides. Those are what actually reached stderr.
   */
  it('neutralizes a schema-failure message without collapsing its lines', () => {
    // U+009B is the 8-bit form of `ESC[`; U+202E flips everything after it.
    const C1_CSI = String.fromCharCode(0x9b);
    const RLO = String.fromCharCode(0x202e);
    const painted = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expectations: ['e'], toolExpectations: { [`mustRun${C1_CSI}31m${RLO}`]: ['Read'] } },
    ] });
    let message = '';
    try {
      parseEvalSuite(painted);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message, 'the strict sub-schema was expected to reject the key').toContain('failed schema validation');
    expect(message, 'an 8-bit CSI from a suite key reached the terminal').not.toContain(C1_CSI);
    expect(message, 'a bidi override from a suite key reached the terminal').not.toContain(RLO);
    // ...and the structure survived. A single-line sanitizer would fold zod's
    // ten-line per-issue list into one capped string, which is the regression this
    // guards: on a 200-eval suite that list is the only thing naming the bad entry.
    expect(message.split('\n').length, 'the issue list was collapsed onto one line')
      .toBeGreaterThan(1);
  });

  it('still parses a normal suite without tier/toolExpectations (both remain optional)', () => {
    const suite = parseEvalSuite(VALID);
    expect(suite.evals[0]?.tier).toBeUndefined();
    expect(suite.evals[0]?.toolExpectations).toBeUndefined();
  });
});

function setupEvalWorkspaces(): { evalsDir: string; workspacesRoot: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-evalws-'));
  const evalsDir = safePath.join(root, 'evals');
  const workspacesRoot = safePath.join(root, 'workspaces');
  mkdirSyncReal(safePath.join(evalsDir, 'fixtures'), { recursive: true });
  mkdirSyncReal(workspacesRoot, { recursive: true });
  writeFileSync(safePath.join(evalsDir, FIXTURES_DOC), '[bad](./missing.md)\n', 'utf-8');
  return { evalsDir, workspacesRoot };
}

/**
 * A non-baseline run's arm dirs. The token is opaque ON PURPOSE — it is quoted to
 * the executor as its working directory, so an arm-named segment tells a control
 * arm which side of the A/B it is on. These tests reference `.with` rather than a
 * literal so they keep testing the LAYOUT rather than pinning the naming scheme.
 */
const WITH_ONLY = { with: 'a1b2c3d4e5f60718' } as const;

/** Stage a one-eval suite declaring `rel`, asserting it throws with no control bytes in the message. */
function expectStagingRejects(rel: string, id: number): void {
  const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
  const suite = { skill_name: 'demo', evals: [
    { id, prompt: 'p', expected_output: 'o', files: [rel], expectations: ['e'] },
  ] };
  expectNoControlBytes(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY }));
}

describe('stageEvalWorkspaces', () => {
  // The segment must not spell the arm. A regression here is silent and total:
  // every control-arm prompt would carry `/without/` in its cwd.
  it('never puts an arm NAME in the path', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const armDirs = { with: 'aaaa1111bbbb2222', without: 'cccc3333dddd4444' };
    const suite = { skill_name: 'demo', evals: [
      { id: 9, prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs });

    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...readdirSync(workspacesRoot)].sort(byName)).toEqual(
      [armDirs.with, armDirs.without].sort(byName),
    );
    expect(readdirSync(workspacesRoot)).not.toContain('with');
    expect(readdirSync(workspacesRoot)).not.toContain('without');
  });

  it('copies declared files into <workspacesRoot>/<id>/ preserving structure', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 7, prompt: 'fix', expected_output: 'fixed', files: [FIXTURES_DOC], expectations: ['ok'] },
    ] };
    const returned = stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY });
    expect(returned).toBe(workspacesRoot);
    expect(existsSync(safePath.join(workspacesRoot, WITH_ONLY.with, '7', FIXTURES_DOC))).toBe(true);
  });

  it('stages files under a string id directory (filesystem-safe via joinUnderRoot)', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 'dollar-quote-recovery', prompt: 'fix', expected_output: 'fixed', files: [FIXTURES_DOC], expectations: ['ok'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY });
    expect(existsSync(safePath.join(workspacesRoot, WITH_ONLY.with, 'dollar-quote-recovery', FIXTURES_DOC))).toBe(true);
  });

  // An eval with no `files` still gets an EMPTY workspace. Before, it got none,
  // and the executor fell back to running inside the staged subject dir — which
  // for a --baseline run put the skill-absent arm's cwd inside the skill it was
  // supposed to be denied. The directory existing is the fix.
  it('creates an empty workspace for an eval with no files (never falls back to the subject dir)', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY });
    const dir = safePath.join(workspacesRoot, WITH_ONLY.with, '1');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates an empty workspace for an eval with an empty files array', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 2, prompt: 'p', expected_output: 'o', files: [], expectations: ['e'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY });
    const dir = safePath.join(workspacesRoot, WITH_ONLY.with, '2');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('throws EvalInputError when a declared file is absent', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 3, prompt: 'p', expected_output: 'o', files: ['fixtures/nope.md'], expectations: ['e'] },
    ] };
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY })).toThrow(EvalInputError);
  });

  it('throws EvalInputError (not raw Error) when a declared file contains a path traversal escape', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 4, prompt: 'p', expected_output: 'o', files: ['../escape.md'], expectations: ['e'] },
    ] };
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY })).toThrow(EvalInputError);
  });

  // All three staging failures interpolate the suite-authored `files[]` entry (and
  // the derived path / OS error text built from it) into a message that reaches
  // stdout via the `Summary:` line. Each site is asserted separately because each
  // builds its message independently.
  describe('suite-authored file paths reach the operator sanitized', () => {
    it('on a containment escape', () => {
      expectStagingRejects(`../${TERMINAL_PAINT}escape.md`, 5);
    });

    it('on an absent declared file', () => {
      expectStagingRejects(`fixtures/${TERMINAL_PAINT}nope.md`, 6);
    });

    // Skipped on Windows, where the scenario cannot be built: this case needs a
    // REAL file whose NAME carries the paint, and the Win32 API rejects every
    // character below 0x20 in a filename, so `writeFileSync` fails ENOENT before
    // staging is ever reached. The sanitizer itself is covered on every platform
    // by the two sibling cases above, which reject before touching the disk.
    it.skipIf(process.platform === 'win32')('on a copy failure (the OS error text carries the path too)', () => {
      const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
      const rel = `fixtures/${TERMINAL_PAINT}doc.md`;
      writeFileSync(safePath.join(evalsDir, rel), 'content\n', 'utf-8');
      // A directory already sitting where the file must land: cpSync refuses to
      // overwrite it, and names both paths in the error it throws.
      mkdirSyncReal(safePath.join(workspacesRoot, WITH_ONLY.with, '7', rel), { recursive: true });
      const suite = { skill_name: 'demo', evals: [
        { id: 7, prompt: 'p', expected_output: 'o', files: [rel], expectations: ['e'] },
      ] };

      expectNoControlBytes(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, armDirs: WITH_ONLY }));
    });
  });
});
