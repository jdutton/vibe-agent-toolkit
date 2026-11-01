/**
 * `reconcile` judges the registry's order against the registry's own contract,
 * `admissionOrder()` — never against the order the crawl handed over.
 *
 * The crawl order is the enumerator's: NTFS lists case-insensitively, so a walk
 * on Windows hands over `broken/…` before `README.md` while the registry admits
 * `README.md` first. Judged against the crawl order, that is drift on Windows
 * only — and on POSIX the two orders agree by coincidence, never by contract.
 */
import { describe, expect, it } from 'vitest';

import { reconcile } from '../../src/pipeline-oracles/enumeration-snapshot.js';
import type { CollisionRow, EnumerationRow } from '../../src/pipeline-oracles/types.js';

/** `reconcile` reads only `path`; the realization fields never reach it. */
function rows(paths: readonly string[]): EnumerationRow[] {
  return paths.map((path) => ({ path }) as unknown as EnumerationRow);
}

describe('reconcile: order', () => {
  it.each([
    { label: 'case-insensitive directory listing (NTFS)', crawl: ['broken/x.md', 'README.md'], registry: ['README.md', 'broken/x.md'] },
    { label: 'a directory before its hyphenated sibling', crawl: ['a/x.md', 'a-b/y.md'], registry: ['a-b/y.md', 'a/x.md'] },
  ])('reports no drift for a $label when the registry is in admission order', ({ crawl, registry }) => {
    expect(reconcile(rows(crawl), registry, [])).toEqual([]);
  });

  it('judges order after the dropped path is removed', () => {
    const collisions: CollisionRow[] = [{ id: 'dup', existingPath: 'dup-hyphen/note.md', conflictingPath: 'dup/note.md' }];
    expect(reconcile(rows(['dup/note.md', 'dup-hyphen/note.md', 'z.md']), ['dup-hyphen/note.md', 'z.md'], collisions)).toEqual([]);
  });

  it('still reports a registry that is NOT in admission order', () => {
    expect(reconcile(rows(['README.md', 'broken/x.md']), ['broken/x.md', 'README.md'], [])).toEqual([
      'order-differs-at-0: admission=README.md registry=broken/x.md',
    ]);
  });
});
