/**
 * A `write` fill stages in a fresh random name made by a plain `mkdir` (so the tree it becomes
 * gets the caller's mode). A collision with a leftover of the same name must draw another name,
 * as `mkdtemp` does for itself — never fail the change, never write into the leftover.
 */
import type * as Crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { safePath } from '../../src/path-core.js';
import { applyTreePlan } from '../../src/tree-change/apply.js';
import { planTreeChanges } from '../../src/tree-change/plan.js';

import { plant, readText, replaceWith, treeChangeSuite } from './tree-change-test-kit.js';

/** The bytes the next `randomBytes` call answers with, once; every later call is real. */
const scripted = vi.hoisted(() => ({ next: undefined as Buffer | undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer => {
      const bytes = scripted.next;
      scripted.next = undefined;
      return bytes ?? actual.randomBytes(size);
    },
  };
});

const suite = treeChangeSuite('tree-change-staging-name-');

describe('applyTreePlan — a write fill\'s staging name', () => {
  it('draws another name when the first collides with a leftover, leaving the leftover as it was', async () => {
    const root = suite.root();
    const out = safePath.join(root, 'out');
    // `randomBytes(4)` of "aaaa" is the hex suffix 61616161: plant a leftover under exactly that name.
    const leftover = '.out.vat-staged-61616161';
    plant(root, { [`${leftover}/keep.txt`]: 'leftover' });
    scripted.next = Buffer.from('aaaa');

    await applyTreePlan(await planTreeChanges([replaceWith(out, { 'x.txt': 'x' }, 'out')]));

    expect(readText(safePath.join(out, 'x.txt'))).toBe('x');
    expect(readText(safePath.join(root, leftover, 'keep.txt'))).toBe('leftover');
  });
});
