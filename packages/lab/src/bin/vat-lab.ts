#!/usr/bin/env node
/**
 * `vat-lab` — the quality lab's command line.
 *
 * Drives vat through its command-line boundary only, which is what lets one run
 * measure two different vat versions and what lets it measure a project with no
 * vat config at all.
 */

import { pathToFileURL } from 'node:url';

import { parseWholeNumberAtLeast, safePath } from '@vibe-agent-toolkit/utils';
import { Command, InvalidArgumentError } from 'commander';

import type { ReportEnvelope } from '../envelope/envelope.js';
import { captureIo } from '../facets/io/capture.js';
import { compareIo } from '../facets/io/compare.js';
import { renderIoComparison, renderIoReport } from '../facets/io/render.js';
import { captureParse } from '../facets/parse/capture.js';
import { compareParse } from '../facets/parse/compare.js';
import { renderParseComparison, renderParseReport } from '../facets/parse/render.js';
import { capturePerf } from '../facets/perf/capture.js';
import { comparePerf } from '../facets/perf/compare.js';
import { renderPerfComparison, renderPerfReport } from '../facets/perf/render.js';
import {
  abExitCondition,
  CHANGED_VERDICT,
  type ComparisonLike,
  type FacetEstimate,
  type FacetFunctions,
  renderAb,
  runAb,
  UNMEASURABLE_VERDICT,
} from '../harness/ab.js';
import {
  DEFAULT_MEASURED_COMMANDS,
  MEASURABLE_COMMAND_NAMES,
  measurableCommand,
  type MeasuredCommandSpec,
} from '../harness/commands.js';
import { resolveInstrument } from '../harness/instrument.js';
import { instrumentTrustNotes } from '../harness/render.js';
import { resolveSubject } from '../harness/subject.js';
import type { CacheMode, InstrumentSource, ResolvedInstrument } from '../harness/types.js';
import { readReport, writeReport } from '../store.js';

/**
 * Exit code used when a comparison is refused rather than merely negative.
 *
 * Exported (with the other two exit codes) so a test can assert against the
 * real constant instead of a duplicated literal.
 */
export const EXIT_REFUSED = 2;
/** Exit code used when a comparison found a significant change. */
export const EXIT_CHANGED = 1;
/**
 * Exit code used when the comparison completed but at least one command could
 * not be measured.
 *
 * Distinct from both other codes on purpose: `EXIT_REFUSED` means the whole
 * comparison could not be attempted, and a run where every command is
 * `unmeasurable` still produces a rendered, per-command comparison — it is not
 * a refusal. But it is not a clean run either, and defaulting to exit `0`
 * would let a CI job read "nothing could be measured" as "nothing changed".
 */
export const EXIT_UNMEASURABLE = 3;

/**
 * Parse an instrument specifier into a source.
 *
 * The prefix is mandatory. "Guess what the user meant" is how a harness ends up
 * stamping reports with an instrument nobody asked for.
 *
 * @param value - `tree:<path>`, `dist:<path>` or `npx:<spec>`
 * @returns The parsed source
 */
export function parseInstrument(value: string): InstrumentSource {
  const separator = value.indexOf(':');
  const kind = separator === -1 ? '' : value.slice(0, separator);
  const rest = separator === -1 ? '' : value.slice(separator + 1);
  if (rest.length === 0) {
    throw new InvalidArgumentError(
      `--instrument expects 'tree:<path>', 'dist:<path>' or 'npx:<spec>'; got '${value}'.`,
    );
  }
  switch (kind) {
    case 'tree': {
      return { kind: 'tree', path: rest };
    }
    case 'dist': {
      return { kind: 'dist', path: rest };
    }
    case 'npx': {
      return { kind: 'npx', spec: rest };
    }
    default: {
      throw new InvalidArgumentError(
        `--instrument prefix must be 'tree', 'dist' or 'npx'; got '${kind}'.`,
      );
    }
  }
}

/**
 * A Commander parser for a whole number at or above a floor.
 *
 * Delegates the check to utils so the rule has one home. The wrapper exists
 * only to raise Commander's error type, which is what makes the CLI print a
 * usage message naming the flag instead of a stack trace.
 *
 * @param flag - Flag spelling, so the error names what the user typed
 * @param floor - Smallest sensible value
 * @returns A parser Commander calls with the raw string
 */
export function wholeNumberAtLeast(flag: string, floor: number): (value: string) => number {
  return (value: string): number => {
    try {
      return parseWholeNumberAtLeast(value, floor, flag);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * A Commander parser for a finite, non-negative number.
 *
 * Separate from {@link wholeNumberAtLeast} because a noise floor is a
 * measurement, not a count: rounding `12.4 ms` up to `13` would silently widen
 * the band in which effects are dismissed as noise, and rounding it down would
 * silently narrow it.
 *
 * @param flag - Flag spelling, so the error names what the user typed
 * @returns A parser Commander calls with the raw string
 */
export function nonNegativeNumber(flag: string): (value: string) => number {
  return (value: string): number => {
    // `Number('')` and `Number('  ')` are both `0`, and a `--noise-floor` of 0
    // means "nothing is noise" — the most permissive possible reading, arrived
    // at by typing nothing. Rejected explicitly rather than left to coercion.
    const parsed = value.trim() === '' ? Number.NaN : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new InvalidArgumentError(
        `${flag} expects a finite number at or above 0; got '${value}'.`,
      );
    }
    return parsed;
  };
}

/**
 * A Commander parser for `--cache`.
 *
 * A synchronous per-option callback, matching {@link parseInstrument} and
 * {@link wholeNumberAtLeast} above, and deliberately NOT a check inside the
 * async `run` action. Commander only recognises an `InvalidArgumentError` as a
 * usage error when it comes out of an option's own parser, where it prints the
 * normal `error: option '--cache <mode>' argument '...' is invalid` message and
 * exits cleanly. The same error thrown from inside an async action handler is
 * just a rejected promise Commander does not special-case: with no top-level
 * catch around `parseAsync`, it surfaces as an unhandled rejection and a raw
 * Node stack trace instead of a CLI usage message.
 *
 * @param value - Raw value Commander parsed
 * @returns The validated cache mode
 * @throws {InvalidArgumentError} when the value is neither 'warm' nor 'cold'
 */
export function parseCacheMode(value: string): CacheMode {
  if (value !== 'warm' && value !== 'cold') {
    throw new InvalidArgumentError(`--cache expects 'warm' or 'cold'; got '${value}'.`);
  }
  return value;
}

/**
 * A Commander parser for `--command`, accumulating repeats into a list.
 *
 * Commander hands a repeatable option's parser the value plus whatever the
 * option holds so far, which is how one flag given twice becomes two specs
 * rather than the last one winning. `previous` is `undefined` on the first
 * occurrence because the option carries no default — "no `--command` at all"
 * has to stay distinguishable from "`--command` given", since the former means
 * {@link DEFAULT_MEASURED_COMMANDS} and an empty-list default would silently
 * mean "measure nothing".
 *
 * The unknown-name check lives here, in the option's own parser, for the reason
 * {@link parseCacheMode} spells out: an `InvalidArgumentError` thrown from the
 * async action is just a rejected promise and surfaces as a raw stack trace.
 *
 * @param value - Raw value Commander parsed
 * @param previous - Specs collected from earlier occurrences of this flag
 * @returns The accumulated specs, in the order the flags were given
 * @throws {InvalidArgumentError} when no measurable command has that name
 */
export function collectMeasuredCommand(
  value: string,
  previous: readonly MeasuredCommandSpec[] | undefined,
): MeasuredCommandSpec[] {
  const spec = measurableCommand(value);
  if (spec === undefined) {
    throw new InvalidArgumentError(
      `--command expects one of: ${MEASURABLE_COMMAND_NAMES.join(', ')}; got '${value}'.`,
    );
  }
  return [...(previous ?? []), spec];
}

/** Options Commander collects for a facet's `run`. */
interface RunOptions {
  readonly instrument: InstrumentSource;
  readonly runs: number;
  readonly cache: CacheMode;
  readonly out: string;
  readonly id?: string;
  /** Absent unless `--command` was given at least once. */
  readonly command?: readonly MeasuredCommandSpec[];
}

/**
 * Everything that differs between one facet's command group and another's.
 *
 * Both facets' `run` and `compare` do the same six things in the same order —
 * resolve the instrument, resolve the subject, capture, write, render, exit.
 * Wiring them separately would mean two copies of the refusal handling and the
 * exit-code rules, and the copies would drift into two different answers to
 * "what exit code does a refusal get?", which is the CLI's whole contract.
 */
interface FacetWiring<TBody, TComparison extends ComparisonLike>
  extends FacetFunctions<TBody, TComparison> {
  /** Subcommand name, and the facet's name in help text. */
  readonly name: string;
  readonly summary: string;
  readonly runSummary: string;
  readonly compareSummary: string;
  /**
   * Default repeats per command.
   *
   * Per facet because the facets need different minima: `io` compares repeats
   * for determinism and needs a warm-up plus two compared runs, while `perf`
   * wants enough samples for a spread to mean something.
   */
  readonly defaultRuns: number;
  /**
   * Cache mode a bare `run` uses.
   *
   * Per facet because the facets need opposite things, and getting it wrong is
   * not a preference but a broken measurement: `perf` and `io` want the steady
   * state, while `parse` can only attribute anything on a cache MISS — vat's
   * parse cache short-circuits the parse function entirely on a hit, so a warm
   * `parse` run produces a breakdown of nine zeroes that reads as "parsing is
   * free". Defaulting every facet to `warm` from one shared constant made that
   * the out-of-the-box experience of the one facet it ruins.
   */
  readonly defaultCache: CacheMode;
  readonly renderReport: (report: ReportEnvelope<TBody>) => string;
  readonly renderComparison: (comparison: TComparison) => string;
}

/** Options Commander collects for a facet's `ab`. */
interface AbOptions {
  readonly instrumentA: InstrumentSource;
  /** Absent for a `--control` run, where arm A is entered twice. */
  readonly instrumentB?: InstrumentSource;
  readonly pairs: number;
  readonly runs: number;
  readonly cache: CacheMode;
  readonly out: string;
  readonly id?: string;
  readonly command?: readonly MeasuredCommandSpec[];
  readonly control: boolean;
  readonly noiseFloor?: number;
}

/**
 * Where one `ab` invocation's per-pair reports live.
 *
 * Stamped with the wall clock so two A/Bs of the same coordinate cannot land on
 * top of each other — the reports inside are `pair-1/a`, `pair-1/b`, … and every
 * pair of one arm shares a coordinate, so nothing else in the name distinguishes
 * two runs.
 *
 * @param out - The `--out` directory
 * @param startedAt - ISO stamp for this invocation
 * @returns The directory to write into
 */
function abRunDirectory(out: string, startedAt: string): string {
  return safePath.join(out, `ab-${startedAt.replaceAll(/[^\dA-Za-z]/g, '-')}`);
}

/**
 * Add a facet's `ab` subcommand.
 *
 * Declared on the shared factory rather than on one facet: every facet's numbers
 * are worth A/B-ing, and a verb that existed only where someone happened to need
 * it first would leave the others with the hand-orchestration this replaces.
 *
 * @param group - The facet's command group
 * @param wiring - See {@link FacetWiring}
 */
function addAbCommand<TBody, TComparison extends ComparisonLike>(
  group: Command,
  wiring: FacetWiring<TBody, TComparison>,
): void {
  group
    .command('ab')
    .argument('<subject>', 'Path to the project to measure')
    .requiredOption(
      '--instrument-a <spec>',
      "Arm A: 'tree:<path>', 'dist:<path>' or 'npx:<pkg@version>'",
      parseInstrument,
    )
    .option('--instrument-b <spec>', 'Arm B; omit only with --control', parseInstrument)
    .option(
      '--control',
      'Run the SAME instrument as both arms, to measure this machine’s noise floor',
      false,
    )
    .option(
      '--noise-floor <value>',
      "Largest effect a --control run reported, in the facet's own units; " +
        'anything at or below it is reported as indistinguishable from noise',
      nonNegativeNumber('--noise-floor'),
    )
    .option('--pairs <n>', 'A-then-B cycles to run', wholeNumberAtLeast('--pairs', 1), 6)
    .option('--runs <n>', 'Repeats per capture', wholeNumberAtLeast('--runs', 1), wiring.defaultRuns)
    .option(
      '--cache <mode>',
      "'warm' or 'cold' (cold clears vat's caches before every repeat)",
      parseCacheMode,
      wiring.defaultCache,
    )
    .option(
      '--command <name>',
      `Measure this command instead of the default set (repeatable). One of: ${MEASURABLE_COMMAND_NAMES.join(', ')}`,
      collectMeasuredCommand,
    )
    .option('--out <dir>', 'Directory to write the reports into', '.vat-lab')
    .option(
      '--id <name>',
      'Subject id recorded in the reports (default: the <subject> argument exactly as given)',
    )
    .description(
      `Interleave two vat builds over the ${wiring.name} facet: A B A B …, min estimator, per-pair verdicts`,
    )
    .action(async (subjectPath: string, options: AbOptions) => {
      const arms = await resolveAbArms(options);
      if (arms === null) return;

      const startedAt = new Date().toISOString();
      const result = await runAb({
        subject: await resolveSubject({ id: options.id ?? subjectPath, path: subjectPath }),
        armA: arms.a,
        armB: arms.b,
        commands: options.command ?? DEFAULT_MEASURED_COMMANDS,
        pairs: options.pairs,
        runs: options.runs,
        cache: options.cache,
        control: options.control,
        noiseFloor: options.noiseFloor ?? null,
        outDir: abRunDirectory(options.out, startedAt),
        now: () => new Date().toISOString(),
        capture: wiring.capture,
        compare: wiring.compare,
        estimate: wiring.estimate,
      });

      process.stdout.write(`${renderAb(result)}\n`);
      applyAbExitCode(result);
    });
}

/**
 * Resolve the two arms, or refuse when the flags do not describe an A/B.
 *
 * A control run uses the *same resolved object* for both arms rather than
 * resolving one spec twice: that is what makes the two stamps identical by
 * construction, so a control can never be mistaken for a two-build comparison.
 *
 * @param options - What the caller passed
 * @returns The two arms, or `null` when the run was refused
 */
async function resolveAbArms(
  options: AbOptions,
): Promise<{ a: ResolvedInstrument; b: ResolvedInstrument } | null> {
  if (options.control) {
    if (options.instrumentB !== undefined) {
      refuse(
        'REFUSED: --control runs one instrument as both arms, so --instrument-b would be ' +
          'silently ignored. Drop one of the two flags.',
      );
      return null;
    }
    const only = await resolveInstrument(options.instrumentA);
    return { a: only, b: only };
  }

  if (options.instrumentB === undefined) {
    refuse(
      'REFUSED: an A/B needs two arms. Pass --instrument-b, or pass --control to enter ' +
        '--instrument-a twice and measure the noise floor instead.',
    );
    return null;
  }

  return {
    a: await resolveInstrument(options.instrumentA),
    b: await resolveInstrument(options.instrumentB),
  };
}

/**
 * Set the exit code an `ab` run earned.
 *
 * Shares the mapping with `compare` — see {@link abExitCondition} for why an
 * unstable verdict lands on `EXIT_UNMEASURABLE` rather than on either answer the
 * pairs gave.
 *
 * @param result - A completed A/B
 */
function applyAbExitCode(result: Parameters<typeof abExitCondition>[0]): void {
  switch (abExitCondition(result)) {
    case 'refused': {
      process.exitCode = EXIT_REFUSED;
      return;
    }
    case 'changed': {
      process.exitCode = EXIT_CHANGED;
      return;
    }
    case 'unmeasurable': {
      process.exitCode = EXIT_UNMEASURABLE;
      return;
    }
    case 'clean': {
      return;
    }
  }
}

/**
 * Build one facet's `run`, `compare` and `ab` subcommands.
 *
 * @param wiring - See {@link FacetWiring}
 * @returns The configured Commander command
 */
function createFacetCommand<TBody, TComparison extends ComparisonLike>(
  wiring: FacetWiring<TBody, TComparison>,
): Command {
  const group = new Command(wiring.name).description(wiring.summary);

  group
    .command('run')
    .argument('<subject>', 'Path to the project to measure')
    .requiredOption(
      '--instrument <spec>',
      "Which vat to measure: 'tree:<path>', 'dist:<path>' or 'npx:<pkg@version>'",
      parseInstrument,
    )
    .option(
      '--runs <n>',
      'Repeats per command',
      wholeNumberAtLeast('--runs', 1),
      wiring.defaultRuns,
    )
    .option(
      '--cache <mode>',
      "'warm' or 'cold' (cold clears vat's caches before every repeat)",
      parseCacheMode,
      wiring.defaultCache,
    )
    .option(
      '--command <name>',
      `Measure this command instead of the default set (repeatable). One of: ${MEASURABLE_COMMAND_NAMES.join(', ')}`,
      collectMeasuredCommand,
    )
    .option('--out <dir>', 'Directory to write the report into', '.vat-lab')
    .option(
      '--id <name>',
      'Subject id recorded in the report (default: the <subject> argument exactly as given)',
    )
    .description(wiring.runSummary)
    .action(async (subjectPath: string, options: RunOptions) => {
      const instrument = await resolveInstrument(options.instrument);
      const subject = await resolveSubject({ id: options.id ?? subjectPath, path: subjectPath });
      const report = await wiring.capture({
        instrument,
        subject,
        // No `--command` means the default set, unchanged — the flag widens what
        // can be asked for and never quietly narrows a bare run.
        commands: options.command ?? DEFAULT_MEASURED_COMMANDS,
        runs: options.runs,
        cache: options.cache,
        capturedAt: new Date().toISOString(),
      });
      const written = await writeReport(options.out, report);
      process.stdout.write(`${wiring.renderReport(report)}\nWrote ${written}\n`);
    });

  group
    .command('compare')
    .argument('<baseline>', 'Path to the baseline report')
    .argument('<candidate>', 'Path to the report being compared against it')
    .option(
      '--allow-multi-axis',
      'Compare even when more than one axis moved (the result cannot be attributed)',
      false,
    )
    .description(wiring.compareSummary)
    .action(
      async (baselinePath: string, candidatePath: string, options: { allowMultiAxis: boolean }) => {
        const baseline = await readReport(baselinePath);
        if (!baseline.ok) return refuse(baseline.refusal);
        const candidate = await readReport(candidatePath);
        if (!candidate.ok) return refuse(candidate.refusal);

        const comparison = wiring.compare(baseline.envelope, candidate.envelope, {
          allowMultiAxis: options.allowMultiAxis,
        });
        if (!comparison.ok) return refuse(comparison.refusal);

        // Above the facet's own output, and for every facet at once: a stamp
        // that misdescribes which build ran invalidates the numbers below it,
        // and only two of the three facets route their comparison through the
        // shared frame that could otherwise carry this.
        const trust = instrumentTrustNotes(
          baseline.envelope.coordinate.instrument,
          candidate.envelope.coordinate.instrument,
        );
        if (trust.length > 0) process.stdout.write(`${trust.join('\n')}\n`);
        process.stdout.write(`${wiring.renderComparison(comparison)}\n`);
        if (comparison.commands.some((command) => command.verdict.kind === CHANGED_VERDICT)) {
          process.exitCode = EXIT_CHANGED;
        } else if (
          comparison.commands.some((command) => command.verdict.kind === UNMEASURABLE_VERDICT)
        ) {
          // No real change, but not a clean run either — at least one command
          // produced no usable measurement. Exiting 0 here would be
          // indistinguishable from a genuinely clean comparison to anything
          // reading `$?`.
          process.exitCode = EXIT_UNMEASURABLE;
        }
      },
    );

  addAbCommand(group, wiring);

  return group;
}

/**
 * Turn a facet's command rows into the estimates `ab` aggregates.
 *
 * Shared by all three wirings because the *rule* is shared and is the part worth
 * getting right: a failed row publishes no estimate at all. Letting one through
 * would feed `ab` the zero a failed row carries, and a zero is the best number
 * this tool can print — one failure would read as the fastest arm ever measured.
 * Three hand-written copies would be three chances to forget that filter.
 *
 * @param rows - The facet's command rows, which all share `name` and `failed`
 * @param unit - What the extracted value is, for rendering only
 * @param valueOf - Which of the row's numbers to publish
 * @returns One estimate per row that produced a usable measurement
 */
function rowEstimates<TRow extends { readonly name: string; readonly failed: boolean }>(
  rows: readonly TRow[],
  unit: string,
  valueOf: (row: TRow) => number,
): readonly FacetEstimate[] {
  return rows
    .filter((row) => !row.failed)
    .map((row) => ({ name: row.name, value: valueOf(row), unit }));
}

/**
 * Report a refusal and set the exit code that distinguishes it from a change.
 *
 * A refusal is not a negative result — it says the question could not be asked.
 * Sharing one exit code between them would let a CI job read "we could not
 * compare these" as "nothing moved".
 *
 * @param refusal - The refusal text, already prefixed
 */
function refuse(refusal: string): void {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = EXIT_REFUSED;
}

/**
 * Build the whole `vat-lab` program.
 *
 * @returns The configured root command
 */
export function createProgram(): Command {
  return new Command('vat-lab')
    .description(
      'Quality lab: report on a project and compare along one axis — which project, which version of it, which vat build',
    )
    .addCommand(
      createFacetCommand({
        name: 'perf',
        summary: 'Measure how long vat commands take, with repeats and spread',
        runSummary: 'Capture a perf report for one project against one vat build',
        compareSummary: 'Diff two perf reports along a single axis',
        defaultRuns: 5,
        defaultCache: 'warm',
        capture: (request) => Promise.resolve(capturePerf(request)),
        compare: comparePerf,
        renderReport: renderPerfReport,
        renderComparison: renderPerfComparison,
        // `minMs`, not `medianMs`. The row already carries the fastest repeat,
        // and it is the right number to hand `ab` for the same reason `ab` then
        // takes a minimum of it — see `harness/estimator.ts`.
        estimate: (report) => rowEstimates(report.body.commands, 'ms', (row) => row.minMs),
      }),
    )
    .addCommand(
      createFacetCommand({
        name: 'io',
        summary: 'Count the filesystem and child-process calls vat commands make',
        runSummary: 'Capture an I/O report for one project against one vat build',
        compareSummary: 'Diff two I/O reports along a single axis',
        // One warm-up plus two compared repeats: the smallest run that can
        // test determinism at all, and io counts are deterministic enough that
        // more repeats buy confidence rather than resolution.
        defaultRuns: 3,
        defaultCache: 'warm',
        capture: captureIo,
        compare: compareIo,
        renderReport: renderIoReport,
        renderComparison: renderIoComparison,
        // Call counts do not move with machine load, so a min across pairs is
        // normally every pair's value. That is a feature: an arm whose min and
        // p25 differ is an arm whose counts were NOT deterministic, and the A/B
        // shows it without needing its own stability rule.
        estimate: (report) => rowEstimates(report.body.commands, 'calls', (row) => row.userCalls),
      }),
    )
    .addCommand(
      createFacetCommand({
        name: 'parse',
        summary: "Attribute vat's document parse time, per parser kind, to individual passes",
        runSummary: 'Capture a parse-timing report for one project against one vat build',
        compareSummary: 'Diff two parse-timing reports along a single axis',
        // Three repeats, so the middle one can be reported and the other two can
        // disagree with it. No warm-up is discarded — see `parse/capture.ts`.
        defaultRuns: 3,
        // The one facet that must not default to warm — see `FacetWiring.defaultCache`.
        defaultCache: 'cold',
        capture: captureParse,
        compare: compareParse,
        renderReport: renderParseReport,
        renderComparison: renderParseComparison,
        // Time inside a parser, summed ACROSS EVERY PARSER KIND — deliberately,
        // and the unit says so. The per-kind totals are the honest unit of
        // attribution, but `ab` compares exactly one number per command, and a
        // number that meant "one kind's total" would reproduce precisely the
        // blindness the per-kind grouping exists to remove: an arm that made one
        // parser slower and another faster would read as unchanged, and on a
        // corpus dominated by the kind the estimate ignored it would read as no
        // change at all. The sum is the only single number that moves whenever
        // any parse work does. A reader who needs to know WHICH kind moved reads
        // the compare output, where the passes are qualified by kind.
        estimate: (report) =>
          rowEstimates(report.body.commands, 'ms parse (all kinds)', (row) => row.totalMs),
      }),
    );
}

// Run only when this is the invoked script, not merely imported — the same
// guard `packages/dev-tools/src/tsc-clean-build.ts` uses. Without it, a test
// that imports `createProgram` for its own argv would also trigger this
// module's own `process.argv`-driven run as an import side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createProgram().parseAsync(process.argv);
}
