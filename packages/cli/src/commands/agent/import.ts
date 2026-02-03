/**
 * Agent import command - convert SKILL.md to agent.yaml
 */

import * as path from 'node:path';

import { importSkillToAgent } from '@vibe-agent-toolkit/agent-skills';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

export interface ImportCommandOptions {
  debug?: boolean;
  output?: string;
  force?: boolean;
}

export async function importCommand(
  skillPath: string,
  options: ImportCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Resolve path
    const resolvedSkillPath = path.resolve(skillPath);
    logger.debug(`Importing Claude Skill: ${resolvedSkillPath}`);

    // Import SKILL.md to agent.yaml
    const importOptions: Parameters<typeof importSkillToAgent>[0] = {
      skillPath: resolvedSkillPath,
      force: options.force ?? false,
    };

    if (options.output) {
      importOptions.outputPath = path.resolve(options.output);
    }

    const result = await importSkillToAgent(importOptions);

    if (!result.success) {
      // Import failed
      const output = {
        status: 'error',
        error: result.error,
        duration: `${Date.now() - startTime}ms`,
      };

      writeYamlOutput(output);
      logger.error(`Import failed: ${result.error}`);
      process.exit(1);
    }

    // Import successful
    const output = {
      status: 'success',
      agentPath: result.agentPath,
      duration: `${Date.now() - startTime}ms`,
    };

    writeYamlOutput(output);
    logger.info(`Successfully imported Claude Skill to: ${result.agentPath}`);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentImport');
  }
}
