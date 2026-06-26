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

import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import { resolveBinPath, runPhase, type Phase, type PhaseResult } from './phase-utils.js';

/** Surfaces `vat validate` knows how to run, in stable execution order. */
const VALID_SURFACES = ['resources', 'skills'] as const;

export interface ValidateCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createValidateTopLevelCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate every configured surface (resources, skills, …) discovered from config')
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
  noise). An explicit '--only <surface>' for an unconfigured surface fails, so
  a CI gate cannot silently lose coverage.

  Source-level only. Unlike 'vat verify', this never inspects built dist
  artifacts and never requires a build.

  Surfaces (run in this order):
    resources  → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills     → SKILL.md frontmatter and packaging validation (when 'skills:' configured)

Output:
  YAML summary for each surface → stdout
  Validation errors → stderr

Exit Codes:
  0 - All configured validators passed (or nothing configured to validate)
  1 - Validation errors found
  2 - System error

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
 * Build the ordered list of validation phases from the project's config.
 * A surface is included only when its config block is present, so coverage is
 * discovered rather than hand-composed. Config is read from the resolved
 * project root (not the invocation cwd) so a run from a subdirectory still
 * discovers the project's surfaces instead of silently finding nothing.
 */
function buildPhaseList(only: string | undefined, projectRoot: string): Phase[] {
  const config = loadConfig(projectRoot);
  const phases: Phase[] = [];

  if ((!only || only === 'resources') && config?.resources) {
    phases.push({ name: 'resources', args: ['resources', 'validate'] });
  }

  if ((!only || only === 'skills') && config?.skills) {
    phases.push({ name: 'skills', args: ['skills', 'validate'] });
  }

  return phases;
}

async function validateTopLevelCommand(options: ValidateCommandOptions): Promise<void> {
  // requireProjectRoot returns the discovered root; read config from there so a
  // subdirectory invocation doesn't load an empty config and falsely pass.
  const projectRoot = requireProjectRoot(process.cwd(), 'vat validate');

  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    if (options.only && !VALID_SURFACES.includes(options.only as (typeof VALID_SURFACES)[number])) {
      throw new Error(`Unknown surface: ${options.only}. Valid surfaces: ${VALID_SURFACES.join(', ')}`);
    }

    const phases = buildPhaseList(options.only, projectRoot);

    if (phases.length === 0) {
      // An explicit `--only <surface>` that isn't configured is a failure: the
      // caller asked for a specific validator that can't run, so a CI gate must
      // not stay green. A bare run with nothing configured is a clean no-op.
      if (options.only) {
        logger.error(`Surface '${options.only}' is not configured in vibe-agent-toolkit.config.yaml — nothing to validate.`);
        writeYamlOutput({
          status: 'error',
          phases: [],
          error: `Surface '${options.only}' is not configured in vibe-agent-toolkit.config.yaml`,
          duration: `${Date.now() - startTime}ms`,
        });
        process.exit(1);
      }

      writeYamlOutput({
        status: 'success',
        phases: [],
        note: 'No configured validators (no resources or skills block in vibe-agent-toolkit.config.yaml).',
        duration: `${Date.now() - startTime}ms`,
      });
      process.exit(0);
    }

    logger.info(`✅ vat validate (surfaces: ${phases.map((p) => p.name).join(' → ')})`);

    const binPath = resolveBinPath();
    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Surface: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    const hasErrors = phaseResults.some((r) => r.status === 'failed');

    writeYamlOutput({
      status: hasErrors ? 'error' : 'success',
      phases: phaseResults,
      duration: `${Date.now() - startTime}ms`,
    });

    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Validate');
  }
}
