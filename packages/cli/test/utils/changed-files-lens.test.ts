/**
 * The changed-files lens refuses rather than answering empty: with no base, or with a base git
 * cannot resolve, an empty `changed_files` would read as "nothing changed" and every check over it
 * would pass. The git reading itself is `gitChangedFiles`'s, under test in utils.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitChangedFiles = vi.hoisted(() => vi.fn());
vi.mock('@vibe-agent-toolkit/utils/git', () => ({ gitChangedFiles }));

const { evaluateChangedFilesLens, NO_BASE_REFUSAL } = await import('../../src/utils/changed-files-lens.js');

describe('evaluateChangedFilesLens', () => {
  beforeEach(() => {
    gitChangedFiles.mockReset();
  });

  it('refuses with the fix when the run was given no base, and asks git nothing', () => {
    expect(evaluateChangedFilesLens('/corpus', undefined)).toStrictEqual({ refused: NO_BASE_REFUSAL });
    expect(NO_BASE_REFUSAL).toContain('--base <ref>');
    expect(gitChangedFiles).not.toHaveBeenCalled();
  });

  it('refuses with git\'s reason when the base cannot be read', () => {
    gitChangedFiles.mockReturnValue({ ok: false, reason: 'The base "nope" does not name a commit.' });

    expect(evaluateChangedFilesLens('/corpus', 'nope')).toStrictEqual({
      refused: 'changed_files cannot be evaluated: The base "nope" does not name a commit.',
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
