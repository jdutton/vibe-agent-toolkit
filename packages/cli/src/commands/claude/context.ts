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
 * ## The limits ride WITH the run — ONCE — in every format
 *
 * Spec §11 puts the stated limits in the command's own output rather than in a
 * doc, because a limit a reader has to go and find is a limit that never reaches
 * the person acting on the number. So {@link CLAUDE_CONTEXT_LIMITS} and
 * {@link CLAUDE_CONTEXT_MODELLED_BEHAVIOURS} are fields of the yaml/json
 * ENVELOPE and a printed section of the text rendering, and
 * {@link CLAUDE_CONTEXT_BOUNDS_STATEMENT} — *neither a floor nor a ceiling* —
 * appears in all three. All three are imported, never restated: the sentence is
 * domain content owned beside the list it frames, so every other consumer of the
 * list reaches it too.
 *
 * ⛔ They belong to the ENVELOPE, never to an answer or a region, and every
 * rendering obeys that identically — see {@link ContextEnvelope} for why.
 * Attaching them per answer was not a formatting preference: on the whole-tree
 * sweep `--all` used to be (6,224 answers on this repository) `--format json`
 * measured 76,877,016 bytes and measures 6,581,468 with the block hoisted — 70.3
 * MB of ONE byte-identical paragraph, repeated. That is the JSON spelling of the
 * very burial {@link renderEnvelopeText} refuses to do in text, and it is why
 * {@link ContextCostMapEnvelope} hoists the same block rather than growing one
 * per region.
 *
 * ## `--all` is a MAP, not a sweep
 *
 * ⛔ `--all` emits no per-path documents in any format. It used to answer for
 * every realized path — 10,438 documents and 205,918 lines on a large adopter
 * monorepo, ~491 s — which is not a report anyone reads. It now emits the
 * whole-tree cost map {@link buildContextCostMap} builds, which answers the
 * question the flag exists for: where in this tree is it expensive to work.
 * Naming paths is the drill-down, and is the only way to get a per-path answer.
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
  buildContextCostMap,
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  CLAUDE_CONTEXT_LIMITS,
  CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  CLAUDE_MD_TAG,
  discoverableFrom,
  whatLoadsAt,
  type AccountedRow,
  type Admission,
  type ContextCostMap,
  type ContextTotals,
  type DirectoryCost,
  type DiscoverableContext,
  type DiscoverableRow,
  type GradedCondition,
  type LoadedContextAnswer,
  type ModelledBehaviour,
  type Projection,
  type RegionCost,
  type StatedLimit,
} from '@vibe-agent-toolkit/resources';
import { findProjectRoot } from '@vibe-agent-toolkit/utils';
import { Command, Option } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { targetPathWithin } from '../../utils/corpus-target.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeStdoutSync, writeYamlOutput } from '../../utils/output.js';
import { populationWiring } from '../../utils/population-wiring.js';
import { withPopulationCache } from '../../utils/projection-store.js';
import { gitTrackerForProjectRoot } from '../audit/distributed-tree.js';

/** Soft wrap width for the printed limit statements. */
const WRAP_COLUMNS = 96;

/** How this command names itself in a refusal. */
const COMMAND_NAME = 'vat claude context';

/**
 * How many rows each RANKED section of the `--all` cost map prints.
 *
 * ⛔ A cap exists because the previous shape of `--all` had none: it answered for
 * every realized path, which on a large adopter monorepo was 10,438 documents and
 * 205,918 lines — an output nobody, human or agent, can act on. The map collapses
 * that to two ranked lists, and a ranked list is only useful if its head is
 * readable in one screen. 20 is that head: enough that a real hot spot is
 * somewhere in it, few enough that the whole report stays scannable.
 *
 * ⛔ It bounds the TEXT rendering ONLY. `--format json` carries the map whole —
 * see {@link ContextCostMapEnvelope} — because a program asked for the map, not
 * for a summary of it, and a silently-truncated array is a defect a consumer
 * cannot see.
 *
 * ⛔ Whenever it fires, {@link omittedNotice} says how many rows were left out. A
 * silent cap reads as "this is everything", which is the one thing this report
 * must never say. Exported so a test pins the notice's arithmetic against the
 * same number the renderer slices at, rather than against a literal that is free
 * to disagree with it.
 */
export const COST_MAP_ROW_LIMIT = 20;

/**
 * What the two halves of the cost map mean, and which one is exact.
 *
 * Printed under the heading because the numbers are unreadable without it: a
 * reader who takes the per-region figure for an average, or borrows a
 * region-mate's on-demand figure, has read the report backwards. This paraphrases
 * the contracts `RegionCost.alwaysTokens` and `DirectoryCost.onDemandTokens`
 * state in `@vibe-agent-toolkit/resources` — it asserts nothing this module
 * decided, and computes nothing.
 */
const COST_MAP_METHOD_STATEMENT =
  'Directories are ranked by what it costs to work in them: the at-launch floor PLUS what fires'
  + ' on demand there, because a cheap rule under a heavy instruction chain is still an expensive'
  + ' place to work.'
  + ' Every working location in a region loads the same files at launch, so the at-launch figure is'
  + ' EXACT for the whole region rather than an average over it. On-demand cost is reported per'
  + ' DIRECTORY instead, because a path-scoped rule is admitted where some file under that'
  + " directory matches its globs and nowhere else — a region-mate's on-demand figure is never a"
  + " substitute for a directory's own. Only a FILE query is exact for path-scoped rules: name a"
  + ' path (vat claude context src/index.ts) to get one.';

/** How the answer is rendered. `text` is for a person; the other two are for a program. */
export type ContextOutputFormat = 'text' | 'yaml' | 'json';

/** Flags `vat claude context` accepts. */
export interface ClaudeContextOptions {
  format?: ContextOutputFormat;
  debug?: boolean;
  all?: boolean;
  discoverable?: boolean;
}

/**
 * The envelope every run emits, however many paths were asked about.
 *
 * ⛔ `answers` is an array **even for one path**, so a consumer never branches on
 * arity. The single-path shape is the N=1 case of the sweep, not a different
 * document — a caller that special-cased "one path means a bare object" is the
 * defect this shape exists to prevent, and pre-1.0 is when to pay for it.
 *
 * `root` rides here rather than on each answer because it is a property of the
 * POPULATION, and one run populates exactly one tree. Repeating it per answer
 * would invite a reader to believe two answers could carry different roots.
 *
 * ⛔ The three limit fields ride here for the SAME reason, and it is the reason
 * {@link renderEnvelopeText} already prints them once: they bound the
 * MEASUREMENT METHOD, not any one path. An answer carrying its own copy reads
 * as though that path had caveats of its own — and repeated across a sweep it
 * is pure duplication, byte-identical every time.
 */
export interface ContextEnvelope {
  /**
   * Which of this command's two documents this is.
   *
   * ⛔ A SHAPE discriminator, not a version. `--all` emits
   * {@link ContextCostMapEnvelope} and everything else emits this one; the two
   * share only `root` and the limit block, so a consumer that guessed would read
   * `answers` off a map and silently get `undefined`. It says nothing about a
   * schema generation — under pre-1.0 the package version is the only contract,
   * and this project prohibits emitting a second versioning scheme.
   */
  readonly kind: 'context-answers';
  readonly root: string;
  readonly answers: readonly (ContextAnswerDocument | ContextUnknownDocument)[];
  /** What these answers do not settle, in either direction. Stated once. */
  readonly boundsStatement: string;
  /** The signed over/under-report bounds on the method. Stated once. */
  readonly limits: readonly StatedLimit[];
  /** The vendor behaviours modelled, each cited. Stated once. */
  readonly modelledBehaviours: readonly ModelledBehaviour[];
}

/**
 * The envelope `--all` emits: the whole-tree cost map, not a pile of answers.
 *
 * ⛔ **A DIFFERENT document from {@link ContextEnvelope}, deliberately, and
 * `kind` is what tells them apart.** `--all` used to answer for every realized
 * path — 10,438 documents on a large adopter monorepo — which answered the
 * question "what loads at each of ten thousand paths" nobody asked, in place of
 * "where is it expensive to work here", which is what the flag is for. Naming
 * paths explicitly is still the per-path answer, and is now the only way to get
 * one.
 *
 * ⛔ The three limit fields ride HERE, exactly as they ride on
 * {@link ContextEnvelope}, and for the same measured reason: attached per row
 * they were 70.3 MB of one byte-identical paragraph on a single sweep. They bound
 * the MEASUREMENT METHOD, so a region carrying its own copy would also read as
 * though that region had caveats of its own.
 *
 * 🔑 `costMap` is nested rather than spread across the envelope so that "the
 * limits are on the envelope and on nothing inside it" is a structural property a
 * reader can check by eye, rather than an invariant maintained by hand at each
 * new field.
 */
export interface ContextCostMapEnvelope {
  /** Which of this command's two documents this is — see {@link ContextEnvelope.kind}. */
  readonly kind: 'context-cost-map';
  readonly root: string;
  /**
   * The map WHOLE — every region and every directory, never the text
   * rendering's top {@link COST_MAP_ROW_LIMIT}. A program asked for the map, and
   * a silently-shortened array is a truncation its consumer cannot detect.
   */
  readonly costMap: ContextCostMap;
  /** What this map does not settle, in either direction. Stated once. */
  readonly boundsStatement: string;
  /** The signed over/under-report bounds on the method. Stated once. */
  readonly limits: readonly StatedLimit[];
  /** The vendor behaviours modelled, each cited. Stated once. */
  readonly modelledBehaviours: readonly ModelledBehaviour[];
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
  /**
   * What the loaded set POINTS AT in one hop and the harness does not load, or
   * null when `--discoverable` was not asked for.
   *
   * ⛔ `null` rather than an empty object, and the difference is the whole
   * reason the field is nullable: an empty `rows` array means "nothing here
   * links anywhere", and a run that never looked must not be readable as that.
   * The same distinction {@link ContextUnknownDocument} exists to draw, one
   * level down.
   *
   * ⛔ Its tokens are NEVER added to `totals`. A markdown link is voluntary —
   * nothing loads it — so folding it into a context-budget figure would charge
   * a session for documents it may never open.
   */
  readonly discoverable: DiscoverableContext | null;
}

/**
 * The yaml/json document for a path the projection never realized.
 *
 * ⛔ Structurally different from an answer, and that is the point: it carries no
 * `totals` and no `rows`, so a consumer cannot accidentally read "VAT never
 * looked at this path" as "nothing loads here". `explanation` says the same thing
 * to a person who is reading the document rather than switching on `kind`.
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
    .argument(
      '[paths...]',
      'Files or directories to answer for (default: the current directory)',
    )
    .addOption(
      new Option('--format <format>', 'Output format: text (default), yaml, or json').choices([
        'text',
        'yaml',
        'json',
      ]).default('text'),
    )
    .option(
      '--all',
      'Report the whole-tree cost map — launch cost per region, total cost per directory —'
      + ' instead of answering for named paths',
    )
    .option(
      '--discoverable',
      'Also report what the loaded files LINK TO in one hop and the harness does not load',
    )
    .option('--debug', 'Verbose logging to stderr')
    .action(claudeContextCommand)
    .addHelpText('after', `
Description:
  Report which CLAUDE.md files, .claude/rules files and @-imported files load
  into an agent's context at a path, why each one is there, and what it costs.
  A FILE argument is exact. A directory argument classifies each path-scoped
  rule as ∀ (its glob covers every file there, so it is a second CLAUDE.md for
  that directory) or ∃ (some file there matches, and the answer names it); a
  rule no file there can match is left out rather than charged.

  Several paths may be named at once. The tree is enumerated ONCE and every
  path answered from that one population, so asking about ten paths together
  costs what asking about one costs — not ten times it. No paths means the
  current directory.

  --all answers a different question: where in this tree is it expensive to
  work. It reports launch cost once per REGION (every directory inheriting one
  CLAUDE.md chain — exact for all of them, not an average) and, per DIRECTORY,
  the TOTAL of that launch floor and what fires on demand there (a path-scoped
  rule fires for some directories and not others, so the on-demand half is
  never borrowed from a region-mate). Directories are ranked by that total. It
  emits no per-path documents; name paths for those. --discoverable applies to
  named paths only.

Output:
  - kind:    context-answers for named paths, context-cost-map for --all —
             the two are different documents, so never guess which you hold
  - root:    the corpus root that was enumerated
  - answers: (context-answers) one document per requested path, in the order
             requested — always a list, even for one path, so consumers never
             branch on count; with totals, rows, and every admitting predicate
  - costMap: (context-cost-map) regions worst-first by launch cost, directories
             worst-first by total cost (launch + on demand), the tree-level
             roll-up of rows nothing could be measured for, plus the counts of
             locations evaluated, queried, and left out for want of an answer
  - limits:  what this run deliberately does not settle, in both directions.
             On the ENVELOPE beside root, never on an answer or a region — they
             bound the method rather than any one path, so they are stated
             exactly once however much was measured

  Counts of rows whose size is unknown, skipped by the 4 MiB cliff, or pruned
  behind one are reported beside every estimate and NEVER summed into it. The
  text rendering prints the top ${COST_MAP_ROW_LIMIT} of each ranked list and says how many it
  left out; --format json carries the map whole.

  A path the projection never realized answers kind: unknown — never zero.
  Diagnostics and blob-stage refusals go to stderr; stdout is the document.

Exit Codes:
  0 - An answer was produced (there is no threshold and no gate)
  1 - Invalid usage (unknown option, or an unsupported --format value)
  2 - System error (a path outside the corpus root, unreadable tree)

Example:
  $ vat claude context src/index.ts docs/ README.md   # one scan, three answers
`);
  return command;
}

/**
 * Action handler for `vat claude context [path]`.
 *
 * ⛔ The two branches produce DIFFERENT documents and there is no third mode: a
 * `--per-path` escape hatch back to the old sweep is exactly the backward
 * compatibility shim this project forbids pre-1.0, and naming paths explicitly
 * already gives the per-path answer — now from a population the caller pays for
 * once instead of ten thousand times.
 *
 * @param pathArgs - The paths to answer for; empty means the current directory
 * @param options - The command's flags
 */
export async function claudeContextCommand(
  pathArgs: readonly string[],
  options: ClaudeContextOptions,
): Promise<void> {
  const logger = createLogger(options.debug === true ? { debug: true } : {});
  const startTime = Date.now();
  const sweep = options.all === true;
  try {
    const root = findProjectRoot(process.cwd()) ?? process.cwd();
    // 🔑 Every argument is resolved BEFORE the population, not inside the map.
    // A path outside the corpus is a usage error, and finding it afterwards
    // would charge the caller a full population — minutes on a cold cache — to
    // be told they mistyped. `--all` has no arguments to check.
    const requested = sweep ? [] : targetsWithin(root, pathArgs);
    const projection = await populateContext(root, logger);
    const format = options.format ?? 'text';
    if (sweep) {
      // Every number in the map is decided in `@vibe-agent-toolkit/resources`.
      // This branch calls one function and formats what it returns.
      const map = buildContextCostMap(projection);
      emit(costMapEnvelope(root, map), renderCostMapText(map), format);
    } else {
      // ONE population, N queries. `whatLoadsAt` is a pure read of materialised
      // tables, so the marginal cost of another path is a map lookup — which is
      // the whole reason this command takes a list rather than being run twice.
      const answers = requested.map(
        (target) => documentFor(target, projection, root, options.discoverable === true),
      );
      emit(contextEnvelope(root, answers), renderEnvelopeText(answers), format);
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
 * The answer document for one query.
 *
 * Split from the handler so the handler stays a straight line: the accounting
 * call needs the `claude-md` identity set, and threading that through the
 * handler body put three statements between the query and its document.
 *
 * Returns the document alone — rendering moved to {@link renderEnvelopeText},
 * which needs every document at once to print the limits exactly once, and the
 * limits themselves are attached by {@link contextEnvelope}, never here.
 *
 * ⛔ Exported so it can be TESTED. What has to be pinned is an ABSENCE — that no
 * limit field is on the returned document — and an absence is only observable by
 * calling the function that would have added it.
 *
 * @param answer - The query's answer
 * @param projection - The populated projection, for the `claude-md` tag rows
 * @param discoverable - Whether to compute the one-hop reachable set
 * @returns The answer document
 */
export function answerDocument(
  answer: LoadedContextAnswer,
  projection: Projection,
  discoverable: boolean,
): ContextAnswerDocument {
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
    // The ANSWER is passed, not recomputed: it is the authority for what is
    // already loaded, and the two lenses partitioning depends on both reading
    // one loaded set.
    discoverable: discoverable ? discoverableFrom(projection, answer) : null,
  };
  return document;
}

/**
 * Wrap the run's documents in the envelope, with the limits attached ONCE.
 *
 * The one place {@link CLAUDE_CONTEXT_LIMITS} and its two companions enter the
 * machine-readable output. Keeping that a single assignment is what makes the
 * "stated once" property structural rather than a habit: there is no per-answer
 * site left where a copy could be reintroduced.
 *
 * ⛔ Exported so it can be TESTED alongside {@link answerDocument} — the
 * regression this guards (an answer growing its own copy of the block) is a
 * property of the two functions TOGETHER, and a test that can reach only one of
 * them cannot see it.
 *
 * @param root - The corpus root that was enumerated
 * @param answers - One document per requested path, in the order requested
 * @returns The envelope, ready to serialize
 */
export function contextEnvelope(
  root: string,
  answers: readonly (ContextAnswerDocument | ContextUnknownDocument)[],
): ContextEnvelope {
  return {
    kind: 'context-answers',
    root,
    answers,
    boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
    limits: CLAUDE_CONTEXT_LIMITS,
    modelledBehaviours: CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  };
}

/**
 * Wrap the `--all` cost map in its envelope, with the limits attached ONCE.
 *
 * The mirror of {@link contextEnvelope}, and deliberately its own function rather
 * than a generic over both: the two envelopes differ in more than one field, and
 * a shared builder taking a payload would make `kind` a parameter — which is how
 * a discriminator stops discriminating.
 *
 * ⛔ Exported so a test can pin, over a many-region map, that the limit block
 * appears exactly ONCE in the serialized document. Presence passes on a copy per
 * region, which is the 70.3 MB defect this command already shipped once.
 *
 * @param root - The corpus root that was enumerated
 * @param costMap - The whole-tree cost map, carried entire
 * @returns The envelope, ready to serialize
 */
export function costMapEnvelope(root: string, costMap: ContextCostMap): ContextCostMapEnvelope {
  return {
    kind: 'context-cost-map',
    root,
    costMap,
    boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
    limits: CLAUDE_CONTEXT_LIMITS,
    modelledBehaviours: CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  };
}

/**
 * Resolve every requested path, defaulting to the current directory.
 *
 * No arguments means the current directory — NOT the whole corpus. `--all` is
 * the sweep, spelled explicitly, because a bare `vat claude context` answering
 * for thousands of paths would turn the friendliest invocation into the most
 * expensive one.
 *
 * @param root - The discovered project root
 * @param pathArgs - The path arguments, possibly empty
 * @returns One root-relative target per argument, in argument order
 */
function targetsWithin(root: string, pathArgs: readonly string[]): string[] {
  if (pathArgs.length === 0) return [targetPathWithin(root, undefined, COMMAND_NAME)];
  return pathArgs.map((pathArg) => targetPathWithin(root, pathArg, COMMAND_NAME));
}

/**
 * The document for one target, answer or non-answer.
 *
 * @param target - The root-relative path to answer for
 * @param projection - The populated projection
 * @param root - The corpus root, for the non-answer's explanation
 * @param discoverable - Whether to compute the one-hop reachable set
 * @returns The answer document, or the structurally-different unknown document
 */
function documentFor(
  target: string,
  projection: Projection,
  root: string,
  discoverable: boolean,
): ContextAnswerDocument | ContextUnknownDocument {
  const answer = whatLoadsAt(projection, target);
  if (answer.kind === 'unknown') return unknownDocumentFor(answer.input, root);
  return answerDocument(answer, projection, discoverable);
}

/**
 * Render every answer for a person, with the limits stated exactly once.
 *
 * ⛔ The limits are printed ONCE, after the last answer, rather than per answer.
 * They are properties of the MEASUREMENT METHOD, not of any one path, so
 * repeating them per path would read as though each answer carried its own
 * caveats — and across a many-path run would bury the answers under identical
 * paragraphs. A run with no answered path prints no limits at all, for the same
 * reason {@link unknownDocumentFor} omits them: nothing was measured, so there is
 * no measurement to bound.
 *
 * @param documents - The answers, in requested order
 * @returns The text rendering, newline-terminated
 */
function renderEnvelopeText(
  documents: readonly (ContextAnswerDocument | ContextUnknownDocument)[],
): string {
  const bodies = documents.map((document) =>
    document.kind === 'unknown' ? renderUnknownText(document) : renderAnswerText(document));
  const measured = documents.some((document) => document.kind === 'answer');
  if (!measured) return bodies.join('\n');
  return `${bodies.join('\n')}${limitSection().join('\n')}\n`;
}

/**
 * Render the `--all` cost map for a person: where in this tree it is expensive
 * to work.
 *
 * Four sections, in the order a reader needs them — the region table (what each
 * part of the tree costs at launch), the regions' own files (what they are paying
 * for), the directories that cost the most to work in overall, and what the map
 * looked at — then the limits, ONCE.
 *
 * ⛔ Every ranked section is capped at {@link COST_MAP_ROW_LIMIT} and every cap
 * that fires announces itself. ⛔ Nothing here sums an unknown into a total or
 * calls any figure complete: the counted-not-summed rows are printed beside each
 * estimate, and the stated limits apply whether or not those counters are zero.
 *
 * ⛔ Exported so the properties above can be TESTED with inputs a real tree never
 * produces — a null token count, more directories than the cap. On this repository
 * every file has a measured blob, so an assertion driven by a real run compares
 * `false === false` and would keep passing against a `?? 0`.
 *
 * @param map - The whole-tree cost map from `buildContextCostMap`
 * @returns The text rendering, newline-terminated
 */
export function renderCostMapText(map: ContextCostMap): string {
  const lines = [
    'Context cost by region — what it costs to work in each part of this tree',
    '',
    ...wrapStatement(COST_MAP_METHOD_STATEMENT, '  '),
    '',
    ...regionTable(map.regions),
    ...map.regions.slice(0, COST_MAP_ROW_LIMIT).flatMap(regionDetail),
    ...directoryTable(map.directories),
    ...coverageLines(map),
  ];
  return `${lines.join('\n')}\n${limitSection().join('\n')}\n`;
}

/**
 * The ranked region table: what a session pays at launch in each part of the tree.
 *
 * @param regions - The regions, already worst-first by launch cost
 * @returns The section's lines, blank-terminated
 */
function regionTable(regions: readonly RegionCost[]): string[] {
  const shown = regions.slice(0, COST_MAP_ROW_LIMIT);
  const lines = ['  at launch   locations   region'];
  for (const region of shown) {
    lines.push(
      `  ${padCount(region.alwaysTokens, 9)}   ${padCount(region.locationCount, 9)}`
      + `   ${displayPath(region.representative)}`,
    );
  }
  lines.push(...omittedNotice(shown.length, regions.length, 'region', 'regions'), '');
  return lines;
}

/**
 * One region's launch-time bill, itemised.
 *
 * 🔑 The rows are rendered by {@link rowSection}, the same function the per-path
 * answer uses, so a file reads identically in both reports and there is exactly
 * one admission-describer. Its `loadClass` filter is a no-op here — `alwaysRows`
 * is already that class — and passing it anyway keeps the call honest rather than
 * relying on the caller's guarantee.
 *
 * @param region - The region to itemise
 * @returns The section's lines, blank-terminated
 */
function regionDetail(region: RegionCost): string[] {
  return [
    `Region ${displayPath(region.representative)} — ${groupDigits(region.alwaysTokens)} tokens`
    + ` at launch, ${countOf(region.locationCount, 'location', 'locations')}`,
    ...quietCounterLines(region),
    ...nestBlock(rowSection('Loaded at launch', region.alwaysRows, 'always')),
    '',
  ];
}

/**
 * A region's three counters, printed only when one of them has something to say.
 *
 * ⛔ **This suppression is safe ONLY because the tree-level roll-up in
 * {@link coverageLines} prints UNCONDITIONALLY, zeros included.** The honesty
 * rule in this lane is that a reader must never be able to mistake "nothing here
 * was unmeasurable" for "nobody counted", and after this suppression the roll-up
 * is the single thing in the report carrying that. Silence a region's zeros only
 * while a tree-level zero is still printed somewhere; drop the roll-up and this
 * function has to go back to unconditional.
 *
 * ⛔ Deliberately NOT applied to {@link estimateLines}. A single-path answer has
 * no roll-up to fall back on, so its counters are the only statement that the
 * rows were counted at all and must keep printing whatever their values.
 *
 * The measured motivation: nine regions on this repository printed 27 lines of
 * pure zeros, burying the launch bills the section exists to show.
 *
 * @param region - The region whose counters to print
 * @returns The three lines, or none when all three are zero
 */
function quietCounterLines(region: RegionCost): string[] {
  const anything = region.unknownTokenRows + region.skippedOversizeRows + region.prunedRows;
  if (anything === 0) return [];
  // Whole block or nothing: a reader comparing two regions must be comparing the
  // same three lines, not one region's selected non-zeros.
  return counterLines(region);
}

/**
 * Indent a borrowed section one level, and drop the blank line it terminates with.
 *
 * {@link rowSection} is written for the per-path answer, where it sits at the top
 * level and separates itself from what follows. Nested under a region heading it
 * needs a level of indent, and its terminator would double the region's own — so
 * this drops every blank rather than the last one specifically, which is exact
 * because that section emits no interior blanks.
 *
 * @param lines - The borrowed section's lines
 * @returns The same lines, indented, with blanks removed
 */
function nestBlock(lines: readonly string[]): string[] {
  return lines.filter((line) => line !== '').map((line) => `  ${line}`);
}

/**
 * The ranked directory table: where in this tree it is most expensive to work.
 *
 * ⛔ Ordered and headed by TOTAL cost — the launch floor plus the on-demand
 * burden — which is the key `buildContextCostMap` sorts by. Ranking on a key the
 * producer did not sort on would make the column descend non-monotonically and
 * read as a bug; ranking on the on-demand half alone would answer "where does a
 * rule fire", which is not the question the map is for.
 *
 * ⛔ Every one of the three figures is READ. The CLI does not add
 * `alwaysTokens` to `onDemandTokens` here — that sum is `DirectoryCost.
 * totalTokens`, computed where both halves are known to be charged-only totals.
 * A second sum in this module would be a second, unowned model of what "cost"
 * means, free to disagree with the ranking beside it. Both halves stay in the
 * table because they are acted on differently: the floor by moving instructions,
 * the burden by scoping rules.
 *
 * @param directories - The directories, already worst-first by total cost
 * @returns The section's lines, blank-terminated, or none when there are none
 */
function directoryTable(directories: readonly DirectoryCost[]): string[] {
  if (directories.length === 0) return [];
  const shown = directories.slice(0, COST_MAP_ROW_LIMIT);
  const lines = [
    'Most expensive directories to work in — at launch PLUS what fires on demand there',
    '      total   at launch   on demand   directory',
  ];
  for (const directory of shown) {
    lines.push(
      `  ${padCount(directory.totalTokens, 9)}   ${padCount(directory.alwaysTokens, 9)}`
      + `   ${padCount(directory.onDemandTokens, 9)}   ${displayPath(directory.directory)}`
      // ⛔ The unknown-row suffix appears only when there is one, for the same
      // reason and under the same condition as {@link quietCounterLines}: the
      // tree-level roll-up in {@link coverageLines} states unconditionally that
      // these rows were counted, so twenty repetitions of "0 rows of unknown
      // size" buy nothing and crowd out the paths the table is ranking. Remove
      // the roll-up and this suffix has to become unconditional again.
      + unknownRowSuffix(directory.unknownTokenRows),
    );
  }
  lines.push(...omittedNotice(shown.length, directories.length, 'directory', 'directories'), '');
  return lines;
}

/**
 * The note that a directory's on-demand cost is an under-report, when it is.
 *
 * @param unknownTokenRows - On-demand rows at that directory whose size is unknown
 * @returns The suffix, or nothing at all when every row was measured
 */
function unknownRowSuffix(unknownTokenRows: number): string {
  if (unknownTokenRows === 0) return '';
  return ` · ${countOf(unknownTokenRows, 'row', 'rows')} of unknown size, counted not summed`;
}

/**
 * What the map looked at, including the locations it could not answer for.
 *
 * ⛔ `skippedUnknownLocations` is PRINTED, not folded away. A location left out
 * because a query it needed answered `unknown` is a hole in the map, and a report
 * that quietly dropped it would be indistinguishable from one where every
 * location answered.
 *
 * ⛔ The tree-level roll-up prints UNCONDITIONALLY, all-zero included, and that
 * is load-bearing: {@link quietCounterLines} suppresses the per-region zeros, so
 * this is the only place left saying the rows were counted at all. A zero here is
 * a measurement; an absent line would be indistinguishable from nobody looking.
 *
 * @param map - The cost map
 * @returns The section's lines, blank-terminated
 */
function coverageLines(map: ContextCostMap): string[] {
  return [
    'What this map looked at',
    `  working locations evaluated   ${groupDigits(map.evaluatedDirectories)}`,
    `  queries issued                ${groupDigits(map.queriedDirectories)}`,
    `  no answer of their own        ${countOf(map.skippedUnknownLocations, 'location', 'locations')}`
    + ' (left out of the table above, never counted as zero)',
    '  rows this map could not measure, over every region and directory above:',
    ...counterLines(map.unmeasuredRows),
    '',
  ];
}

/**
 * Say how many ranked rows were left unprinted, or say nothing when none were.
 *
 * ⛔ The COUNT is the point. "Some rows were omitted" leaves a reader unable to
 * tell a table that dropped three rows from one that dropped three thousand, and
 * a cap with no notice at all reads as "this is everything" — which is the claim
 * this whole report is built not to make.
 *
 * @param shown - How many rows were printed
 * @param total - How many there were
 * @param singular - What one omitted row is, for the `total - shown === 1` case
 * @param plural - What several of them are
 * @returns The notice line, or none when nothing was truncated
 */
function omittedNotice(shown: number, total: number, singular: string, plural: string): string[] {
  if (total <= shown) return [];
  const omitted = total - shown;
  const noun = omitted === 1 ? singular : plural;
  return [
    `  ... and ${groupDigits(omitted)} more ${noun} not shown —`
    + ` this is the ${groupDigits(shown)} most expensive, not the whole tree`,
  ];
}

/**
 * The three row counters that keep an estimate from reading as settled.
 *
 * Shared by the per-path answer and by every region of the cost map, because it
 * is one rule stated in one place: a row whose size is unknown, whose file the
 * 4 MiB cliff skipped, or which sits behind such a file is COUNTED here and
 * summed into nothing. Two copies of these three lines would be two places for a
 * `?? 0` to appear in.
 *
 * @param counters - Anything carrying the three counts — `ContextTotals`, or a
 *   region's own always-row counts
 * @returns The three lines, unterminated
 */
function counterLines(counters: {
  readonly unknownTokenRows: number;
  readonly skippedOversizeRows: number;
  readonly prunedRows: number;
}): string[] {
  return [
    `  size unknown          ${countOf(counters.unknownTokenRows, 'row', 'rows')}`
    + ' (counted, never summed as zero)',
    `  skipped over 4 MiB    ${countOf(counters.skippedOversizeRows, 'row', 'rows')}`,
    `  pruned behind a skip  ${countOf(counters.prunedRows, 'row', 'rows')}`,
  ];
}

/**
 * A count with its noun, digit-grouped and agreeing in number.
 *
 * The alternative — a bare `${n} ${plural}` — prints "1 locations" whenever a
 * region has exactly one, which is the common case on a tree with many small
 * packages and reads as a rendering bug the moment anyone sees it. Both forms are
 * PARAMETERS rather than a suffixed `s`, because the nouns this report uses are
 * not all regular ("directory" is the counter-example living two functions away).
 *
 * @param value - The count
 * @param singular - The noun for exactly one
 * @param plural - The noun for any other count, zero included
 * @returns The count and its noun
 */
function countOf(value: number, singular: string, plural: string): string {
  return `${groupDigits(value)} ${value === 1 ? singular : plural}`;
}

/**
 * A count, digit-grouped and right-aligned to a column width.
 *
 * @param value - The count
 * @param width - The column width; a longer number overflows rather than truncates
 * @returns The padded text
 */
function padCount(value: number, width: number): string {
  return groupDigits(value).padStart(width);
}

/**
 * A non-negative integer with thousands separators.
 *
 * ⚠️ Written out by hand rather than through `toLocaleString` or `Intl`: those
 * are ICU- and locale-dependent, so the same tree would render `38,412` on one
 * machine and `38 412` on another, and this report is exactly the kind of output
 * people diff between machines. Every number reaching it is a token estimate or a
 * row count, so the negative case cannot arise and is not invented for.
 *
 * @param value - The count
 * @returns The grouped digits
 */
function groupDigits(value: number): string {
  const digits = String(value);
  let grouped = '';
  for (const [index, digit] of [...digits].entries()) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digit;
  }
  return grouped;
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
    return buildClaudeContextPopulation({ root, ...populationWiring(logger, gitTracker, cache, root) });
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
 * ⛔ **A non-answer publishes no measurement, in every format.** No `totals`, no
 * `rows`: nothing was measured here, so anything readable as a figure would
 * assert that a measurement happened, which is the exact confusion `kind:
 * 'unknown'` exists to prevent. The limits are one level up on the ENVELOPE and
 * bound the run's method, not this path — a sweep whose every path was
 * unrealized still measured nothing, and the `explanation` carries the only
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
    ...discoverySection(document.discoverable),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * What the loaded files point at and the harness does not load.
 *
 * ⛔ Printed under its own heading with its own total, never merged into the
 * token estimate. Nothing loads a markdown link, so this is an upper bound on a
 * VOLUNTARY cost — what following every link once would add — and adding it to a
 * context-budget figure would charge a session for documents it may never open.
 * The heading says "not loaded" for a reader who sees only this section.
 *
 * A `null` argument means the lens was not asked for and prints NOTHING. An
 * empty `rows` prints the heading with a zero, because "this file links nowhere"
 * is a real and useful answer that must not be confused with "nobody looked".
 *
 * @param discoverable - The lens's answer, or null when `--discoverable` was off
 * @returns The section's lines, or none when the lens did not run
 */
function discoverySection(discoverable: DiscoverableContext | null): string[] {
  if (discoverable === null) return [];
  const { rows, totals } = discoverable;
  const lines = [
    'Discoverable in one hop — LINKED from the loaded files, NOT loaded',
    `  ${groupDigits(totals.discoverableTokens)} tokens if every link were followed once`
    + ' (a ceiling, never a charge)',
    `  ${groupDigits(totals.unknownTokenRows)} size unknown`
    + ` · ${groupDigits(totals.unrealizedRows)} not in this tree`
    + ` · ${groupDigits(totals.outsideRootRows)} outside the root`,
  ];
  for (const row of rows) {
    lines.push(`  ${displayPath(row.path)} — ${discoverableCost(row)}`);
    for (const citation of row.citedBy) {
      const text = citation.text === null ? '' : ` as "${citation.text}"`;
      lines.push(`      linked from ${displayPath(citation.fromPath)}:${citation.line}${text}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * What one discoverable row would cost, or why VAT cannot say.
 *
 * ⛔ Never `0` for an unmeasured row, the same rule {@link chargeText} enforces
 * one section up. `unrealized` says what it is — an absence in THIS projection —
 * rather than "broken": adjudicating a link is `vat resources validate`'s lane.
 *
 * @param row - The discoverable row
 * @returns The cost phrase
 */
function discoverableCost(row: DiscoverableRow): string {
  if (row.reach === 'outside-root') return 'outside the corpus root, so its size is unknowable here';
  if (row.reach === 'unrealized') return 'not realized in this projection, so nothing is known of it';
  if (row.tokens === null) return 'size unknown: no measured blob, so it is counted, not summed';
  return `${groupDigits(row.tokens)} tokens if opened`;
}

/**
 * The heading, which states up front whether the query was exact.
 *
 * @param document - The answer document
 * @returns The heading lines, blank-terminated
 */
function headingLines(document: ContextAnswerDocument): string[] {
  const exactness = document.file === null
    ? 'DIRECTORY query — a path-scoped rule is reported as ∀ (covers every file here)'
      + ' or ∃ (some file here matches); only a FILE query is exact'
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
    `  always-loaded         ${groupDigits(totals.alwaysTokens)} tokens`,
    `  on-demand             ${groupDigits(totals.onDemandTokens)} tokens`,
    // ⛔ UNCONDITIONAL here, unlike a region's — see {@link quietCounterLines}.
    // A single-path answer has no tree-level roll-up to fall back on, so these
    // three lines are its only statement that the rows were counted at all.
    ...counterLines(totals),
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
  // ⚠️ Grouped through the SAME helper the tables use. Two spellings of one
  // quantity — `14,396` in a column and `8385` on the row ten lines below it —
  // read as a bug in the measurement rather than as a formatting choice. This
  // changes only how the number is written, never whether one is written: the
  // null branch above is what keeps an unknown size out of the digits entirely.
  return `${groupDigits(row.tokens)} tokens`;
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
    case 'glob-rule-covers-dir':
      return `∀ rule covers EVERY file here via ${admission.pattern}`
        + ' — a second CLAUDE.md for this directory in all but name';
    case 'glob-rule-may-fire':
      return `∃ rule may fire here — ${admission.pattern} matches ${displayPath(admission.examplePath)}`
        + ', among possibly others; ask about a FILE for an exact answer';
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
 * conditions and no unknown rows is subject to exactly the same signed
 * over/under-report bounds as a messy one.
 *
 * ⛔ Reads the imported constants, NOT an answer document — the same source
 * {@link contextEnvelope} reads. It took no argument's worth of per-answer data
 * even when the fields were on the answer, and threading one through was what
 * made "the limits belong to an answer" look true.
 *
 * @returns The section's lines
 */
function limitSection(): string[] {
  const lines = [
    'What this answer does not settle',
    ...wrapStatement(CLAUDE_CONTEXT_BOUNDS_STATEMENT, '  '),
    '',
  ];
  for (const limit of CLAUDE_CONTEXT_LIMITS) {
    lines.push(`  ${limit.direction}: ${limit.id}`);
    lines.push(...wrapStatement(limit.statement, '    '));
  }
  lines.push('', 'Modelled Claude Code behaviours (vendor versions, each cited)');
  for (const behaviour of CLAUDE_CONTEXT_MODELLED_BEHAVIOURS) {
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
