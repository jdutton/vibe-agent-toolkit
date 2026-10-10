/**
 * `vat claude context --all` answers the whole tree and takes no paths. A path or
 * `--discoverable` beside it used to be dropped without a word: the run printed
 * the cost map, exit 0, and never mentioned what the caller named.
 */

import { describe, expect, it } from 'vitest';

import { __internal } from '../../../src/commands/claude/context.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';
import { thrownBy } from '../../helpers/refusal-doubles.js';

/** The working directory: a named path then resolves INSIDE the root, so only `--all` can refuse it. */
const ROOT = process.cwd();

describe('vat claude context --all - what it refuses to ignore', () => {
  it.each([
    ['a named path', ['docs/a.md'], {}, 'docs/a.md'],
    ['--discoverable', [], { discoverable: true }, '--discoverable'],
  ])('refuses --all with %s as USAGE_INVALID, naming it', (_label, paths, flags, named) => {
    const refused = thrownBy(() => __internal.requestedTargets(ROOT, paths, { all: true, ...flags }));

    expect(refusalCodeOf(refused)).toBe('USAGE_INVALID');
    expect((refused as Error).message).toContain(named);
    expect((refused as Error).message).toContain('--all');
  });

  it('asks for no per-path target under a bare --all', () => {
    expect(__internal.requestedTargets(ROOT, [], { all: true })).toEqual([]);
  });

  it('answers the named paths without --all', () => {
    expect(__internal.requestedTargets(ROOT, ['docs/a.md'], {})).toEqual(['docs/a.md']);
  });
});
