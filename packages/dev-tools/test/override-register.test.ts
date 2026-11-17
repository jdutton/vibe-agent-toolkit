/**
 * Root `overrides` never reach an adopter, so every pin states whether a published workspace
 * reaches the package it pins, and the check holds that statement to `bun.lock` both ways.
 */
import { describe, expect, it } from 'vitest';

import { type OverrideRow, overrideFindings, publishedReach } from '../src/override-register.js';

/**
 * A bun.lock: a private root, a published `packages/lib` depending on `chain-a`, which depends on
 * `leaf` with a nested copy under it, and a private `packages/tools` depending on `dev-dep`.
 */
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "dev-dep": "^1.0.0", }, },
    "packages/lib": { "name": "@scope/lib", "dependencies": { "chain-a": "^1.0.0", }, "optionalDependencies": { "opt": "^1.0.0", }, },
    "packages/tools": { "name": "tools", "dependencies": { "dev-dep": "^1.0.0", }, },
  },
  "packages": {
    "chain-a": ["chain-a@1.0.0", "", { "dependencies": { "leaf": "^5.0.0" } }, "sha512-a"],
    "chain-a/leaf": ["leaf@5.3.1", "", { "peerDependencies": { "peer-of-leaf": "*" } }, "sha512-b"],
    "leaf": ["leaf@6.2.4", "", {}, "sha512-c"],
    "peer-of-leaf": ["peer-of-leaf@1.0.0", "", {}, "sha512-d"],
    "opt": ["opt@1.0.0", "", {}, "sha512-e"],
    "dev-dep": ["dev-dep@1.0.0", "", { "dependencies": { "dev-leaf": "*" } }, "sha512-f"],
    "dev-leaf": ["dev-leaf@1.0.0", "", {}, "sha512-g"],
  }
}`;

const PUBLISHED = new Set(['packages/lib']);

describe('publishedReach', () => {
  it('follows runtime, optional and peer edges from published workspaces only, nested copies included', () => {
    expect([...publishedReach(LOCK, PUBLISHED)].toSorted((a, b) => a.localeCompare(b))).toEqual(['chain-a', 'leaf', 'opt', 'peer-of-leaf']);
  });

  it('reaches nothing from a private workspace or the root devDependencies', () => {
    expect([...publishedReach(LOCK, new Set())]).toEqual([]);
  });
});

describe('overrideFindings', () => {
  const reach = publishedReach(LOCK, PUBLISHED);
  const register: Record<string, OverrideRow> = {
    leaf: { reach: 'published', reason: 'advisory', adopters: 'chain-a 1.0.1 declares ^6.2.4' },
    'dev-leaf': { reach: 'dev-only', reason: 'advisory' },
  };
  const overrides = { leaf: '6.2.4', 'dev-leaf': '1.0.0' };

  it('passes when every pin has a row stating its reach truly', () => {
    expect(overrideFindings(overrides, reach, register)).toEqual([]);
  });

  it('refuses a pin with no row', () => {
    expect(overrideFindings({ ...overrides, opt: '1.0.0' }, reach, register)).toEqual([expect.stringContaining('overrides opt with no OVERRIDE_REGISTER row')]);
  });

  it('refuses a row with no pin', () => {
    expect(overrideFindings({ leaf: '6.2.4' }, reach, register)).toEqual([expect.stringContaining('row for dev-leaf, which package.json no longer overrides')]);
  });

  it('refuses a dev-only row on a package a published workspace reaches: the adopter ignores the pin', () => {
    const wrong = { ...register, leaf: { reach: 'dev-only', reason: 'advisory' } as const };

    expect(overrideFindings(overrides, reach, wrong)).toEqual([expect.stringContaining('leaf is registered dev-only, but a published workspace reaches it')]);
  });

  it('refuses a published row on a package nothing published reaches', () => {
    const wrong = { ...register, 'dev-leaf': { reach: 'published', reason: 'advisory', adopters: 'x' } as const };

    expect(overrideFindings(overrides, reach, wrong)).toEqual([expect.stringContaining('dev-leaf is registered published, but no published workspace reaches it')]);
  });

  it.each([
    ['a blank reason', { reach: 'dev-only', reason: ' ' } as const, 'has no reason'],
  ])('refuses %s', (_case, row, message) => {
    expect(overrideFindings(overrides, reach, { ...register, 'dev-leaf': row })).toEqual([expect.stringContaining(message)]);
  });

  it('refuses a published row that does not say why adopters are safe', () => {
    const wrong = { ...register, leaf: { reach: 'published', reason: 'advisory', adopters: '' } as const };

    expect(overrideFindings(overrides, reach, wrong)).toEqual([expect.stringContaining('does not say why they are safe')]);
  });
});
