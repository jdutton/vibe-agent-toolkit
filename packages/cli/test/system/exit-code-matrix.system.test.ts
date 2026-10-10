/**
 * The exit code is DERIVED from the published document — observed, verb by verb.
 *
 * ## The class this pins
 *
 * Every verb used to choose its exit code at its own call site, so one outcome
 * got different codes in different verbs: a `resources check` budget kill was 1
 * or 2 depending on timing, `vat ard emit` published the envelope's `status:
 * error` at exit 1, and `vat audit` over a root the OS would not list exited 1
 * where `resources validate`, `check`, `query` and `scan` exit 2. The fix is ONE
 * derivation, `exitCodeForReport(document)`; the lint rule
 * `no-literal-process-exit` (`derived`) refuses a code decided beside the
 * document, and the matrix proves, by running the verbs, that the code each one
 * ends on IS the code its document derives.
 *
 * ## The matrix is several spec files over ONE table
 *
 * Running every scenario spawns the built CLI well over a hundred times — more
 * than one spec file may spend (the per-file duration budget). So:
 *
 * - **this file** asserts everything that is true of the WHOLE table, and runs
 *   nothing but the one external-verb spawn;
 * - `exit-code-matrix-shard-<name>.system.test.ts` run the envelope scenarios,
 *   each the slice `MATRIX_SHARDS` assigns to the shard it is named after;
 * - `exit-code-matrix-path-{missing,unlistable,untraversable}.system.test.ts`
 *   run ONE outcome each across every document verb that takes a path.
 *
 * The table, the fixtures and the shard definition live in
 * `test-helpers/exit-code-matrix.ts`; the path verbs in
 * `test-helpers/exit-code-path-verbs.ts`.
 *
 * ## What is enumerated, and asserted both ways
 *
 * - Every `report` entry of `PUBLISHED_SHAPES` — the registered commands whose
 *   document is the envelope — has scenarios in the table, one per status the
 *   envelope can take, and no scenario names a verb that is not registered.
 *   Adding an envelope verb without adding it there is a red test, not a silent
 *   gap.
 * - Every scenario is RUN, by exactly one file: the shards partition the
 *   table's verbs, and the shard spec files on disk are exactly the declared
 *   shards. A verb with scenarios and no shard, a verb in two shards, a shard
 *   with no file and a shard file with no shard are each a red test here — and
 *   so is a path-outcome file that is missing or names no declared outcome.
 * - Every `error` scenario names the refusal code its document must carry: a
 *   user's mistake published as `INTERNAL_ERROR` reads as a VAT bug.
 * - Every outcome of every `external` entry's adapter maps to its code, and
 *   the adapter's table and this file's cases match both ways.
 */

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExitCode, REPORT_STATUSES } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { exitCodeForExternal, PUBLISHED_SHAPES, type ExternalOutcome } from '../../src/report-schemas.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { fakeHomeEnv } from './test-common.js';
import {
  byName,
  documentOf,
  ENVELOPE_SCENARIOS,
  MATRIX_BIN_PATH,
  MATRIX_SHARD_FILE,
  MATRIX_SHARDS,
  matrixTempDir,
  REGISTERED_ENVELOPE_VERBS,
  UNREACHABLE_STATUSES,
  useMatrixTempDir,
} from './test-helpers/exit-code-matrix.js';
import { MATRIX_PATH_FILE, MATRIX_PATH_OUTCOMES } from './test-helpers/exit-code-path-verbs.js';
import { executeCli } from './test-helpers/index.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test, and every `vat`
// child it spawns inherits them, so neither the run nor a mutation of its cleanup can reach the real temp dir.
useScratchTmpdir('vat-scratch-cli-16-');

/** The registered external verbs — the passed-through Admin API payloads, whose code an adapter decides. */
const REGISTERED_EXTERNAL_VERBS = PUBLISHED_SHAPES.flatMap((entry) => (entry.kind === 'external' ? entry.verbs : []));

/** One case per outcome an external adapter maps: only a write that fully landed is OK. */
const EXTERNAL_OUTCOMES: Readonly<Record<ExternalOutcome['kind'], { outcome: ExternalOutcome; code: number }>> = {
  ok: { outcome: { kind: 'ok' }, code: ExitCode.OK },
  partial: { outcome: { kind: 'partial', failed: 1 }, code: ExitCode.ERROR },
  failed: { outcome: { kind: 'failed', cause: 'refused' }, code: ExitCode.ERROR },
};

/** What each spec file beside this one is named after, for one file-name pattern — what actually runs. */
function namedOnDisk(pattern: RegExp): string[] {
  return readdirSync(dirname(fileURLToPath(import.meta.url))).flatMap((file) => {
    const name = pattern.exec(file)?.[1];
    return name === undefined ? [] : [name];
  });
}

/**
 * Every scenario that may SKIP, and what its skip costs — the whole list, both ways.
 *
 * A skipped scenario "still counts as present" in every check above, so a green
 * run says nothing about a status whose scenario did not run. This list is
 * where that is said out loud:
 *
 * - `platform` — skips only where the platform cannot do what the scenario sets
 *   up: a mode that denies a read or a write (Windows, or root), or a `--dev`
 *   symlink install (Windows). It RUNS on the ubuntu CI leg.
 * - `network` — skips when the npm registry does not answer. It runs on CI.
 * - `never-on-ci` — ⚠️ needs something NO CI runner provisions: a `claude` binary
 *   on PATH, or the ONNX embedding model already cached under the real home. On
 *   CI these scenarios always skip, so the matrix never observes that status of
 *   that verb there — it is checked only on a developer machine that has both.
 *
 * Adding a `skipReason` to a scenario, or removing one, is a red test here until
 * this list says which kind it is.
 */
const SKIPPABLE_SCENARIOS: Readonly<Record<string, 'platform' | 'network' | 'never-on-ci'>> = {
  'agent installed → findings': 'platform',
  'agent list → findings': 'platform',
  'cache clear → error': 'platform',
  'claude plugin install → findings': 'platform',
  'doctor → ok': 'network',
  'inventory → findings': 'platform',
  'rag index → findings': 'platform',
  'rag query → ok': 'never-on-ci',
  'skill test run → ok': 'never-on-ci',
  'skills list → findings': 'platform',
};

describe('exit codes are derived from the published document (system test)', () => {
  useMatrixTempDir();

  it('names every scenario that may skip — no scenario skips unlisted, and no listed one always runs', () => {
    const skippable = Object.entries(ENVELOPE_SCENARIOS).flatMap(([verb, scenarios]) =>
      scenarios.filter((scenario) => scenario.skipReason !== undefined).map((scenario) => `${verb} → ${scenario.status}`));

    expect(skippable.toSorted(byName)).toStrictEqual(Object.keys(SKIPPABLE_SCENARIOS).sort(byName));
  });

  // The bound on what a green CI run does not show: two statuses, of two verbs, and no third.
  it('leaves exactly two scenarios that no CI runner can run', () => {
    const neverOnCi = Object.entries(SKIPPABLE_SCENARIOS).flatMap(([scenario, kind]) => (kind === 'never-on-ci' ? [scenario] : []));

    expect(neverOnCi.toSorted(byName)).toStrictEqual(['rag query → ok', 'skill test run → ok']);
  });

  it('covers EXACTLY the registered envelope verbs — no more, no fewer', () => {
    expect(Object.keys(ENVELOPE_SCENARIOS).sort(byName)).toStrictEqual([...REGISTERED_ENVELOPE_VERBS].sort(byName));
  });

  it('gives every envelope verb one scenario per status, or the reason a status is unreachable', () => {
    for (const [verb, scenarios] of Object.entries(ENVELOPE_SCENARIOS)) {
      const shown = scenarios.map((scenario) => scenario.status);
      const unreachable = Object.keys(UNREACHABLE_STATUSES[verb] ?? {});
      expect(shown.filter((status) => unreachable.includes(status)), verb).toStrictEqual([]);
      expect([...shown, ...unreachable].sort(byName), verb).toStrictEqual([...REPORT_STATUSES].sort(byName));
    }
  });

  it('declares unreachable statuses only for envelope verbs', () => {
    expect(Object.keys(UNREACHABLE_STATUSES).filter((verb) => !REGISTERED_ENVELOPE_VERBS.includes(verb))).toStrictEqual([]);
  });

  /**
   * The scenarios are run by the shard files, not here — so "the table covers
   * the registry" proves nothing about what RUNS unless the shards are the
   * table. Compared as sorted LISTS, not sets: a verb in two shards is in the
   * left list twice, a verb in none is missing from it, and a shard naming a
   * verb the table lacks adds one the right list does not have.
   */
  it('assigns every verb of the table to EXACTLY one shard', () => {
    expect(Object.values(MATRIX_SHARDS).flat().sort(byName)).toStrictEqual(Object.keys(ENVELOPE_SCENARIOS).sort(byName));
  });

  // A shard file takes its slice by its own name (`exitCodeMatrixShard`),
  // so the files on disk ARE the shards that run: a declared shard with no file
  // runs nothing, and a file naming no declared shard throws when collected.
  it('has EXACTLY one spec file per declared shard', () => {
    expect(namedOnDisk(MATRIX_SHARD_FILE).sort(byName)).toStrictEqual(Object.keys(MATRIX_SHARDS).sort(byName));
  });

  // A path file runs every path verb for its one outcome and takes no slice,
  // so nothing in it can notice it is gone: a path file moved away would drop
  // an outcome from every verb with every other file still green.
  it('has EXACTLY one spec file per declared path outcome', () => {
    expect(namedOnDisk(MATRIX_PATH_FILE).sort(byName)).toStrictEqual([...MATRIX_PATH_OUTCOMES].sort(byName));
  });

  /**
   * An external verb has no envelope to derive a code from, so its entry's
   * adapter maps what the Admin API write did to the code. Only `failed` is
   * reachable by a spawned CLI — the org client has no base-URL override, so
   * `ok` and `partial` need the live API — so the table is asserted for every
   * verb through the adapter itself, and `failed` is also observed end to end.
   */
  describe('external verbs: the adapter decides the code', () => {
    it('covers every external adapter outcome', () => {
      const externals = PUBLISHED_SHAPES.filter((entry) => entry.kind === 'external');
      expect(externals.length).toBeGreaterThan(0);
      for (const entry of externals) {
        // Both ways: every outcome the adapter maps has a case here, and every case is one it maps.
        expect(Object.keys(entry.exitCodes).sort(byName), entry.verbs.join(', ')).toStrictEqual(Object.keys(EXTERNAL_OUTCOMES).sort(byName));
      }
      for (const verb of REGISTERED_EXTERNAL_VERBS) {
        for (const [kind, { outcome, code }] of Object.entries(EXTERNAL_OUTCOMES)) {
          expect(exitCodeForExternal(verb, outcome), `${verb} ${kind}`).toBe(code);
        }
      }
    });

    it('claude org info with no admin key publishes its USAGE_INVALID refusal and ends on the adapter\'s failed code', () => {
      const home = safePath.join(matrixTempDir(), 'homes', 'external-org-info');
      mkdirSyncReal(home, { recursive: true });
      const env = { ...process.env, ...fakeHomeEnv(home), ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' };
      const result = executeCli(MATRIX_BIN_PATH, ['claude', 'org', 'info'], { cwd: matrixTempDir(), env });

      expect(documentOf(result.stdout), `${result.stdout}\n${result.stderr}`).toMatchObject({ error: { code: 'USAGE_INVALID' } });
      expect(result.status).toBe(exitCodeForExternal('claude org info', { kind: 'failed', cause: 'refused' }));
    });
  });
});
