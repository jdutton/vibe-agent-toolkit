/**
 * The document `vat skills validate` publishes for a project on disk,
 * validated against the verb's own registry schema — so a test reads exactly what
 * the writer would put on stdout, run-integrity refusal included.
 */

import type { SkillsValidateReport } from '../../../src/commands/skills/validate-schema.js';
import { runSkillsValidatePhase, type SkillsValidateCommandOptions } from '../../../src/commands/skills/validate.js';
import { publishedPhase } from '../../helpers/published-phase.js';

/**
 * @param root - A project directory holding `vibe-agent-toolkit.config.yaml`
 * @param options - The command's options (`--skill`); none by default
 * @returns The phase's exit code and its published document
 */
export async function publishedSkillsValidate(
  root: string,
  options: SkillsValidateCommandOptions = {},
): Promise<{ exitCode: number; document: SkillsValidateReport }> {
  return publishedPhase<SkillsValidateReport>('skills validate', await runSkillsValidatePhase(root, options));
}
