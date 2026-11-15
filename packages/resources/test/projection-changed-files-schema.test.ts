/**
 * A `changed_files` row states its rename source exactly when it is a rename: `oldPath` and
 * `similarity` are set together on a "renamed" row, and both are NULL on every other status.
 */

import { describe, expect, it } from 'vitest';

import { ChangedFileRowSchema } from '../src/schemas/projection-changed-files.js';

describe('ChangedFileRowSchema', () => {
  it.each([
    ['a rename with its source and score', { path: 'b.md', status: 'renamed', oldPath: 'a.md', similarity: 92 }],
    ['any other status with neither', { path: 'b.md', status: 'modified', oldPath: null, similarity: null }],
  ])('accepts %s', (_what, row) => {
    expect(ChangedFileRowSchema.safeParse(row).success).toBe(true);
  });

  it.each([
    ['a rename with no source', { path: 'b.md', status: 'renamed', oldPath: null, similarity: 92 }],
    ['a rename with no score', { path: 'b.md', status: 'renamed', oldPath: 'a.md', similarity: null }],
    ['an addition carrying a source', { path: 'b.md', status: 'added', oldPath: 'a.md', similarity: null }],
    ['a modification carrying a score', { path: 'b.md', status: 'modified', oldPath: null, similarity: 50 }],
  ])('refuses %s', (_what, row) => {
    expect(ChangedFileRowSchema.safeParse(row).success).toBe(false);
  });
});
