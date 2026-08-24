/**
 * The projection store changes COST, never the ANSWER.
 *
 * `VAT_PROJECTION_STORE=sqlite` is opt-in today and is about to become the
 * default. The moment it does, every command's answer is served from a cache on
 * the second run — so the property that has to be true BEFORE the flip is that
 * nothing depends on the store being there, and nothing depends on it being
 * absent. This suite pins that, per command, against one fixture tree.
 *
 * ## Three arms, because "cache off" and "cache warm" are different questions
 *
 * - **A** — store off. The uncached derivation, the reference answer.
 * - **B** — store on, COLD. Derives exactly as A does and WRITES what it found.
 * - **C** — store on, WARM. Runs immediately after B against the store B left.
 *
 * A and B differ only in whether the extent is recorded; B and C differ only in
 * whether one already existed. A suite that ran only A and B would prove nothing
 * about the read path, which is the half that can silently answer with stale or
 * partial content.
 *
 * ## 🪤 The failure this file exists to make impossible
 *
 * An equivalence test whose arms never diverged is green forever and proves
 * nothing — the same "a subject that exercised nothing looks like a clean
 * result" trap `projection-store.ts` names in its own header. So every arm
 * carries a POSITIVE tell, asserted before the outputs are compared at all:
 *
 * - A touched no store: no `projection.db`, zero rows, and not one contributor
 *   charged under `projection-store:`.
 * - B wrote one: no store existed before it ran, one exists after, holding rows,
 *   and it charged `projection-store:write`.
 * - C read one: a populated store existed BEFORE it ran, and it charged
 *   `projection-store:read`.
 *
 * ## 🪤 `projection-store:read` is charged for a MISS too
 *
 * `readCachedProjection` files the row from a `finally` on purpose, so a dump
 * can tell a served population from a subject that exercised nothing. It
 * therefore proves the store was CONSULTED, not that it answered. What proves an
 * answer is the ABSENCE of `projection-store:write` in the warm arm — a hit
 * returns before anything is derived, and only a derivation is written back.
 * That is per-command, and it is recorded per-command in {@link COMMANDS} rather
 * than assumed. Pinning it as a boolean means a change in either direction is a
 * visible test failure rather than an unnoticed cost — which is what happened:
 * both commands hit warm now, and `vat resources validate` did not always.
 *
 * ## Why `vat resources validate` started hitting warm
 *
 * ⛔ This boolean was flipped for a reason, not to get green. A stored extent is
 * filed under `(rootId, treeHash + ambient)` — ONE key per process — and
 * `selectRequestedContexts` then serves it only if it holds a provenance row for
 * every `(contributorId, parameterSet)` the run registered. `vat resources
 * validate` makes THREE `populate()` calls: the resource population, and the
 * Claude-context lane's discovery and real passes.
 *
 * All three used to ask the filesystem extent a DIFFERENT question — the
 * resource population passed `DECLINE_IGNORED`, and neither context pass passed
 * anything — so each missed the extent the previous one had written and
 * overwrote it. Three misses, three writes, every run, warm or cold; the "cache"
 * was three lanes evicting each other under one key.
 *
 * The context lane now declines the gitignored half too, so all three ask for
 * `filesystem[DECLINE_IGNORED]`. The cold run's LAST write is the real pass's
 * superset, every warm request is a subset of it, and all three are served
 * without deriving anything. `vat claude context` was unaffected either way — it
 * only ever made the two context calls, which always agreed with each other.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contributorsCharged,
  rowsStoredUnder,
  storeFilesUnder,
  tmpdirEnv,
} from '../helpers/projection-store-probe.js';
import { createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-store-equivalence-', import.meta.url);

/** The one lane selector every arm shares. Only the STORE varies between arms. */
const PROJECTION_LANE = 'projection';

/** The prefix every charge the store itself files carries. */
const STORE_CHARGE_PREFIX = 'projection-store:';

/** Charged by a run that DERIVED and recorded an extent — so, by one that missed. */
const STORE_WRITE = `${STORE_CHARGE_PREFIX}write`;

/** Charged by a run that CONSULTED the store, hit or miss. See the header. */
const STORE_READ = `${STORE_CHARGE_PREFIX}read`;

let corpus: string;

/** One arm's observable result: what it printed, how it exited, what it charged. */
interface ArmResult {
  readonly document: Record<string, unknown>;
  readonly status: number | null;
  readonly charged: readonly string[];
}

/** One command under test, and the two things that are true only of it. */
interface CommandCase {
  /** How the case reads in the test name. */
  readonly name: string;
  /** The `vat` argv, in a machine-readable format. */
  readonly args: readonly string[];
  /**
   * Drop the fields that legitimately differ between two runs of THIS command.
   *
   * Nothing else may be touched. The corpus root is NOT normalized: all three
   * arms run the same tree, so a root that differed would be a real finding.
   */
  readonly normalize: (document: Record<string, unknown>) => Record<string, unknown>;
  /** Whether the warm arm is served BY the store rather than re-deriving. */
  readonly warmHitsStore: boolean;
}

const COMMANDS: readonly CommandCase[] = [
  {
    name: 'vat resources validate',
    args: ['resources', 'validate', '--format', 'json'],
    // `durationSecs` is this run's wall clock. It is the ONLY per-run field in
    // this document, and a cache that made the run faster is the whole point.
    normalize: ({ durationSecs: _durationSecs, ...rest }: Record<string, unknown>) => rest,
    // Measured, and CHANGED from `false` deliberately — see the header for the
    // one-key/three-questions mechanism that used to make its three populations
    // evict each other. All three now ask `filesystem[DECLINE_IGNORED]`, so the
    // warm run derives nothing and writes nothing.
    warmHitsStore: true,
  },
  {
    name: 'vat claude context .',
    args: ['claude', 'context', '.', '--format', 'json'],
    // Nothing in this envelope is per-run: it carries no timing, and its `root`
    // is the same corpus in every arm.
    normalize: (document: Record<string, unknown>) => document,
    warmHitsStore: true,
  },
];

/**
 * Run one arm of one command and collect everything it can be judged on.
 *
 * @param options - The arm's command, its private temp directory, and whether
 *   the store is selected for it
 * @param options.args - The `vat` argv, including `--format json`
 * @param options.temp - The arm's private `os.tmpdir()`, where its store lands
 * @param options.store - Whether to select the SQLite projection store
 * @returns The parsed document, the exit status, and the charged contributors
 */
async function runArm(options: {
  args: readonly string[];
  temp: string;
  store: boolean;
}): Promise<ArmResult> {
  const timing = context.createTempDir();
  const result = await executeCli(context.binPath, [...options.args], {
    cwd: corpus,
    env: {
      VAT_RESOURCES_CRAWL: PROJECTION_LANE,
      VAT_CRAWL_TIMING: timing,
      ...(options.store ? { VAT_PROJECTION_STORE: 'sqlite' } : {}),
      ...tmpdirEnv(options.temp),
    },
  });
  // A run that crashed prints nothing, and an equivalence between two nothings
  // is the most convincing vacuous pass there is.
  expect(result.status, result.stderr).toBe(0);
  return {
    document: JSON.parse(result.stdout) as Record<string, unknown>,
    status: result.status,
    charged: contributorsCharged(timing),
  };
}

/**
 * The store's own charges, out of everything an arm charged.
 *
 * @param arm - One arm's result
 * @returns The `projection-store:` ids it filed, in charge order
 */
function storeCharges(arm: ArmResult): string[] {
  return arm.charged.filter((id) => id.startsWith(STORE_CHARGE_PREFIX));
}

describe('the projection store and the answers it is supposed not to change', () => {
  beforeAll(() => {
    context.setup();
    // Committed, because the store's key is `git write-tree` against a throwaway
    // index — a corpus outside a readable repository cannot be keyed, and every
    // arm would silently run uncached.
    corpus = join(context.createTempDir(), 'corpus');
    mkdirSyncReal(join(corpus, 'docs'), { recursive: true });
    writeTestFile(join(corpus, 'docs', 'one.md'), '# One\n\nSee [two](./two.md).\n');
    writeTestFile(join(corpus, 'docs', 'two.md'), '# Two\n');
    // A CLAUDE.md, so `vat claude context` has something to charge and the two
    // commands are not asking the same question of the same three files.
    writeTestFile(join(corpus, 'CLAUDE.md'), '# Corpus\n\nProject notes.\n');
    commitTestFixture(corpus);
  });

  afterAll(context.cleanup);

  it.each(COMMANDS)(
    'answers $name identically with the store off, cold and warm',
    async ({ args, normalize, warmHitsStore }) => {
      const withoutStore = context.createTempDir();
      // ONE directory for B and C: C is warm precisely because it inherits it.
      const withStore = context.createTempDir();

      // ── A: store off ──────────────────────────────────────────────────────
      const armA = await runArm({ args, temp: withoutStore, store: false });
      expect(storeFilesUnder(withoutStore)).toEqual([]);
      expect(rowsStoredUnder(withoutStore)).toBe(0);
      expect(storeCharges(armA)).toEqual([]);

      // ── B: store on, cold ─────────────────────────────────────────────────
      // Asserted BEFORE the run: without this, a leaked store from another arm
      // would make B a second warm run wearing a cold label.
      expect(storeFilesUnder(withStore)).toEqual([]);
      const armB = await runArm({ args, temp: withStore, store: true });
      expect(armB.charged).toContain(STORE_WRITE);
      expect(storeFilesUnder(withStore)).toHaveLength(1);
      const rowsAfterCold = rowsStoredUnder(withStore);
      expect(rowsAfterCold).toBeGreaterThan(0);

      // ── C: store on, warm ─────────────────────────────────────────────────
      const armC = await runArm({ args, temp: withStore, store: true });
      expect(armC.charged).toContain(STORE_READ);
      // The half that says whether the store ANSWERED — see the header on why a
      // charged read alone cannot.
      if (warmHitsStore) expect(armC.charged).not.toContain(STORE_WRITE);
      else expect(armC.charged).toContain(STORE_WRITE);
      expect(rowsStoredUnder(withStore)).toBeGreaterThan(0);

      // ── The equivalence itself ────────────────────────────────────────────
      expect([armB.status, armC.status]).toEqual([armA.status, armA.status]);
      const reference = normalize(armA.document);
      expect(normalize(armB.document)).toEqual(reference);
      expect(normalize(armC.document)).toEqual(reference);
    },
  );
});
