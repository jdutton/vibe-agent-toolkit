#!/usr/bin/env node
/**
 * `vat-lab` — the quality lab's command line.
 *
 * Drives vat through its command-line boundary only, which is what lets one run
 * measure two different vat versions and what lets it measure a project with no
 * vat config at all.
 */

import { ExitCode, installLastResortExit } from '@vibe-agent-toolkit/schema';
import { parseWholeNumberAtLeast, safePath } from '@vibe-agent-toolkit/utils';
import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';
import { Command, InvalidArgumentError } from 'commander';

import type { ReportEnvelope } from '../envelope/envelope.js';
import { captureCrawl } from '../facets/crawl/capture.js';
import { compareCrawl } from '../facets/crawl/compare.js';
import { renderCrawlComparison, renderCrawlReport } from '../facets/crawl/render.js';
import { captureIo } from '../facets/io/capture.js';
import { compareIo } from '../facets/io/compare.js';
import { renderIoComparison, renderIoReport } from '../facets/io/render.js';
import { captureParse } from '../facets/parse/capture.js';
import { compareParse } from '../facets/parse/compare.js';
import { renderParseComparison, renderParseReport } from '../facets/parse/render.js';
import { capturePerf } from '../facets/perf/capture.js';
import { comparePerf } from '../facets/perf/compare.js';
import { renderPerfComparison, renderPerfReport } from '../facets/perf/render.js';
import { capturePopulation } from '../facets/population/capture.js';
import { comparePopulation } from '../facets/population/compare.js';
import {
  renderPopulationComparison,
  renderPopulationReport,
} from '../facets/population/render.js';
import { captureVerdict } from '../facets/verdict/capture.js';
import { compareVerdict, readVerdictDirectory } from '../facets/verdict/compare.js';
import { CHANGELOG_REFERENCE_ROOT, COMMITTED_VERDICT_DELTAS, loadVerdictDeltas, readChangelogSources } from '../facets/verdict/deltas.js';
import { renderVerdictComparison, renderVerdictReport } from '../facets/verdict/render.js';
import { loadVerdictSubjects } from '../facets/verdict/subjects.js';
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
import { type ArmEnvironment, armEnvironmentClash, sameArmEnvironment } from '../harness/arm-env.js';
import { indistinguishableArms } from '../harness/closure.js';
import {
  DEFAULT_MEASURED_COMMANDS,
  MEASURABLE_COMMAND_NAMES,
  measurableCommand,
  type MeasuredCommandSpec,
  POPULATION_MEASURED_COMMANDS,
} from '../harness/commands.js';
import { resolveInstrument } from '../harness/instrument.js';
import { instrumentLabel, instrumentTrustNotes } from '../harness/render.js';
import { resolveSubject } from '../harness/subject.js';
import type { CacheMode, InstrumentSource, ResolvedInstrument } from '../harness/types.js';
import { readReport, writeReport } from '../store.js';

/*
 * Exit codes are the one contract every VAT process shares (`ExitCode` in
 * `@vibe-agent-toolkit/schema`): a comparison that found a significant change
 * ends on `FINDINGS`; a refused comparison — and one that completed but could
 * not measure at least one command — ends on `ERROR`. The lab used to reserve a
 * third code (3) for "unmeasurable"; under the shared contract that is a run
 * the lab could not do, and the rendered per-command comparison on stdout is
 * where a reader learns which command produced no usable measurement. What the
 * fold keeps is the property that mattered: neither case exits 0, so a CI job
 * cannot read "nothing could be measured" as "nothing changed".
 */

/** The `--out` flag's spelling, shared by every facet's `run` and `ab`. */
const OUT_OPTION = '--out <dir>';

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

/**
 * A Commander parser for `--env`, `--env-a` and `--env-b`, accumulating `KEY=VALUE` pairs.
 *
 * Splits on the FIRST `=` only, so a value may contain one. An empty value is
 * accepted — `KEY=` is a real thing to want, since a seam that tests
 * `env['X'] === '1'` reads it as off — but an empty KEY is not, because
 * `process.env` cannot carry one and the child would silently see nothing.
 *
 * @param flag - Flag spelling, so the error names what the user typed
 * @returns A parser Commander calls with the raw string and the value so far
 */
export function collectEnv(
  flag: string,
): (value: string, previous: Readonly<Record<string, string>> | undefined) => Record<string, string> {
  return (value, previous) => {
    const at = value.indexOf('=');
    if (at <= 0) {
      throw new InvalidArgumentError(
        `${flag} expects KEY=VALUE with a non-empty KEY; got '${value}'.`,
      );
    }
    return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
  };
}

/**
 * A Commander parser for `--unset`, `--unset-a` and `--unset-b`, accumulating
 * variable names to remove from the inherited environment.
 *
 * A name containing `=` is refused: it is almost certainly a `--env` value
 * given to the wrong flag, and unsetting a variable literally named `X=1`
 * would silently do nothing.
 *
 * @param flag - Flag spelling, so the error names what the user typed
 * @returns A parser Commander calls with the raw string and the names so far
 */
export function collectUnset(
  flag: string,
): (value: string, previous: readonly string[] | undefined) => string[] {
  return (value, previous) => {
    if (value === '' || value.includes('=')) {
      throw new InvalidArgumentError(`${flag} expects a variable NAME; got '${value}'.`);
    }
    return [...(previous ?? []), value];
  };
}

/**
 * Assemble one arm's environment from its `--env*` and `--unset*` flags, or
 * refuse when one key is on both.
 *
 * Refused here, before anything runs, rather than left to `buildArmEnv` to
 * throw at the first spawn — where it would surface as a stack trace mid-run.
 *
 * @param set - Collected `KEY=VALUE` pairs, if the flag was given
 * @param unset - Collected names, if the flag was given
 * @param flags - The two flag spellings, for the refusal
 * @returns The arm's environment, or `null` when the run was refused
 */
function armEnvironment(
  set: ArmEnvironment['set'] | undefined,
  unset: readonly string[] | undefined,
  flags: string,
): ArmEnvironment | null {
  const env: ArmEnvironment = { set: set ?? {}, unset: unset ?? [] };
  const clash = armEnvironmentClash(env);
  if (clash === undefined) return env;
  refuse(`REFUSED: ${flags} both name '${clash}' — an arm cannot set and unset one variable.`);
  return null;
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
  /** Variables set for every child; absent unless `--env` was given. */
  readonly env?: ArmEnvironment['set'];
  /** Variables removed from every child; absent unless `--unset` was given. */
  readonly unset?: readonly string[];
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
  /**
   * The commands a bare run measures, when the shared default set is wrong for
   * this facet.
   *
   * Absent means {@link DEFAULT_MEASURED_COMMANDS} — the three corpus-enumerating
   * verbs every cost facet is taken over. `population` overrides it because two
   * of those three emit no file list, so a bare run would be two refusals and a
   * measurement. Overriding the DEFAULT never narrows what `--command` can ask
   * for; the registry is still the whole menu.
   */
  readonly defaultCommands?: readonly MeasuredCommandSpec[];
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
  /** Variables set for arm A's children only. */
  readonly envA?: ArmEnvironment['set'];
  /** Variables set for arm B's children only. */
  readonly envB?: ArmEnvironment['set'];
  /** Variables removed from arm A's children only. */
  readonly unsetA?: readonly string[];
  /** Variables removed from arm B's children only. */
  readonly unsetB?: readonly string[];
}

/** Two resolved arms, each with the environment it runs under. */
interface AbArms {
  readonly a: ResolvedInstrument;
  readonly b: ResolvedInstrument;
  readonly envA: ArmEnvironment;
  readonly envB: ArmEnvironment;
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
    .option(
      '--env-a <KEY=VALUE>',
      'Extra environment for arm A only (repeatable). Pass the same instrument to both arms ' +
        'to measure one build in two configurations',
      collectEnv('--env-a'),
    )
    .option(
      '--env-b <KEY=VALUE>',
      'Extra environment for arm B only (repeatable)',
      collectEnv('--env-b'),
    )
    .option(
      '--unset-a <KEY>',
      'Remove an inherited variable from arm A only (repeatable)',
      collectUnset('--unset-a'),
    )
    .option(
      '--unset-b <KEY>',
      'Remove an inherited variable from arm B only (repeatable)',
      collectUnset('--unset-b'),
    )
    .option(OUT_OPTION, 'Directory to write the reports into', '.vat-lab')
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
        commands: options.command ?? wiring.defaultCommands ?? DEFAULT_MEASURED_COMMANDS,
        pairs: options.pairs,
        runs: options.runs,
        cache: options.cache,
        control: options.control,
        noiseFloor: options.noiseFloor ?? null,
        envA: arms.envA,
        envB: arms.envB,
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
export async function resolveAbArms(options: AbOptions): Promise<AbArms | null> {
  const envA = armEnvironment(options.envA, options.unsetA, '--env-a and --unset-a');
  if (envA === null) return null;
  const envB = armEnvironment(options.envB, options.unsetB, '--env-b and --unset-b');
  if (envB === null) return null;

  if (options.control) {
    if (options.instrumentB !== undefined) {
      refuse(
        'REFUSED: --control runs one instrument as both arms, so --instrument-b would be ' +
          'silently ignored. Drop one of the two flags.',
      );
      return null;
    }
    if (!sameArmEnvironment(envA, envB)) {
      refuse(
        'REFUSED: --control measures what this machine returns for a difference that does ' +
          'not exist, so both arms must be configured identically. --env-a/--unset-a and ' +
          '--env-b/--unset-b ' +
          'differ, which is a real difference — it would be published as the noise floor and ' +
          'then used to judge every later run. Make them match, or drop --control and run it ' +
          'as the A/B it is.',
      );
      return null;
    }
    const only = await resolveInstrument(options.instrumentA);
    return { a: only, b: only, envA, envB };
  }

  if (options.instrumentB === undefined) {
    refuse(
      'REFUSED: an A/B needs two arms. Pass --instrument-b, or pass --control to enter ' +
        '--instrument-a twice and measure the noise floor instead.',
    );
    return null;
  }

  const a = await resolveInstrument(options.instrumentA);
  const b = await resolveInstrument(options.instrumentB);
  if (indistinguishableArms({ instrument: a.version, env: envA }, { instrument: b.version, env: envB })) {
    refuse(
      'REFUSED: the two arms are indistinguishable — same instrument ' +
        `(${instrumentLabel(a.version)}) and same environment. Pass --control to measure the ` +
        'noise floor, or change one arm.',
    );
    return null;
  }
  return { a, b, envA, envB };
}

/**
 * Set the exit code an `ab` run earned.
 *
 * Shares the mapping with `compare` — see {@link abExitCondition} for why an
 * unstable verdict lands on `ERROR` (unmeasurable) rather than on either answer
 * the pairs gave.
 *
 * @param result - A completed A/B
 */
function applyAbExitCode(result: Parameters<typeof abExitCondition>[0]): void {
  switch (abExitCondition(result)) {
    case 'changed': {
      process.exitCode = ExitCode.FINDINGS;
      return;
    }
    case 'refused':
    case 'unmeasurable': {
      process.exitCode = ExitCode.ERROR;
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
    .option(
      '--env <KEY=VALUE>',
      'Set a variable for every child (repeatable). VAT_BIN, VAT_ROOT_DIR and the other ' +
        'variables that select which vat runs are never inherited — set them here',
      collectEnv('--env'),
    )
    .option(
      '--unset <KEY>',
      'Remove an inherited variable from every child (repeatable)',
      collectUnset('--unset'),
    )
    .option(OUT_OPTION, 'Directory to write the report into', '.vat-lab')
    .option(
      '--id <name>',
      'Subject id recorded in the report (default: the <subject> argument exactly as given)',
    )
    .description(wiring.runSummary)
    .action(async (subjectPath: string, options: RunOptions) => {
      const env = armEnvironment(options.env, options.unset, '--env and --unset');
      if (env === null) return;
      const instrument = await resolveInstrument(options.instrument);
      const subject = await resolveSubject({ id: options.id ?? subjectPath, path: subjectPath });
      const report = await wiring.capture({
        instrument,
        subject,
        // No `--command` means the facet's default set, unchanged — the flag
        // widens what can be asked for and never quietly narrows a bare run.
        commands: options.command ?? wiring.defaultCommands ?? DEFAULT_MEASURED_COMMANDS,
        runs: options.runs,
        cache: options.cache,
        env,
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
          process.exitCode = ExitCode.FINDINGS;
        } else if (
          comparison.commands.some((command) => command.verdict.kind === UNMEASURABLE_VERDICT)
        ) {
          // No real change, but not a clean run either — at least one command
          // produced no usable measurement. Exiting 0 here would be
          // indistinguishable from a genuinely clean comparison to anything
          // reading `$?`, and it is not a finding: the lab could not do its job.
          process.exitCode = ExitCode.ERROR;
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
 * The fastest repeat a row measured — the reduction `FacetEstimate` requires.
 *
 * `FacetFunctions.estimate` demands "a per-capture reduction that is already
 * robust to a slow repeat", because `ab` then takes a minimum across captures
 * and **a min over medians is not a min**: a median carries whichever repeat
 * happened to land in the middle, so a single slow repeat inside an arm survives
 * into the number `ab` compares and reads as a real effect.
 *
 * `perf` publishes `minMs` and needs no help. `parse` and `crawl` both report
 * one repeat WHOLE — the one whose total is the median, so that every share on
 * the row comes from a run that actually happened — and both carry the spread
 * separately as `totalMsSamples`. This is where those two facets stop agreeing
 * with their own row and start agreeing with the contract; keeping it in one
 * place is what stops them diverging again.
 *
 * Falls back to `totalMs` only when no samples were published, which is a row
 * that ran zero repeats.
 *
 * ⚠️ A degenerate capture reduces to its degenerate value, deliberately: `parse
 * --cache warm` parses on repeat 0 and nothing afterwards, so its samples are
 * `[x, 0, 0]` and the minimum is `0`. The median is `0` there too — this is the
 * mode the row's `attribution` and `stable: false` exist to report, and neither
 * reduction can rescue a measurement that was never taken.
 *
 * @param row - Any facet row publishing a total and its per-repeat samples
 * @returns The smallest repeat, in the row's own unit
 */
export function fastestRepeat(row: {
  readonly totalMs: number;
  readonly totalMsSamples: readonly number[];
}): number {
  return row.totalMsSamples.length === 0 ? row.totalMs : Math.min(...row.totalMsSamples);
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
  process.exitCode = ExitCode.ERROR;
}

/** Options Commander collects for `verdict run`. */
interface VerdictRunOptions {
  readonly subjects: string;
  readonly instrument: InstrumentSource;
  readonly out: string;
  readonly timeoutMs?: number;
  readonly env?: ArmEnvironment['set'];
  readonly unset?: readonly string[];
}

/** Options Commander collects for `verdict compare`. */
interface VerdictCompareCliOptions {
  readonly deltas: string;
  readonly control: boolean;
}

/**
 * Build the `verdict` facet's `run` and `compare`.
 *
 * Not built by {@link createFacetCommand}: that factory's shape is one subject,
 * repeats, a cache mode, one report per run and an `ab` over a per-command
 * estimate — none of which a verdict has. A verdict runs a SUBJECT SET once per
 * arm, writes one report per alias, and compares two capture directories
 * against a committed deltas file.
 *
 * @returns The configured command group
 */
function createVerdictCommand(): Command {
  const group = new Command('verdict').description(
    'Compare what two vat builds DECIDE — exit codes, findings, full documents — across a subject set',
  );

  group
    .command('run')
    .requiredOption('--subjects <file>', 'The local subjects file (alias → path, verbs, SQL files); never committed')
    .requiredOption(
      '--instrument <spec>',
      "Which vat to run: 'tree:<path>', 'dist:<path>' or 'npx:<pkg@version>'",
      parseInstrument,
    )
    .requiredOption(OUT_OPTION, 'Directory to write one report per alias into; outside every subject')
    .option('--timeout-ms <n>', 'Kill any one verb after this long', wholeNumberAtLeast('--timeout-ms', 1))
    .option('--env <KEY=VALUE>', 'Set a variable for every child of this arm (repeatable)', collectEnv('--env'))
    .option('--unset <KEY>', 'Remove an inherited variable from every child of this arm (repeatable)', collectUnset('--unset'))
    .description('Capture one arm: every verb of every subject, one report per alias')
    .action(async (options: VerdictRunOptions) => {
      const env = armEnvironment(options.env, options.unset, '--env and --unset');
      if (env === null) return;
      const loaded = loadVerdictSubjects(options.subjects);
      if (!loaded.ok) return refuse(loaded.refusal);
      const result = await captureVerdict({
        instrument: await resolveInstrument(options.instrument),
        subjects: loaded.subjects.subjects,
        subjectsDir: loaded.baseDir,
        env,
        outDir: safePath.resolve(options.out),
        capturedAt: new Date().toISOString(),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (!result.ok) return refuse(result.refusal);
      for (const envelope of result.envelopes) process.stdout.write(`${renderVerdictReport(envelope)}\n`);
      process.stdout.write(`Wrote ${result.written.join(', ')}\n`);
    });

  group
    .command('compare')
    .argument('<baselineDir>', "The baseline arm's `verdict run --out` directory")
    .argument('<candidateDir>', "The candidate arm's `verdict run --out` directory")
    .option('--deltas <file>', 'The committed expected-deltas file', COMMITTED_VERDICT_DELTAS)
    .option('--control', 'Both directories are the SAME instrument, on purpose', false)
    .description('Diff two arms and check the result both ways against the committed deltas')
    .action(async (baselineDir: string, candidateDir: string, options: VerdictCompareCliOptions) => {
      const deltas = loadVerdictDeltas(options.deltas);
      if (!deltas.ok) return refuse(deltas.refusal);
      const baseline = await readVerdictDirectory(baselineDir);
      if (!baseline.ok) return refuse(baseline.refusal);
      const candidate = await readVerdictDirectory(candidateDir);
      if (!candidate.ok) return refuse(candidate.refusal);
      const comparison = compareVerdict(baseline.value, candidate.value, {
        control: options.control,
        deltas: deltas.deltas,
        changelog: readChangelogSources(deltas.deltas, CHANGELOG_REFERENCE_ROOT),
      });
      if (!comparison.ok) return refuse(comparison.refusal);
      process.stdout.write(`${renderVerdictComparison(comparison)}\n`);
      if (comparison.exitCode !== ExitCode.OK) process.exitCode = comparison.exitCode;
    });

  return group;
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
        // The MINIMUM repeat, via the shared `fastestRepeat` — not the median
        // this row otherwise reports. A review finding, now fixed: the
        // one facet the mandatory-`estimate` contract was written to protect was
        // the facet violating it, and nothing caught it because `ab.test.ts`
        // supplies a STUB estimate — no test exercises any real one.
        //
        // Measured cost of the defect, first real `parse ab`, pair 1 arm A on
        // the primary adopter: samples [9381.952, 9085.774, 9258.195] → reported
        // 9258.195, min 9085.774. That is +172.4ms (1.9%), ~1.8x the 97.561ms
        // noise floor, injected into the number `ab` aggregated on every
        // capture. Numbers from `parse ab` runs before this change carry it.
        //
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
          rowEstimates(report.body.commands, 'ms parse (all kinds)', fastestRepeat),
      }),
    )
    .addCommand(
      createFacetCommand({
        name: 'crawl',
        summary:
          "Attribute the time vat spends FINDING documents, per contributor, stratum and fixpoint pass",
        runSummary: 'Capture a crawl-timing report for one project against one vat build',
        compareSummary: 'Diff two crawl-timing reports along a single axis',
        // Three repeats, so the middle one can be reported and the other two can
        // disagree with it. No warm-up is discarded — see `crawl/capture.ts`.
        defaultRuns: 3,
        // Warm, unlike `parse`. There is no cache in front of a crawl, so the
        // work happens on every repeat and the steady state is the honest one.
        defaultCache: 'warm',
        capture: captureCrawl,
        compare: compareCrawl,
        renderReport: renderCrawlReport,
        renderComparison: renderCrawlComparison,
        // The MINIMUM repeat, not the median — via the same `fastestRepeat` the
        // `parse` wiring uses, which is the point: these two facets report a
        // median row and must reduce it identically for `ab`, and stating the
        // rule twice is how they drifted apart the first time.
        estimate: (report) =>
          rowEstimates(report.body.commands, 'ms crawl (all strata)', fastestRepeat),
      }),
    )
    .addCommand(
      createFacetCommand({
        name: 'population',
        summary: 'Record WHICH files a vat command enumerated, and diff two populations as sets',
        runSummary: 'Capture a population report for one project against one vat build',
        compareSummary: 'Diff two population reports along a single axis',
        // Two repeats, which is the smallest number that can disagree. A
        // population is supposed to be deterministic, so more repeats buy
        // confidence in that rather than resolution in a statistic — and each
        // repeat is a whole corpus enumeration, which is not cheap.
        defaultRuns: 2,
        // Warm. There is no cache in front of the enumeration, and a set does
        // not move with one.
        defaultCache: 'warm',
        defaultCommands: POPULATION_MEASURED_COMMANDS,
        capture: (request) => Promise.resolve(capturePopulation(request)),
        compare: comparePopulation,
        renderReport: renderPopulationReport,
        renderComparison: renderPopulationComparison,
        // The file COUNT, and it is deliberately the weakest thing this facet
        // knows. `ab` compares exactly one number per command, and a population
        // has no number worth interleaving arms over — the evidence is the set,
        // which `compare` diffs exactly. The count is here because the contract
        // requires an estimate, and it is honest about what it can see: two
        // populations of equal size and different membership read as unchanged
        // through `ab` and as CHANGED through `compare`. Use `compare`.
        estimate: (report) => rowEstimates(report.body.commands, 'files', (row) => row.count),
      }),
    )
    .addCommand(createVerdictCommand());
}

// Run only when this is the invoked script, not merely imported. Without the
// guard, a test that imports `createProgram` for its own argv would also
// trigger this module's own `process.argv`-driven run as an import side effect.
//
// ⛔ NOT `import.meta.url === pathToFileURL(process.argv[1]).href`, which is
// what this used to be. This package declares a `vat-lab` bin, so the normal way
// to run it is through `node_modules/.bin/vat-lab` — a SYMLINK. `argv[1]` is
// then the link and `import.meta.url` the resolved target, the strings differ,
// and the guard is false: `vat-lab` prints nothing and exits 0. Measured on Node
// 22.14.0 and 24.13.1 alike.
if (isEntrypoint(import.meta.url)) {
  installLastResortExit();
  await createProgram().parseAsync(process.argv);
}
