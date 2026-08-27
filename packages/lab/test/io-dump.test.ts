/**
 * The `io` facet's dump reader.
 *
 * Two of these tests are the reason the file exists, and both guard against a
 * *confident wrong number* rather than a crash:
 *
 * 1. **Merging across PIDs.** One `vat` invocation writes more than one dump,
 *    because vat's launcher spawns a second node process for the real binary. A
 *    reader that took the first file it found would report the launcher's
 *    handful of calls and look perfectly healthy doing it. The fixtures below
 *    therefore give the two PIDs *different* counts at the *same* site — 66 and
 *    7 — so a first-file-only reader reports 66, a last-file-only reader reports
 *    7, and only a merging reader reports 73. A fixture where both PIDs carried
 *    the same count could not tell those three readers apart.
 * 2. **`sameBuckets` distinguishing distributions, not totals.** Two repeats
 *    with the same total call count but a different shape are not the same
 *    measurement, so there is a fixture whose totals match and whose buckets do
 *    not.
 */

import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  type IoDump,
  type IoDumpRow,
  type MergedDumps,
  mergeDumps,
  normalizeSite,
  readDumps,
  sameBuckets,
} from '../src/facets/io/dump.js';
import { IoBodySchema } from '../src/facets/io/types.js';

import { writeDumpDir } from './dump-fixtures.js';

/** Roots used for every normalization assertion, kept POSIX-shaped on purpose. */
const ROOTS = { instrumentRoot: '/repo/vat', subjectPath: '/work/adopter' } as const;

/** Fixture constants, named so the same string never appears twice. */
const READ_FILE = 'fs.readFile';
const CONTENT_KEY_SITE = '/repo/vat/packages/resources/dist/content-key.js:141';
const SITE_A = '/repo/vat/a.js:1';
const SITE_B = '/repo/vat/b.js:1';
const SITE_C = '/repo/vat/c.js:1';
const BUN_NESTED_SITE = '/repo/vat/node_modules/.bun/isexe@3.1.4/node_modules/isexe/x.js:1';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-io-dump-'));
});

/** Build a dump row without repeating the defaults in every fixture. */
function row(over: Partial<IoDumpRow> = {}): IoDumpRow {
  return {
    cls: 'user',
    method: READ_FILE,
    site: CONTENT_KEY_SITE,
    count: 1,
    distinctArgs: 1,
    argsCapped: false,
    ...over,
  };
}

/** Build a dump around some rows. */
function dump(pid: number, rows: readonly IoDumpRow[]): IoDump {
  return { pid, rows };
}

/** Merge a set of dumps with the standard roots. */
function merged(...dumps: readonly IoDump[]): MergedDumps {
  return mergeDumps(dumps, ROOTS);
}

/** Write raw files into a fresh directory under this suite's temp root. */
async function dumpDir(name: string, files: Readonly<Record<string, string>>): Promise<string> {
  return writeDumpDir(tempDir, name, files);
}

/** Write a directory of well-formed dumps. */
async function dumpDirOf(name: string, dumps: readonly IoDump[]): Promise<string> {
  const files: Record<string, string> = {};
  for (const one of dumps) files[`io-${String(one.pid)}.json`] = JSON.stringify(one);
  return dumpDir(name, files);
}

describe('normalizeSite', () => {
  it('keeps only the last node_modules segment', () => {
    // Bun nests real paths. A rule keyed on the FIRST occurrence yields
    // 'node_modules/.bun/isexe@3.1.4/node_modules/isexe/dist/index.js', which
    // carries a version and a package-manager layout — neither comparable
    // across machines.
    expect(
      normalizeSite(
        '/repo/vat/node_modules/.bun/isexe@3.1.4/node_modules/isexe/dist/index.js:12',
        ROOTS,
      ),
    ).toBe('node_modules/isexe/dist/index.js:12');
  });

  it('keeps a single node_modules segment', () => {
    expect(normalizeSite('/elsewhere/node_modules/zod/lib/index.js:9', ROOTS)).toBe(
      'node_modules/zod/lib/index.js:9',
    );
  });

  it('makes an instrument-root path root-relative', () => {
    expect(normalizeSite(CONTENT_KEY_SITE, ROOTS)).toBe(
      'packages/resources/dist/content-key.js:141',
    );
  });

  it('marks a subject path with the subject prefix', () => {
    expect(normalizeSite('/work/adopter/scripts/hook.js:3', ROOTS)).toBe(
      '<subject>/scripts/hook.js:3',
    );
  });

  it('leaves an unrelated absolute path alone', () => {
    expect(normalizeSite('/usr/local/lib/node/thing.js:1', ROOTS)).toBe(
      '/usr/local/lib/node/thing.js:1',
    );
  });

  it('always returns forward slashes', () => {
    expect(
      normalizeSite(String.raw`C:\repo\vat\packages\cli\dist\x.js:5`, {
        instrumentRoot: String.raw`C:\repo\vat`,
        subjectPath: String.raw`D:\work`,
      }),
    ).toBe('packages/cli/dist/x.js:5');
  });

  it('tolerates a drive letter whose case differs from the root', () => {
    // Windows hands back either case for the same drive. A case-sensitive
    // prefix test would leave the path absolute and machine-specific.
    expect(
      normalizeSite('c:/repo/vat/packages/cli/dist/x.js:5', {
        instrumentRoot: 'C:/repo/vat',
        subjectPath: 'D:/work',
      }),
    ).toBe('packages/cli/dist/x.js:5');
  });

  it('does not treat a sibling directory as being under the root', () => {
    expect(normalizeSite('/repo/vat-other/x.js:1', ROOTS)).toBe('/repo/vat-other/x.js:1');
  });

  it('leaves a site that is not a path alone', () => {
    expect(normalizeSite('node:internal/fs/utils:0', ROOTS)).toBe('node:internal/fs/utils:0');
  });
});

/**
 * Assert that a directory of raw dump text is refused, and why.
 *
 * The refusals differ only in the malformed payload and the message they must
 * name; writing that scaffolding out four times is the duplication the gate
 * catches, and it also makes it easy for one copy to drift into asserting
 * nothing.
 *
 * @param name - Temp directory label
 * @param files - Raw file contents to write, verbatim
 * @param pattern - What the refusal message must say
 */
async function expectRefusal(
  name: string,
  files: Record<string, string>,
  pattern: RegExp,
): Promise<void> {
  const directory = await dumpDir(name, files);
  const result = await readDumps(directory, ROOTS);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toMatch(pattern);
}

/**
 * Read a directory of well-formed dumps, failing loudly if it refused.
 *
 * The mirror of {@link expectRefusal}, and extracted for the same reason: every
 * success case otherwise repeats the same four lines of ok-checking, which is
 * both noise and a duplication-gate failure.
 *
 * @param name - Directory name under the temp root
 * @param dumps - The dumps to write into it
 * @returns The merged numbers
 * @throws When the read refused, which no caller of this helper expects
 */
async function expectMerge(name: string, dumps: readonly IoDump[]): Promise<MergedDumps> {
  const directory = await dumpDirOf(name, dumps);
  const result = await readDumps(directory, ROOTS);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.refusal);
  return result.merged;
}

describe('mergeDumps', () => {
  /**
   * Two processes reporting the SAME site with DIFFERENT numbers.
   *
   * The asymmetry is the point: a reader that took only the first dump gets 66,
   * only the last gets 7, and a merging reader gets 73 — three visibly different
   * answers, so the fixture can actually distinguish them. Equal counts could not.
   */
  const twoProcessesOneSite = (): ReturnType<typeof merged> =>
    merged(
      dump(1, [row({ count: 66, distinctArgs: 66 })]),
      dump(2, [row({ count: 7, distinctArgs: 7 })]),
    );

  it('sums one site across two processes', () => {
    const result = twoProcessesOneSite();
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.count).toBe(73);
    expect(result.userCalls).toBe(73);
  });

  it('counts distinct PIDs as processes', () => {
    const result = merged(dump(1, [row()]), dump(2, [row()]));
    expect(result.processes).toBe(2);
  });

  it('sums distinctArgs as an upper bound', () => {
    expect(twoProcessesOneSite().sites[0]?.distinctArgs).toBe(73);
  });

  it('keeps an absent distinct-argument reading absent when merging processes', () => {
    // Summing is only defined over readings. Treating a missing one as 0 would
    // turn two spawn rows into "0 distinct args", which reads as a measurement.
    const result = merged(
      dump(1, [row({ count: 8, distinctArgs: null })]),
      dump(2, [row({ count: 3, distinctArgs: null })]),
    );
    expect(result.sites[0]?.count).toBe(11);
    expect(result.sites[0]?.distinctArgs).toBeNull();
  });

  it('refuses to invent a total when only one process took a reading', () => {
    const result = merged(
      dump(1, [row({ count: 8, distinctArgs: null })]),
      dump(2, [row({ count: 3, distinctArgs: 3 })]),
    );
    expect(result.sites[0]?.distinctArgs).toBeNull();
  });

  it('ORs argsCapped across processes', () => {
    const result = merged(
      dump(1, [row({ argsCapped: false })]),
      dump(2, [row({ argsCapped: true })]),
    );
    expect(result.sites[0]?.argsCapped).toBe(true);
  });

  it('keeps two methods at one site apart', () => {
    const result = merged(dump(1, [row({ method: READ_FILE }), row({ method: 'fs.statSync' })]));
    expect(result.sites).toHaveLength(2);
  });

  it('merges sites that only normalize to the same string', () => {
    // Two processes resolved the same dependency through different real paths.
    // Normalization is what makes them one row; without it the report shows two
    // half-sized sites and no N+1 is visible.
    const result = merged(
      dump(1, [
        row({ site: BUN_NESTED_SITE, count: 5 }),
      ]),
      dump(2, [row({ site: '/other/node_modules/isexe/x.js:1', count: 6 })]),
    );
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.site).toBe('node_modules/isexe/x.js:1');
    expect(result.sites[0]?.count).toBe(11);
  });

  it('reports loader calls in aggregate and keeps them out of sites', () => {
    const result = merged(
      dump(1, [
        row({ cls: 'loader', method: 'fs.realpathSync', site: '', count: 3731, distinctArgs: null }),
        row({ count: 40 }),
      ]),
    );
    expect(result.loaderCalls).toBe(3731);
    expect(result.userCalls).toBe(40);
    expect(result.sites).toHaveLength(1);
    expect(result.sites.every((site) => site.site !== '')).toBe(true);
  });

  it('orders sites by descending count', () => {
    const result = merged(
      dump(1, [
        row({ site: SITE_A, count: 3 }),
        row({ site: SITE_B, count: 9 }),
        row({ site: SITE_C, count: 5 }),
      ]),
    );
    expect(result.sites.map((site) => site.site)).toEqual(['b.js:1', 'c.js:1', 'a.js:1']);
  });

  it('breaks count ties deterministically rather than by read order', () => {
    const forward = merged(
      dump(1, [row({ site: SITE_B }), row({ site: SITE_A })]),
    );
    const backward = merged(
      dump(1, [row({ site: SITE_A }), row({ site: SITE_B })]),
    );
    expect(forward.sites.map((site) => site.site)).toEqual(backward.sites.map((site) => site.site));
    expect(forward.sites.map((site) => site.site)).toEqual(['a.js:1', 'b.js:1']);
  });

  it('reports zero processes for no dumps at all', () => {
    const result = merged();
    expect(result.processes).toBe(0);
    expect(result.userCalls).toBe(0);
    expect(result.loaderCalls).toBe(0);
  });
});

describe('readDumps', () => {
  it('merges every dump in the directory, not just the first', async () => {
    const merge = await expectMerge('merge-all', [
      dump(1, [row({ count: 66, distinctArgs: 66 })]),
      dump(2, [row({ count: 7, distinctArgs: 7 })]),
    ]);

    expect(merge.processes).toBe(2);
    expect(merge.userCalls).toBe(73);
  });

  it('refuses a directory it cannot read', async () => {
    const result = await readDumps(safePath.join(tempDir, 'nope'), ROOTS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });

  it('refuses an empty directory rather than reporting zero I/O', async () => {
    const directory = await dumpDir('empty', {});
    const result = await readDumps(directory, ROOTS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/no I\/O dumps/);
  });


  it('refuses a dump that is not valid JSON', async () => {
    await expectRefusal('bad-json', { 'io-1.json': '{ not json' }, /^REFUSED:/);
  });

  it('refuses a dump carrying an unknown field', async () => {
    await expectRefusal(
      'unknown-field',
      { 'io-1.json': JSON.stringify({ ...dump(1, [row()]), elapsedMs: 3 }) },
      /elapsedMs|unrecognized/i,
    );
  });

  it('refuses a dump from a build that still stamped a dumpVersion, and names the producer', async () => {
    // The counter used to stamp `dumpVersion` and this reader used to compare it
    // to an integer of its own. Both are gone: strictness refuses the stale
    // field for the honest reason — this build does not model it — without
    // anyone being obliged to remember a number. The refusal must still say what
    // to re-capture with, because the commonest cause is an OLDER BUILD's dump.
    await expectRefusal(
      'stale-version-field',
      { 'io-1.json': JSON.stringify({ ...dump(1, [row()]), dumpVersion: 2 }) },
      /dumpVersion/,
    );
    await expectRefusal(
      'stale-version-field-producer',
      { 'io-1.json': JSON.stringify({ ...dump(1, [row()]), dumpVersion: 2 }) },
      /counter/,
    );
  });

  it('refuses a loader row that carries a site', async () => {
    await expectRefusal(
      'loader-site',
      {
        'io-1.json': JSON.stringify(
          dump(1, [row({ cls: 'loader', site: '/repo/vat/x.js:1', distinctArgs: null })]),
        ),
      },
      /^REFUSED:/,
    );
  });

  it('refuses a loader row that claims a distinct-argument reading', async () => {
    // Loader calls are bucketed in aggregate and no distinct set is kept for
    // them, so a number here describes a measurement that was never taken.
    await expectRefusal(
      'loader-reading',
      { 'io-1.json': JSON.stringify(dump(1, [row({ cls: 'loader', site: '', distinctArgs: 4 })])) },
      /^REFUSED:/,
    );
  });

  it('refuses a row that claims to have capped a reading it never took', async () => {
    // `argsCapped` describes a set that filled up. With no set there is nothing
    // to cap, and a `true` here would make an absent reading look like an exact
    // one that merely overflowed.
    await expectRefusal(
      'capped-without-reading',
      {
        'io-1.json': JSON.stringify(dump(1, [row({ distinctArgs: null, argsCapped: true })])),
      },
      /^REFUSED:/,
    );
  });

  it('accepts a row with no distinct-argument reading', async () => {
    const merge = await expectMerge('no-reading', [
      dump(1, [row({ method: 'child_process.spawnSync', count: 8, distinctArgs: null })]),
    ]);

    expect(merge.sites[0]?.count).toBe(8);
    expect(merge.sites[0]?.distinctArgs).toBeNull();
  });

  it('ignores non-dump files in the directory', async () => {
    const directory = await dumpDir('with-noise', {
      'io-1.json': JSON.stringify(dump(1, [row({ count: 4 })])),
      'notes.txt': 'not a dump',
    });
    const result = await readDumps(directory, ROOTS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.merged.userCalls).toBe(4);
  });
});

describe('sameBuckets', () => {
  it('accepts two identical merges', () => {
    const a = merged(dump(1, [row({ count: 5 })]));
    const b = merged(dump(1, [row({ count: 5 })]));
    expect(sameBuckets(a, b)).toBe(true);
  });

  it('rejects a differing count at one site', () => {
    const a = merged(dump(1, [row({ count: 5 })]));
    const b = merged(dump(1, [row({ count: 6 })]));
    expect(sameBuckets(a, b)).toBe(false);
  });

  it('rejects two repeats whose totals match but whose distribution does not', () => {
    // The sharp case: a predicate that compared totals would call these stable.
    const a = merged(
      dump(1, [
        row({ site: SITE_A, count: 1 }),
        row({ site: SITE_B, count: 2 }),
      ]),
    );
    const b = merged(
      dump(1, [
        row({ site: SITE_A, count: 2 }),
        row({ site: SITE_B, count: 1 }),
      ]),
    );
    expect(a.userCalls).toBe(b.userCalls);
    expect(sameBuckets(a, b)).toBe(false);
  });

  it('rejects a repeat that visited an extra site', () => {
    const a = merged(dump(1, [row({ site: SITE_A })]));
    const b = merged(
      dump(1, [row({ site: SITE_A }), row({ site: SITE_B })]),
    );
    expect(sameBuckets(a, b)).toBe(false);
  });

  it('sees loader movement, which no site row would show', () => {
    const a = merged(dump(1, [row({ cls: 'loader', site: '', count: 10, distinctArgs: null })]));
    const b = merged(dump(1, [row({ cls: 'loader', site: '', count: 11, distinctArgs: null })]));
    expect(a.sites).toHaveLength(0);
    expect(b.sites).toHaveLength(0);
    expect(sameBuckets(a, b)).toBe(false);
  });

  it('ignores distinctArgs, which describes a site rather than a bucket', () => {
    const a = merged(dump(1, [row({ count: 5, distinctArgs: 1 })]));
    const b = merged(dump(1, [row({ count: 5, distinctArgs: 5 })]));
    expect(sameBuckets(a, b)).toBe(true);
  });
});

describe('IoBodySchema', () => {
  const command = {
    name: 'resources-scan',
    args: ['resources', 'scan', 'docs/'],
    cache: 'warm',
    runs: 3,
    comparedRuns: 2,
    stable: true,
    processes: 2,
    loaderCalls: 6371,
    userCalls: 40,
    sites: [
      {
        method: 'fs.readFile',
        site: 'packages/resources/dist/content-key.js:141',
        count: 40,
        distinctArgs: 40,
        argsCapped: false,
      },
    ],
    failed: false,
    failure: null,
  };
  const body = {
    commands: [command],
    load: { before: 1.2, after: 1.4, cpus: 10, available: true, contaminated: false },
  };

  it('accepts a well-formed body', () => {
    expect(IoBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a body whose loader aggregate is missing', () => {
    const withoutLoader: Record<string, unknown> = { ...command };
    delete withoutLoader['loaderCalls'];
    expect(IoBodySchema.safeParse({ ...body, commands: [withoutLoader] }).success).toBe(false);
  });

  it('rejects an unknown field, because we wrote this body', () => {
    const result = IoBodySchema.safeParse({
      ...body,
      commands: [{ ...command, syscalls: 12 }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a null `stable`, which is how "never established" is spelled', () => {
    // Not the same claim as `true`. With fewer than two compared repeats nothing
    // could disagree, so a boolean would assert a determinism that was never
    // tested — and a comparator reading it would trust an exact-equality delta it
    // has no warrant for. Same distinction LoadReadings draws for a missing
    // reading; the schema has to admit it or the capture cannot express it.
    const unestablished = { ...command, runs: 1, comparedRuns: 0, stable: null };
    expect(IoBodySchema.safeParse({ ...body, commands: [unestablished] }).success).toBe(true);
  });

  it('rejects a body missing `comparedRuns`, which is what makes `stable` readable', () => {
    const withoutCompared: Record<string, unknown> = { ...command };
    delete withoutCompared['comparedRuns'];
    expect(IoBodySchema.safeParse({ ...body, commands: [withoutCompared] }).success).toBe(false);
  });
});
