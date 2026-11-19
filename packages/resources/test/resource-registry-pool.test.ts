/**
 * Wiring the parse pool into the INCUMBENT crawl lane — the ordering properties
 * that decide whether the wiring is safe, not whether it is fast.
 *
 * `vat resources validate` is the parse-heaviest command VAT ships, and until
 * this wiring existed its lane spawned zero workers: `admitResource` called
 * `parseKeyed` directly and `addResources` was a strictly sequential `for` loop,
 * 1,566 documents one after another. The pool reached only the projection lane.
 *
 * ⛔ **"Just add a pool" would have been a correctness bug, not a speedup.** The
 * loop's docstring justified itself with *"Sequential execution ensures
 * deterministic duplicate ID detection"*, and that is a REAL constraint — the
 * same one the projection lane solved by splitting `deriveBlob` into a
 * concurrent `prepareBlob` that decides everything as a value and a sequential
 * `emitPreparedBlob` that performs every mutation. So every test here is about
 * the SPLIT:
 *
 * - **First-added wins** on a duplicate id — the first path in the input list,
 *   never the first read to finish.
 * - **Results come back in input order**, so a caller's array is a function of
 *   its own argument rather than of the machine.
 * - **The 1:many indexes stay in corpus order.** `resourcesByChecksum` and
 *   `resourcesByName` are arrays whose insertion order `getDuplicates` and
 *   `getResourcesByChecksum` read back. Nothing throws when these scramble; the
 *   answers just quietly become machine-dependent.
 * - **A genuine defect fails on the corpus-first offender**, because a failure
 *   raised where it was discovered would make which one kills the run a race.
 * - **The pool is shut down** on the success path and the throw path alike — an
 *   un-shut-down pool loses every worker's parse-timing dump.
 * - **Sizing counts documents that reach a PARSER**, not paths. On this
 *   repository 6,967 of 8,713 documents route to `none`.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache } from '../src/parse-cache.js';
import type { ParsePool } from '../src/parse-pool.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { fakePool } from './parse-pool-fixture.js';
import { setupSubdirTestSuite } from './test-helpers.js';

/**
 * A cache that never touches disk.
 *
 * A disk-backed cache would serve a second run of a fixture from the first
 * one's entries, so "the pool parsed these" and "nothing parsed anything" would
 * produce identical registries.
 */
const NO_CACHE = new ParseCache({ enabled: false });

const suite = setupSubdirTestSuite('resource-registry-pool-');

/** The message prefix every deliberately-failing fake parse raises. */
const EXPLODED = 'parser exploded';

/** The first line of the lead document {@link plantLead} writes. */
const LEAD_HEADING = '# Lead';

/**
 * Reject a dispatched document with an error that NAMES it by its first line —
 * every document but the lead, which every miss now sends to the pool too and
 * which must be admitted for the test to reach the documents behind it.
 *
 * Naming it is what makes "which failure surfaced" answerable: two files
 * rejecting with one shared `Error` cannot tell a corpus-ordered raise from a
 * completion-ordered one, because both raise the same object.
 *
 * @param content - The document's bytes, as the pool received them
 * @returns The error the fake pool should throw for it
 */
const explodeOn = (content: string): Error | undefined => {
  const firstLine = content.split('\n')[0] ?? '';
  return firstLine === LEAD_HEADING ? undefined : new Error(`${EXPLODED}: ${firstLine}`);
};

/**
 * Write one fixture file beneath this test's root.
 *
 * @param name - Path relative to the suite root
 * @param content - The bytes to write
 * @returns The absolute path, for handing straight to `addResources`
 */
const plant = async (name: string, content: string): Promise<string> => {
  const absolute = safePath.join(suite.tempDir, name);
  await writeFile(absolute, content, 'utf-8');
  return absolute;
};

/**
 * The document that pays for the pool's activation, planted first in every
 * fixture that needs a FAN-OUT rather than merely a pool.
 *
 * ⚠️ The dispatcher activates on EVIDENCE, after an emission rather than before
 * the run: width is 1 until a pool exists, so the first document is always
 * parsed on this thread and only then is activation considered. A two-file
 * fixture therefore never has two files in flight at once — the first is emitted
 * before the second is claimed — and every order assertion below would be
 * vacuous, passing on a lane that happened to be sequential anyway.
 *
 * @returns The lead document's absolute path, to be listed FIRST
 */
const plantLead = async (): Promise<string> => plant('0-lead.md', '# Lead\n\nActivates.\n');

/**
 * A registry wired to a fake pool, or to the real one.
 *
 * `size` and `missThreshold` are stated rather than left to their defaults: the
 * default width stays at one thread for a corpus this small, so a test that
 * inherited it would never exercise the concurrent half and keep passing. The
 * other arm is the shipped route — the real bounded pool, real worker threads —
 * because there is no unpooled route left to compare against.
 *
 * @param pool - The fake pool to force on, or `undefined` for the real pool
 * @param idField - Frontmatter field to take resource ids from
 * @returns A registry rooted at this test's directory
 */
const registryWith = (pool?: ParsePool, idField?: string): ResourceRegistry =>
  new ResourceRegistry({
    baseDir: suite.tempDir,
    parseCache: NO_CACHE,
    ...(idField !== undefined && { idField }),
    parsePool:
      pool === undefined
        ? {}
        : { missThreshold: 1, size: pool.size, createPool: (): ParsePool => pool },
  });

describe('the incumbent crawl lane under a parse pool', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('lets the FIRST path in the list win a duplicate id, not the first read to finish', async () => {
    // Both files declare id `shared`. The fake pool answers in reverse dispatch
    // order, so if adjudication moved into the concurrent half — or if emission
    // ran in completion order — `second.md` would be indexed and `first.md`
    // would be recorded as the collision, exactly inverting this.
    const lead = await plantLead();
    const first = await plant('first.md', '---\nid: shared\n---\n\n# First\n');
    const second = await plant('second.md', '---\nid: shared\n---\n\n# Second\n');

    const { pool, record } = fakePool(4, { reverseCompletion: true });
    const registry = registryWith(pool, 'id');
    const results = await registry.addResources([lead, first, second]);

    // ⚠️ FIRST, and in every pooled test: this whole suite passes at width 1,
    // because one job at a time is sequential and therefore trivially in
    // order. Without this line the suite would go green while
    // proving nothing about the thing it is named after.
    // All three: there is no in-process route, the lead included.
    expect(record.calls).toBe(3);
    expect(record.maxInFlight).toBe(2);
    expect(results.map((r) => r.filePath)).toStrictEqual([lead, first]);
    expect(registry.getResourceById('shared')?.filePath).toBe(first);
    expect(registry.getDuplicateIdCollisions()).toStrictEqual([
      { id: 'shared', existingPath: first, conflictingPath: second },
    ]);
  });

  it('returns results in input order however the pool answers', async () => {
    const paths = await Promise.all(
      Array.from({ length: 6 }, async (_unused, index) =>
        plant(`doc-${String(index)}.md`, `# Doc ${String(index)}\n\nBody ${String(index)}.\n`),
      ),
    );

    const { pool, record } = fakePool(6, { reverseCompletion: true });
    const results = await registryWith(pool).addResources(paths);

    expect(record.calls).toBe(paths.length);
    // The lane really did fan out — a width that stayed at 1 would order the
    // results correctly for the wrong reason.
    expect(record.maxInFlight).toBeGreaterThan(1);
    expect(results.map((r) => r.filePath)).toStrictEqual(paths);
  });

  it('keeps the 1:many checksum index in corpus order', async () => {
    // Identical bytes under two names: ONE checksum, two entries, and the array
    // order is what `getResourcesByChecksum` and `getDuplicates` hand back.
    const lead = await plantLead();
    const shared = '# Same\n\nIdentical bytes.\n';
    const alpha = await plant('alpha.md', shared);
    const beta = await plant('beta.md', shared);

    const { pool, record } = fakePool(4, { reverseCompletion: true });
    const registry = registryWith(pool);
    const added = await registry.addResources([lead, alpha, beta]);

    expect(record.maxInFlight).toBe(2);
    const checksum = added[1]?.checksum ?? '';
    expect(registry.getResourcesByChecksum(checksum).map((r) => r.filePath)).toStrictEqual([
      alpha,
      beta,
    ]);
  });

  it('records an unreadable file without losing what was in flight beside it', async () => {
    const lead = await plantLead();
    // Named so the list below is already in admission order (the registry sorts
    // by path), which keeps the missing file BETWEEN the two in flight.
    const before = await plant('b-before.md', '# Before\n');
    const missing = safePath.join(suite.tempDir, 'c-absent.md');
    const after = await plant('d-after.md', '# After\n');

    const { pool, record } = fakePool(4, { reverseCompletion: true });
    const registry = registryWith(pool);
    const results = await registry.addResources([lead, before, missing, after]);

    // `before` and `after` were in flight alongside the failed read.
    expect(record.maxInFlight).toBe(2);

    // A read failure is a FINDING, not an abort, and the two readable files in
    // flight beside it must still be admitted — a prepare that threw would have
    // taken the whole run down with it.
    expect(results.map((r) => r.filePath)).toStrictEqual([lead, before, after]);
    expect(registry.getUnreadableResources().map((u) => u.filePath)).toStrictEqual([missing]);
  });

  it('fails on the corpus-first defect, not on whichever raced ahead', async () => {
    const lead = await plantLead();
    const first = await plant('a-first.md', '# A\n');
    const second = await plant('b-second.md', '# B\n');

    // Both pooled documents fail. Under a rejected `Promise.all` the winner
    // would be whichever settled first, which the reversed ladder makes
    // `b-second.md`.
    const { pool, record } = fakePool(4, { reverseCompletion: true, failWith: explodeOn });
    const registry = registryWith(pool);

    // `# A` — the first in the list. `# B` settles first and must NOT win.
    await expect(registry.addResources([lead, first, second])).rejects.toThrow(
      `${EXPLODED}: # A`,
    );
    expect(record.maxInFlight).toBe(2);
    // The lead was admitted before the failures were claimed, so a rejection did
    // not unwind work that had already been emitted.
    expect(registry.size()).toBe(1);
  });

  it('shuts the pool down on the success path and on the throw path', async () => {
    const lead = await plantLead();
    const good = await plant('good.md', '# Good\n');

    const clean = fakePool(2);
    await registryWith(clean.pool).addResources([lead, good]);
    expect(clean.record.calls).toBe(2);
    expect(clean.record.shutdowns).toBe(1);

    const bad = fakePool(2, { failWith: explodeOn });
    await expect(registryWith(bad.pool).addResources([lead, good])).rejects.toThrow(
      EXPLODED,
    );
    expect(bad.record.calls).toBe(2);
    expect(bad.record.shutdowns).toBe(1);
  });

  it('admits exactly what the shipped bounded pool admits', async () => {
    const paths = await Promise.all([
      plant('one.md', '# One\n\nSee [two](./two.md).\n'),
      plant('two.md', '# Two\n'),
      plant('page.html', '<h1 id="top">Page</h1>\n<a href="./one.md">one</a>\n'),
      plant('build.ts', '// see ./one.md\nexport const target = 1;\n'),
    ]);

    const shipped = await registryWith().addResources(paths);
    const { pool, record } = fakePool(4, { reverseCompletion: true });
    const pooled = await registryWith(pool).addResources(paths);

    // Three of the four reach a parser, so three are dispatched. `build.ts`
    // routes to `none` and must never be dispatched at all, which is what makes
    // this a kind-routing check too.
    expect(record.calls).toBe(3);
    expect(pooled).toStrictEqual(shipped);
  });

  it('sizes the pool on documents that reach a parser, never on paths', async () => {
    // Two markdown documents, then a long tail that routes to `none`. Counting
    // paths would buy two workers (262 / 128); counting parsable documents buys
    // no widening, because only one markdown document is left after the first
    // emission.
    const head = await Promise.all([
      plant('lead-0.md', '# Lead 0\n'),
      plant('lead-1.md', '# Lead 1\n'),
    ]);
    const tail = await Promise.all(
      Array.from({ length: 260 }, async (_unused, index) =>
        plant(`bulk-${String(index)}.ts`, `export const bulk${String(index)} = ${String(index)};\n`),
      ),
    );

    const { pool, record } = fakePool(2);
    const registry = new ResourceRegistry({
      baseDir: suite.tempDir,
      parseCache: NO_CACHE,
      parsePool: { missThreshold: 1, createPool: (): ParsePool => pool },
    });
    await registry.addResources([...head, ...tail]);

    // Never widened: one document in flight at a time, in the one thread every miss runs in.
    expect(record.calls).toBe(2);
    expect(record.maxInFlight).toBe(1);
  });
});
