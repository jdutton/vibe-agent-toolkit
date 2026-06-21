/**
 * evals-template.ts — scaffold a starter `evals.json` on bootstrap (exit 3).
 *
 * When a subject skill has no `evals/evals.json`, the harness writes an
 * annotated template the user can fill in and re-run. The shape mirrors
 * skill-creator's evals.json (see vendor/skill-creator/references/schemas.md):
 *
 *   { "skill_name": "...", "evals": [ { id, prompt, expected_output, expectations } ] }
 *
 * JSON has no comment syntax, so the template carries an inline `_comment` field
 * (a string array) and a single placeholder eval whose values are instructions.
 * Both are stripped by the user as they fill in real evals; the harness does not
 * read `_comment`.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

/** Build the annotated evals.json template text for a given skill name. */
export function buildEvalsTemplate(skillName: string): string {
  const template = {
    _comment: [
      'This is a starter evals.json scaffolded by `vat skill test`.',
      'Replace the placeholder eval below with one entry per behavior you want to verify.',
      'Fields per eval:',
      '  id              — unique integer identifier',
      '  prompt          — the task prompt handed to the executor (it is NOT told it is being tested)',
      '  expected_output — human-readable description of what success looks like',
      '  files           — OPTIONAL list of input file paths relative to the skill root',
      '  expectations    — list of verifiable statements the grader checks against the output',
      'Delete this _comment field once you have filled in real evals, then re-run.',
    ],
    skill_name: skillName,
    evals: [
      {
        id: 1,
        prompt: 'TODO: describe the task a user would ask this skill to perform.',
        expected_output: 'TODO: describe what a correct result looks like.',
        expectations: [
          'TODO: a verifiable statement about the output, e.g. "The output includes X".',
        ],
      },
    ],
  };
  return JSON.stringify(template, null, 2) + '\n';
}

/**
 * Write the annotated evals.json template to `evalsPath`, creating parent dirs.
 * Returns the path written (forward-slash absolute).
 */
export function writeEvalsTemplate(evalsPath: string, skillName: string): string {
  const parent = safePath.join(evalsPath, '..');
  mkdirSyncReal(parent, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own resolved scaffold path
  writeFileSync(evalsPath, buildEvalsTemplate(skillName), 'utf8');
  return evalsPath;
}
