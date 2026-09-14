/**
 * The comment-density ratchet on the REAL tree — the same check the structure
 * gate runs, so a package that grew prose, or one whose ceiling was left
 * standing after prose left, is a red test before it is a red gate. Reads
 * every `packages/*\/src` file, which is why it is not a unit test.
 */

import { describe, expect, it } from 'vitest';

import { COMMENT_DENSITY_CEILINGS } from '../../src/comment-density-ceilings.js';
import { checkCommentDensity, measurePackageDensities } from '../../src/comment-density.js';
import { PROJECT_ROOT } from '../../src/common.js';

describe('comment-density ratchet on the real tree', () => {
  it('every package sits within its comment-density ceiling, and every ceiling names a package', () => {
    expect(checkCommentDensity(PROJECT_ROOT).map((finding) => finding.message)).toEqual([]);
  });

  it('measures the packages the ceilings table names, and nothing it does not', () => {
    const measured = [...measurePackageDensities(PROJECT_ROOT).keys()];
    expect(measured).toEqual(Object.keys(COMMENT_DENSITY_CEILINGS).sort((a, b) => a.localeCompare(b)));
  });
});
