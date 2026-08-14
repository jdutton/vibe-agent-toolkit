#!/usr/bin/env node
/**
 * `vat-lab` — the quality lab's command line.
 *
 * Drives vat through its command-line boundary only, which is what lets one run
 * measure two different vat versions and what lets it measure a project with no
 * vat config at all.
 */

import { pathToFileURL } from 'node:url';

import { parseWholeNumberAtLeast } from '@vibe-agent-toolkit/utils';
import { Command, InvalidArgumentError } from 'commander';

import type { ReportEnvelope } from '../envelope/envelope.js';
import { captureIo } from '../facets/io/capture.js';
import { compareIo } from '../facets/io/compare.js';
import { renderIoComparison, renderIoReport } from '../facets/io/render.js';
import { capturePerf } from '../facets/perf/capture.js';
import { comparePerf } from '../facets/perf/compare.js';
import { renderPerfComparison, renderPerfReport } from '../facets/perf/render.js';
import {
  DEFAULT_MEASURED_COMMANDS,
  MEASURABLE_COMMAND_NAMES,
  measurableCommand,
  type MeasuredCommandSpec,
} from '../harness/commands.js';
import { resolveInstrument } from '../harness/instrument.js';
import { resolveSubject } from '../harness/subject.js';
import type { CacheMode, CaptureRequest, InstrumentSource } from '../harness/types.js';
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

/** The verdict kind that means a real, attributable difference was found. */
const CHANGED_VERDICT = 'changed';
/** The verdict kind that means no usable measurement exists for a command. */
const UNMEASURABLE_VERDICT = 'unmeasurable';

/**
 * The least a comparison must expose for the CLI to report it.
 *
 * Deliberately structural rather than a union of the two facets' result types:
 * the CLI's job is to print what a facet rendered and to pick an exit code, and
 * it should not acquire a reason to know what a `perf` verdict is called versus
 * an `io` one. A third facet wires itself up by satisfying this and nothing else.
 */
interface ComparisonLike {
  /** The discriminant, so a refusal and a result stay distinguishable here too. */
  readonly ok: true;
  readonly commands: readonly { readonly verdict: { readonly kind: string } }[];
}

/** A comparison that refused, in the shape every facet's comparator returns. */
interface RefusalLike {
  readonly ok: false;
  readonly refusal: string;
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
interface FacetWiring<TBody, TComparison extends ComparisonLike> {
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
  readonly capture: (request: CaptureRequest) => Promise<ReportEnvelope<TBody>>;
  readonly compare: (
    before: ReportEnvelope<unknown>,
    after: ReportEnvelope<unknown>,
    options: { allowMultiAxis: boolean },
  ) => RefusalLike | TComparison;
  readonly renderReport: (report: ReportEnvelope<TBody>) => string;
  readonly renderComparison: (comparison: TComparison) => string;
}

/**
 * Build one facet's `run` and `compare` subcommands.
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
      'warm',
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

  return group;
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
        capture: (request) => Promise.resolve(capturePerf(request)),
        compare: comparePerf,
        renderReport: renderPerfReport,
        renderComparison: renderPerfComparison,
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
        capture: captureIo,
        compare: compareIo,
        renderReport: renderIoReport,
        renderComparison: renderIoComparison,
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
