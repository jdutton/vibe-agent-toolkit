/* eslint-disable security/detect-non-literal-fs-filename -- tests use controlled temp directories */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { EvalInputError, parseEvalSuite, stageEvalWorkspaces } from '../../src/skill-test/eval-inputs.js';

const FIXTURES_DOC = 'fixtures/doc.md';
const DESCRIPTIVE_ID = 'cast-smell-typed-column';

const VALID = JSON.stringify({
  skill_name: 'demo',
  evals: [
    { id: 1, prompt: 'do a thing', expected_output: 'a thing is done', expectations: ['it did the thing'] },
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

describe('stageEvalWorkspaces', () => {
  it('copies declared files into <workspacesRoot>/<id>/ preserving structure', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 7, prompt: 'fix', expected_output: 'fixed', files: [FIXTURES_DOC], expectations: ['ok'] },
    ] };
    const returned = stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] });
    expect(returned).toBe(workspacesRoot);
    expect(existsSync(safePath.join(workspacesRoot, 'with', '7', FIXTURES_DOC))).toBe(true);
  });

  it('stages files under a string id directory (filesystem-safe via joinUnderRoot)', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 'dollar-quote-recovery', prompt: 'fix', expected_output: 'fixed', files: [FIXTURES_DOC], expectations: ['ok'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] });
    expect(existsSync(safePath.join(workspacesRoot, 'with', 'dollar-quote-recovery', FIXTURES_DOC))).toBe(true);
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
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] });
    const dir = safePath.join(workspacesRoot, 'with', '1');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates an empty workspace for an eval with an empty files array', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 2, prompt: 'p', expected_output: 'o', files: [], expectations: ['e'] },
    ] };
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] });
    const dir = safePath.join(workspacesRoot, 'with', '2');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('throws EvalInputError when a declared file is absent', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 3, prompt: 'p', expected_output: 'o', files: ['fixtures/nope.md'], expectations: ['e'] },
    ] };
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] })).toThrow(EvalInputError);
  });

  it('throws EvalInputError (not raw Error) when a declared file contains a path traversal escape', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 4, prompt: 'p', expected_output: 'o', files: ['../escape.md'], expectations: ['e'] },
    ] };
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot, arms: ['with'] })).toThrow(EvalInputError);
  });
});
