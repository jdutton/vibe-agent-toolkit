/**
 * What a measurement facet is pointed at: the commands it can run, the default
 * set to run when the caller does not name their own, and — per command — which
 * exit codes mean the run finished its work.
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

/** What one vat command was asked to do. */
export interface MeasuredCommandSpec {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments after the vat binary, with `{subject}` substituted at capture time. */
  readonly args: readonly string[];
  /**
   * The exit codes that mean **this run finished its work**.
   *
   * Deliberately not "success". vat's exit codes are `0` success, `1` validation
   * findings, `2` system error (see `docs/architecture/cli.md` and
   * `statusFromExitCode` in the CLI's `phase-utils.ts`). A command that exits `1`
   * ran to completion and did every byte of the work being measured — it just
   * had something to report at the end of it. Refusing to time that made
   * `vat validate`, `vat verify` and `vat resources validate` unmeasurable on any
   * real project, because every real project has findings.
   *
   * Exit `2` is the opposite and is never listed here: the run did not complete,
   * so its duration is the duration of giving up. Timing that measures how fast
   * vat fails, and failures are fast enough to read as an improvement.
   *
   * Absent means {@link DEFAULT_COMPLETED_EXIT_CODES} — `[0]` alone. The default
   * stays narrow on purpose: a command whose author has not thought about which
   * of its exit codes denote a completed run must not silently start admitting
   * crashes into a median.
   *
   * Whatever is listed here, the codes a row's repeats actually produce must be
   * **uniform** — see `summarizeRepeatFailures` in `repeat.ts`.
   */
  readonly completedExitCodes?: readonly number[];
}

/**
 * What a spec means by "completed" when it does not say.
 *
 * `0` alone: the conservative reading, and the one that cannot turn a crash into
 * a data point without someone opting in.
 */
export const DEFAULT_COMPLETED_EXIT_CODES: readonly number[] = Object.freeze([0]);

/**
 * The codes accepted for a command whose findings are reported by exit code.
 *
 * `0` (nothing to report) and `1` (findings). Never `2` — that is vat's
 * system-error code, and a system error is a run that did not complete.
 */
const FINDINGS_COMPLETED_EXIT_CODES: readonly number[] = Object.freeze([0, 1]);

/**
 * Which exit codes denote a completed run for this command.
 *
 * One accessor rather than `spec.completedExitCodes ?? [0]` at each call site:
 * both measurement facets ask this question, and a facet that spelled the
 * default differently would measure a different population than its sibling
 * while producing an equally well-formed report.
 *
 * @param spec - The command being measured
 * @returns The accepted codes, defaulting to {@link DEFAULT_COMPLETED_EXIT_CODES}
 */
export function completedExitCodesOf(spec: MeasuredCommandSpec): readonly number[] {
  return spec.completedExitCodes ?? DEFAULT_COMPLETED_EXIT_CODES;
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
    args: Object.freeze(['resources', 'scan', '{subject}']),
    // Exits 0 whatever it finds — scanning reports statistics, not findings.
  }),
  'resources-population': Object.freeze({
    name: 'resources-population',
    // The same scan, asked for the whole file list in a format a consumer can
    // read without a YAML parser. Three flags, each load-bearing and none of
    // them a preference:
    //
    // - `--verbose` is what makes the command emit `files` at all. Without it
    //   the document carries `filesScanned` and no population, and a count
    //   compares byte-identically against any other run of the same size while
    //   knowing nothing about which files those were.
    // - `--format json` keeps the lab free of a YAML parser.
    //
    // Its own entry rather than flags added to `resources-scan`, because that
    // spec is what `perf` and `io` measure: widening it would change what every
    // stored timing and call count in this repo was taken over.
    args: Object.freeze(['resources', 'scan', '{subject}', '--verbose', '--format', 'json']),
    // Exits 0 whatever it finds — scanning reports statistics, not findings.
  }),
  'resources-query': Object.freeze({
    name: 'resources-query',
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
    // Exits 0 when the statement ran; 2 when it was refused or the crawl
    // failed, and a refusal measured nothing. So the default codes.
  }),
  'resources-validate': Object.freeze({
    name: 'resources-validate',
    args: Object.freeze(['resources', 'validate', '{subject}', '--format', 'json']),
    completedExitCodes: FINDINGS_COMPLETED_EXIT_CODES,
  }),
  audit: Object.freeze({
    name: 'audit',
    args: Object.freeze(['audit', '{subject}']),
    // Documented as "0 - Always (even when validation errors are surfaced)".
  }),
  inventory: Object.freeze({
    name: 'inventory',
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
    // No subject argument: `vat validate` REJECTS a positional path (exit 2) and
    // takes its scope from the config at the cwd, which the harness has already
    // set to the subject.
    args: Object.freeze(['validate']),
    completedExitCodes: FINDINGS_COMPLETED_EXIT_CODES,
  }),
  verify: Object.freeze({
    name: 'verify',
    // Also path-rejecting, for the same reason. Reads the built `dist/` tree, so
    // a subject measured with this one has to have been built first.
    args: Object.freeze(['verify']),
    completedExitCodes: FINDINGS_COMPLETED_EXIT_CODES,
  }),
  'claude-context-all': Object.freeze({
    name: 'claude-context-all',
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
    // takes the default codes and must never accept findings-style completion.
  }),
  'claude-context': Object.freeze({
    name: 'claude-context',
    // The single-path control arm for the sweep above. One path answered out of
    // the same enumeration the sweep pays for, so the pair separates what the
    // population costs from what each answer costs: a fix that halves the sweep
    // while leaving this one unmoved shaved per-answer work, and one that moves
    // both shaved the crawl. Neither arm can distinguish those alone.
    args: Object.freeze(['claude', 'context', '{subject}']),
    // Same exit-code contract as the sweep — see the entry above.
  }),
  'claude-budget': Object.freeze({
    name: 'claude-budget',
    // No subject argument, and not as a convenience: `vat claude budget` REJECTS
    // (exit 2) a path that resolves outside the root it discovered, so a
    // positional pointing at the subject fails from anywhere else. Its scope
    // comes from the cwd, which the harness has already set to the subject.
    //
    // Here because it was the largest hole in this registry. It shares
    // `vat claude context`'s lane, route and population exactly — both reach
    // `buildClaudeContextPopulation`, both take two `populate()` passes and one
    // crawl (`docs/contributing/command-lane-table.md`) — but it asks a
    // different question of that population: `context` answers for the paths
    // named, while this sweeps EVERY working location through
    // `sweepAlwaysLoadedBudgets()`. So the per-answer half of its cost grows
    // with the number of regions in the tree rather than with the argument, and
    // the `claude-context` pair could not see that half at all: both of its arms
    // hold the query count fixed.
    args: Object.freeze(['claude', 'budget']),
    // Exits 1 when a chain is over budget and 0 when none is — a gate, so both
    // codes are a run that swept the whole tree.
    completedExitCodes: FINDINGS_COMPLETED_EXIT_CODES,
  }),
  'skills-validate': Object.freeze({
    name: 'skills-validate',
    // The `registry-md-html` lane's cheapest read-only entry point. Everything
    // else that builds that registry — `skills build`, `skills package`,
    // `claude plugin build`, `agent build`, `skill test run` — writes output, so
    // this is the one command that exercises the second registry builder without
    // a build target to prepare or a tree to dirty. `audit` and `verify` reach
    // the same lane but each bundle other work on top of it.
    args: Object.freeze(['skills', 'validate', '{subject}']),
    completedExitCodes: FINDINGS_COMPLETED_EXIT_CODES,
  }),
  'skills-list': Object.freeze({
    name: 'skills-list',
    // The cheapest enumerating verb there is: one crawl, no validation, no
    // parse. That is the point of measuring it — it is the closest thing the
    // registry has to a control for the crawl itself, so a change that moves
    // this row moved enumeration rather than anything downstream of it.
    args: Object.freeze(['skills', 'list', '{subject}']),
    // Listing reports what it found and exits 0 whatever that is.
  }),
}) satisfies Readonly<Record<string, MeasuredCommandSpec>>;

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
