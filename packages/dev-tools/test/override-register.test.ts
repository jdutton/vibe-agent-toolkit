/**
 * Root `overrides` never reach an adopter, so every pin states whether a published workspace
 * reaches the package it pins, and for one that does, every range an adopter resolves must admit the
 * pin or be named as an exception. The check holds both to `bun.lock`, both ways.
 */
import { describe, expect, it } from 'vitest';

import { type OverrideRow, overrideFindings, publishedReach } from '../src/override-register.js';

/**
 * A bun.lock: a private root, a published `packages/lib` depending on `chain-a`, which declares
 * `leaf ^5.0.0` and gets a nested 5.x copy, and a private `packages/tools` depending on `dev-dep`.
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

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('publishedReach', () => {
  it('follows runtime, optional and peer edges from published workspaces only, nested copies included', () => {
    expect([...publishedReach(LOCK, PUBLISHED).keys()].toSorted(byName)).toEqual(['chain-a', 'leaf', 'opt', 'peer-of-leaf']);
  });

  it('records the range each reached package declares', () => {
    expect(publishedReach(LOCK, PUBLISHED).get('leaf')).toEqual([{ from: 'chain-a', range: '^5.0.0' }]);
  });

  it('reaches nothing from a private workspace or the root devDependencies', () => {
    expect([...publishedReach(LOCK, new Set()).keys()]).toEqual([]);
  });

  it("follows a published workspace's own copy, which Bun keys under the workspace name, not the hoisted one", () => {
    // Bun 1.3.9 writes `<workspace name>/<dep>` for a workspace's copy that differs from the hoisted one.
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "root", "devDependencies": { "x": "1.0.0", }, },
        "packages/lib": { "name": "@scope/lib", "dependencies": { "x": "2.0.0", }, },
      },
      "packages": {
        "x": ["x@1.0.0", "", { "dependencies": { "dev-only-dep": "*" } }, "sha512-a"],
        "@scope/lib/x": ["x@2.0.0", "", { "dependencies": { "runtime-dep": "*" } }, "sha512-b"],
        "dev-only-dep": ["dev-only-dep@1.0.0", "", {}, "sha512-c"],
        "runtime-dep": ["runtime-dep@1.0.0", "", {}, "sha512-d"],
      }
    }`;

    expect([...publishedReach(lock, PUBLISHED).keys()].toSorted(byName)).toEqual(['runtime-dep', 'x']);
  });
});

describe('overrideFindings', () => {
  const reach = publishedReach(LOCK, PUBLISHED);
  const register: Record<string, OverrideRow> = {
    leaf: { reach: 'published', reason: 'advisory', outsideRanges: { 'chain-a ^5.0.0': 'outside the advisory range' } },
    'dev-leaf': { reach: 'dev-only', reason: 'advisory' },
  };
  const overrides = { leaf: '6.2.4', 'dev-leaf': '1.0.0' };

  it('passes when every pin has a row stating its reach truly', () => {
    expect(overrideFindings(overrides, reach, register)).toEqual([]);
  });

  it('passes a published row with no exceptions when every declared range admits the pin', () => {
    const admitting = { ...register, leaf: { reach: 'published', reason: 'advisory', outsideRanges: {} } as const };

    expect(overrideFindings({ ...overrides, leaf: '5.3.2' }, reach, admitting)).toEqual([]);
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
    const wrong = { ...register, 'dev-leaf': { reach: 'published', reason: 'advisory', outsideRanges: {} } as const };

    expect(overrideFindings(overrides, reach, wrong)).toEqual([expect.stringContaining('dev-leaf is registered published, but no published workspace reaches it')]);
  });

  it('refuses a blank reason', () => {
    expect(overrideFindings(overrides, reach, { ...register, 'dev-leaf': { reach: 'dev-only', reason: ' ' } })).toEqual([expect.stringContaining('has no reason')]);
  });

  it('refuses a pin a reached range does not admit: basic-ftp 6.2.4 over get-uri ^5.3.1 fixes only this repo', () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "root", },
        "packages/lib": { "name": "@scope/lib", "dependencies": { "get-uri": "^8.0.0", }, },
      },
      "packages": {
        "get-uri": ["get-uri@8.0.1", "", { "dependencies": { "basic-ftp": "^5.3.1" } }, "sha512-a"],
        "basic-ftp": ["basic-ftp@6.2.4", "", {}, "sha512-b"],
      }
    }`;
    const row: Record<string, OverrideRow> = { 'basic-ftp': { reach: 'published', reason: 'GHSA-5pm8-86m8-9m6r', outsideRanges: {} } };

    expect(overrideFindings({ 'basic-ftp': '6.2.4' }, publishedReach(lock, PUBLISHED), row)).toEqual([
      expect.stringContaining('override basic-ftp pins 6.2.4, but get-uri declares ^5.3.1, which does not admit it'),
    ]);
  });

  it('refuses an exception no declared range needs any more', () => {
    expect(overrideFindings({ ...overrides, leaf: '5.3.2' }, reach, register)).toEqual([expect.stringContaining('outsideRanges names "chain-a ^5.0.0", which no reached package declares outside the pin')]);
  });

  it('refuses an exception with a blank reason', () => {
    const wrong = { ...register, leaf: { reach: 'published', reason: 'advisory', outsideRanges: { 'chain-a ^5.0.0': '' } } as const };

    expect(overrideFindings(overrides, reach, wrong)).toEqual([expect.stringContaining('outsideRanges "chain-a ^5.0.0" has no reason')]);
  });

  it('refuses a published pin that is not a version', () => {
    expect(overrideFindings({ ...overrides, leaf: 'workspace:*' }, reach, register)).toEqual([expect.stringContaining('pins workspace:*, which is not a version')]);
  });
});
