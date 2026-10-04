/**
 * Agent import command - convert SKILL.md to agent.yaml
 */

import { importSkillToAgent } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';

import type { AgentImportReport } from './import-schema.js';

export interface ImportCommandOptions {
  debug?: boolean;
  output?: string;
  force?: boolean;
}

/** `vat agent import` has no `--strict` and publishes no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/** One skill per run. */
const SKILLS_IMPORTED = 1;

export async function importCommand(
  skillPath: string,
  options: ImportCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: AgentImportReport;
  try {
    const resolvedSkillPath = safePath.resolve(skillPath);
    logger.debug(`Importing Agent Skill: ${resolvedSkillPath}`);

    const importOptions: Parameters<typeof importSkillToAgent>[0] = {
      skillPath: resolvedSkillPath,
      force: options.force ?? false,
    };
    if (options.output) {
      importOptions.outputPath = safePath.resolve(options.output);
    }

    const result = await importSkillToAgent(importOptions);

    // The library names the refusal where it was raised; nothing was written.
    if (!result.success) throw new CommandRefusalError(result.refusal, result.error);

    logger.info(`Successfully imported Agent Skill to: ${result.agentPath}`);
    report = buildReport({
      examined: SKILLS_IMPORTED,
      findings: [],
      data: { agentPath: result.agentPath },
      gate: GATE,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    endWithRefusal('agent import', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  endWithReport('agent import', report, 'yaml');
}
