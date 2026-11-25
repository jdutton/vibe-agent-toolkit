/**
 * A run with no projection store to ask counts every file its skills lane scans from text as
 * `skillText.noStore`, never as `skillText.storeMiss`: a miss says a store was asked and did
 * not serve the file, and these runs ask none.
 *
 * Two runs with no store, over one committed fixture whose skills lane scans {@link SCANNED}
 * files (two SKILL.md files and the reference one of them bundles):
 *
 * - `vat audit`, which declares it has no store (`projectionStore: 'none'`): it opens none,
 *   so it reads nothing persistent from one.
 * - `vat skills validate` with the store switched off (`VAT_PROJECTION_STORE=off`).
 *
 * And the store-on reference: a cold `vat skills validate` asks its store, which holds nothing
 * yet, so the same files are misses and none is a `noStore`.
 */

import type { WorkCounter } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { MARKDOWN_AND_SKILLS_CONFIG, createSkillMarkdown, createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-work-no-store-', import.meta.url);

/** The fixture: two skills, one bundling a reference. */
const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': MARKDOWN_AND_SKILLS_CONFIG,
  'skills/one/SKILL.md': `${createSkillMarkdown('one')}\nSee [the guide](./references/guide.md).\n`,
  'skills/one/references/guide.md': '# Guide\n',
  'skills/two/SKILL.md': createSkillMarkdown('two'),
};

/** Every markdown file the skills lane scans: each SKILL.md and the reference it bundles. */
const SCANNED = Object.keys(FILES).filter((path) => path.endsWith('.md')).length;

/** The counters this suite holds. */
const HELD = ['skillText.storeMiss', 'skillText.noStore', 'store.reads.extent', 'store.reads.blob'] as const satisfies readonly WorkCounter[];

/**
 * Run `vat <args>` in a fresh committed copy of the fixture and read back the held counters
 * of its one CLI process.
 *
 * @param args - The verb and its arguments, `{root}` replaced by the fixture's root
 * @param storeOff - Whether the store is switched off
 * @returns The held counters
 */
async function heldCounters(args: readonly string[], storeOff: boolean): Promise<Record<(typeof HELD)[number], number>> {
  const root = writeCommittedCorpus(context.createTempDir(), FILES);
  const { result, dumps } = await runWithWorkCounters(context, root, args.map((arg) => (arg === '{root}' ? root : arg)), {
    cacheDir: context.createTempDir(),
    tmpDir: null,
    storeOff,
    probeRoot: null,
    cores: null,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const [dump, ...others] = dumps;
  if (dump === undefined || others.length > 0) throw new Error(`expected one CLI process, got ${String(dumps.length)}`);
  return Object.fromEntries(HELD.map((counter) => [counter, dump.counters[counter]])) as Record<(typeof HELD)[number], number>;
}

beforeAll(() => {
  context.setup();
});

afterAll(() => {
  context.cleanup();
});

describe('a skills lane with no store to ask counts its scans as noStore, never as store misses', () => {
  it('vat audit, which opens no store', async () => {
    expect(await heldCounters(['audit', '{root}'], false)).toEqual({
      'skillText.storeMiss': 0,
      'skillText.noStore': SCANNED,
      'store.reads.extent': 0,
      'store.reads.blob': 0,
    });
  });

  it('vat skills validate with the store switched off', async () => {
    expect(await heldCounters(['skills', 'validate'], true)).toEqual({
      'skillText.storeMiss': 0,
      'skillText.noStore': SCANNED,
      'store.reads.extent': 0,
      'store.reads.blob': 0,
    });
  });

  it('a cold vat skills validate with the store on asks its store: every scan is a miss', async () => {
    const counters = await heldCounters(['skills', 'validate'], false);
    expect({ miss: counters['skillText.storeMiss'], noStore: counters['skillText.noStore'] }).toEqual({ miss: SCANNED, noStore: 0 });
    // A cold run's extent read is a miss, still a read: the manifest was asked.
    expect(counters['store.reads.extent'], 'the run asked its store').toBeGreaterThan(0);
  });
});
