/**
 * The pure planner core: `planFromFacts` decides every action from facts a fake
 * supplies, so aliasing, containment, ownership and the dry-run lines are pinned
 * with no filesystem. `planTreeChanges` is the same core over the live facts.
 */

import { describe, expect, it } from 'vitest';

import { isVatError } from '../src/errors/vat-error.js';
import {
  type EntryKind,
  type PlanFacts,
  planFromFacts,
  TREE_DEST_HOLDS_SOURCE_CODE,
  TREE_DEST_NOT_OWNED_CODE,
  TREE_DEST_OCCUPIED_CODE,
  TREE_DESTS_OVERLAP_CODE,
  TREE_SOURCE_HOLDS_DEST_CODE,
  type TreeChange,
} from '../src/tree-change/plan.js';

/**
 * A fake world: what is at each path, and the identity each answers to. Two paths
 * sharing an id are one entry; an id of `?` is an entry the OS will not identify.
 * Containment walks the path's lexical parents and compares ids, as the live
 * `isInsideByIdentity` walks real ones.
 */
function world(entries: Record<string, { kind: EntryKind; id?: string; empty?: boolean; toDirectory?: boolean }>): PlanFacts {
  const idOf = (path: string): string | undefined => entries[path]?.id ?? (entries[path] === undefined ? undefined : path);
  const same = (a: string, b: string): 'same' | 'different' | 'unknown' => {
    const left = idOf(a);
    const right = idOf(b);
    if (left === undefined || right === undefined) return 'different';
    if (left === '?' || right === '?') return 'unknown';
    return left === right ? 'same' : 'different';
  };
  return {
    existing: (dest) => entries[dest]?.kind ?? 'absent',
    isEmptyDirectory: (dest) => entries[dest]?.empty === true,
    linksToDirectory: (dest) => entries[dest]?.toDirectory === true,
    // A fake world refuses no examination of a target: its `?` ids are other entries' unknowns.
    requireExaminable: () => undefined,
    // `?` in the fake world is an identity the OS refused to examine.
    refusesToExamine: (entry) => entries[entry]?.id === '?',
    sameEntry: same,
    isInside: (child, ancestor) => {
      let undecided = false;
      for (let parent = child.slice(0, child.lastIndexOf('/')); parent.length > 0; parent = parent.slice(0, parent.lastIndexOf('/'))) {
        const verdict = same(parent, ancestor);
        if (verdict === 'same') return 'inside';
        if (verdict === 'unknown') undecided = true;
      }
      return undecided ? 'unknown' : 'outside';
    },
  };
}

const FORCE = { kind: 'force' } as const;
const FREE = { kind: 'must-be-free' } as const;
const NO_WRITE = (): Promise<void> => Promise.resolve();

const replace = (dest: string, label = 'new'): TreeChange => ({ op: 'replace', dest, ownership: FORCE, fill: { from: 'write', write: NO_WRITE }, label });
const remove = (dest: string, label = 'old', extra: Partial<Extract<TreeChange, { op: 'remove' }>> = {}): TreeChange => ({ op: 'remove', dest, ownership: FORCE, label, ...extra });

/** The code `work` threw, or a failure naming what it threw instead. */
function codeThrownBy(work: () => unknown): string {
  try {
    work();
  } catch (error: unknown) {
    if (isVatError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a coded refusal');
}

describe('planFromFacts — aliasing and containment', () => {
  it('subsumes a remove aliased to a replace (plugins/Old and plugins/old are one entry): the replace parks it', () => {
    const facts = world({ '/p/Old': { kind: 'directory', id: 'one' }, '/p/old': { kind: 'directory', id: 'one' } });
    const plan = planFromFacts([remove('/p/Old'), replace('/p/old')], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['subsumed', 'replace']);
    expect(plan.changes[0]?.reason).toContain('new');
  });

  it('subsumes a remove inside a replaced tree', () => {
    const facts = world({ '/p/mp': { kind: 'directory' }, '/p/mp/skills/legacy': { kind: 'directory' } });
    const plan = planFromFacts([replace('/p/mp'), remove('/p/mp/skills/legacy')], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['replace', 'subsumed']);
  });

  it('subsumes the second of two removes of one entry, and a remove inside another remove', () => {
    const facts = world({ '/p/A': { kind: 'directory', id: 'a' }, '/p/a': { kind: 'directory', id: 'a' }, '/p/a/x': { kind: 'file' } });
    const plan = planFromFacts([remove('/p/A'), remove('/p/a'), remove('/p/a/x')], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['remove', 'subsumed', 'subsumed']);
  });

  // An ino-0 filesystem answers `unknown` for every pair it cannot fold together: both changes run, never a refusal.
  it('keeps two changes whose aliasing or containment is unknown as two changes, refusing neither', () => {
    const facts = world({ '/p/a': { kind: 'directory', id: '?' }, '/p/b': { kind: 'directory', id: '?' } });
    const plan = planFromFacts([remove('/p/a'), replace('/p/b')], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['remove', 'replace']);
  });

  it('copies a source whose containment against the destination is unknown, refusing nothing', () => {
    const facts = world({ '/p/src': { kind: 'directory', id: '?' }, '/p/out': { kind: 'directory', id: '?' } });
    const change: TreeChange = { op: 'replace', dest: '/p/out', ownership: FORCE, fill: { from: 'copy', source: '/p/src', side: 'source', links: 'preserve' }, label: 'out' };
    expect(planFromFacts([change], facts).changes[0]?.action).toBe('replace');
  });
});

// Two active changes over one tree cannot be one transaction: the outer park carries the inner one's
// staging away. Only a remove the other change takes with it (subsumed) may overlap; anything else
// is the calling verb's defect, refused before anything is written.
describe('planFromFacts — overlapping destinations', () => {
  it.each([
    ['a replace inside a replaced tree', [replace('/p/mp'), replace('/p/mp/sub')], { '/p/mp': { kind: 'directory' } }],
    ['a replace inside a removed tree', [remove('/p/plugins'), replace('/p/plugins/x')], { '/p/plugins': { kind: 'directory' } }],
    ['two replaces of one entry', [replace('/p/a'), replace('/p/A')], { '/p/a': { kind: 'directory', id: 'x' }, '/p/A': { kind: 'directory', id: 'x' } }],
    ['a replace holding a later create', [replace('/p/new/inner'), replace('/p/new')], {}],
  ] as const)('refuses %s with TREE_DESTS_OVERLAP', (_name, changes, entries) => {
    expect(codeThrownBy(() => planFromFacts(changes, world(entries)))).toBe(TREE_DESTS_OVERLAP_CODE);
  });

  it('never refuses an overlap it cannot prove (unknown)', () => {
    const facts = world({ '/p/a': { kind: 'directory', id: '?' }, '/p/b': { kind: 'directory', id: '?' } });
    expect(planFromFacts([replace('/p/a'), replace('/p/b')], facts).changes.map((c) => c.action)).toEqual(['replace', 'replace']);
  });
});

describe('planFromFacts — keep', () => {
  it('keeps a remove whose keepIfSameAs answers unknown, with a reason naming the path', () => {
    const facts = world({ '/p/v1': { kind: 'directory', id: '?' }, '/p/v2': { kind: 'directory' } });
    const plan = planFromFacts([remove('/p/v1', 'v1', { keepIfSameAs: () => ['/p/v2'] })], facts);
    expect(plan.changes[0]).toMatchObject({ action: 'keep', reason: expect.stringContaining('/p/v2') as string });
  });

  // The caller drops its own record of what it removes; a keep it must name is told apart from one that is not.
  it('names the sibling on a keep the OS forced by refusing to examine that sibling, and only then', () => {
    const refused = world({ '/p/v1': { kind: 'directory' }, '/p/v2': { kind: 'directory', id: '?' } });
    expect(planFromFacts([remove('/p/v1', 'v1', { keepIfSameAs: () => ['/p/v2'] })], refused).changes[0]).toMatchObject({ action: 'keep', unexaminedSibling: '/p/v2' });
    const undecided = world({ '/p/v1': { kind: 'directory', id: '?' }, '/p/v2': { kind: 'directory' } });
    expect(planFromFacts([remove('/p/v1', 'v1', { keepIfSameAs: () => ['/p/v2'] })], undecided).changes[0]).not.toHaveProperty('unexaminedSibling');
  });

  it('keeps a remove whose keepIfSameAs names the same entry', () => {
    const facts = world({ '/p/v1': { kind: 'directory', id: 'x' }, '/p/V1': { kind: 'directory', id: 'x' } });
    expect(planFromFacts([remove('/p/v1', 'v1', { keepIfSameAs: () => ['/p/V1'] })], facts).changes[0]?.action).toBe('keep');
  });

  it('removes when every keepIfSameAs path is a different entry', () => {
    const facts = world({ '/p/v1': { kind: 'directory' }, '/p/v2': { kind: 'directory' } });
    expect(planFromFacts([remove('/p/v1', 'v1', { keepIfSameAs: () => ['/p/v2'] })], facts).changes[0]?.action).toBe('remove');
  });

  it('keeps a remove with nothing there', () => {
    expect(planFromFacts([remove('/p/gone')], world({})).changes[0]).toMatchObject({ existing: 'absent', action: 'keep' });
  });

  // A removal of `mp/` would take `mp/plugins/p` with it — the very entry a keep just decided must
  // stay (another plugin links to it). A kept entry is kept whole: so is every removal that holds it.
  it('keeps a remove that holds a kept entry, and every remove that holds that one, naming what it holds', () => {
    const facts = world({
      '/c/mp': { kind: 'directory' },
      '/c/mp/plugins': { kind: 'directory' },
      '/c/mp/plugins/p': { kind: 'directory', id: 'p' },
      '/c/mp2/plugins/p': { kind: 'link', id: 'p' },
    });
    const plan = planFromFacts([
      remove('/c/mp/plugins/p', 'plugin', { keepIfSameAs: () => ['/c/mp2/plugins/p'] }),
      remove('/c/mp/plugins', 'plugins'),
      remove('/c/mp', 'marketplace'),
    ], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['keep', 'keep', 'keep']);
    expect(plan.changes[2]?.reason).toContain('/c/mp/plugins/p');
  });

  // `unknown` keeps, as everywhere a removal is decided: `/c/mp` cannot be identified, so whether
  // it holds the kept `/c/other` is unknown; `/c/x` provably does not.
  it('keeps a remove whose holding of a kept entry is unknown, and removes one that provably does not hold it', () => {
    const facts = world({
      '/c': { kind: 'directory' },
      '/c/mp': { kind: 'directory', id: '?' },
      '/c/x': { kind: 'directory' },
      '/c/other': { kind: 'directory', id: 'e' },
      '/c/elsewhere': { kind: 'directory', id: 'e' },
    });
    const plan = planFromFacts([
      remove('/c/other', 'other', { keepIfSameAs: () => ['/c/elsewhere'] }),
      remove('/c/x', 'x'),
      remove('/c/mp', 'marketplace'),
    ], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['keep', 'remove', 'keep']);
  });
});

describe('planFromFacts — ownership', () => {
  it('refuses must-be-free over a non-empty directory with TREE_DEST_OCCUPIED', () => {
    const facts = world({ '/p/out': { kind: 'directory' } });
    expect(codeThrownBy(() => planFromFacts([{ ...replace('/p/out'), ownership: FREE }], facts))).toBe(TREE_DEST_OCCUPIED_CODE);
  });

  it('refuses must-be-free over a file', () => {
    const facts = world({ '/p/out': { kind: 'file' } });
    expect(codeThrownBy(() => planFromFacts([{ ...replace('/p/out'), ownership: FREE }], facts))).toBe(TREE_DEST_OCCUPIED_CODE);
  });

  it('replaces an empty directory and creates over nothing under must-be-free', () => {
    const facts = world({ '/p/out': { kind: 'directory', empty: true } });
    const plan = planFromFacts([{ ...replace('/p/out'), ownership: FREE }, { ...replace('/p/new'), ownership: FREE }], facts);
    expect(plan.changes.map((c) => c.action)).toEqual(['replace', 'create']);
  });

  it('refuses must-be-free for a FILE over an empty directory: a folder the user made is not free for a file', () => {
    const facts = world({ '/p/agent.yaml': { kind: 'directory', empty: true } });
    const file = { op: 'replace-file', dest: '/p/agent.yaml', ownership: FREE, contents: 'x', label: 'agent.yaml' } as const;
    expect(codeThrownBy(() => planFromFacts([file], facts))).toBe(TREE_DEST_OCCUPIED_CODE);
  });

  // Ruling R2: `--force` means "overwrite the file". A file change that took a directory parked the
  // whole tree, put a file on its name and deleted the tree — exit 0.
  it.each([
    ['force', FORCE],
    ['vat-state', { kind: 'vat-state' }],
    ['must-be-free', FREE],
    ['vat-made, recognised', { kind: 'vat-made', recognise: () => ({ owned: true }) }],
  ] as const)('refuses a replace-file over a DIRECTORY under %s ownership, saying it is a directory', (_kind, ownership) => {
    const facts = world({ '/p/out': { kind: 'directory' } });
    const file = { op: 'replace-file', dest: '/p/out', ownership, contents: 'x', label: 'agent.yaml' } as const;
    let thrown: unknown;
    try {
      planFromFacts([file], facts);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(isVatError(thrown, TREE_DEST_OCCUPIED_CODE), String(thrown)).toBe(true);
    expect(String(thrown)).toContain('/p/out is a directory');
  });

  it('refuses a replace-file over a LINK to a directory under force, and takes a link to a file', () => {
    const facts = world({ '/p/out': { kind: 'link', toDirectory: true }, '/p/alias.yaml': { kind: 'link' } });
    const file = (dest: string) => ({ op: 'replace-file', dest, ownership: FORCE, contents: 'x', label: 'agent.yaml' }) as const;
    expect(codeThrownBy(() => planFromFacts([file('/p/out')], facts))).toBe(TREE_DEST_OCCUPIED_CODE);
    expect(planFromFacts([file('/p/alias.yaml')], facts).changes.map((c) => c.action)).toEqual(['replace']);
  });

  it('refuses vat-made when recognise says not owned, with TREE_DEST_NOT_OWNED and its reason', () => {
    const facts = world({ '/p/db': { kind: 'directory' } });
    const ownership = { kind: 'vat-made', recognise: () => ({ owned: false, reason: 'it holds notes.txt' }) } as const;
    let thrown: unknown;
    try {
      planFromFacts([{ ...remove('/p/db'), ownership }], facts);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(isVatError(thrown, TREE_DEST_NOT_OWNED_CODE)).toBe(true);
    expect((thrown as Error).message).toContain('it holds notes.txt');
    // The refusal says what the change would have done: a remove is never "refusing to replace".
    expect((thrown as Error).message).toContain('refusing to remove /p/db');
    expect(() => planFromFacts([{ ...replace('/p/db'), ownership }], facts)).toThrow('refusing to replace /p/db');
  });

  it('never asks recognise about an absent destination, nor about a subsumed remove', () => {
    const asked: string[] = [];
    const recognise = (dest: string): { owned: false; reason: string } => {
      asked.push(dest);
      return { owned: false, reason: 'no' };
    };
    const facts = world({ '/p/mp': { kind: 'directory' }, '/p/mp/x': { kind: 'directory' } });
    planFromFacts([replace('/p/mp'), { ...remove('/p/mp/x'), ownership: { kind: 'vat-made', recognise } }, { ...replace('/p/none'), ownership: { kind: 'vat-made', recognise } }], facts);
    expect(asked).toEqual([]);
  });
});

describe('planFromFacts — source holding', () => {
  const copy = (source: string, dest: string): TreeChange => ({ op: 'replace', dest, ownership: FORCE, fill: { from: 'copy', source, side: 'source', links: 'preserve' }, label: 'out' });

  it('refuses a source inside its destination (the replace would delete it) with TREE_DEST_HOLDS_SOURCE', () => {
    const facts = world({ '/p/out': { kind: 'directory' }, '/p/out/src': { kind: 'directory' } });
    expect(codeThrownBy(() => planFromFacts([copy('/p/out/src', '/p/out')], facts))).toBe(TREE_DEST_HOLDS_SOURCE_CODE);
  });

  it('refuses a source that is its destination with TREE_DEST_HOLDS_SOURCE', () => {
    const facts = world({ '/p/a': { kind: 'directory', id: 'x' }, '/p/A': { kind: 'directory', id: 'x' } });
    expect(codeThrownBy(() => planFromFacts([copy('/p/a', '/p/A')], facts))).toBe(TREE_DEST_HOLDS_SOURCE_CODE);
  });

  // A destination that is a LINK holds nothing: replacing it parks the link, never what it points at.
  // A `--dev` link to the very build being installed (or to a directory above it) was refused as
  // "replacing it would delete the source" — false, and it left `--force` unable to leave dev mode.
  it.each([
    ['the source itself', { '/skills/good': { kind: 'link', id: 'src' }, '/dist/good': { kind: 'directory', id: 'src' } }],
    ['a directory above the source', { '/skills/good': { kind: 'link', id: 'dist' }, '/dist': { kind: 'directory', id: 'dist' }, '/dist/good': { kind: 'directory' } }],
  ] as const)('replaces a destination that is a link to %s: the link goes, the source stays', (_label, entries) => {
    const plan = planFromFacts([copy('/dist/good', '/skills/good')], world(entries));
    expect(plan.changes.map((c) => c.action)).toEqual(['replace']);
  });

  it('refuses a destination inside its source (a copy into itself) with TREE_SOURCE_HOLDS_DEST', () => {
    const facts = world({ '/p/src': { kind: 'directory' } });
    expect(codeThrownBy(() => planFromFacts([copy('/p/src', '/p/src/dist')], facts))).toBe(TREE_SOURCE_HOLDS_DEST_CODE);
  });

  it('holds a write fill\'s declared reads to the same check', () => {
    const facts = world({ '/p/out': { kind: 'directory' }, '/p/out/in.md': { kind: 'file' } });
    const change: TreeChange = { op: 'replace', dest: '/p/out', ownership: FORCE, fill: { from: 'write', write: NO_WRITE, reads: ['/p/out/in.md'] }, label: 'out' };
    expect(codeThrownBy(() => planFromFacts([change], facts))).toBe(TREE_DEST_HOLDS_SOURCE_CODE);
  });
});

describe('TreePlan.describe', () => {
  it('prints one line per change: action, label, destination, and the reason in parentheses', () => {
    const facts = world({ '/p/Old': { kind: 'directory', id: 'o' }, '/p/old': { kind: 'directory', id: 'o' }, '/p/v1': { kind: 'directory', id: '?' } });
    const plan = planFromFacts([
      remove('/p/Old', 'plugin Old'),
      replace('/p/old', 'plugin old'),
      { op: 'replace-file', dest: '/p/reg.json', ownership: { kind: 'vat-state' }, contents: '{}', label: 'registry' },
      remove('/p/v1', 'version v1', { keepIfSameAs: () => ['/p/old'] }),
      remove('/p/none', 'nothing'),
    ], facts);
    expect(plan.describe()).toEqual([
      'subsumed plugin Old /p/Old (parked by replace plugin old)',
      'replace plugin old /p/old',
      'create registry /p/reg.json',
      'keep version v1 /p/v1 (could not tell whether /p/old is the same entry)',
      'keep nothing /p/none (nothing there)',
    ]);
  });
});
