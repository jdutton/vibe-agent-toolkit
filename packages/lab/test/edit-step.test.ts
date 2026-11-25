/**
 * An edit arm's plan: which files, in which order, and bytes that differ every
 * round — and the one spelling of an arm state.
 */

import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import { collectArmsSelection, collectEditPath } from '../src/bin/vat-lab.js';
import { armStateName, armStateSegment, parseArmState } from '../src/harness/arm-state.js';
import { type EditSpec, planEdits } from '../src/harness/edit-step.js';

/** Tracked markdown, deliberately out of order and with a code-unit trap: 'B' sorts before 'a'. */
const TRACKED = ['docs/b.md', 'docs/a.md', 'README.md', 'Zeta.md', 'alpha.md'];

/**
 * @param count - Files to edit
 * @param kind - What to do to them
 * @returns The spec, picking from the tracked set
 */
function spec(count: number, kind: EditSpec['kind'] = 'modify'): EditSpec {
  return { kind, count, paths: null };
}

describe('planEdits', () => {
  it('picks the first N tracked files in code-unit order, not locale order', () => {
    expect(planEdits(TRACKED, spec(3), 0).map((action) => action.path)).toEqual(['README.md', 'Zeta.md', 'alpha.md']);
  });

  it('is deterministic for one (tracked, spec, round), whatever order the tracked set arrives in', () => {
    expect(planEdits([...TRACKED].reverse(), spec(4), 2)).toEqual(planEdits(TRACKED, spec(4), 2));
  });

  it("gives every round new bytes, so no round can be served an earlier round's facts", () => {
    const appended = [0, 1, 2].map((round) => planEdits(TRACKED, spec(1), round).map((action) => ('append' in action ? action.append : '')));

    expect(new Set(appended.map((bytes) => bytes.join('\0'))).size).toBe(3);
  });

  it('creates lab-edit-<r>-<i>.md beside each picked file, and deletes the picked files', () => {
    expect(planEdits(TRACKED, spec(2, 'create'), 3).map((action) => action.path)).toEqual(['lab-edit-3-0.md', 'lab-edit-3-1.md']);
    expect(planEdits(['docs/a.md'], spec(1, 'create'), 0).map((action) => action.path)).toEqual(['docs/lab-edit-0-0.md']);
    expect(planEdits(TRACKED, spec(1, 'delete'), 0)).toEqual([{ kind: 'delete', path: 'README.md' }]);
  });

  it('rotates a delete window by round, so no two rounds delete the same files, wrapping at the end', () => {
    const window = (round: number): string[] => planEdits(TRACKED, spec(2, 'delete'), round).map((action) => action.path);

    expect([0, 1, 2].map((round) => window(round))).toEqual([
      ['README.md', 'Zeta.md'],
      ['alpha.md', 'docs/a.md'],
      ['docs/b.md', 'README.md'],
    ]);
  });

  it('edits the --edit paths instead of the tracked set when they are given', () => {
    expect(planEdits(TRACKED, { kind: 'modify', count: 1, paths: ['docs/z.md'] }, 0).map((action) => action.path)).toEqual(['docs/z.md']);
  });

  it('refuses a count above the tracked markdown set, naming the count', () => {
    expect(() => planEdits(TRACKED, spec(6), 0)).toThrow(/warm-edit6 edits 6 files, but there are only 5 tracked markdown files/u);
    expect(() => planEdits(TRACKED, spec(0), 0)).toThrow(/positive whole number/u);
  });
});

describe('the arm state spelling', () => {
  it('reads warm, cold and warm-edit<N>[:<kind>], and nothing else', () => {
    expect(parseArmState('warm')).toBe('warm');
    expect(parseArmState('cold')).toBe('cold');
    expect(parseArmState('warm-edit50')).toEqual({ warm: 'edit', count: 50, kind: 'modify' });
    expect(parseArmState('warm-edit1:create')).toEqual({ warm: 'edit', count: 1, kind: 'create' });
    for (const bad of ['hot', 'warm-edit0', 'warm-edit', 'warm-edit1:rename', 'warm-edit01', 'cold-edit1']) {
      expect(parseArmState(bad)).toBeNull();
    }
  });

  it('spells one arm one way: the default kind is never spelled, and a directory name has no colon', () => {
    const modify = parseArmState('warm-edit1:modify');
    const create = parseArmState('warm-edit1:create');
    if (modify === null || create === null) throw new Error('both parse');

    expect(armStateName(modify)).toBe('warm-edit1');
    expect(armStateName(create)).toBe('warm-edit1:create');
    expect(armStateSegment(create)).toBe('warm-edit1-create');
    expect(armStateName('cold')).toBe('cold');
  });

  it('is what perf arms --arm accepts, and --edit takes relative paths only', () => {
    const [arm] = collectArmsSelection('main:ci-c:warm-edit50:delete', undefined);

    expect(arm?.state).toEqual({ warm: 'edit', count: 50, kind: 'delete' });
    expect(() => collectArmsSelection('main:ci-c:warm-edit0', undefined)).toThrow(/warm-edit<N>/u);
    expect(collectEditPath(" docs/guide.md ", ['README.md'])).toEqual(['README.md', 'docs/guide.md']);
    expect(() => collectEditPath('/etc/passwd', undefined)).toThrow(/relative to the subject/u);
  });

  it('refuses an --edit path given twice: one file edited twice leaves one changed path, never the count asked for', () => {
    expect(() => collectEditPath('docs/guide.md', ['docs/guide.md'])).toThrow(InvalidArgumentError);
    expect(() => collectEditPath(' docs/guide.md ', ['README.md', 'docs/guide.md'])).toThrow(/--edit names 'docs\/guide\.md' more than once/u);
  });
});
