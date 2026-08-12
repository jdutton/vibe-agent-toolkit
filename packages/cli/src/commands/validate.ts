/**
 * `vat validate` — top-level validation orchestration
 *
 * Runs every validator the project's config declares — and only those — so a
 * single command covers all configured surfaces and cannot drift out of
 * coverage the way a hand-composed `resources validate && skills validate`
 * script does.
 *
 * Config-driven: a surface is validated only when its block is present in
 * vibe-agent-toolkit.config.yaml. A project with no `skills:` block simply
 * does not run skill validation — no error, no noise.
 *
 * Distinct from `vat verify`, which validates the *built* dist artifacts
 * (marketplace tree, files-config dests, distribution consistency). `vat
 * validate` runs the source-level validators only and never requires a build.
 *
 * DECISION (revisitable): `vat validate` deliberately covers source-level
 * surfaces only (resources, skills) and excludes marketplace-artifact
 * validation. Marketplace validation runs against the built dist tree, which
 * would couple `vat validate` to a prior `vat build` and overlap `vat verify`.
 * Keeping it build-free makes `vat validate` safe for pre-commit / CI-before-
 * build. If a single "validate the whole shippable thing" command is later
 * wanted, fold the marketplace phase in here (mirror verify.ts) — see #128.
 */

import { type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import {
  addRetiredOnlyOption,
  aggregatePhaseIssueCounts,
  aggregatePhaseStatus,
  applyPhaseSelection,
  decidePhaseSelection,
  exitCodeForPhases,
  rejectRetiredOnly,
  resolveBinPath,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { rejectPositionalArguments } from './positional-args.js';

/** Surfaces `vat validate` knows how to run, in stable execution order. */
const VALID_SURFACES = ['resources', 'skills'] as const;

const VALIDATE_VOCABULARY: PhaseVocabulary = {
  noun: 'Surface',
  verb: 'validate',
  validNames: VALID_SURFACES,
  noop: {
    // A bare run with nothing configured is a clean no-op (exit 0, per issue
    // #128's "doesn't check what it doesn't know about") — but silent success
    // on stdout alone is indistinguishable, to anyone watching only the exit
    // code, from a run that actually validated something. Warn on stderr so a
    // config typo (e.g. `recources:`) doesn't masquerade as "all good."
    warning:
      'No resources: or skills: block found in vibe-agent-toolkit.config.yaml — nothing to validate. If this is unexpected, check your config.',
    note: 'No configured validators (no resources or skills block in vibe-agent-toolkit.config.yaml).',
  },
};

export interface ValidateCommandOptions {
  /** Retired; declared only so {@link rejectRetiredOnly} can explain the removal. */
  only?: string;
  debug?: boolean;
  verbose?: boolean;
}

/**
 * Measured full-run duration on the 90-skill / 1,041-document adopter, cited by
 * the retired-`--only` message: resources 13.9s + skills 19.3s.
 */
const VALIDATE_FULL_RUN_SECONDS = 35;

/** How this command names itself in every user-facing diagnostic. */
const COMMAND_NAME = 'vat validate';

export function createValidateTopLevelCommand(): Command {
  const command = new Command('validate');

  addRetiredOnlyOption(command)
    .description('Validate configured surfaces from source (resources + skills) — no build required')
    .option('--debug', 'Enable debug logging')
    .option('-v, --verbose', 'Show every finding, not just the collapsed counts')
    .action(validateTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Runs the source-level validators (resources, skills) the project's config
  declares — and only those. A surface whose config block is absent is skipped
  (a project with no skills block does not run skill validation; no error, no
  noise, but a stderr warning if nothing at all is configured).

  A run is a WHOLE run: '--only' was removed (a full run is ~35s, and the flag
  let a renamed config key silently drop a CI gate's coverage). 'vat build'
  keeps its '--only', where a phase costs minutes rather than seconds.

  Source-level only. Unlike 'vat verify', this never inspects built dist
  artifacts and never requires a build.

  Surfaces (run in this order):
    resources  → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills     → SKILL.md frontmatter and packaging validation (when 'skills:' configured)

Output:
  ONE YAML document → stdout
    per surface: status (success | warning | error | system-error) plus the
    child's exitCode, signal, or spawn error — a surface that could not run is
    never reported as a surface that failed validation. The validator's own
    report is captured and nested under 'report', so the whole run stays a
    single parseable document ('vat validate | jq' works). A surface's status
    comes from the validator's REPORTED status, not from its exit code — an
    exit code cannot express 'warning'.
  Progress and validation errors → stderr (streamed live)

Exit Codes:
  0 - All configured validators passed (or nothing configured to validate)
  1 - Validation errors found, or the retired '--only' flag was passed
  2 - System error (this command's own, or propagated from a validator that
      could not run: exited 2, was killed by a signal, was never spawned, or
      wrote output that could not be parsed), or a usage error such as passing
      a path

Arguments:
  None. Scope comes from vibe-agent-toolkit.config.yaml, never from the command
  line — a path argument is rejected (exit 2) rather than discarded. For a
  path-scoped run use 'vat resources validate <path>' for resources, or
  'vat skill review <path>' for a single skill.

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      used to discover which surfaces to validate

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat validate                       # Validate every configured surface
`
    );

  return command;
}

/**
 * Decide which validation surfaces to run.
 *
 * A surface is included only when its config block is present, so coverage is
 * discovered rather than hand-composed — and with `--only` retired, config
 * presence is now the ONLY input. There is no longer a way for a caller to
 * narrow the run, so there is no longer a way for a CI gate to ask for coverage
 * it cannot get; the class of silent-coverage-loss bug the `--only` failure arms
 * existed to catch is now unreachable by construction rather than guarded.
 *
 * `only` is still passed to {@link decidePhaseSelection} as `undefined`: that
 * helper is shared with `vat build`, which keeps its own `--only`.
 */
export function selectValidateSurfaces(
  config: ProjectConfig | undefined,
  verbose = false,
): PhaseSelection {
  // Forwarded to every surface, exactly as `vat verify` forwards its own. Both
  // child validators already accept `-v, --verbose`; only this command lacked
  // the flag, which made the collapsed warning/info detail unreachable HERE
  // while the same findings were one `vat skills validate` away.
  const detail = verbose ? ['--verbose'] : [];
  const phases: Phase[] = [];

  if (config?.resources) {
    phases.push({ name: 'resources', args: ['resources', 'validate', ...detail] });
  }

  if (config?.skills) {
    phases.push({ name: 'skills', args: ['skills', 'validate', ...detail] });
  }

  return decidePhaseSelection(undefined, phases, VALIDATE_VOCABULARY);
}

async function validateTopLevelCommand(
  options: ValidateCommandOptions,
  command: Command,
): Promise<void> {
  // First, and before requireProjectRoot: `vat validate docs/` used to be
  // accepted, have its path discarded, run wide over every configured surface
  // and report success. Nothing below can un-tell that lie, so the run ends
  // here. (`vat resources validate <path>` is the path-taking form.)
  rejectPositionalArguments(
    command.args,
    COMMAND_NAME,
    'validates every source surface vibe-agent-toolkit.config.yaml declares',
  );

  // Before requireProjectRoot: a retired flag is a usage error, and answering it
  // with "no vibe-agent-toolkit.config.yaml found" would diagnose the wrong
  // problem for anyone running the old invocation outside a project.
  rejectRetiredOnly(options.only, COMMAND_NAME, VALIDATE_FULL_RUN_SECONDS);

  // requireProjectRoot returns the discovered root; read config from there so a
  // subdirectory invocation doesn't load an empty config and falsely pass.
  const projectRoot = requireProjectRoot(process.cwd(), COMMAND_NAME);

  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const phases = applyPhaseSelection(
      selectValidateSurfaces(loadConfig(projectRoot), options.verbose === true),
      logger,
      startTime,
    );

    logger.info(`✅ vat validate (surfaces: ${phases.map((p) => p.name).join(' → ')})`);

    const binPath = resolveBinPath();
    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Surface: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    // A surface whose validator could not RUN (exit 2, killed, never spawned)
    // is not a surface that failed validation: it exits 2, so a CI gate can
    // tell a broken config from a broken link.
    // `issueCounts` beside `status` because a status alone cannot express a
    // three-valued distribution, and this document published none at all: a
    // consumer that wanted "did anything need acting on" had to either trust a
    // bare `status` or hand-sum the phases. `status: warning` on a warnings-only
    // repo is correct and deliberate — `success` means "nothing to act on", not
    // "nothing to see" — so gate on `issueCounts.errors` or the exit code, both
    // of which stay 0 through any number of warnings.
    writeYamlOutput({
      status: aggregatePhaseStatus(phaseResults),
      issueCounts: aggregatePhaseIssueCounts(phaseResults),
      phases: phaseResults,
      duration: `${Date.now() - startTime}ms`,
    });

    process.exit(exitCodeForPhases(phaseResults));
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validate');
  }
}
