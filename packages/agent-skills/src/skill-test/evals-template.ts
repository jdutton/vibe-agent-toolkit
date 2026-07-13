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

import { existsSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

/** Build the annotated evals.json template text for a given skill name. */
export function buildEvalsTemplate(skillName: string): string {
  const template = {
    _comment: [
      'This is a starter evals.json scaffolded by `vat skill test`.',
      'Replace the placeholder eval below with one entry per behavior you want to verify.',
      'Fields per eval:',
      '  id              — unique identifier: an integer (1) or a short descriptive',
      '                    string ("year-extraction"). Descriptive ids read better in results.',
      '                    A string id names a working directory, so use only letters,',
      '                    digits, hyphen, or underscore (no spaces, slashes, or colons).',
      '  prompt          — the task, written the way a REAL user would phrase it. The executor',
      '                    is NOT told it is being tested, so do not mention testing/evals here.',
      '  expected_output — OPTIONAL human-readable description of what a correct result looks like',
      '  files           — OPTIONAL input files (paths relative to THIS evals.json dir),',
      '                    staged into a per-eval working directory the executor operates on',
      '  expectations    — verifiable statements the grader checks. Make them DISCRIMINATING:',
      '                    a wrong or hallucinated output should FAIL them (presence != correctness).',
      '                    Include negative assertions too, e.g. "does NOT claim every row reconciles".',
      '  category        — OPTIONAL label you choose to group evals (e.g. "recognition",',
      '                    "guidance", "recovery"). VAT ignores it; it is for your own organization.',
      '  tier            — OPTIONAL non-negative integer cost/foundational tier, ascending',
      '                    (0 = cheapest/first). Used for fail-fast gating: cheaper tiers run',
      '                    first and can short-circuit later, more expensive tiers. Default: 0.',
      '  toolExpectations — OPTIONAL { mustRun, mustNotRun, sequence }, each an array of',
      '                    executable tool NAMES. The grader checks these against what the',
      '                    executor actually ran in the transcript (mustRun: all present;',
      '                    mustNotRun: none present; sequence: appear in this relative order).',
      'Aim for at least 3 evals covering real scenarios. Delete this _comment field once filled in, then re-run.',
    ],
    skill_name: skillName,
    evals: [
      {
        id: 1,
        category: 'TODO: optional grouping label, or remove this field',
        prompt: 'TODO: a realistic task a user would actually ask this skill to perform.',
        expected_output: 'TODO: describe what a correct result looks like.',
        files: [],
        expectations: [
          'TODO: a verifiable statement a correct output satisfies, e.g. "The output reports a total of 29500".',
          'TODO: a negative assertion a wrong output would trip, e.g. "The output does NOT claim the file is empty".',
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
  // Defensive: never clobber an authored eval suite. Callers only reach here when
  // the suite is absent, but guard so a stray call can never destroy real evals.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own resolved scaffold path
  if (!existsSync(evalsPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own resolved scaffold path
    writeFileSync(evalsPath, buildEvalsTemplate(skillName), 'utf8');
  }
  return evalsPath;
}
