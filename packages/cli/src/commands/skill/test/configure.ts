/**
 * `vat skill test configure <skill-name>` — upsert `skills.config.<skill>.test`
 * in vibe-agent-toolkit.config.yaml without disturbing comments or key ordering.
 *
 * Orchestration only. Domain logic lives in upsertTestConfig (agent-skills).
 * Mirrors review.ts error-handling conventions (handleCommandError / projectRootOrNull).
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { upsertTestConfig } from '@vibe-agent-toolkit/agent-skills';
import { ProjectConfigSchema } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'yaml';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';

import { assertValidAuth, type AuthValue } from './auth-flags.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

export interface SkillTestConfigureOptions {
  auth?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
  stall?: string;
  model?: string;
  baseline?: boolean;
  evals?: string;
  print?: boolean;
  debug?: boolean;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer. Got: ${value}`);
  }
  return n;
}

function parsePositiveFloat(value: string, flag: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive number. Got: ${value}`);
  }
  return n;
}

function buildKnobs(
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

async function configureCommand(
  skillName: string,
  options: SkillTestConfigureOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const projectRoot = findProjectRoot(process.cwd());
    if (projectRoot === null) {
      throw new Error(
        'skill test configure requires a vibe-agent-toolkit.config.yaml or .git/ ancestor. ' +
          'Run from inside a VAT project or initialize one.',
      );
    }

    const configPath = safePath.join(projectRoot, CONFIG_FILENAME);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath constructed from trusted projectRoot
    const yamlText = readFileSync(configPath, 'utf-8');

    const knobs = buildKnobs(options);
    const updatedYaml = upsertTestConfig(yamlText, skillName, knobs);

    // Validate the FULL updated config before writing.
    const parsed = yaml.parse(updatedYaml) as unknown;
    const validation = ProjectConfigSchema.safeParse(parsed);
    if (!validation.success) {
      throw new Error(
        `Updated config would fail schema validation: ${validation.error.message}`,
      );
    }

    if (options.print) {
      process.stdout.write(updatedYaml);
    } else {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath constructed from trusted projectRoot
      writeFileSync(configPath, updatedYaml, 'utf-8');
      logger.info(`Updated ${configPath}`);
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillTestConfigure');
  }
}

export function createSkillTestConfigureCommand(): Command {
  const command = new Command('configure');

  command
    .description('Upsert the test block for a skill in vibe-agent-toolkit.config.yaml')
    .argument('<skill>', 'Skill name (key under skills.config)')
    .option('--auth <mode>', 'Auth mechanism: inherit | subscription | api-key | auto')
    .option('--max-turns <n>', 'Cap on experimenter turns (positive integer)')
    .option('--max-budget-usd <n>', 'Hard USD budget cap (positive number)')
    .option('--timeout <s>', 'Wall-clock timeout in seconds (positive integer)')
    .option('--stall <s>', 'Stall-watchdog seconds (positive integer)')
    .option('--model <id>', 'Pinned model ID for reproducibility')
    .option('--baseline', 'Enable with/without A/B baseline run')
    .option('--evals <path>', 'Path to evals.json (relative to skill source)')
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

Exit Codes:
  0 - Config updated successfully (or printed with --print)
  2 - Error (invalid option value, config validation failure, file not found)

Example:
  $ vat skill test configure my-skill --auth subscription --max-turns 20
`,
    );

  return command;
}
