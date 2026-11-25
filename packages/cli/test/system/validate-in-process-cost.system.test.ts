/**
 * What `vat validate`'s two in-process phases (resources, skills) read from the fact store on a
 * warm run, counted per phase and per verb (ADR I10).
 *
 * `vat validate` opens one run context for every phase, so its skills phase reuses the resources
 * phase's home population and its blob-tier memo: the resources phase makes the run's one extent
 * read (membership) and one blob read (the tier), and the skills phase makes none. A standalone
 * `vat skills validate` builds its own population: one of each.
 *
 * Every arm has a private `VAT_CACHE_DIR`, warmed by one run of the same verb first. The membership
 * and git-spawn arms over the same fixture are in
 * `validate-in-process-cost-membership-git.system.test.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { ADMISSION_BLOB_REQUEST, AST_SYNTACTIC_FORMS, MEMBERSHIP_EXTENT_REQUEST, PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { compareCodeUnits, toForwardSlash, type WorkCounter, type WorkCounterDump, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryVerb, VERBS } from '../helpers/cache-differential.js';
import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { createSuiteContext, executeCli } from './test-common.js';
import {
  BUNDLED_JSON,
  type DamageTarget,
  declinesOf,
  expectChecksMode,
  expectEveryDamageObserved,
  FORMS_MARKDOWN,
  HTML_PAGE,
  IN_PROCESS_COST_FIXTURE,
  LEXICAL_FORMS,
  queryRows,
  REFERENCE_ROWS_SNAPSHOT,
  RESOURCES_EXCLUDE,
  SKILLS_ONLY_MARKDOWN,
  storedRowCount,
  validateOver,
  type ChecksMode,
  type ValidateRun,
  withStoreDatabase,
  writeInProcessCostFixture,
} from './validate-in-process-cost-fixture.js';

const context = createSuiteContext('vat-in-process-cost-', import.meta.url);

/** Whether the fixture config's `resources.exclude` drops a path. */
const excluded = picomatch([...RESOURCES_EXCLUDE]);

/** The resources view: every markdown document and HTML page but what `resources.exclude` drops. */
const RESOURCES_VIEW = Object.keys(IN_PROCESS_COST_FIXTURE).filter((path) => /\.(?:md|html)$/u.test(path) && !excluded(toForwardSlash(path)));

/** The two store-read counters. */
const READS = ['store.reads.extent', 'store.reads.blob'] as const satisfies readonly WorkCounter[];

/** One count set's store reads. */
function readsOf(counters: Readonly<Record<WorkCounter, number>> | undefined): Record<(typeof READS)[number], number | undefined> {
  return Object.fromEntries(READS.map((counter) => [counter, counters?.[counter]])) as Record<(typeof READS)[number], number | undefined>;
}

/**
 * Run `vat <args>` twice in `root` over one private cache, and return the second (warm) run's
 * dumps.
 *
 * @param root - The fixture
 * @param args - The verb
 * @returns Every CLI process's dump of the warm run
 */
async function warmDumps(root: string, args: readonly string[]): Promise<readonly WorkCounterDump[]> {
  const options = { cacheDir: context.createTempDir(), tmpDir: null, storeOff: false, probeRoot: null, cores: 2 } as const;
  const cold = await runWithWorkCounters(context, root, args, options);
  expect(cold.result.status, `cold ${args.join(' ')}\n${cold.result.stdout}\n${cold.result.stderr}`).toBe(0);
  const warm = await runWithWorkCounters(context, root, args, options);
  expect(warm.result.status, `warm ${args.join(' ')}\n${warm.result.stdout}\n${warm.result.stderr}`).toBe(0);
  return warm.dumps;
}

/** A fixture's cold then warm `vat validate` over one private cache. */
interface ColdWarm {
  readonly repo: string;
  readonly cacheDir: string;
  readonly cold: ValidateRun;
  readonly warm: ValidateRun;
}

/**
 * Run `vat validate` over a committed fixture cold, then warm, on a fresh private cache.
 *
 * @param repo - The fixture
 * @param checks - How the checks child runs
 * @returns The two runs
 */
async function coldThenWarm(repo: string, checks: ChecksMode): Promise<ColdWarm> {
  const cacheDir = context.createTempDir();
  const cold = await validateOver(context, repo, cacheDir, checks);
  const warm = await validateOver(context, repo, cacheDir, checks);
  expectChecksMode(warm, checks);
  return { repo, cacheDir, cold, warm };
}

/** The cost fixture's cold then warm runs, started by whichever arm asks first. */
let fixtureRuns: Promise<ColdWarm> | undefined;

/** The cost fixture's ({@link root}'s) cold then warm runs: once per file, however many arms ask. */
function costFixtureRuns(): Promise<ColdWarm> {
  fixtureRuns ??= coldThenWarm(root, 'overlapped');
  return fixtureRuns;
}

/** The cost fixture, committed once for the whole file. */
let root: string;

beforeAll(() => {
  context.setup();
  root = writeInProcessCostFixture(context.createTempDir());
});

afterAll(() => {
  context.cleanup();
});

describe('store reads per phase and per verb, warm', () => {
  it('reads the store once per kind in validate resources, never in validate skills, once in standalone skills validate', async () => {
    const validate = await warmDumps(root, ['validate']);
    // The validate process itself: the one dump carrying the resources phase (the checks child is another).
    const parent = validate.find((dump) => dump.phases['resources'] !== undefined);
    expect(parent, 'the validate process\'s dump').toBeDefined();
    expect(readsOf(parent?.phases['resources']), 'validate, resources phase').toEqual({ 'store.reads.extent': 1, 'store.reads.blob': 1 });
    expect(readsOf(parent?.phases['skills']), 'validate, skills phase').toEqual({ 'store.reads.extent': 0, 'store.reads.blob': 0 });

    const standalone = await warmDumps(root, ['skills', 'validate']);
    expect(standalone, 'one CLI process').toHaveLength(1);
    expect(readsOf(standalone[0]?.counters), 'vat skills validate').toEqual({ 'store.reads.extent': 1, 'store.reads.blob': 1 });
  });
});

// The control: every arm above is only as good as the fixture's claim to hold what they need.
describe('the fixture holds what the cost arms need', () => {
  it('stores every syntactic form, harness rows, a none-kind asset and a skills-only document', async () => {
    const cacheDir = context.createTempDir();
    const ask = (sql: string): Promise<Array<Record<string, unknown>>> => queryRows(context.binPath, root, cacheDir, sql);
    // The skills-only document is outside the resources view: validate's resources phase admits
    // every other markdown document and HTML page, and its skills phase admits it alone.
    const { result, dumps } = await runWithWorkCounters(context, root, ['validate'], { cacheDir, tmpDir: null, storeOff: false, probeRoot: null, cores: 2 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The view by path: `vat resources scan` admits the `resources` view the phase admits, and
    // names each member, so the skills-only document's absence is read, not inferred from a count.
    const scan = await executeCli(context.binPath, ['resources', 'scan', '--verbose', '--format', 'json'], { cwd: root, env: { [VAT_CACHE_DIR_ENV]: cacheDir } });
    expect(scan.status, `${scan.stdout}\n${scan.stderr}`).toBe(0);
    const scanned = (JSON.parse(scan.stdout) as { data: { files: Array<{ path: string }> } }).data.files.map((file) => toForwardSlash(file.path));
    expect(scanned, 'the resources view, by path').not.toContain(SKILLS_ONLY_MARKDOWN);
    expect([...scanned].sort(compareCodeUnits), 'the resources view, by path').toEqual([...RESOURCES_VIEW].sort(compareCodeUnits));
    const phases = dumps.find((dump) => dump.phases['resources'] !== undefined)?.phases;
    expect(phases?.['resources']?.['registry.admitted'], 'the resources phase admits that view').toBe(RESOURCES_VIEW.length);
    expect(phases?.['skills']?.['registry.admitted'], 'only the skills view admits the skills-only document').toBe(1);
    const forms = await ask(
      `SELECT DISTINCT x.syntacticForm AS form FROM blob_references x JOIN resource_realizations r ON r.contentKey = x.blob WHERE r.path IN ('${FORMS_MARKDOWN}', '${HTML_PAGE}')`,
    );
    expect(new Set(forms.map((row) => row['form']))).toEqual(new Set([...AST_SYNTACTIC_FORMS, ...LEXICAL_FORMS]));
    const [harness] = await ask('SELECT (SELECT COUNT(*) FROM harness_blob_facts) AS facts, (SELECT COUNT(*) FROM harness_blob_imports) AS imports');
    expect(harness?.['facts'], 'harness_blob_facts rows').toBeGreaterThan(0);
    expect(harness?.['imports'], 'harness_blob_imports rows').toBeGreaterThan(0);
    const keys = await ask(`SELECT path, contentKey FROM resource_realizations WHERE path IN ('${BUNDLED_JSON}', '${SKILLS_ONLY_MARKDOWN}') ORDER BY path`);
    expect(keys.map((row) => [row['path'], String(row['contentKey']).split('.')[0]])).toEqual([
      [SKILLS_ONLY_MARKDOWN, 'markdown'],
      [BUNDLED_JSON, 'none'],
    ]);
  });
});

// ── The stored admission's blob read ─────────────────────────────────────────────────────────
//
// The stored admission reads only what the fact reader consumes (`ADMISSION_BLOB_REQUEST`: the
// reader's tables, and of `blob_references` only the AST forms). The checks child and a query
// decode every other table whole and only the AST forms of `blob_references`: its lexical rows
// they copy from the store inside SQLite, never decoded.

/** The statements over the rows the admission does not read: a lexical form, and a harness table. */
const UNREAD_ROW_QUERIES = {
  bareToken: "SELECT * FROM blob_references WHERE syntacticForm = 'bare-token' ORDER BY 1, 2",
  harnessImports: 'SELECT * FROM harness_blob_imports ORDER BY 1, 2, 3',
} as const;

/**
 * `vat resources query <sql>` over `cacheDir`, parsed.
 *
 * @param cacheDir - The run's `VAT_CACHE_DIR`
 * @param sql - The statement
 * @returns The document
 */
async function queryOver(cacheDir: string, sql: string): Promise<Record<string, unknown>> {
  const verb = queryVerb(sql);
  const result = await executeCli(context.binPath, [...verb.args], { cwd: root, env: { [VAT_CACHE_DIR_ENV]: cacheDir } });
  expect(result.status, `query ${sql}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return verb.parse(result.stdout) as Record<string, unknown>;
}

describe('the stored admission reads only what the fact reader consumes, warm', () => {
  let runs: ColdWarm;

  beforeAll(async () => {
    runs = await costFixtureRuns();
  });

  it('holds a reference row of every AST form and lexical rows, and decodes only the AST forms', () => {
    const { warm } = runs;
    withStoreDatabase(runs.cacheDir, (database) => {
      for (const form of AST_SYNTACTIC_FORMS) expect(storedRowCount(database, 'blobReferences', new Set([form])), `${form} rows`).toBeGreaterThan(0);
      for (const form of LEXICAL_FORMS) expect(storedRowCount(database, 'blobReferences', new Set([form])), `${form} rows`).toBeGreaterThan(0);

      // One extent and one tree's keys, so a count over a whole table is a count over what each read asked for.
      expect(Number((database.prepare('SELECT COUNT(*) AS n FROM extents').get() as { n: number }).n), 'extents').toBe(1);
      const keyed = Number((database.prepare("SELECT COUNT(DISTINCT contentKey) AS n FROM resource_realizations WHERE contentState = 'keyed'").get() as { n: number }).n);
      expect(Number((database.prepare('SELECT COUNT(*) AS n FROM blob_keys').get() as { n: number }).n), 'every stored key is a keyed member').toBe(keyed);

      const tables = Object.values(PROJECTION_TABLES);
      const sum = (keys: readonly (keyof typeof PROJECTION_TABLES)[], forms: ReadonlySet<string> | 'all'): number =>
        keys.reduce((total, key) => total + storedRowCount(database, key, key === 'blobReferences' ? forms : 'all'), 0);
      const extentRows = sum(tables.filter((spec) => spec.scope === 'extent').map((spec) => spec.key), 'all');
      // Membership's three tables under the one extent key.
      const membershipRows = sum(MEMBERSHIP_EXTENT_REQUEST.tables, 'all');
      expect(membershipRows, 'the membership request leaves extent rows unread').toBeLessThan(extentRows);
      // The forms the fact reader keeps, never the request's own: a request reading the lexical
      // forms too would otherwise expect what it decodes.
      const admitted = sum(ADMISSION_BLOB_REQUEST.tables, AST_SYNTACTIC_FORMS);
      const every = sum(tables.filter((spec) => spec.scope === 'blob').map((spec) => spec.key), 'all');
      expect(admitted, 'the admission request leaves rows unread').toBeLessThan(every);

      // The resources phase reads the extent once (membership) and the tier once (the admission);
      // the checks child decodes the extent whole and the tier less its lexical references.
      expect(warm.parent.phases['resources']?.['store.rows.decoded.persistent'], 'validate, resources phase').toBe(membershipRows + admitted);
      expect(warm.parent.phases['skills']?.['store.rows.decoded.persistent'], 'validate, skills phase').toBe(0);
      const lexical = storedRowCount(database, 'blobReferences', new Set(LEXICAL_FORMS));
      expect(warm.child.counters['store.rows.decoded.persistent'], 'the checks child').toBe(extentRows + every - lexical);
    });
  });

  it('serves the checks child and a query every table and every form, as the cold run answers', async () => {
    const { cold, warm } = runs;
    // Links and findings: the warm run answers what the cold one did, the checks child from the store.
    expect(VERBS.vatValidate.normalize(warm.document)).toEqual(VERBS.vatValidate.normalize(cold.document));
    const phases = (warm.document['data'] as { phases: Array<{ name: string; data: { population?: unknown } }> }).phases;
    expect(phases.find((phase) => phase.name === 'checks')?.data.population, 'the checks child is served').toBe('store');
    expect(declinesOf(warm.parent)['content.read'], 'nothing read the cold way').toBe(0);

    const recorded: Record<string, unknown> = {};
    for (const [name, sql] of Object.entries(UNREAD_ROW_QUERIES)) {
      const computed = await queryOver(context.createTempDir(), sql);
      const served = await queryOver(runs.cacheDir, sql);
      expect((served['data'] as { population: unknown }).population, `${name}: served from the store`).toBe('store');
      expect(queryVerb(sql).normalize(served), name).toEqual(queryVerb(sql).normalize(computed));
      const rows = (computed['data'] as { rows: unknown[] }).rows;
      expect(rows.length, `${name}: the fixture holds such rows`).toBeGreaterThan(0);
      recorded[name] = rows;
    }
    if (process.env['UPDATE_IN_PROCESS_COST_SNAPSHOT'] === '1') {
      writeFileSync(REFERENCE_ROWS_SNAPSHOT, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    expect(recorded, `the recorded rows (${REFERENCE_ROWS_SNAPSHOT}; UPDATE_IN_PROCESS_COST_SNAPSHOT=1 rewrites it)`).toEqual(JSON.parse(readFileSync(REFERENCE_ROWS_SNAPSHOT, 'utf-8')));
  });

  it('changes what the admission does when any row it reads is damaged', async () => {
    const forms = ADMISSION_BLOB_REQUEST.referenceForms;
    // One target per table the admission reads, and of the reference table one per form it reads.
    const targets = ADMISSION_BLOB_REQUEST.tables.flatMap((table): DamageTarget[] =>
      table === 'blobReferences' && forms !== 'all' ? [...forms].map((form) => ({ table, form })) : [{ table, form: null }]);
    await expectEveryDamageObserved(context, runs, targets, 'the admission');
  });
});

// ── `fs.lstat` per phase, warm ───────────────────────────────────────────────────────────────
//
// `fs.lstat` is held by relation, never by a literal: the link-chain walks it counts include paths
// walked from the filesystem root, so a count is set by where the machine keeps its temp
// directory. Each side of the relation is derived from the fixture's own paths. The cost fixture
// against the same fixture plus one decoy document nested below the root, both warm: the resources
// phase admits the decoy from the store, and its warm admission walks the decoy's path, one
// `lstat` per component below the root. The decoy is outside the skills view, so the skills phase
// and the checks phase do the same work either way.
//
// Cold minus warm is not held: what one more member costs a cold run depends on whether the
// directories it passes through are new to the run (a decoy at the root and one in new directories
// differ by more than their components), so it is no figure derivable from the member's own path.

/** The decoy: a markdown document three directories below the root, in no skill's view. */
const DECOY = 'docs/decoy/nested/decoy.md';

/** The phases a validate process counts in. */
const LSTAT_PHASES = ['resources', 'skills', 'checks'] as const;

/** A warm run's `fs.lstat` per phase. */
function lstatsByPhase(run: ValidateRun): Record<(typeof LSTAT_PHASES)[number], number | undefined> {
  return Object.fromEntries(LSTAT_PHASES.map((phase) => [phase, run.parent.phases[phase]?.['fs.lstat']])) as Record<(typeof LSTAT_PHASES)[number], number | undefined>;
}

describe('fs.lstat per phase, warm, by relation', () => {
  // Overlapped, the checks child starts during the resources phase and the parent's checks phase
  // only takes its turn; sequential, that phase spawns the child. Either way the decoy costs the
  // resources phase its walk below the root and every other phase nothing.
  it.each(['overlapped', 'sequential'] as const)('%s: one more member below the root costs the resources phase its walk below the root, and the other phases nothing', async (checks) => {
    const bare = checks === 'overlapped' ? await costFixtureRuns() : await coldThenWarm(root, checks);
    const decoyed = await coldThenWarm(writeCommittedCorpus(context.createTempDir(), { ...IN_PROCESS_COST_FIXTURE, [DECOY]: '# Decoy\n\nNothing links here.\n' }), checks);
    const without = lstatsByPhase(bare.warm);
    const withDecoy = lstatsByPhase(decoyed.warm);
    // The phases that walk paths in the parent, so the relation below is not over zeros.
    for (const phase of ['resources', 'skills'] as const) expect(without[phase], `${phase}: the phase counted fs.lstat`).toBeGreaterThan(0);
    const walkBelowRoot = toForwardSlash(DECOY).split('/').length;
    expect({
      resources: (withDecoy.resources ?? 0) - (without.resources ?? 0),
      skills: (withDecoy.skills ?? 0) - (without.skills ?? 0),
      checks: (withDecoy.checks ?? 0) - (without.checks ?? 0),
    }, `the decoy ${DECOY}: its components below the root, in the resources phase alone`).toEqual({ resources: walkBelowRoot, skills: 0, checks: 0 });
    // The pin took: the parent's checks phase lstats only when it spawns the child itself, so an
    // arm that silently ran the other mode fails here.
    if (checks === 'overlapped') expect(without.checks ?? 0, 'overlapped: the checks phase only takes its turn').toBe(0);
    else expect(without.checks, 'sequential: the checks phase spawns the child').toBeGreaterThan(0);
  });
});
