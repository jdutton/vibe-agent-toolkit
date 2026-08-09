#!/usr/bin/env node
/**
 * `vat-lab` — the quality lab's command line.
 *
 * Drives vat through its command-line boundary only, which is what lets one run
 * measure two different vat versions and what lets it measure a project with no
 * vat config at all.
 */

import { parseWholeNumberAtLeast } from '@vibe-agent-toolkit/utils';
import { Command, InvalidArgumentError } from 'commander';

import type { ReportEnvelope } from '../envelope/envelope.js';
import { captureIo } from '../facets/io/capture.js';
import { compareIo } from '../facets/io/compare.js';
import { renderIoComparison, renderIoReport } from '../facets/io/render.js';
import { capturePerf } from '../facets/perf/capture.js';
import { comparePerf } from '../facets/perf/compare.js';
import { renderPerfComparison, renderPerfReport } from '../facets/perf/render.js';
import { DEFAULT_MEASURED_COMMANDS } from '../harness/commands.js';
import { resolveInstrument } from '../harness/instrument.js';
import { resolveSubject } from '../harness/subject.js';
import type { CaptureRequest, InstrumentSource } from '../harness/types.js';
import { readReport, writeReport } from '../store.js';

/** Exit code used when a comparison is refused rather than merely negative. */
const EXIT_REFUSED = 2;
/** Exit code used when a comparison found a significant change. */
const EXIT_CHANGED = 1;

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

/** Options Commander collects for a facet's `run`. */
interface RunOptions {
  readonly instrument: InstrumentSource;
  readonly runs: number;
  readonly cache: string;
  readonly out: string;
  readonly id?: string;
}

/** The verdict kind that means a real, attributable difference was found. */
const CHANGED_VERDICT = 'changed';

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
    .option('--cache <mode>', "'warm' or 'cold' (cold clears vat's caches before every repeat)", 'warm')
    .option('--out <dir>', 'Directory to write the report into', '.vat-lab')
    .option('--id <name>', 'Subject id recorded in the report (default: the directory name)')
    .description(wiring.runSummary)
    .action(async (subjectPath: string, options: RunOptions) => {
      if (options.cache !== 'warm' && options.cache !== 'cold') {
        throw new InvalidArgumentError(`--cache expects 'warm' or 'cold'; got '${options.cache}'.`);
      }
      const instrument = await resolveInstrument(options.instrument);
      const subject = await resolveSubject({ id: options.id ?? subjectPath, path: subjectPath });
      const report = await wiring.capture({
        instrument,
        subject,
        commands: DEFAULT_MEASURED_COMMANDS,
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

await createProgram().parseAsync(process.argv);
