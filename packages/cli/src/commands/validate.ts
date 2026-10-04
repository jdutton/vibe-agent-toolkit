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
 * does not run skill validation; one that configures nothing at all examines
 * nothing, and the writer refuses that run.
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
 * wanted, fold the marketplace phase in here (mirror verify.ts).
 */

import { type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { loadConfig } from '../utils/config-loader.js';
import { endWithReport } from '../utils/document-writer.js';
import { createLogger } from '../utils/logger.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';
import { withPopulationCache } from '../utils/projection-store.js';

import {
  addRetiredOnlyOption,
  applyPhaseSelection,
  decidePhaseSelection,
  orchestrate,
  ORCHESTRATOR_FORMAT,
  rejectRetiredOnly,
  runPhase,
  type Phase,
  type PhaseResult,
  type PhaseSelection,
  type PhaseVocabulary,
} from './phase-utils.js';
import { rejectPositionalArguments } from './positional-args.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from './resources/validate-schema.js';
import { runResourcesValidatePhase } from './resources/validate.js';
import { SKILLS_VALIDATE_REPORT_SCHEMA } from './skills/validate-schema.js';
import { runSkillsValidatePhase } from './skills/validate.js';

/** Surfaces `vat validate` knows how to run, in stable execution order. */
const VALID_SURFACES = ['resources', 'skills'] as const;

const VALIDATE_VOCABULARY: PhaseVocabulary = {
  noun: 'Surface',
  verb: 'validate',
  validNames: VALID_SURFACES,
  noop: {
    // A bare run with nothing configured examines nothing, which the writer
    // refuses (exit 1): a gate that checked nothing is not a pass. The stderr
    // warning names the likely cause, a config typo such as `recources:`.
    warning:
      'No resources: or skills: block found in vibe-agent-toolkit.config.yaml — nothing to validate. If this is unexpected, check your config.',
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
  (a project with no skills block does not run skill validation). A project
  that configures nothing examines nothing, which is refused (exit 1) with a
  stderr warning naming the likely config typo.

  A run is a WHOLE run: '--only' was removed (a full run is ~35s, and the flag
  let a renamed config key silently drop a CI gate's coverage). 'vat build'
  keeps its '--only', where a phase costs minutes rather than seconds.

  Source-level only. Unlike 'vat verify', this never inspects built dist
  artifacts and never requires a build.

  Surfaces (run in this order):
    resources  → link integrity, collection frontmatter schemas (when 'resources:' configured)
    skills     → SKILL.md frontmatter and packaging validation (when 'skills:' configured)

Output:
  ONE report envelope (YAML) → stdout: status (ok | findings | error),
  examined (the sum over every surface), summary {errors, warnings, info},
  findings (every surface's, flat), and data.phases — one entry per surface
  with its own status, examined, summary, error (when it did not finish) and
  the surface's own data. Schema: packages/cli/schemas/orchestrator.json.
  Progress and validation errors → stderr (streamed live)

Exit Codes:
  0 - Every surface finished and no finding is an error (warnings never fail)
  1 - An error finding, or nothing was examined at all (RESOURCE_CHECK_BROKEN)
  2 - The run could not do its job: a surface did not finish (RUN_INCOMPLETE,
      the finished surfaces still in data.phases), a path argument or the
      retired '--only' (USAGE_INVALID), no project root

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
  // validators already accept `-v, --verbose`; only this command lacked the
  // flag, which made the collapsed warning/info detail unreachable HERE while
  // the same findings were one `vat skills validate` away. It is now passed as
  // the option it is, rather than re-serialized into an argv a second Commander
  // would have to parse back.
  const phases: Phase[] = [];

  if (config?.resources) {
    phases.push({
      name: 'resources',
      schema: RESOURCES_VALIDATE_REPORT_SCHEMA,
      run: () => runResourcesValidatePhase(undefined, { verbose }),
    });
  }

  if (config?.skills) {
    phases.push({
      name: 'skills',
      schema: SKILLS_VALIDATE_REPORT_SCHEMA,
      run: () => runSkillsValidatePhase(undefined, { verbose }),
    });
  }

  return decidePhaseSelection(undefined, phases, VALIDATE_VOCABULARY);
}

/**
 * Run every surface inside ONE projection-store scope, so the lanes share one
 * database and one `git write-tree` instead of taking one each. The measurement,
 * and why the hoist is admissible here and nowhere else, are in
 * `docs/architecture/resource-scanning-and-caching.md` §3.7.
 *
 * ⚠️ One scope is one git snapshot for the whole run. `vat validate` never
 * writes — source-level and build-free by the decision at the top of this file —
 * so no phase can miss another's output. A verb whose phases produce files for
 * the next to read (`vat build`) must not be hoisted this way, and is not.
 *
 * @param projectRoot - The resolved project root, which every surface roots at
 * @param phases - The surfaces to run, in order
 * @param logger - Where the per-surface banner goes
 * @param results - Where each surface's result is recorded as it finishes, so
 *   a later throw still publishes the finished ones
 */
async function runPhasesUnderOnePopulation(
  projectRoot: string,
  phases: readonly Phase[],
  logger: ReturnType<typeof createLogger>,
  results: PhaseResult[],
): Promise<void> {
  await withPopulationCache({ root: projectRoot }, async () => {
    for (const phase of phases) {
      logger.info(`\n▶ Surface: ${phase.name}`);
      // Awaited in the loop, deliberately: surfaces are announced in a fixed
      // order and their stderr streams live, so overlapping them would
      // interleave two running reports into one unreadable channel.
      results.push(await runPhase(phase));
    }
  });
}

async function validateTopLevelCommand(
  options: ValidateCommandOptions,
  command: Command,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  const report = await orchestrate(async (results) => {
    // First, and before requireProjectRoot: `vat validate docs/` used to be
    // accepted, have its path discarded, run wide over every configured surface
    // and report success. (`vat resources validate <path>` is the path-taking form.)
    rejectPositionalArguments(
      command.args,
      COMMAND_NAME,
      'validates every source surface vibe-agent-toolkit.config.yaml declares',
    );
    // Before requireProjectRoot: a retired flag is a usage error, and answering it
    // with "no vibe-agent-toolkit.config.yaml found" would diagnose the wrong problem.
    rejectRetiredOnly(options.only, COMMAND_NAME, VALIDATE_FULL_RUN_SECONDS);

    // requireProjectRoot returns the discovered root; read config from there so a
    // subdirectory invocation doesn't load an empty config and falsely pass.
    const projectRoot = requireProjectRoot(process.cwd(), COMMAND_NAME);
    const phases = applyPhaseSelection(
      selectValidateSurfaces(loadConfig(projectRoot), options.verbose === true),
      logger,
    );

    logger.info(`✅ vat validate (surfaces: ${phases.map((p) => p.name).join(' → ')})`);
    await runPhasesUnderOnePopulation(projectRoot, phases, logger, results);
  });
  endWithReport('validate', report, ORCHESTRATOR_FORMAT);
}
