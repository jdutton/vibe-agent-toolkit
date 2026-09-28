/**
 * The document `runSkillsValidatePhase` publishes for a project on disk,
 * parsed with the verb's own registry schema — so a test reads exactly what
 * the writer would put on stdout, run-integrity refusal included.
 */

import { SKILLS_VALIDATE_REPORT_SCHEMA, type SkillsValidateReport } from '../../../src/commands/skills/validate-schema.js';
import { runSkillsValidatePhase } from '../../../src/commands/skills/validate.js';

/**
 * @param root - A project directory holding `vibe-agent-toolkit.config.yaml`
 * @returns The phase's exit code and its published document
 */
export async function publishedSkillsValidate(root: string): Promise<{ exitCode: number; document: SkillsValidateReport }> {
  const outcome = await runSkillsValidatePhase(root, {});
  return { exitCode: outcome.exitCode, document: SKILLS_VALIDATE_REPORT_SCHEMA.parse(outcome.document) as SkillsValidateReport };
}
