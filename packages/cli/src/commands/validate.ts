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
  aggregatePhaseStatus,
  applyPhaseSelection,
  decidePhaseSelection,
  exitCodeForPhases,
  resolveBinPath,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';

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
  only?: string;
  debug?: boolean;
}

export function createValidateTopLevelCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate configured surfaces from source (resources + skills) — no build required')
    .option('--only <surface>', 'Validate only a specific surface: resources, skills')
    .option('--debug', 'Enable debug logging')
    .action(validateTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Runs the source-level validators (resources, skills) the project's config
  declares — and only those. A surface whose config block is absent is skipped
  (a project with no skills block does not run skill validation; no error, no
  noise, but a stderr warning if nothing at all is configured). An explicit
  '--only <surface>' fails for a surface that is unrecognized or unconfigured,
  so a CI gate cannot silently lose coverage.

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
  1 - Validation errors found, or --only named a surface that is unrecognized or unconfigured
  2 - System error (this command's own, or propagated from a validator that
      could not run: exited 2, was killed by a signal, was never spawned, or
      wrote output that could not be parsed)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      used to discover which surfaces to validate

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat validate                       # Validate every configured surface
  $ vat validate --only skills         # Validate skills only
`
    );

  return command;
}

/**
 * Decide which validation surfaces to run.
 *
 * A surface is included only when its config block is present, so coverage is
 * discovered rather than hand-composed. An explicit `--only` naming a surface
 * that is unrecognized OR recognized-but-unconfigured is a failure (exit 1),
 * not a silent pass: a CI gate that asked for coverage it cannot get must not
 * stay green.
 */
export function selectValidateSurfaces(
  only: string | undefined,
  config: ProjectConfig | undefined,
): PhaseSelection {
  const phases: Phase[] = [];

  if ((!only || only === 'resources') && config?.resources) {
    phases.push({ name: 'resources', args: ['resources', 'validate'] });
  }

  if ((!only || only === 'skills') && config?.skills) {
    phases.push({ name: 'skills', args: ['skills', 'validate'] });
  }

  return decidePhaseSelection(only, phases, VALIDATE_VOCABULARY);
}

async function validateTopLevelCommand(options: ValidateCommandOptions): Promise<void> {
  // requireProjectRoot returns the discovered root; read config from there so a
  // subdirectory invocation doesn't load an empty config and falsely pass.
  const projectRoot = requireProjectRoot(process.cwd(), 'vat validate');

  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const phases = applyPhaseSelection(
      selectValidateSurfaces(options.only, loadConfig(projectRoot)),
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
    writeYamlOutput({
      status: aggregatePhaseStatus(phaseResults),
      phases: phaseResults,
      duration: `${Date.now() - startTime}ms`,
    });

    process.exit(exitCodeForPhases(phaseResults));
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validate');
  }
}
