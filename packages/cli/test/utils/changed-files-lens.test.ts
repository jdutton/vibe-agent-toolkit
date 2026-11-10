/**
 * The changed-files lens refuses rather than answering empty: with no base, or with a base git
 * cannot resolve, an empty `changed_files` would read as "nothing changed" and every check over it
 * would pass. The git reading itself is `gitChangedFiles`'s, under test in utils.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitChangedFiles = vi.hoisted(() => vi.fn());
vi.mock('@vibe-agent-toolkit/utils/git', () => ({ gitChangedFiles }));

const { evaluateChangedFilesLens, NO_BASE_REFUSAL } = await import('../../src/utils/changed-files-lens.js');

describe('evaluateChangedFilesLens', () => {
  beforeEach(() => {
    gitChangedFiles.mockReset();
  });

  it('refuses with the fix when the run was given no base, and asks git nothing', () => {
    expect(evaluateChangedFilesLens('/corpus', undefined)).toStrictEqual({ refused: NO_BASE_REFUSAL, refusal: 'USAGE_INVALID' });
    expect(NO_BASE_REFUSAL).toContain('--base <ref>');
    expect(gitChangedFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['base', 'USAGE_INVALID'],
    ['git-failed', 'BACKEND_UNAVAILABLE'],
    ['repository', 'INPUT_UNREADABLE'],
  ])('refuses with git\'s reason, and a %s fault as %s', (kind, refusal) => {
    gitChangedFiles.mockReturnValue({ ok: false, kind, reason: 'The reason.' });

    expect(evaluateChangedFilesLens('/corpus', 'nope')).toStrictEqual({
      refused: 'changed_files cannot be evaluated: The reason.',
      refusal,
    });
  });

  it('hands back every changed file as a row, asking git about the run\'s root and base', () => {
    const files = [
      { path: 'docs/a.md', status: 'modified', oldPath: null, similarity: null },
      { path: 'docs/b.md', status: 'renamed', oldPath: 'docs/old-b.md', similarity: 92 },
    ];
    gitChangedFiles.mockReturnValue({ ok: true, baseCommit: 'abc123', files });

    expect(evaluateChangedFilesLens('/corpus', 'origin/main')).toStrictEqual({
      rows: { changedFiles: files },
      population: null,
    });
    expect(gitChangedFiles).toHaveBeenCalledWith({ root: '/corpus', base: 'origin/main' });
  });

  it('hands back an EMPTY relation when git answered that nothing changed: an answer, not a refusal', () => {
    gitChangedFiles.mockReturnValue({ ok: true, baseCommit: 'abc123', files: [] });

    expect(evaluateChangedFilesLens('/corpus', 'HEAD')).toStrictEqual({ rows: { changedFiles: [] }, population: null });
  });
});

/** One documented `changed_files` refusal: its cause, git's fault kind, and the code it is documented to carry. */
interface DocumentedRefusal {
  readonly cause: string;
  readonly kind: string;
  readonly code: string;
}

/** A refusal-table row: `| cause | \`kind\` | \`CODE\` |`. */
const REFUSAL_ROW = /^\| (.+) \| `(base|git-failed|repository)` \| `([A-Z_]+)` \|$/;

/** The `changed_files` refusal table a document carries. */
function refusalTableOf(file: string): DocumentedRefusal[] {
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    const match = REFUSAL_ROW.exec(line);
    return match === null ? [] : [{ cause: match[1] ?? '', kind: match[2] ?? '', code: match[3] ?? '' }];
  });
}

/** The two documents that state the table: the CLI reference and the shipped skill. */
const DOCUMENTED = {
  reference: refusalTableOf(safePath.join(import.meta.dirname, '..', '..', 'docs', 'resources.md')),
  skill: refusalTableOf(
    safePath.join(import.meta.dirname, '..', '..', '..', 'vat-development-agents', 'resources', 'skills', 'vat-knowledge-resources.md'),
  ),
};

// The table is the class fix for a documented cause → code that drifted from the lens: every row is
// checked against what the lens actually maps its fault kind to.
describe('the documented changed_files refusal table', () => {
  it('is stated, and stated identically, in the CLI reference and the skill', () => {
    expect(DOCUMENTED.reference.length).toBeGreaterThanOrEqual(20);
    expect(DOCUMENTED.skill).toStrictEqual(DOCUMENTED.reference);
  });

  it.each(DOCUMENTED.reference.map((row) => [row.cause, row.kind, row.code]))(
    'documents "%s" (%s) with the code the lens refuses it with, %s',
    (_cause, kind, code) => {
      gitChangedFiles.mockReset();
      gitChangedFiles.mockReturnValue({ ok: false, kind, reason: 'The reason.' });

      expect(evaluateChangedFilesLens('/corpus', 'main')).toMatchObject({ refusal: code });
    },
  );

  it('documents no --base with the code the lens refuses it with', () => {
    const noBase = DOCUMENTED.reference.find((row) => row.cause === 'no `--base`');

    expect(evaluateChangedFilesLens('/corpus', undefined)).toMatchObject({ refusal: noBase?.code });
  });
});
