/**
 * The fixture every warm in-process cost arm of `vat validate` runs over: the cache
 * differential's gate fixture (its documents, its HTML page, its `CLAUDE.md` import and
 * path-scoped rule, which give the harness tables rows, and its SQL checks), plus what the
 * in-process cost enforcers need of their own:
 *
 * - a skill bundling a `.json` asset (a keyed member of the `none` parser kind);
 * - a markdown file only the skills view admits (`resources.exclude` hides it; the skill links it);
 * - a markdown document carrying every AST syntactic form (`AST_SYNTACTIC_FORMS`) and every
 *   lexical form ({@link LEXICAL_FORMS}).
 *
 * Small and plain text, so it builds on every OS and runs fast; members that need a POSIX file
 * mode or a symlink are planted by the arm that needs them, not here.
 *
 * The cost arms are split across two files, each inside the system tier's per-file budget
 * (`validate-in-process-cost.system.test.ts`: store reads, the admission and `fs.lstat`;
 * `validate-in-process-cost-membership-git.system.test.ts`: membership and git spawns). What both
 * run lives here: one checked `vat validate` run ({@link validateOver}) and the over-declaration
 * arm ({@link expectEveryDamageObserved}).
 *
 * Deliberately absent: an over-cap markdown file and a standalone keyed `.json` resources member.
 * The one-open-one-stat probe item and the served-kinds restriction are not built in this change,
 * so neither member is needed; the skill's bundled `.json` is the one `none`-kind member needed.
 */

import { cpSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { BUILTIN_CHECKS, PROJECTION_TABLES, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { mapWithConcurrency, safePath, type WorkCounter, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import type { ValidateDebugFacts } from '../../src/commands/validate-debug-facts.js';
import { RUN_INTEGRITY_CODE } from '../../src/utils/run-integrity.js';
import { GATE_FIXTURE, VERBS } from '../helpers/cache-differential.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { runWithWorkCounters } from '../helpers/work-counter-run.js';
import { writeCommittedCorpus } from '../test-helpers.js';

import { createSkillMarkdown, executeCli } from './test-common.js';

/** The lexical forms the raw-source lexer stores, which the fact reader drops. */
export const LEXICAL_FORMS = ['bare-token', 'at-prefixed', 'env-anchored'] as const;

/** The skill's directory, repository-relative. */
const COST_SKILL_DIR = 'skills/cost';

/** The skill's bundled `.json` asset: keyed, of the `none` parser kind. */
export const BUNDLED_JSON = `${COST_SKILL_DIR}/data.json`;

/** A markdown file only the skills view admits: `resources.exclude` hides it and the skill links it. */
export const SKILLS_ONLY_MARKDOWN = 'reference/skills-only.md';

/** A document carrying every AST syntactic form and every lexical form. */
export const FORMS_MARKDOWN = 'docs/forms.md';

/** The gate fixture's HTML member: its anchor is stored under the HTML form. */
export const HTML_PAGE = 'docs/page.html';

/** The config's `resources.exclude`: what hides {@link SKILLS_ONLY_MARKDOWN} from the resources view. */
export const RESOURCES_EXCLUDE = ['reference/**'] as const;

/** The gate fixture's config, with {@link RESOURCES_EXCLUDE} and a skills block added. */
function costConfig(): string {
  const gate = GATE_FIXTURE['vibe-agent-toolkit.config.yaml'];
  if (gate?.startsWith('resources:\n') !== true) throw new Error('the gate fixture config no longer opens with its resources block');
  return [
    'resources:',
    '  exclude:',
    ...RESOURCES_EXCLUDE.map((glob) => `    - "${glob}"`),
    gate.slice('resources:\n'.length).trimEnd(),
    'skills:',
    '  include:',
    '    - "skills/**/SKILL.md"',
    '',
  ].join('\n');
}

/**
 * Every form, one line each. The markdown parser stores the link, the reference and its
 * definition; the inline HTML anchor is the HTML form's (the gate fixture's `docs/page.html`
 * holds that form too); the lexer stores the three tokens on the last lines.
 */
const FORMS_CONTENT = [
  '# Forms',
  '',
  'An inline [link](./two.md) and a [reference link][two-ref].',
  '',
  '[two-ref]: ./guide.md',
  '',
  'An anchor: <a href="./two.md">two</a>.',
  '',
  'Run ./helper.mts beside it.',
  '',
  'Import @docs/two.md here.',
  '',
  'Settings at ${HOME}/.claude/settings.json today.',
  '',
].join('\n');

/** The fixture's files, repository-relative. */
export const IN_PROCESS_COST_FIXTURE: Readonly<Record<string, string>> = {
  ...GATE_FIXTURE,
  'vibe-agent-toolkit.config.yaml': costConfig(),
  [FORMS_MARKDOWN]: FORMS_CONTENT,
  [SKILLS_ONLY_MARKDOWN]: '# Skills only\n\nOnly the skill reaches this.\n',
  [`${COST_SKILL_DIR}/SKILL.md`]: `${createSkillMarkdown('cost')}\nRead [the data](./data.json) and [the reference](../../${SKILLS_ONLY_MARKDOWN}).\n`,
  [BUNDLED_JSON]: '{ "answer": 42 }\n',
};

/**
 * Write the fixture under `root` and commit it.
 *
 * @param root - An empty directory
 * @returns `root`
 */
export function writeInProcessCostFixture(root: string): string {
  return writeCommittedCorpus(root, IN_PROCESS_COST_FIXTURE);
}

/**
 * The rows `vat resources query <sql>` answers in `root` over the store in `cacheDir`.
 *
 * @param binPath - The CLI build
 * @param root - The fixture
 * @param cacheDir - The run's `VAT_CACHE_DIR`
 * @param sql - The statement
 * @returns Its rows
 * @throws Error when the query exits non-zero
 */
export async function queryRows(binPath: string, root: string, cacheDir: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const result = await executeCli(binPath, ['resources', 'query', sql, '--format', 'json'], { cwd: root, env: { [VAT_CACHE_DIR_ENV]: cacheDir } });
  if (result.status !== 0) throw new Error(`vat resources query exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`);
  const document = JSON.parse(result.stdout) as { data: { rows: Array<Record<string, unknown>> } };
  return document.data.rows;
}

/**
 * The committed snapshot of what the fixture's cold `vat resources query` answers over the rows the
 * stored admission does not read (a lexical form, a harness table).
 *
 * Provenance: recorded from the cold run, over an empty cache. A cold run computes its projection
 * and never reads the blob tier, so its rows cannot depend on the restricted blob read under test.
 * Checked when it was recorded: the base branch's build, run cold over the same fixture, answers
 * these rows byte for byte. Regenerate with
 * `UPDATE_IN_PROCESS_COST_SNAPSHOT=1` after `bun run build`, running
 * `validate-in-process-cost.system.test.ts` from `packages/cli`.
 */
export const REFERENCE_ROWS_SNAPSHOT = safePath.resolve(import.meta.dirname, '..', 'fixtures', 'in-process-cost', 'reference-rows.json');

/**
 * Run `body` on the one projection store a private cache holds, its connection closed after.
 *
 * @param cacheDir - The run's `VAT_CACHE_DIR`
 * @param body - What to do with the open store
 * @returns What `body` returned
 * @throws Error unless exactly one store is under `cacheDir`
 */
export function withStoreDatabase<T>(cacheDir: string, body: (database: DatabaseSync) => T): T {
  const files = storeFilesUnder(cacheDir);
  const [file] = files;
  if (file === undefined || files.length !== 1) throw new Error(`expected one projection store under ${cacheDir}, found ${String(files.length)}`);
  const database = new DatabaseSync(file);
  try {
    return body(database);
  } finally {
    database.close();
  }
}

/**
 * How many rows one projection table holds in a store, optionally only those of some
 * reference forms (`syntacticForm`).
 *
 * @param database - The store
 * @param table - The table's projection key (`blobReferences`)
 * @param forms - The forms to count, or `'all'`
 * @returns The count
 */
export function storedRowCount(database: DatabaseSync, table: keyof typeof PROJECTION_TABLES, forms: ReadonlySet<string> | 'all'): number {
  const name = PROJECTION_TABLES[table].name;
  if (forms === 'all') return Number((database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n);
  const values = [...forms];
  if (values.length === 0) return 0;
  const placeholders = values.map(() => '?').join(', ');
  return Number((database.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE syntacticForm IN (${placeholders})`).get(...values) as { n: number }).n);
}

/**
 * A copy of a warm cache with one stored row deleted: the first row of `table`, or the first of
 * one reference form when `form` is given.
 *
 * @param cacheDir - The warm cache
 * @param into - An empty directory for the copy
 * @param table - The table's projection key
 * @param form - The `syntacticForm` the deleted row has, or `null` for any row
 * @returns How many rows were deleted: 1, or 0 when the table held no such row
 */
function damagedCopy(cacheDir: string, into: string, table: keyof typeof PROJECTION_TABLES, form: string | null): number {
  cpSync(cacheDir, into, { recursive: true });
  const name = PROJECTION_TABLES[table].name;
  const where = form === null ? '' : ' WHERE syntacticForm = ?';
  return withStoreDatabase(into, (database) => {
    const statement = database.prepare(`DELETE FROM "${name}" WHERE rowid = (SELECT MIN(rowid) FROM "${name}"${where})`);
    return Number((form === null ? statement.run() : statement.run(form)).changes);
  });
}

// ── One `vat validate` run, and the over-declaration arm, shared by the cost files ───────────

/** What a cost arm needs of its suite: the CLI build, and private directories. */
interface CostSuite {
  readonly binPath: string;
  readonly createTempDir: () => string;
}

/** One `vat validate` run, read back. */
export interface ValidateRun {
  readonly document: Record<string, unknown>;
  /** The validate process's dump (the one with phases); the checks child's is `child`. */
  readonly parent: WorkCounterDump;
  readonly child: WorkCounterDump;
  /** The validate process's debug facts: the checks mode it got, and the gate condition that declined it. */
  readonly facts: ValidateDebugFacts;
}

/** How `vat validate`'s checks child runs: overlapping a warm resources phase, or at its turn. */
export type ChecksMode = 'overlapped' | 'sequential';

/** The core count the parent reports for each mode: the overlap gate needs two. */
const CHECKS_CORES: Readonly<Record<ChecksMode, number>> = { overlapped: 2, sequential: 1 };

/**
 * Run `vat validate` in `repo` over `cacheDir`, require it to pass, and read it back. A damaged
 * store is read whole by the checks child (a projection hit reads every table); every damage
 * target the arms commit leaves that child running, so every run passes.
 *
 * @param suite - The suite's build and temp directories
 * @param repo - The fixture
 * @param cacheDir - The run's `VAT_CACHE_DIR`
 * @param checks - How the checks child runs on a warm store, pinned through the core count the
 *   parent reports, so the run is the same on every machine
 * @returns The run
 */
export async function validateOver(suite: CostSuite, repo: string, cacheDir: string, checks: ChecksMode): Promise<ValidateRun> {
  const run = await runWithWorkCounters(suite, repo, VERBS.vatValidate.args, { cacheDir, tmpDir: null, storeOff: false, probeRoot: null, cores: CHECKS_CORES[checks] });
  expect(run.result.status, `validate\n${run.result.stdout}\n${run.result.stderr}`).toBe(0);
  const parent = run.dumps.find((dump) => dump.phases['resources'] !== undefined);
  const child = run.dumps.find((dump) => dump.phases['resources'] === undefined);
  if (parent === undefined || child === undefined) throw new Error(`expected the validate process's dump and its checks child's, got ${String(run.dumps.length)}`);
  const [facts, ...extra] = run.debugFacts;
  if (facts === undefined || extra.length > 0) throw new Error(`expected one validate debug-facts dump, got ${String(run.debugFacts.length)}`);
  return { document: VERBS.vatValidate.parse(run.result.stdout) as Record<string, unknown>, parent, child, facts };
}

/**
 * Require a warm run to have run its checks child in the mode its cores pinned, so a run the gate
 * declined for another reason (a timing, a member sent cold) names that reason instead of failing
 * later on a count.
 *
 * @param run - A warm run
 * @param checks - The mode its cores pinned
 */
export function expectChecksMode(run: ValidateRun, checks: ChecksMode): void {
  expect(
    { checksOverlapped: run.facts.checksOverlapped, gateDeclinedBy: checks === 'overlapped' ? run.facts.gateDeclinedBy : 'any' },
    `the warm run's checks mode (declined by ${JSON.stringify(run.facts.gateDeclinedBy)})`,
  ).toEqual({ checksOverlapped: checks === 'overlapped' ? 1 : 0, gateDeclinedBy: checks === 'overlapped' ? null : 'any' });
}

/**
 * The codes only the checks child reports: every built-in check's, and the refusal of a check
 * that stopped running. A declared check's code is `CUSTOM:<name>`.
 */
const CHECKS_CHILD_CODES: ReadonlySet<string> = new Set([...BUILTIN_CHECKS.map((check) => check.code), RUN_INTEGRITY_CODE]);

/**
 * What the in-process phases (resources, skills) answered: their phase entries and every finding
 * no check produced. The checks child reads the tier through its own request, so it is left out:
 * a damaged row that only the checks child reads must not pass for one the admission reads.
 *
 * @param document - A validate document
 * @returns The comparable part
 */
function admissionView(document: Record<string, unknown>): unknown {
  const normalized = VERBS.vatValidate.normalize(document) as { data: { phases: Array<{ name: string }> }; findings: Array<{ code: string }> };
  return {
    phases: normalized.data.phases.filter((phase) => phase.name !== 'checks'),
    findings: normalized.findings.filter((finding) => !finding.code.startsWith('CUSTOM:') && !CHECKS_CHILD_CODES.has(finding.code)),
  };
}

/** The counters a counted cold decline moves: a member read, admitted or scanned the cold way. */
const DECLINES = ['content.read', 'registry.admitted', 'skillText.storeMiss'] as const satisfies readonly WorkCounter[];

/**
 * The decline counters of one dump.
 *
 * @param dump - A dump
 * @returns Each decline counter's count
 */
export function declinesOf(dump: WorkCounterDump): Record<(typeof DECLINES)[number], number | undefined> {
  return Object.fromEntries(DECLINES.map((counter) => [counter, dump.counters[counter]])) as Record<(typeof DECLINES)[number], number | undefined>;
}

/** One stored row to damage: the first of `table`, or the first of one reference form. */
export interface DamageTarget {
  readonly table: keyof typeof PROJECTION_TABLES;
  readonly form: string | null;
}

/**
 * How many damaged runs go at once. Each is a `vat validate` with its checks child (two Node
 * processes); unbounded, a damage arm starts a dozen beside other files' tests that bound a stall
 * in seconds.
 */
const DAMAGE_RUN_CONCURRENCY = 2;

/** A warm store: the fixture, the cache written over it, and the undamaged warm run over that cache. */
interface WarmStore {
  readonly repo: string;
  readonly cacheDir: string;
  readonly warm: ValidateRun;
}

/**
 * The over-declaration arm: for each target, damage it in a copy of the warm store, run validate
 * over the copy, and require that the in-process phases' findings change or a counted cold decline
 * differs. Rows decoded is never the observable: a declared table nobody reads still decodes.
 *
 * @param suite - The suite's build and temp directories
 * @param store - The warm store to damage copies of
 * @param targets - What to damage, one copy each
 * @param reader - Who reads the targets, for the failure message
 */
export async function expectEveryDamageObserved(suite: CostSuite, store: WarmStore, targets: readonly DamageTarget[], reader: string): Promise<void> {
  const outcomes = await mapWithConcurrency(targets, async ({ table, form }) => {
    const copy = safePath.join(suite.createTempDir(), 'cache');
    const deleted = damagedCopy(store.cacheDir, copy, table, form);
    const damaged = await validateOver(suite, store.repo, copy, 'overlapped');
    return {
      target: form === null ? table : `${table}:${form}`,
      deleted,
      findingsChanged: JSON.stringify(admissionView(damaged.document)) !== JSON.stringify(admissionView(store.warm.document)),
      declines: declinesOf(damaged.parent),
    };
  }, DAMAGE_RUN_CONCURRENCY);
  const undamaged = declinesOf(store.warm.parent);
  for (const outcome of outcomes) expect(outcome.deleted, `${outcome.target}: the store held a row to damage`).toBe(1);
  // Every unobserved target at once, so a red names all of them.
  const unobserved = outcomes
    .filter((outcome) => !outcome.findingsChanged && JSON.stringify(outcome.declines) === JSON.stringify(undamaged))
    .map((outcome) => outcome.target);
  expect(unobserved, `damaging these changed nothing (findings, or the declines ${JSON.stringify(undamaged)}), so ${reader} does not need them`).toEqual([]);
}
