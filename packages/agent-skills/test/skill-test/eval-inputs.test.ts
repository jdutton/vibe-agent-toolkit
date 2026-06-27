/* eslint-disable security/detect-non-literal-fs-filename -- tests use controlled temp directories */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { EvalInputError, parseEvalSuite, stageEvalWorkspaces } from '../../src/skill-test/eval-inputs.js';

const FIXTURES_DOC = 'fixtures/doc.md';

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

  it('throws EvalInputError on an unknown field (strict)', () => {
    const extra = JSON.stringify({ skill_name: 'demo', evals: [{ id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'], bogus: true }] });
    expect(() => parseEvalSuite(extra)).toThrow(EvalInputError);
  });

  it('throws EvalInputError on duplicate eval ids', () => {
    const dup = JSON.stringify({ skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
      { id: 1, prompt: 'p2', expected_output: 'o2', expectations: ['e2'] },
    ] });
    expect(() => parseEvalSuite(dup)).toThrow(/unique/i);
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
    ] } as const;
    const returned = stageEvalWorkspaces({ suite, evalsDir, workspacesRoot });
    expect(returned).toBe(workspacesRoot);
    expect(existsSync(safePath.join(workspacesRoot, '7', FIXTURES_DOC))).toBe(true);
  });

  it('skips evals with no files', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 1, prompt: 'p', expected_output: 'o', expectations: ['e'] },
    ] } as const;
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot });
    expect(existsSync(safePath.join(workspacesRoot, '1'))).toBe(false);
  });

  it('skips evals with an empty files array', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 2, prompt: 'p', expected_output: 'o', files: [], expectations: ['e'] },
    ] } as const;
    stageEvalWorkspaces({ suite, evalsDir, workspacesRoot });
    expect(existsSync(safePath.join(workspacesRoot, '2'))).toBe(false);
  });

  it('throws EvalInputError when a declared file is absent', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 3, prompt: 'p', expected_output: 'o', files: ['fixtures/nope.md'], expectations: ['e'] },
    ] } as const;
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot })).toThrow(EvalInputError);
  });

  it('throws EvalInputError (not raw Error) when a declared file contains a path traversal escape', () => {
    const { evalsDir, workspacesRoot } = setupEvalWorkspaces();
    const suite = { skill_name: 'demo', evals: [
      { id: 4, prompt: 'p', expected_output: 'o', files: ['../escape.md'], expectations: ['e'] },
    ] } as const;
    expect(() => stageEvalWorkspaces({ suite, evalsDir, workspacesRoot })).toThrow(EvalInputError);
  });
});
