/**
 * `vat claude context [path]` — what loads into an agent's context here, and
 * what it costs.
 *
 * The first ANALYSIS verb under `vat claude`, which until now held only
 * management verbs (plugins, marketplaces, org administration). It answers a
 * question, changes nothing, and never gates: there is no threshold anywhere in
 * this file, and the only non-zero exit is {@link handleCommandError}'s 2 for a
 * system failure. A number that fails a build teaches people to stop reading it.
 *
 * ## Everything below is orchestration and formatting — deliberately
 *
 * Which files load, why, and what they cost are all decided in
 * `@vibe-agent-toolkit/resources` (`whatLoadsAt` and `account`). This module
 * populates, calls them, and renders. It computes nothing about context loading
 * of its own, which is the CLI-stays-dumb rule applied to a lane where the
 * temptation is strong: the totals are right there and a "just one more derived
 * field" would put a second, unowned model of the vendor's behaviour in the
 * package no other package can depend on.
 *
 * ## The limits ride WITH the answer, in every format
 *
 * Spec §11 puts the stated limits in the command's own output rather than in a
 * doc, because a limit a reader has to go and find is a limit that never reaches
 * the person acting on the number. So {@link CLAUDE_CONTEXT_LIMITS} and
 * {@link CLAUDE_CONTEXT_MODELLED_BEHAVIOURS} are fields of the yaml/json document
 * and a printed section of the text rendering, and
 * {@link CLAUDE_CONTEXT_BOUNDS_STATEMENT} — *neither a floor nor a ceiling* —
 * appears in all three. All three are imported, never restated: the sentence is
 * domain content owned beside the list it frames, so every other consumer of the
 * list reaches it too.
 *
 * ⛔ Nothing here may read as "complete". Many of the stated limits are signed
 * `over-report`/`under-report` and apply whether or not `unknownTokenRows`,
 * `skippedOversizeRows` and `prunedRows` are all zero, so zeroed counters are not
 * a licence for the words "total cost", "full" or "all context".
 *
 * ⛔ A `null` token or byte count is an UNKNOWN SIZE and is never rendered as 0 —
 * see {@link chargeText}. A confident zero is indistinguishable from a measured
 * one, and the same reasoning is why an unrealized path answers `unknown` rather
 * than an empty table.
 */

import {
  account,
  buildClaudeContextPopulation,
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  CLAUDE_CONTEXT_LIMITS,
  CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  CLAUDE_MD_TAG,
  whatLoadsAt,
  type AccountedRow,
  type Admission,
  type ContextTotals,
  type GradedCondition,
  type LoadedContextAnswer,
  type ModelledBehaviour,
  type Projection,
  type StatedLimit,
} from '@vibe-agent-toolkit/resources';
import { findProjectRoot, isAbsoluteAnyPlatform, safePath } from '@vibe-agent-toolkit/utils';
import { Command, Option } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeStdoutSync, writeYamlOutput } from '../../utils/output.js';
import { populationWiring } from '../../utils/population-wiring.js';
import { withPopulationCache } from '../../utils/projection-store.js';
import { gitTrackerForProjectRoot } from '../audit/distributed-tree.js';

/** Soft wrap width for the printed limit statements. */
const WRAP_COLUMNS = 96;

/** How the answer is rendered. `text` is for a person; the other two are for a program. */
export type ContextOutputFormat = 'text' | 'yaml' | 'json';

/** Flags `vat claude context` accepts. */
export interface ClaudeContextOptions {
  format?: ContextOutputFormat;
  debug?: boolean;
}

/**
 * The yaml/json document for a path the projection realizes.
 *
 * `rows` are `AccountedRow`s verbatim rather than a narrowed projection of them:
 * re-shaping the rows here would be the CLI deciding which of the accounting
 * module's facts a consumer is allowed to see, and `resourceId` and `bytes` are
 * exactly what a consumer joining this answer to another projection query needs.
 */
export interface ContextAnswerDocument {
  readonly kind: 'answer';
  readonly input: string;
  readonly directory: string;
  readonly file: string | null;
  readonly totals: ContextTotals;
  readonly rows: readonly AccountedRow[];
  readonly conditions: readonly GradedCondition[];
  readonly overBudgetRules: readonly string[];
  readonly unattributedImports: readonly string[];
  readonly boundsStatement: string;
  readonly limits: readonly StatedLimit[];
  readonly modelledBehaviours: readonly ModelledBehaviour[];
}

/**
 * The yaml/json document for a path the projection never realized.
 *
 * ⛔ Structurally different from an answer, and that is the point: it carries no
 * `totals` and no `rows`, so a consumer cannot accidentally read "VAT never
 * looked at this path" as "nothing loads here". `explanation` says the same thing
 * to a person who is reading the document rather than switching on `kind`.
 *
 * ⛔ It carries no `boundsStatement` and no `limits` either, and their absence is
 * a DECISION rather than an oversight — see {@link unknownDocumentFor}.
 */
export interface ContextUnknownDocument {
  readonly kind: 'unknown';
  readonly input: string;
  readonly reason: 'path-not-realized';
  readonly explanation: string;
}

/**
 * Create the `vat claude context [path]` command.
 *
 * @returns The configured Commander command
 */
export function createContextCommand(): Command {
  const command = new Command('context');
  command
    .description('Report what Claude Code loads into context at a path, why, and what it costs')
    .argument('[path]', 'File or directory to answer for (default: the current directory)')
    .addOption(
      new Option('--format <format>', 'Output format: text (default), yaml, or json').choices([
        'text',
        'yaml',
        'json',
      ]).default('text'),
    )
    .option('--debug', 'Verbose logging to stderr')
    .action(claudeContextCommand)
    .addHelpText('after', `
Description:
  Report which CLAUDE.md files, .claude/rules files and @-imported files load
  into an agent's context at a path, why each one is there, and what it costs.
  A FILE argument is exact; a directory argument answers path-scoped rules as
  "may fire here".

Output:
  - totals:  always/on-demand token estimates, plus counts of rows whose size
             is unknown, skipped by the 4 MiB cliff, or pruned behind one
  - rows:    one per resource, with every predicate that admitted it
  - limits:  what this answer deliberately does not settle, in both directions

  A path the projection never realized answers kind: unknown — never zero.
  Diagnostics and blob-stage refusals go to stderr; stdout is the document.

Exit Codes:
  0 - An answer was produced (there is no threshold and no gate)
  1 - Invalid usage (unknown option, or an unsupported --format value)
  2 - System error (path outside the corpus root, unreadable tree)

Example:
  $ vat claude context packages/cli/src/index.ts    # exact, file-scoped answer
`);
  return command;
}

/**
 * Action handler for `vat claude context [path]`.
 *
 * @param pathArg - The path to answer for, or undefined for the current directory
 * @param options - The command's flags
 */
export async function claudeContextCommand(
  pathArg: string | undefined,
  options: ClaudeContextOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const root = findProjectRoot(process.cwd()) ?? process.cwd();
    const target = targetPathWithin(root, pathArg);
    const projection = await populateContext(root, logger);
    const answer = whatLoadsAt(projection, target);
    const format = options.format ?? 'text';

    if (answer.kind === 'unknown') {
      const document = unknownDocumentFor(answer.input, root);
      emit(document, renderUnknownText(document), format);
    } else {
      emit(...answerRenderings(answer, projection), format);
    }
    // ⛔ Always 0. There is no threshold in this command and there is not going
    // to be one — a number that fails a build is a number people learn to stop
    // reading. The explicit exit matches every other leaf here and guarantees the
    // process ends rather than waiting on whatever the population left behind.
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'claude context');
  }
}

/**
 * The answer document and its text rendering, as one pair.
 *
 * Split from the handler so the handler stays a straight line: the accounting
 * call needs the `claude-md` identity set, and threading that through the
 * handler body put three statements between the query and its rendering.
 *
 * @param answer - The query's answer
 * @param projection - The populated projection, for the `claude-md` tag rows
 * @returns The document, and the text rendering of it
 */
function answerRenderings(
  answer: LoadedContextAnswer,
  projection: Projection,
): [ContextAnswerDocument, string] {
  // The cliff and root discovery read ONE vocabulary: these are the ids the
  // shipped `classifyPath` tagged, not a second basename rule invented here.
  const claudeMdIds = new Set(
    projection.resourceTags
      .filter((tag) => tag.tag === CLAUDE_MD_TAG)
      .map((tag) => tag.resourceId),
  );
  const accounted = account(answer, claudeMdIds);
  // 🔑 `conditions`, `overBudgetRules` and `unattributedImports` live on the
  // ORIGINAL answer — `AccountedContext` is `{rows, totals}` and nothing else.
  // Reading them off the accounting result silently drops every warning.
  const document: ContextAnswerDocument = {
    kind: 'answer',
    input: answer.input,
    directory: answer.directory,
    file: answer.file,
    totals: accounted.totals,
    rows: accounted.rows,
    conditions: answer.conditions,
    overBudgetRules: answer.overBudgetRules,
    unattributedImports: answer.unattributedImports,
    boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
    limits: CLAUDE_CONTEXT_LIMITS,
    modelledBehaviours: CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  };
  return [document, renderAnswerText(document)];
}

/**
 * Does a path already stated against the corpus root fall OUTSIDE it?
 *
 * Three spellings of "outside", not two, and the third is the one that could
 * only fail where nobody would see it. `safePath.relative` says "not under this
 * root" with a `..`-prefixed path in the ordinary case, but returns an ABSOLUTE
 * path when no relative route exists at all — which on Windows is exactly what a
 * different drive letter produces. Without the third test, `vat claude context
 * D:\elsewhere\doc.md` run from a `C:` repo passes the guard and answers `kind:
 * unknown`, indistinguishable from a typo inside the tree, which is the one
 * outcome {@link targetPathWithin}'s `@throws` claims to prevent. Its sibling
 * `escapesRoot` (`closure-extent.ts`) applies the same triple for the same
 * reason.
 *
 * ⛔ Exported so it can be TESTED. On POSIX `safePath.relative` between two
 * absolute paths never returns an absolute string, so the third clause is
 * unreachable through {@link targetPathWithin} on every machine a developer
 * runs — the branch has to be exercised directly or not at all, and "not at
 * all" is how it went missing in the first place.
 *
 * @param normalizedRelative - A forward-slashed path already stated against the
 *   corpus root
 * @returns True when the corpus root does not contain it
 */
export function escapesCorpusRoot(normalizedRelative: string): boolean {
  return normalizedRelative === '..'
    || normalizedRelative.startsWith('../')
    || isAbsoluteAnyPlatform(normalizedRelative);
}

/**
 * The root-relative path to query, refusing anything outside the corpus.
 *
 * @param root - The discovered project root
 * @param pathArg - The path argument, or undefined for the current directory
 * @returns The root-relative, forward-slashed target. `''` is the corpus root
 * @throws When the argument resolves outside `root` — answering for it would
 *   mean querying a corpus this projection never enumerated, and a confident
 *   `unknown` there would be indistinguishable from a typo inside the tree
 */
function targetPathWithin(root: string, pathArg: string | undefined): string {
  const relative = safePath.relative(root, safePath.resolve(process.cwd(), pathArg ?? '.'));
  if (escapesCorpusRoot(relative)) {
    throw new Error(
      `${pathArg ?? process.cwd()} resolves outside the corpus root ${root}.`
      + ' vat claude context answers only for paths inside the root it discovered —'
      + ' run it from within the project you mean to ask about.',
    );
  }
  return relative;
}

/**
 * Populate the Claude-context lane for one tree.
 *
 * @param root - The absolute corpus root
 * @param logger - Where blob-stage refusals go. **stderr**, never stdout: this
 *   command's stdout is the document a caller parses, and a diagnostic in the
 *   middle of it breaks every consumer
 * @returns The populated projection
 */
async function populateContext(root: string, logger: Logger): Promise<Projection> {
  return withPopulationCache({ root }, async (cache) => {
    const gitTracker = await gitTrackerForProjectRoot(root);
    return buildClaudeContextPopulation({ root, ...populationWiring(logger, gitTracker, cache) });
  });
}

/**
 * Write the document in the requested format.
 *
 * @param document - The yaml/json payload
 * @param text - The text rendering of the same answer
 * @param format - The selected format
 */
function emit(document: unknown, text: string, format: ContextOutputFormat): void {
  if (format === 'json') {
    writeJsonOutput(document);
    return;
  }
  if (format === 'yaml') {
    writeYamlOutput(document);
    return;
  }
  writeStdoutSync(text);
}

/**
 * The non-answer, spelled so it cannot be mistaken for an empty answer.
 *
 * ⛔ **`boundsStatement` and `limits` are omitted on purpose, in every format.**
 * Every one of those limits is a bound on a MEASUREMENT — how much this answer
 * may over- or under-report. Nothing was measured here, so publishing them would
 * assert that a measurement happened and merely came with caveats, which is the
 * exact confusion `kind: 'unknown'` exists to prevent. A consumer reading
 * `document.limits` unconditionally therefore gets `undefined`, and that is the
 * correct signal: switch on `kind` first. The `explanation` carries the only
 * caveat that applies to a non-answer, which is that there is no answer.
 *
 * @param input - The path that was asked about
 * @param root - The corpus root that was enumerated
 * @returns The unknown document
 */
function unknownDocumentFor(input: string, root: string): ContextUnknownDocument {
  return {
    kind: 'unknown',
    input,
    reason: 'path-not-realized',
    explanation:
      `${displayPath(input)} is not a path this projection realized under ${root}, so VAT did not`
      + ' look at it. This is NOT an answer of "nothing loads here" — no context was measured at'
      + ' all. Check the path exists and is not excluded from enumeration.',
  };
}

/**
 * Render the non-answer for a person.
 *
 * @param document - The unknown document
 * @returns The text rendering, newline-terminated
 */
function renderUnknownText(document: ContextUnknownDocument): string {
  return [
    `NO ANSWER for ${displayPath(document.input)} — reason: ${document.reason}`,
    '',
    ...wrapStatement(document.explanation, '  '),
    '',
  ].join('\n');
}

/**
 * Render the answer for a person.
 *
 * @param document - The answer document
 * @returns The text rendering, newline-terminated
 */
function renderAnswerText(document: ContextAnswerDocument): string {
  const lines = [
    ...headingLines(document),
    ...estimateLines(document.totals),
    ...rowSection('Loaded at launch (always)', document.rows, 'always'),
    ...rowSection('Loaded on demand', document.rows, 'on-demand'),
    ...listSection('Conditions', document.conditions.map(conditionLine)),
    ...listSection('Rules whose paths: list exceeded the vendor pattern budget', document.overBudgetRules),
    ...listSection('Imported files no importer could be attributed to', document.unattributedImports),
    ...limitSection(document),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The heading, which states up front whether the query was exact.
 *
 * @param document - The answer document
 * @returns The heading lines, blank-terminated
 */
function headingLines(document: ContextAnswerDocument): string[] {
  const exactness = document.file === null
    ? 'DIRECTORY query — path-scoped rules are reported as "may fire here", not exactly'
    : 'FILE query — path-scoped rules are matched exactly';
  return [`Claude Code context at ${displayPath(document.input)}`, `  ${exactness}`, ''];
}

/**
 * The token estimate and the three counters that keep it from reading as settled.
 *
 * @param totals - The accounting totals
 * @returns The section's lines, blank-terminated
 */
function estimateLines(totals: ContextTotals): string[] {
  return [
    'Token estimate',
    `  always-loaded         ${totals.alwaysTokens} tokens`,
    `  on-demand             ${totals.onDemandTokens} tokens`,
    `  size unknown          ${totals.unknownTokenRows} rows (counted, never summed as zero)`,
    `  skipped over 4 MiB    ${totals.skippedOversizeRows} rows`,
    `  pruned behind a skip  ${totals.prunedRows} rows`,
    '',
  ];
}

/**
 * One load class's rows, each with every predicate that admitted it.
 *
 * @param title - The section heading
 * @param rows - Every accounted row
 * @param loadClass - The class this section reports
 * @returns The section's lines, or none when the class is empty
 */
function rowSection(
  title: string,
  rows: readonly AccountedRow[],
  loadClass: AccountedRow['loadClass'],
): string[] {
  const selected = rows.filter((row) => row.loadClass === loadClass);
  if (selected.length === 0) return [];
  const lines = [title];
  for (const row of selected) {
    lines.push(`  ${row.path} — ${chargeText(row)}`);
    for (const admission of row.admissions) {
      lines.push(`      ${describeAdmission(admission)}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * What one row costs, or why it costs nothing.
 *
 * ⛔ A null token count renders as "size unknown", never as `0`. The `charged`
 * branch cannot be reached with a null — `chargeOf` classifies those
 * `unknown-size` first — but the check is written as a value test rather than a
 * `?? 0`, so if that ever changed the output would say what it knows instead of
 * asserting a measurement it does not have.
 *
 * **Exported solely so that rule can be pinned by a test that would FAIL if a
 * `?? 0` were introduced.** The property lives in the RENDERER and nowhere else:
 * an assertion over the json rows only re-states what `account` already
 * guarantees, and on any real tree every row carries a blob, so such an
 * assertion compares `false === false` and passes without ever reaching the code
 * that could print a zero. It is not part of this module's command surface and
 * nothing outside its own test may call it.
 *
 * @param row - The accounted row
 * @returns The cost phrase
 */
export function chargeText(row: AccountedRow): string {
  if (row.charge === 'oversize-skipped') {
    return 'skipped: past the 4 MiB CLAUDE.md cliff, so none of it loads';
  }
  if (row.charge === 'pruned-by-oversize') {
    return 'not reached: every import route into it passes through a skipped file';
  }
  if (row.tokens === null) return 'size unknown: no measured blob, so it is counted, not summed';
  return `${row.tokens} tokens`;
}

/**
 * One admission, in prose.
 *
 * @param admission - Why the row is in the answer
 * @returns The prose form
 */
function describeAdmission(admission: Admission): string {
  switch (admission.kind) {
    case 'ancestry':
      return `CLAUDE.md chain, from ${displayPath(admission.dir)}`;
    case 'root-rule':
      return 'root-scope rules file';
    case 'nested-rule':
      return `nested rules file, under ${displayPath(admission.under)}`;
    case 'glob-rule':
      return `rule matched ${admission.pattern}`;
    case 'glob-rule-may-fire':
      return 'path-scoped rule MAY fire here — ask about a FILE for an exact answer';
    // Spelled out rather than left to a `default`, so that adding a seventh
    // admission kind upstream is a lint error here instead of an import
    // description silently applied to something that is not an import.
    case 'import':
      return describeImport(admission);
  }
}

/**
 * One import admission, in prose.
 *
 * An unattributed member says so rather than naming a plausible importer: the
 * query reports `viaPath: null` precisely when it could not attribute a parent,
 * and inventing one here would launder that into a fact.
 *
 * @param admission - The import admission
 * @returns The prose form
 */
function describeImport(admission: Extract<Admission, { kind: 'import' }>): string {
  if (admission.viaPath === null || admission.depth === null) {
    return `@-imported into the closure rooted at ${admission.rootPath}, importer unattributed`;
  }
  return `imported by ${admission.viaPath} at depth ${admission.depth}`
    + ` (closure rooted at ${admission.rootPath})`;
}

/**
 * One condition, in the compact `severity code at location: message` shape.
 *
 * @param condition - The graded condition
 * @returns The line
 */
function conditionLine(condition: GradedCondition): string {
  const reference = condition.sourceRef === null ? '' : ` [${condition.sourceRef}]`;
  return `  ${condition.severity.padEnd(5)} ${condition.code}`
    + ` at ${conditionLocation(condition)}${reference}: ${condition.message}`;
}

/**
 * Where a condition points, using the most specific provenance it carries.
 *
 * @param condition - The graded condition
 * @returns A path, or a `path:line`
 */
function conditionLocation(condition: GradedCondition): string {
  if (condition.sourcePath === null) return condition.path;
  if (condition.sourceLine === null) return condition.sourcePath;
  return `${condition.sourcePath}:${condition.sourceLine}`;
}

/**
 * A heading plus its lines, or nothing at all when there are none.
 *
 * @param title - The section heading
 * @param entries - The already-formatted lines, or bare strings to indent
 * @returns The section's lines, blank-terminated, or none
 */
function listSection(title: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  return [title, ...entries.map((entry) => (entry.startsWith('  ') ? entry : `  ${entry}`)), ''];
}

/**
 * The limits section — the one part of this rendering that is never omitted.
 *
 * Printed even when there is nothing else to say, because the limits are a
 * property of the METHOD rather than of this particular tree: an answer with no
 * conditions and no unknown rows is subject to exactly the same nine signed
 * over/under-report bounds as a messy one.
 *
 * @param document - The answer document
 * @returns The section's lines
 */
function limitSection(document: ContextAnswerDocument): string[] {
  const lines = ['What this answer does not settle', ...wrapStatement(document.boundsStatement, '  '), ''];
  for (const limit of document.limits) {
    lines.push(`  ${limit.direction}: ${limit.id}`);
    lines.push(...wrapStatement(limit.statement, '    '));
  }
  lines.push('', 'Modelled Claude Code behaviours (vendor versions, each cited)');
  for (const behaviour of document.modelledBehaviours) {
    lines.push(`  ${behaviour.behaviour}`);
    lines.push(`    ${behaviour.introducedIn} — ${behaviour.citedFrom}`);
  }
  return lines;
}

/**
 * Soft-wrap a statement to {@link WRAP_COLUMNS}, under a fixed indent.
 *
 * The limit statements are two and three sentences long and are the part of this
 * output people actually have to read; unwrapped they arrive as one 400-column
 * line that a terminal breaks mid-word.
 *
 * @param text - The statement
 * @param indent - Leading whitespace for every produced line
 * @returns One or more indented lines
 */
function wrapStatement(text: string, indent: string): string[] {
  const width = Math.max(WRAP_COLUMNS - indent.length, 20);
  const lines: string[] = [];
  let pending: string[] = [];
  let used = 0;
  for (const word of text.split(' ')) {
    if (pending.length > 0 && used + pending.length + word.length > width) {
      lines.push(indent + pending.join(' '));
      pending = [];
      used = 0;
    }
    pending.push(word);
    used += word.length;
  }
  if (pending.length > 0) lines.push(indent + pending.join(' '));
  return lines;
}

/**
 * A root-relative path as a reader should see it.
 *
 * The corpus root itself is `''`, which renders as nothing at all and reads like
 * a bug. Only the empty case is special-cased — every other path is printed
 * exactly as the projection holds it, so a reader can paste it straight back in.
 *
 * @param path - The root-relative path
 * @returns The display form
 */
function displayPath(path: string): string {
  return path === '' ? '<corpus root>' : path;
}
