/**
 * `selectInjectionPoints`: the covering sample of the fault matrix. Pure — hand-built
 * traces, no fs.
 */
import type { FaultRule, FsCall, FsOpFamily } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import {
  ERRNOS_FOR_FAMILY,
  MAX_INJECTIONS_PER_FILE,
  assertWithinShardLimit,
  normaliseCallPath,
  selectInjectionPoints,
  shardOf,
  sideOfPath,
  type Roots,
} from './fault-matrix/select.js';

const byName = (a: string, b: string): number => a.localeCompare(b);
const roots: Roots = { home: '/c/home', tmp: '/c/tmp', project: '/c/project', sources: ['/c/src'] };

let seq = 0;
const call = (op: string, family: FsOpFamily, path: string, dest?: string): FsCall => ({
  seq: ++seq, op, family, api: 'sync', path, ...(dest === undefined ? {} : { dest }),
});

/** Which trace call (by seq) a rule hits, replaying the harness's own counting rule. */
function hitBy(rule: FaultRule, trace: readonly FsCall[]): FsCall | undefined {
  let seen = 0;
  for (const c of trace) {
    const matches = (rule.family === undefined || rule.family === c.family)
      && (rule.op === undefined || rule.op === c.op)
      && (rule.path(c.path) || (c.dest !== undefined && rule.path(c.dest)));
    if (matches && ++seen === (rule.nth ?? 1)) return c;
  }
  return undefined;
}

describe('sideOfPath', () => {
  it('classifies source, tmp (environment), home and project (destination), and the rest (environment)', () => {
    expect(sideOfPath('/c/src/a/SKILL.md', roots)).toBe('source');
    expect(sideOfPath('/c/home/.claude/x', roots)).toBe('destination');
    expect(sideOfPath('/c/project/out', roots)).toBe('destination');
    expect(sideOfPath('/c/tmp/stage', roots)).toBe('environment');
    expect(sideOfPath('/elsewhere', roots)).toBe('environment');
  });

  it('a source nested under home is still a source; a sibling that only shares a prefix is not', () => {
    expect(sideOfPath('/c/home/src/x', { ...roots, sources: ['/c/home/src'] })).toBe('source');
    expect(sideOfPath('/c/srcfoo/x', roots)).toBe('environment');
  });
});

/** Every chosen injection as `<call seq> <errno>`: what a selection injects, whatever the rule objects. */
const chosen = (trace: readonly FsCall[]): Set<string> =>
  new Set(selectInjectionPoints(trace, roots, 'covering').map((p) => `${hitBy(p.rule, trace)?.seq ?? 'none'} ${p.rule.errno}`));

// The class T12 (a realpath) and T15 (a marker's mkdir) each hit: a verb that gains one more call of a
// kind it already makes moved first/last-per-bucket selection off every site the new call outranked,
// so those sites went uninjected while the defects at them stayed live.
describe('selectInjectionPoints (covering) is append-stable', () => {
  it('appending a call of a kind the trace already makes never evicts an injection already chosen', () => {
    const trace = [
      call('mkdir', 'create', '/c/home/.claude/plugins/cache/mp/p/.v.vat-staged-x1'),
      call('mkdir', 'create', '/c/home/.claude/plugins/cache/mp/p/.v.vat-staged-x1/skills'),
      call('symlink', 'create', '/c/home/.claude/plugins/cache/mp/p/.v.vat-staged-x1/skills/s'),
      call('writeFile', 'write', '/c/home/.claude/plugins/cache/mp/p/.v.vat-staged-x1/plugin.json'),
      call('rm', 'remove', '/c/home/.claude/plugins/cache/mp/p/.v.vat-staged-x2.previous'),
    ];
    const before = chosen(trace);
    const appended = [...trace, call('mkdir', 'create', '/c/home/.claude/plugins/marketplaces/mp'), call('writeFile', 'write', '/c/home/.claude/plugins/marketplaces/.mp.marker')];
    const after = chosen(appended);
    expect([...before].filter((injection) => !after.has(injection))).toEqual([]);
  });

  // A removal retried once the owner has rwx is a step of its own: the repeat on one path is its own site.
  it('injects a repeat of one op on one path (a retry) as a site of its own, at its own nth', () => {
    const trace = [call('rm', 'remove', '/c/home/a/x'), call('chmod', 'meta', '/c/home/a/x'), call('rm', 'remove', '/c/home/a/x')];
    const retries = selectInjectionPoints(trace, roots, 'covering').filter((p) => p.rule.family === 'remove' && p.rule.nth === 2);
    expect(retries).toHaveLength(1);
    expect(retries[0] === undefined ? undefined : hitBy(retries[0].rule, trace)).toBe(trace[2]);
  });

  // Siblings a verb walks concurrently (Node's rm, a parallel copy) reach the trace in completion
  // order, which differs between runs: a choice that depends on it gives an injection a different id in each run.
  it('the order of calls on different paths moves nothing: two siblings swapped are injected the same', () => {
    const lead = call('rm', 'remove', '/c/home/a/x');
    const first = call('readdir', 'list', '/c/home/b');
    const y = call('readdir', 'list', '/c/home/b/y');
    const z = call('readdir', 'list', '/c/home/b/z');
    expect(chosen([lead, first, z, y])).toEqual(chosen([lead, first, y, z]));
  });
});

describe('selectInjectionPoints (covering)', () => {
  it('injects a bucket\'s first site with every errno of the family, once each', () => {
    const trace = [call('readFile', 'read', '/c/src/a')];
    const points = selectInjectionPoints(trace, roots, 'covering');
    const errnos = points.map((p) => p.rule.errno);
    expect(new Set(errnos)).toEqual(new Set(ERRNOS_FOR_FAMILY.read));
    expect(errnos).toHaveLength(ERRNOS_FOR_FAMILY.read.length);
    expect(points.every((p) => p.side === 'source' && p.rule.family === 'read' && hitBy(p.rule, trace) === trace[0])).toBe(true);
  });

  it('injects every later call (op × path × nth) as a site of its own, with one errno each', () => {
    const trace = [call('rm', 'remove', '/c/home/a/x'), call('rm', 'remove', '/c/home/b/y'), call('rm', 'remove', '/c/home/b/z'), call('rmdir', 'remove', '/c/home/a/w')];
    const hits = selectInjectionPoints(trace, roots, 'covering').map((p) => hitBy(p.rule, trace));
    expect(hits.filter((hit) => hit === trace[0])).toHaveLength(ERRNOS_FOR_FAMILY.remove.length);
    for (const later of trace.slice(1)) expect(hits.filter((hit) => hit === later)).toHaveLength(1);
  });

  it('a full disk lands on a data write mid-extraction: ENOSPC on the second file\'s first `write` under tmp, not only on an open', () => {
    const trace = [1, 2, 3].flatMap((n) => [
      call('open', 'write', `/c/tmp/stage/f${n}`),
      call('write', 'write', `/c/tmp/stage/f${n}`),
      call('write', 'write', `/c/tmp/stage/f${n}`),
    ]);
    const enospc = selectInjectionPoints(trace, roots, 'covering').filter((p) => p.rule.errno === 'ENOSPC').map((p) => hitBy(p.rule, trace));
    expect(enospc.some((hit) => hit?.op === 'write' && hit.path === '/c/tmp/stage/f2' && hit === trace[4])).toBe(true);
  });

  it('keeps sides apart: the same family on two sides is two buckets', () => {
    const trace = [call('readFile', 'read', '/c/src/a'), call('readFile', 'read', '/c/home/b')];
    const points = selectInjectionPoints(trace, roots, 'covering');
    const sides = new Set(points.map((p) => p.side));
    expect(sides).toEqual(new Set(['source', 'destination']));
    expect(points).toHaveLength(2 * ERRNOS_FOR_FAMILY.read.length);
  });

  // Path resolution is its own site: a realpath (the harness reaches `.native` too) must not take the
  // first/last slot of the meta bucket from the stat, lstat, chmod and close calls it sits among.
  it('buckets realpath apart, so the other meta calls keep their own sites and sweep', () => {
    const trace = [
      call('realpath', 'meta', '/c/home/.claude'),
      call('lstat', 'meta', '/c/home/.claude/a'),
      call('chmod', 'meta', '/c/home/.claude/b'),
      call('realpath', 'meta', '/c/home/.claude/c'),
    ];
    const hit = selectInjectionPoints(trace, roots, 'covering').map((p) => hitBy(p.rule, trace)?.op);
    expect(new Set(hit)).toEqual(new Set(['realpath', 'lstat', 'chmod']));
    // Two realpath sites: the first swept with every meta errno, the second with one.
    expect(hit.filter((op) => op === 'realpath')).toHaveLength(ERRNOS_FOR_FAMILY.meta.length + 1);
  });

  // A rename counts a call by its destination too: the second rename's source IS the first one's
  // destination, so the rule chosen for the second (its own site) must be its path's nth 2.
  it('computes nth per (op, path): a site whose first call is the second of its path is nth 2, not its trace position', () => {
    const trace = [
      call('stat', 'meta', '/c/home/x'),
      call('rename', 'rename', '/c/home/a/p', '/c/home/b/q'),
      call('rename', 'rename', '/c/home/b/q', '/c/home/c/r'),
    ];
    const points = selectInjectionPoints(trace, roots, 'covering').filter((p) => p.rule.family === 'rename');
    const second = points.find((p) => p.rule.nth === 2);
    expect(second?.rule.path('/c/home/b/q')).toBe(true);
    expect(second === undefined ? undefined : hitBy(second.rule, trace)).toBe(trace[2]);
    // every rule hits exactly one real call
    for (const p of points) expect(hitBy(p.rule, trace)).toBeDefined();
  });

  it('counts a rename by its destination too, as the harness does', () => {
    const trace = [call('rename', 'rename', '/c/home/a', '/c/home/b'), call('rename', 'rename', '/c/home/c', '/c/home/b')];
    for (const p of selectInjectionPoints(trace, roots, 'covering')) {
      const target = hitBy(p.rule, trace);
      expect(target).toBeDefined();
      // the rule is pinned to the path of the call it was derived from
      expect(p.call).toBe(target);
    }
  });

  it('routes errnos by family', () => {
    const trace = [call('mkdir', 'create', '/c/home/d')];
    const errnos = selectInjectionPoints(trace, roots, 'covering').map((p) => p.rule.errno).toSorted(byName);
    expect(errnos).toEqual([...ERRNOS_FOR_FAMILY.create].toSorted(byName));
  });

  it('emits nothing for an empty trace', () => {
    expect(selectInjectionPoints([], roots, 'covering')).toEqual([]);
  });
});

describe('side of a two-path call', () => {
  it('takes the side from the destination: copyFile source -> home is a destination fault', () => {
    const trace = [call('copyFile', 'write', '/c/src/a', '/c/home/a')];
    expect(new Set(selectInjectionPoints(trace, roots, 'covering').map((p) => p.side))).toEqual(new Set(['destination']));
  });

  it('rename tmp staging -> home is a destination fault, not environment', () => {
    const trace = [call('rename', 'rename', '/c/tmp/stage', '/c/home/final')];
    expect(new Set(selectInjectionPoints(trace, roots, 'covering').map((p) => p.side))).toEqual(new Set(['destination']));
  });

  it('a symlink is judged by where the link is made, not by its target text', () => {
    const trace = [call('symlink', 'create', '/c/home/link', '/c/src/target')];
    expect(new Set(selectInjectionPoints(trace, roots, 'covering').map((p) => p.side))).toEqual(new Set(['destination']));
  });
});

describe('rules survive a second run (random names, another case root)', () => {
  const rootsB: Roots = { home: '/d/home', tmp: '/d/tmp', project: '/d/project', sources: ['/d/src'] };
  const traceA = [
    call('mkdtemp', 'create', '/c/tmp/vat-install-AbC123'),
    call('write', 'write', '/c/tmp/vat-install-AbC123/SKILL.md'),
    call('rename', 'rename', '/c/home/.p.vat-staged-aaaaaa', '/c/home/p'),
    call('rm', 'remove', '/c/home/.p.vat-staged-aaaaaa.previous'),
    call('mkdir', 'create', '/c/project/dist/.vat-skills-0a1b2c3d4e5f'),
  ];
  const traceB = [
    call('mkdtemp', 'create', '/d/tmp/vat-install-Zy9876'),
    call('write', 'write', '/d/tmp/vat-install-Zy9876/SKILL.md'),
    call('rename', 'rename', '/d/home/.p.vat-staged-bbbbbb', '/d/home/p'),
    call('rm', 'remove', '/d/home/.p.vat-staged-bbbbbb.previous'),
    call('mkdir', 'create', '/d/project/dist/.vat-skills-ffeeddccbbaa'),
  ];

  it('every rule chosen from run A hits the same-position call of run B', () => {
    const points = selectInjectionPoints(traceA, roots, 'full', rootsB);
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(hitBy(p.rule, traceB)).toBe(traceB[traceA.indexOf(p.call)]);
    }
  });

  it('normalises roots and random suffixes, and leaves real names alone', () => {
    expect(normaliseCallPath('/c/home/.p.vat-staged-aaaaaa.previous', roots)).toBe(normaliseCallPath('/d/home/.p.vat-staged-bbbbbb.previous', rootsB));
    expect(normaliseCallPath('/c/tmp/vat-install-AbC123/x', roots)).toBe(normaliseCallPath('/d/tmp/vat-install-Zy9876/x', rootsB));
    expect(normaliseCallPath('/c/home/skills/readme-notes', roots)).not.toBe(normaliseCallPath('/c/home/skills/readme-other', roots));
    expect(normaliseCallPath('/c/home/a', roots)).not.toBe(normaliseCallPath('/c/project/a', roots));
  });

  // A verb that walks up from TMPDIR stats the case's own root, the mkdtemp directory above every
  // named root: spelled raw, its id differed in every run.
  it('normalises an ancestor of a root (the case root above TMPDIR) to the same key in every run', () => {
    expect(normaliseCallPath('/c', roots)).toBe(normaliseCallPath('/d', rootsB));
    expect(normaliseCallPath('/c', roots)).not.toContain('/c');
  });
});

describe('selectInjectionPoints (full)', () => {
  it('is every call times every errno of its family', () => {
    const trace = [call('unlink', 'remove', '/c/home/a'), call('unlink', 'remove', '/c/home/b'), call('unlink', 'remove', '/c/home/c')];
    const points = selectInjectionPoints(trace, roots, 'full');
    expect(points).toHaveLength(3 * ERRNOS_FOR_FAMILY.remove.length);
    expect(new Set(points.map((p) => hitBy(p.rule, trace)?.path))).toEqual(new Set(['/c/home/a', '/c/home/b', '/c/home/c']));
  });
});

describe('shard limit (C10)', () => {
  it('allows exactly the limit and refuses one past it, naming the file', () => {
    expect(() => assertWithinShardLimit(MAX_INJECTIONS_PER_FILE, 'lane-a')).not.toThrow();
    expect(() => assertWithinShardLimit(MAX_INJECTIONS_PER_FILE + 1, 'lane-a')).toThrow(/lane-a.*41.*40/);
  });
});

describe('shardOf (C10 slices)', () => {
  const ids = Array.from({ length: 200 }, (_, n) => `plugin/install/x#write:write:<tmp>/f${n}@1:ENOSPC:environment`);
  const partition = (list: readonly string[], files: number): string[][] =>
    Array.from({ length: files }, (_, index) => list.filter((id) => shardOf(id, files) === index).toSorted(byName));

  it('the slices are disjoint and together are the whole selection', () => {
    const slices = partition(ids, 3);
    expect(slices.flat().toSorted(byName)).toEqual(ids.toSorted(byName));
    expect(new Set(slices.flat()).size).toBe(ids.length);
    expect(slices.every((slice) => slice.length > 0)).toBe(true);
  });

  it('depends on the id alone: a selection in another trace order is sliced the same way', () => {
    expect(partition(ids.toReversed(), 3)).toEqual(partition(ids, 3));
  });
});
