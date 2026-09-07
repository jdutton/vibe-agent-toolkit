/**
 * Bundle discovery: the population OKF conformance is judged over.
 *
 * The property under test is **maximality**. §3.1 reserves exactly two
 * filenames and says "all other `.md` files are concept documents", so anything
 * that narrows the walk — a gitignore fast path, a build-output exclude, an
 * include glob — would let VAT report a clean bundle while a file it never
 * opened broke conformance.
 */

import { describe, expect, it } from 'vitest';

import { discoverOkfBundle } from '../../src/okf/discovery.js';

import {
  NFD_CAFE_DOC,
  REFERENCE_TYPE,
  SYMLINKS_AVAILABLE,
  TABLE_TYPE,
  conceptDoc,
  plantOkfBundle,
  plantSymlink,
} from './bundle-fixture.js';

describe('discoverOkfBundle', () => {
  it('walks every .md beneath the root, at any depth', async () => {
    const root = plantOkfBundle({
      'overview.md': conceptDoc(REFERENCE_TYPE),
      'tables/customers.md': conceptDoc(TABLE_TYPE),
      'tables/deep/nested/orders.md': conceptDoc(TABLE_TYPE),
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual([
      'overview.md',
      'tables/customers.md',
      'tables/deep/nested/orders.md',
    ]);
    expect(found.reservedDocuments).toEqual([]);
  });

  it('separates the two reserved filenames at every level, root included', async () => {
    const root = plantOkfBundle({
      'index.md': '# Bundle\n',
      'log.md': '# Log\n',
      'tables/index.md': '# Tables\n',
      'tables/log.md': '# Tables log\n',
      'tables/customers.md': conceptDoc(TABLE_TYPE),
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual(['tables/customers.md']);
    expect(found.reservedDocuments).toEqual([
      'index.md',
      'log.md',
      'tables/index.md',
      'tables/log.md',
    ]);
  });

  it('ignores files that are not markdown', async () => {
    const root = plantOkfBundle({
      'concept.md': conceptDoc('Metric'),
      'references/attesters/revenue.py': 'print("not markdown")\n',
      'data.json': '{}\n',
      'README': 'no extension\n',
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual(['concept.md']);
  });

  it('counts an upper-case extension as markdown, widening the population', async () => {
    // Direction matters: extension matching is case-INSENSITIVE so that a file a
    // consumer would read as markdown cannot slip past the conformance checks.
    const root = plantOkfBundle({
      'shouted.MD': conceptDoc(REFERENCE_TYPE),
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual(['shouted.MD']);
  });

  it('treats a case-variant of a reserved name as a concept document', async () => {
    // The opposite direction, for the opposite reason: reserved matching is
    // case-SENSITIVE, because being reserved EXEMPTS a file from the concept
    // checks. §3.1 reserves `index.md`, not `Index.md`, so the exemption stays
    // narrow and `Index.md` is held to the frontmatter requirement.
    const root = plantOkfBundle({
      'Index.md': '# Not the reserved name\n',
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual(['Index.md']);
    expect(found.reservedDocuments).toEqual([]);
  });

  it('walks a subtree named like build output — the population is not narrowable', async () => {
    // A `dist/` inside a bundle root is part of the bundle; VAT's usual crawl
    // excludes are a performance/relevance judgement that has no standing here.
    // (Created at runtime under mkdtemp — nothing gitignored is committed.)
    const root = plantOkfBundle({
      'concept.md': conceptDoc('Metric'),
      'dist/generated.md': '# no frontmatter\n',
    });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual(['concept.md', 'dist/generated.md']);
  });

  it.skipIf(!SYMLINKS_AVAILABLE)(
    'enumerates a symlinked markdown FILE, whose bytes travel with the bundle',
    async () => {
      // The docstring on `walkInto` promises exactly this: "A symlinked file is
      // read like any other, because its bytes do travel when the bundle is
      // packed." `entry.isFile()` on an lstat-based Dirent answers false for a
      // symlink, so the promise and the code disagreed — and a §11.1 violation
      // reachable through the link was reported as a conformant bundle.
      const root = plantOkfBundle({
        'real.md': conceptDoc(TABLE_TYPE),
        'elsewhere/target.md': 'NO FRONTMATTER AT ALL\n',
      });
      plantSymlink(root, 'linked.md', 'elsewhere/target.md', 'file');

      const found = await discoverOkfBundle(root);

      expect(found.conceptDocuments).toContain('linked.md');
    },
  );

  it.skipIf(!SYMLINKS_AVAILABLE)('does not follow a symlinked DIRECTORY', async () => {
    // The other half of the same ruling, and it must not move: a directory link
    // is a doorway out of the tree, and what lies beyond it does not travel.
    const root = plantOkfBundle({
      'real.md': conceptDoc(TABLE_TYPE),
      'outside/hidden.md': 'NO FRONTMATTER AT ALL\n',
    });
    plantSymlink(root, 'doorway', 'outside', 'dir');

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).not.toContain('doorway/hidden.md');
  });

  it('reports a filename in the normalization form disk holds, unfolded', async () => {
    // Discovery must not fold: the population it reports is what the link check
    // is then judged against, and a folded population would reconcile an NFD
    // filename with an NFC link before anything could notice they differ.
    const root = plantOkfBundle({ [NFD_CAFE_DOC]: conceptDoc(REFERENCE_TYPE) });

    const found = await discoverOkfBundle(root);

    expect(found.conceptDocuments).toEqual([NFD_CAFE_DOC]);
  });

  it('reports a root that does not exist rather than an empty bundle', async () => {
    const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });

    await expect(discoverOkfBundle(`${root}/no-such-subtree`)).rejects.toThrow(
      /no-such-subtree/,
    );
  });
});
