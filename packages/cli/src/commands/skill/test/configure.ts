/**
 * `vat skill test configure <skill-name>` — upsert `skills.config.<skill>.test`
 * in vibe-agent-toolkit.config.yaml without disturbing comments or key ordering.
 *
 * Orchestration only. Domain logic lives in upsertTestConfig (agent-skills).
 * Publishes the report contract (`SKILL_TEST_CONFIGURE_REPORT_SCHEMA`); under
 * `--print` stdout is the `skill-test-config` artifact — the config text alone.
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { upsertTestConfig } from '@vibe-agent-toolkit/agent-skills';
import { parseConfigAllowingUnknownKeys, type ProjectConfig, ProjectConfigSchema, readConfigText } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'yaml';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, writeArtifact } from '../../../utils/document-writer.js';
import { createLogger } from '../../../utils/logger.js';
import { requireInputPath, requireProjectRoot } from '../../../utils/project-root-policy.js';
import { discoverSkillsFromConfig } from '../../skills/skill-discovery.js';

import { assertValidAuth, type AuthValue } from './auth-flags.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
/** No `--strict`: the edit has no warnings to gate on. */
const CONFIGURE_GATE: Gate = { strict: false };

export interface SkillTestConfigureOptions {
  auth?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
  stall?: string;
  model?: string;
  /**
   * Tri-state, like `run`'s: `true` from `--baseline`, `false` from
   * `--no-baseline`, `undefined` when neither was typed — and only `undefined`
   * leaves an existing `baseline:` in the config alone. Commander gives this shape
   * only because `--baseline` is declared BEFORE `--no-baseline`; declaring the
   * negation first would default it to `true` and make every `configure` call
   * silently commit a baseline.
   */
  baseline?: boolean;
  evals?: string;
  print?: boolean;
  debug?: boolean;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandRefusalError('USAGE_INVALID', `${flag} must be a positive integer. Got: ${value}`);
  }
  return n;
}

function parsePositiveFloat(value: string, flag: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CommandRefusalError('USAGE_INVALID', `${flag} must be a positive number. Got: ${value}`);
  }
  return n;
}

/**
 * Assemble the knob patch handed to `upsertTestConfig`. Exported for testing: the
 * option DECLARATIONS were pinned (Commander's `--baseline`/`--no-baseline`
 * tri-state) and `upsertTestConfig` writes `false` correctly, but the assembly
 * between them — the step that decides which typed flags become knobs at all — was
 * not, so both `if (options.baseline === true)` (a `--no-baseline` that silently
 * does nothing, i.e. the exact regression `--no-baseline` exists to prevent) and
 * deleting the branch outright left the whole CLI suite green.
 */
export function buildKnobs(
  options: SkillTestConfigureOptions,
): Parameters<typeof upsertTestConfig>[2] {
  const knobs: Parameters<typeof upsertTestConfig>[2] = {};

  if (options.auth !== undefined) {
    assertValidAuth(options.auth);
    knobs.auth = options.auth as AuthValue;
  }
  if (options.maxTurns !== undefined) {
    knobs.maxTurns = parsePositiveInt(options.maxTurns, '--max-turns');
  }
  if (options.maxBudgetUsd !== undefined) {
    knobs.maxBudgetUsd = parsePositiveFloat(options.maxBudgetUsd, '--max-budget-usd');
  }
  if (options.timeout !== undefined) {
    knobs.timeout = parsePositiveInt(options.timeout, '--timeout');
  }
  if (options.stall !== undefined) {
    knobs.stall = parsePositiveInt(options.stall, '--stall');
  }
  if (options.model !== undefined) {
    knobs.model = options.model;
  }
  if (options.baseline !== undefined) {
    knobs.baseline = options.baseline;
  }
  if (options.evals !== undefined) {
    knobs.evals = options.evals;
  }

  return knobs;
}

/**
 * Read the config at `configPath`, apply `knobs` to `skillName`'s test block, and
 * hand back the YAML to write — refusing only what VAT would otherwise MISREAD.
 *
 * Exported and separated from the command because the command's own shape made
 * both of this lane's defects untestable: the read and the schema check were
 * inlined between a `process.cwd()` walk-up and a `writeFileSync`, so reaching
 * them from a test meant `process.chdir`, which the Unix unit pool (threads)
 * cannot do at all. Two defects therefore shipped with a green suite.
 *
 * 🔑 **The schema check goes through the SHARED reader**, not
 * `ProjectConfigSchema.safeParse`. This was the THIRD config reader in the
 * toolkit and the only one still carrying both defects the other two had fixed:
 *
 * - An unrecognized key was a hard refusal. `vat skill test configure my-skill
 *   --max-turns 20` exited 1 on a config carrying `resources.metadata` — a
 *   section this command never reads — refusing to write a change that had
 *   nothing to do with it. Unknown keys are a warning now; see
 *   {@link parseConfigAllowingUnknownKeys} for why.
 * - The message was `validation.error.message`, which in Zod 3 is a **JSON dump
 *   of the issue array**: no file named, no key named in words, no remedy.
 *
 * 🔑 **The read goes through the shared `readConfigText`**, never `readFileSync(path,
 * 'utf-8')`. This is a read-modify-WRITE path, so a UTF-16LE or BOM-prefixed
 * config (what PowerShell 5.1 writes by default) was decoded as mojibake and then
 * serialized back over the original — destroying a config whose only fault was
 * its encoding.
 *
 * @param configPath - Absolute path to `vibe-agent-toolkit.config.yaml`
 * @param skillName - The key under `skills.config` to upsert
 * @param knobs - The knobs the operator typed; only these are changed
 * @param onWarn - Receives the unknown-key warning, if any
 * @returns The updated YAML, comments and key ordering preserved
 * @throws {CommandRefusalError} `CONFIG_INVALID` when the project has no config
 *   file, or the UPDATED config would fail validation for any reason other than
 *   an unknown key; `USAGE_INVALID` when `skills.include` discovers no skill named
 *   `skillName`; `VatError` `CONFIG_UNREADABLE` (→ `INPUT_UNREADABLE`) when the OS refuses the read
 */
export async function updateSkillTestConfig(
  configPath: string,
  skillName: string,
  knobs: Parameters<typeof upsertTestConfig>[2],
  onWarn: (message: string) => void,
): Promise<string> {
  // A `.git/` ancestor is a project root with no config file in it.
  requireInputPath(configPath, {
    code: 'CONFIG_INVALID',
    message: `No ${CONFIG_FILENAME} at the project root: ${configPath}. Create one (a skills: block) first.`,
  });
  const yamlText = await readConfigText(configPath);
  const updatedYaml = upsertTestConfig(yamlText, skillName, knobs);

  // Validate the FULL updated config before it can be written.
  const parsed = yaml.parse(updatedYaml) as unknown;
  let config: ProjectConfig;
  try {
    config = parseConfigAllowingUnknownKeys(ProjectConfigSchema, parsed, onWarn, { configPath });
  } catch (validationError) {
    // The prefix is kept because it carries information the shared formatter
    // cannot know: what is being judged is the config AFTER this command's
    // edit, so a reader has to be told the file on disk may still be fine.
    const detail = validationError instanceof Error ? validationError.message : String(validationError);
    throw new CommandRefusalError('CONFIG_INVALID', `Updated config would fail schema validation.\n${detail}`);
  }

  await requireDeclaredSkill(configPath, config.skills, skillName);
  return updatedYaml;
}

/**
 * Refuse a skill name `skills.include` does not discover. A typo used to be
 * persisted as `skills.config.<typo>.test`, exit 0, and only the next
 * `vat skill test run <typo>` refused it — against the same discovery used here.
 */
async function requireDeclaredSkill(
  configPath: string,
  skills: ProjectConfig['skills'],
  skillName: string,
): Promise<void> {
  const declared = skills === undefined ? [] : await discoverSkillsFromConfig(skills, dirname(configPath), 'refuse');
  if (declared.some((skill) => skill.name === skillName)) return;
  const known = declared.map((skill) => skill.name).sort((a, b) => a.localeCompare(b)).join(', ') || '(none)';
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `No skill named '${skillName}' is declared by ${configPath} (declared: ${known}). Name a skill its skills.include discovers — the SKILL.md frontmatter name — or declare the skill before configuring its tests.`,
  );
}

/** Write the updated config over the file — a failed write stopped the run, it is not VAT's defect. */
function writeConfig(configPath: string, updatedYaml: string): void {
  try {
    writeFileSync(configPath, updatedYaml, 'utf-8');
  } catch (error) {
    throw new CommandRefusalError('RUN_INCOMPLETE', `Could not write ${configPath}: ${errorMessageOf(error)}`, { cause: error });
  }
}

async function configureCommand(
  skillName: string,
  options: SkillTestConfigureOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    const projectRoot = requireProjectRoot(process.cwd(), 'vat skill test configure');
    const configPath = safePath.join(projectRoot, CONFIG_FILENAME);
    const updatedYaml = await updateSkillTestConfig(
      configPath,
      skillName,
      buildKnobs(options),
      (message) => { logger.warn(message); },
    );

    if (options.print) {
      // The artifact alone: redirectable over the file, so no report rides along.
      // Returning (exit 0) rather than `process.exit`, which could cut a piped write short.
      writeArtifact('skill-test-config', updatedYaml, 'raw');
      return;
    }

    writeConfig(configPath, updatedYaml);
    logger.info(`Updated ${configPath}`);
    endWithReport('skill test configure', buildReport({
      examined: 1,
      findings: [],
      data: { configPath: toForwardSlash(safePath.relative(process.cwd(), configPath)), skill: skillName },
      gate: CONFIGURE_GATE,
    }), 'yaml');
  } catch (error) {
    endWithRefusal('skill test configure', refusalCodeOf(error), error, 'yaml', CONFIGURE_GATE, NOTHING_FINISHED);
  }
}

export function createSkillTestConfigureCommand(): Command {
  const command = new Command('configure');

  command
    .description('Upsert the test block for a skill in vibe-agent-toolkit.config.yaml')
    .argument('<skill>', 'Skill name (key under skills.config); must be a skill skills.include discovers')
    .option('--auth <mode>', 'Auth mechanism: inherit | subscription | api-key | auto')
    .option('--max-turns <n>', 'Per-spawn cap on executor/grader turns (positive integer)')
    .option('--max-budget-usd <n>', 'Per-spawn USD budget cap, applied to EACH executor and grader spawn (positive number). Not a whole-run ceiling: a baseline run has twice the spawns, so twice the worst-case spend.')
    .option('--timeout <s>', 'Wall-clock timeout in seconds (positive integer)')
    .option('--stall <s>', 'Stall-watchdog seconds (positive integer)')
    .option('--model <id>', 'Pinned model ID for reproducibility')
    // `--baseline` MUST stay declared BEFORE `--no-baseline`, for the same Commander
    // reason it is on `run`: only a pre-existing positive option leaves the value
    // undefined when neither flag is typed. A lone negated option defaults it to
    // `true`, which here would write `baseline: true` into the config on every
    // `configure` invocation that never mentioned baseline at all.
    .option(
      '--baseline',
      "Make the with/without A/B PERMANENT for this skill: every later `skill test run` then runs each eval TWICE, roughly doubling its spend (override for one run with `run --no-baseline`). It measures the skill's INSTRUCTIONS, not capability -- both arms share a filesystem, so check baselineIntegrity in baseline.json before trusting a delta.",
    )
    .option(
      '--no-baseline',
      'Persist `baseline: false` for this skill, turning a committed baseline back OFF. Without it the setting could only ever be written true by this command and had to be removed by hand. Omit both flags to leave the knob untouched.',
    )
    .option(
      '--evals <path>',
      "Path to evals.json, recorded in config as-is: relative to the skill source, absolute, or an npm bare specifier. (Note the asymmetry with `skill test run --evals`, which resolves against the current directory — config travels with the skill, a flag is typed by an operator.)",
    )
    .option('--print', 'Print the updated YAML to stdout instead of writing the file')
    .option('--debug', 'Enable debug logging')
    .action(configureCommand)
    .addHelpText(
      'after',
      `
Description:
  Reads vibe-agent-toolkit.config.yaml from the project root and upserts the
  test block for the named skill. Comments and key ordering are preserved.
  Only the knobs you pass are changed; other knob values remain intact.

Output:
  YAML report on stdout (schema: packages/cli/schemas/skill-test-configure.json):
  status ok|error, examined (1 config file), data: configPath (relative to the
  working directory), skill. With --print, stdout is the updated config text
  and nothing else, so it can be redirected over the file. Warnings (an
  unknown config key) go to stderr.

Exit Codes:
  0 - Config updated (or printed with --print)
  2 - Refused; error.code says why: USAGE_INVALID (an invalid option value, a
      skill the config's skills.include does not discover, or no project
      root), CONFIG_INVALID (no config file, or the updated config
      fails its schema), INPUT_UNREADABLE (the config cannot be read),
      RUN_INCOMPLETE (the config could not be written)

Example:
  $ vat skill test configure my-skill --auth subscription --max-turns 20
`,
    );

  return command;
}
