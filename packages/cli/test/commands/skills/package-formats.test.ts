/**
 * `vat skills package --formats`: an unknown or empty format is the
 * invocation's mistake, refused — never dropped so the run writes less than it
 * was asked for and exits 0.
 */

import { describe, expect, it } from 'vitest';

import { __internal } from '../../../src/commands/skills/package.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';
import { thrownBy } from '../../helpers/refusal-doubles.js';

describe('skills package --formats', () => {
  it('defaults to directory and zip', () => {
    expect(__internal.resolvePackageFormats(undefined)).toEqual(['directory', 'zip']);
  });

  it('accepts every known format, trimmed', () => {
    expect(__internal.resolvePackageFormats(' directory , zip,npm,marketplace')).toEqual(['directory', 'zip', 'npm', 'marketplace']);
  });

  it('refuses an unknown format as USAGE_INVALID, naming it and the accepted set', () => {
    const error = thrownBy(() => __internal.resolvePackageFormats('directory,zpi'));
    expect(refusalCodeOf(error)).toBe('USAGE_INVALID');
    expect((error as Error).message).toContain('"zpi"');
    expect((error as Error).message).toContain('directory, zip, npm, marketplace');
  });

  it('refuses a list with no format in it', () => {
    expect(refusalCodeOf(thrownBy(() => __internal.resolvePackageFormats(' , ')))).toBe('USAGE_INVALID');
  });
});
