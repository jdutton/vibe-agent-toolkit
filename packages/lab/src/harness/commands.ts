/**
 * What a measurement facet is pointed at: the commands it can run, the default
 * set to run when the caller does not name their own, and — per command — the
 * exits that mean it did its work ({@link ExitCommitment}).
 *
 * This lives in the harness rather than in a facet for the same reason
 * `schemas.ts` does. `perf` and `io` do not merely happen to measure the same
 * three vat commands — they have to, or their reports describe different work
 * and holding one beside the other is meaningless. Two per-facet copies would be
 * free to drift the moment one of them gained a fourth command or changed an
 * argument, and the drift would be invisible: both reports would still be
 * well-formed, still name their commands, and still disagree about what was
 * measured.
 *
 * It is also the only way `io` can have defaults at all without importing
 * `perf`, which the facet contract forbids — see
 * [Facets](../../docs/facets.md).
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';

import type { ProvenanceReader } from './provenance.js';

/**
 * The exit a step must make for a repetition to count — the ONE type every
 * facet judges a step's exit by, recorded in every report.
 *
 * - `exact` — one committed code. What `perf arms` uses for every step (0
 *   unless `--expect-exit` says otherwise: a CI step has one committed
 *   outcome), and what `--expect-exit <command>=<code>` makes a command of
 *   `run`/`ab`.
 * - `observed` — a single-command facet's default: any code the command
 *   declares as a completed run (`0`, or `0` and `1` for a verb that reports
 *   findings by exit), provided every repetition exits the SAME one
 *   (`summarizeRepeatFailures`): a set where one repeat exited 0 and another 1
 *   did two different amounts of work. The code it observed is recorded.
 *
 * Exit `2` is never either: the run did not complete, and timing it times how
 * fast vat gives up.
 */
export type ExitCommitment =
  | { readonly kind: 'exact'; readonly code: number }
  | { readonly kind: 'observed'; readonly completed: readonly number[] };

/** The largest code a process can exit with: no commitment names one above it. */
export const MAX_EXIT_CODE = 255;

/** A command that completes only clean: exit 0 whatever it found. */
const COMPLETES_CLEAN: ExitCommitment = Object.freeze({ kind: 'observed', completed: Object.freeze([ExitCode.OK]) });

/** A gate: exit 0 with nothing to report, 1 with findings — both a run that did all its work. */
const COMPLETES_WITH_FINDINGS: ExitCommitment = Object.freeze({
  kind: 'observed',
  completed: Object.freeze([ExitCode.OK, ExitCode.FINDINGS]),
});

/**
 * @param code - The one committed code
 * @returns The `exact` commitment to it
 */
export function exactExit(code: number): ExitCommitment {
  return { kind: 'exact', code };
}

/**
 * Whether one step's exit keeps its repetition a measurement. Uniformity across
 * repetitions is judged separately (`summarizeRepeatFailures`).
 *
 * @param commitment - The step's commitment
 * @param exit - The code it exited
 * @returns Why it does not, or `null`
 */
export function exitCommitmentViolation(commitment: ExitCommitment, exit: number): string | null {
  const admitted = commitment.kind === 'exact' ? exit === commitment.code : commitment.completed.includes(exit);
  // 2 is refused before anything runs (`assertCommittedExits`), so it is never admitted here.
  return admitted ? null : `exited ${String(exit)}, not ${describeExitCommitment(commitment)}`;
}

/**
 * @param commitment - A commitment
 * @returns How a report and a message spell it: `exactly N`, or `one of N, M`
 */
function describeExitCommitment(commitment: ExitCommitment): string {
  return commitment.kind === 'exact' ? `exactly ${String(commitment.code)}` : `one of ${commitment.completed.join(', ')}`;
}

/** What one vat command was asked to do. */
export interface MeasuredCommandSpec {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments after the vat binary, with `{subject}` substituted at capture time. */
  readonly args: readonly string[];
  /** What exit this command must make for a repetition to be a measurement — see {@link ExitCommitment}. */
  readonly exit: ExitCommitment;
  /**
   * Which document reader this command's stdout goes through for the warm rule
   * (`provenance.ts`): `none` for a verb that publishes no population.
   */
  readonly provenance: ProvenanceReader;
  /**
   * Whether this command populates a projection, so a cold run of it as the first
   * step (the cold rule) or a priming run (the warm rule) is checked for what the
   * ARM's environment says it writes (`populationExpectation`: no store under
   * `VAT_PROJECTION_STORE=off`, nothing under `VAT_CACHE=0`). `false` asserts
   * nothing — say `true` only for a verb known to populate on every build it is
   * measured with.
   */
  readonly populates: boolean;
}

/** A named sequence of measured commands, run in order as one repetition (CI's `&&` chain). */
export interface MeasuredSequenceSpec {
  readonly name: string;
  readonly steps: readonly MeasuredCommandSpec[];
}


/**
 * Every vat command the lab knows how to measure, by name.
 *
 * The registry exists because `DEFAULT_MEASURED_COMMANDS` has always claimed
 * "not a closed set — a caller measuring something else passes its own specs",
 * and that was true of the library and false of the instrument as shipped: the
 * `vat-lab` CLI hard-wired the defaults and offered no way to name anything
 * else. `--command <name>` selects from here.
 *
 * A superset of the defaults, not a replacement for them: adding an entry here
 * changes what a caller *can* ask for and nothing about what a bare run
 * measures.
 */
export const MEASURABLE_COMMANDS = Object.freeze({
  'resources-scan': Object.freeze({
    name: 'resources-scan',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    args: Object.freeze(['resources', 'scan', '{subject}']),
    // Exit 1 is only the refusal for a scan of NOTHING — no measurement — so `[0]`.
  }),
  'resources-population': Object.freeze({
    name: 'resources-population',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    // The same scan, asked for the whole file list in a format a consumer can
    // read without a YAML parser. Three flags, each load-bearing and none of
    // them a preference:
    //
    // - `--verbose` is what makes the command emit `data.files` at all. Without
    //   it the document carries `examined` and no population, and a count
    //   compares byte-identically against any other run of the same size while
    //   knowing nothing about which files those were.
    // - `--format json` keeps the lab free of a YAML parser.
    //
    // Its own entry rather than flags added to `resources-scan`, because that
    // spec is what `perf` and `io` measure: widening it would change what every
    // stored timing and call count in this repo was taken over.
    args: Object.freeze(['resources', 'scan', '{subject}', '--verbose', '--format', 'json']),
    // Exit 1 scanned nothing, so there is no population; never a committed exit.
  }),
  'resources-query': Object.freeze({
    name: 'resources-query',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    // The ONLY entry whose own output names which population arm the run took
    // (`population: derived | store`) and what that arm cost
    // (`populationSecs`). Every other entry is silent about it, so an A/B
    // varying `VAT_PROJECTION_STORE` can only be confirmed from a `crawl`
    // dump's `projection-store:read` / `projection-store:write` charges — this
    // one says it in the document itself.
    //
    // The statement is deliberately trivial. `resources query` is populate +
    // one SQL, so with a counting query essentially all of its wall time IS the
    // population, which is the quantity a projection store exists to move. A
    // heavier statement would dilute exactly the signal this entry is for.
    args: Object.freeze([
      'resources',
      'query',
      'SELECT count(*) AS members FROM resource_realizations',
      '{subject}',
      '--format',
      'json',
    ]),
    // Exits 0 over a populated tree whatever it selected; 1 (empty population)
    // and 2 (refused) measured no population, so never a committed exit.
  }),
  'resources-validate': Object.freeze({
    name: 'resources-validate',
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    // The same verb as `resources-validate-ci`: it writes the projection whatever its argv.
    populates: true,
    args: Object.freeze(['resources', 'validate', '{subject}', '--format', 'json']),
  }),
  audit: Object.freeze({
    name: 'audit',
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    populates: false,
    args: Object.freeze(['audit', '{subject}']),
    // Exits 1 over `status: error` like every other gate.
  }),
  inventory: Object.freeze({
    name: 'inventory',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    args: Object.freeze(['inventory', '{subject}']),
    // Structural extraction: reports what it found and exits 0 whatever that is.
    //
    // Here because it is the ONLY verb whose link walk is membership-only, which
    // makes it the one place both crawlers can be run over the same subject and
    // compared. With `VAT_INVENTORY_CRAWL=projection` in the environment its
    // membership comes from `populate()` instead of `walkLinkGraph`, so a `crawl`
    // dump taken with and without that variable is the first side-by-side reading
    // the two lanes have ever had. Not in the defaults — a bare run's command set
    // is unchanged; a caller has to ask for this one.
  }),
  validate: Object.freeze({
    name: 'validate',
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    // The same verb as `validate-ci`: its resources phase writes the projection.
    populates: true,
    // No subject argument: `vat validate` REJECTS a positional path (exit 2) and
    // takes its scope from the config at the cwd, which the harness has already
    // set to the subject.
    args: Object.freeze(['validate']),
  }),
  verify: Object.freeze({
    name: 'verify',
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    populates: false,
    // Also path-rejecting, for the same reason. Reads the built `dist/` tree, so
    // a subject measured with this one has to have been built first.
    args: Object.freeze(['verify']),
  }),
  'claude-context-all': Object.freeze({
    name: 'claude-context-all',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    // No subject argument: `--all` sweeps every path the projection realized and
    // takes no positional, so like `validate` and `verify` its scope comes from
    // the cwd, which the harness has already set to the subject.
    //
    // Here because the sweep was measured at 561 seconds on a large adopter
    // tree and nothing in this instrument could see it, which made every claim
    // about a fix unfalsifiable. Its per-answer cost scales with the size of the
    // projection rather than with the query, so this arm alone cannot say
    // whether a change moved the population cost or the per-answer cost —
    // `claude-context` is the other half of that reading.
    args: Object.freeze(['claude', 'context', '--all']),
    // Documented as "0 - An answer was produced (there is no threshold and no
    // gate)". Its `1` is invalid usage — a run that measured nothing — so this
    // commits to 0 and a caller must never commit it to 1.
  }),
  'claude-context': Object.freeze({
    name: 'claude-context',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    // The single-path control arm for the sweep above. One path answered out of
    // the same enumeration the sweep pays for, so the pair separates what the
    // population costs from what each answer costs: a fix that halves the sweep
    // while leaving this one unmoved shaved per-answer work, and one that moves
    // both shaved the crawl. Neither arm can distinguish those alone.
    args: Object.freeze(['claude', 'context', '{subject}']),
    // Same exit-code contract as the sweep — see the entry above.
  }),
  'skills-validate': Object.freeze({
    name: 'skills-validate',
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    populates: false,
    // The `registry-md-html` lane's cheapest read-only entry point. Everything
    // else that builds that registry — `skills build`, `skills package`,
    // `claude plugin build`, `agent build`, `skill test run` — writes output, so
    // this is the one command that exercises the second registry builder without
    // a build target to prepare or a tree to dirty. `audit` and `verify` reach
    // the same lane but each bundle other work on top of it.
    args: Object.freeze(['skills', 'validate', '{subject}']),
  }),
  'skills-list': Object.freeze({
    name: 'skills-list',
    provenance: 'none',
    exit: COMPLETES_CLEAN,
    populates: false,
    // The cheapest enumerating verb there is: one crawl, no validation, no
    // parse. That is the point of measuring it — it is the closest thing the
    // registry has to a control for the crawl itself, so a change that moves
    // this row moved enumeration rather than anything downstream of it.
    args: Object.freeze(['skills', 'list', '{subject}']),
    // Listing reports what it found and exits 0 whatever that is.
  }),
  // ─── Commands exactly as CI runs them ────────────────────────────────────
  // cwd is the subject root and there is NO subject path, no `--format`, no
  // `--verbose`: the argv a CI job types. Each declares its verb's completed
  // exits; `perf arms` commits every step of a sequence to exit 0 (`exact`)
  // unless `--expect-exit` says otherwise — a clean subject is the committed
  // state, so a findings exit fails the measurement rather than timing a run
  // that did different work than CI's.
  'resources-validate-ci': Object.freeze({
    name: 'resources-validate-ci',
    args: Object.freeze(['resources', 'validate']),
    // Today's builds publish no population on `resources validate`.
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    populates: true,
  }),
  'resources-check-ci': Object.freeze({
    name: 'resources-check-ci',
    args: Object.freeze(['resources', 'check']),
    // `data.population` — the field that proves arm B's baseline is warm.
    provenance: 'resources-check',
    exit: COMPLETES_WITH_FINDINGS,
    populates: true,
  }),
  'skills-validate-ci': Object.freeze({
    name: 'skills-validate-ci',
    args: Object.freeze(['skills', 'validate']),
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    // Never a first step in a CI sequence; nothing is asserted after it.
    populates: false,
  }),
  'validate-ci': Object.freeze({
    name: 'validate-ci',
    args: Object.freeze(['validate']),
    // The orchestrator document: the resources phase's population, and the
    // checks phase's population and lensPopulation.
    provenance: 'validate',
    exit: COMPLETES_WITH_FINDINGS,
    populates: true,
  }),
  'verify-ci': Object.freeze({
    name: 'verify-ci',
    // Reads a built `dist/`: the subject must have been built first.
    args: Object.freeze(['verify']),
    provenance: 'none',
    exit: COMPLETES_WITH_FINDINGS,
    populates: false,
  }),
}) satisfies Readonly<Record<string, MeasuredCommandSpec>>;

/**
 * The CI sequences the timed arms replay, by name: each is one repetition,
 * steps in order, every step timed.
 *
 * - `ci-a` — today's CI: `resources validate` → `skills validate`.
 * - `ci-b` — today's CI plus the checks (equal coverage): `resources validate`
 *   → `resources check` → `skills validate`.
 * - `ci-c` — the single run: `validate`.
 */
export const MEASURABLE_SEQUENCES = Object.freeze({
  'ci-a': Object.freeze({
    name: 'ci-a',
    steps: Object.freeze([MEASURABLE_COMMANDS['resources-validate-ci'], MEASURABLE_COMMANDS['skills-validate-ci']]),
  }),
  'ci-b': Object.freeze({
    name: 'ci-b',
    steps: Object.freeze([
      MEASURABLE_COMMANDS['resources-validate-ci'],
      MEASURABLE_COMMANDS['resources-check-ci'],
      MEASURABLE_COMMANDS['skills-validate-ci'],
    ]),
  }),
  'ci-c': Object.freeze({ name: 'ci-c', steps: Object.freeze([MEASURABLE_COMMANDS['validate-ci']]) }),
}) satisfies Readonly<Record<string, MeasuredSequenceSpec>>;

/**
 * Look one measurable sequence up by name.
 *
 * @param name - A key of {@link MEASURABLE_SEQUENCES}
 * @returns The sequence, or `undefined` when nothing answers to that name
 */
export function measurableSequence(name: string): MeasuredSequenceSpec | undefined {
  const registry: Readonly<Record<string, MeasuredSequenceSpec>> = MEASURABLE_SEQUENCES;
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/** Every name {@link MEASURABLE_COMMANDS} answers to, for help text and errors. */
export const MEASURABLE_COMMAND_NAMES: readonly string[] = Object.freeze(
  Object.keys(MEASURABLE_COMMANDS),
);

/**
 * Look one measurable command up by name.
 *
 * @param name - A key of {@link MEASURABLE_COMMANDS}
 * @returns The spec, or `undefined` when nothing answers to that name
 */
export function measurableCommand(name: string): MeasuredCommandSpec | undefined {
  const registry: Readonly<Record<string, MeasuredCommandSpec>> = MEASURABLE_COMMANDS;
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/**
 * The vat commands measured when the caller does not name their own.
 *
 * These three are the corpus-enumerating verbs — the ones whose cost scales
 * with the size of the project rather than with the size of their arguments,
 * and therefore the ones where a regression actually hurts. They deliberately
 * mirror the set vat's own QA instrument spawns, so a perf report, an io report
 * and a correctness snapshot are all talking about the same commands.
 *
 * Not a closed set. A caller measuring something else passes its own specs (the
 * CLI's `--command` names one from {@link MEASURABLE_COMMANDS}); this is the
 * default, not the definition.
 *
 * **Membership and order are frozen in every sense.** Changing either would
 * silently change what every already-stored report measured, so the registry
 * grows and this selection does not.
 */
export const DEFAULT_MEASURED_COMMANDS: readonly MeasuredCommandSpec[] = Object.freeze([
  MEASURABLE_COMMANDS['resources-scan'],
  MEASURABLE_COMMANDS['resources-validate'],
  MEASURABLE_COMMANDS.audit,
]);

/**
 * The commands whose output carries a population.
 *
 * The `population` facet's default set, and it is a different set rather than a
 * subset of a preference: two of the three defaults above emit no file list at
 * all, so a bare `population run` over {@link DEFAULT_MEASURED_COMMANDS} would
 * produce one measured row and two refusals every time. A facet whose
 * out-of-the-box output is two thirds noise teaches people to skim past the
 * third.
 */
export const POPULATION_MEASURED_COMMANDS: readonly MeasuredCommandSpec[] = Object.freeze([
  MEASURABLE_COMMANDS['resources-population'],
]);
