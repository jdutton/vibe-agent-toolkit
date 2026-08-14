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
