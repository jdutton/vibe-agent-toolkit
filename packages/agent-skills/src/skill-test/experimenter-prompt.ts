export class PromptInvariantError extends Error {
  constructor(message: string) {
    super(`Experimenter prompt invariant violated: ${message}`);
    this.name = 'PromptInvariantError';
  }
}

export interface BuildPromptOptions {
  subjectPath: string;
  evalsPath: string;
  gradingOut: string;
  frictionOut: string;
  baseline: boolean;
}

/**
 * vat's canned, non-interactive experimenter prompt (spec §6c). Reuses
 * skill-creator's grader RUBRIC and JSON shapes, NOT its interactive driver.
 * Invariants: non-interactive procedure then STOP; write exact artifacts;
 * forbid browser/aggregation/feedback/iteration; emit incrementally.
 */
export const DEFAULT_EXPERIMENTER_PROMPT = [
  'You are running a precise, NON-INTERACTIVE evaluation procedure. Do exactly the steps below, then STOP.',
  '',
  'For each eval in {{EVALS_PATH}}:',
  '  1. Dispatch ONE executor subagent. Tell it ONLY the task prompt and the staged subject path {{SUBJECT_PATH}}.',
  '     Never tell the executor it is being tested.',
  '  2. Grade the executor output against the eval\'s `expectations` using skill-creator\'s grader.md rubric.',
  '  3. Append each graded expectation to the SINGLE top-level `expectations` array in {{GRADING_OUT}} IMMEDIATELY',
  '     (incremental flush — a mid-run kill must leave partial results).',
  '  4. Record any packaging-fidelity friction to {{FRICTION_OUT}} using the vat friction schema.',
  '',
  '{{GRADING_OUT}} MUST be ONE flat JSON object in skill-creator\'s grading.json shape (references/schemas.md):',
  'a top-level `expectations` array — one entry {"text","passed","evidence"} per expectation across ALL evals —',
  'and a top-level `summary` {"passed","total"}. Do NOT wrap results in an `evals` array or any per-eval nesting;',
  'vat reads the flat top-level shape and rejects anything else. Example:',
  '  {"expectations":[{"text":"...","passed":true,"evidence":"..."}],"summary":{"passed":1,"total":1}}',
  '',
  'When all evals are graded, write the final `summary` to {{GRADING_OUT}} and STOP.',
  '',
  'You are FORBIDDEN to: open a browser or viewer; run aggregation/optimizer scripts; wait for human feedback;',
  'or iterate/improve the skill. This is a downstream packaging check, not an authoring loop.',
  '{{BASELINE_BLOCK}}',
].join('\n');

const BASELINE_BLOCK =
  '\nAlso run the WITH/WITHOUT baseline: repeat each eval once WITHOUT the skill present, recording the A/B in skill-creator\'s shapes.';

export function buildExperimenterPrompt(opts: BuildPromptOptions): string {
  return DEFAULT_EXPERIMENTER_PROMPT
    .replace('{{EVALS_PATH}}', opts.evalsPath)
    .replace('{{SUBJECT_PATH}}', opts.subjectPath)
    .replaceAll('{{GRADING_OUT}}', opts.gradingOut)
    .replace('{{FRICTION_OUT}}', opts.frictionOut)
    .replace('{{BASELINE_BLOCK}}', opts.baseline ? BASELINE_BLOCK : '');
}

const REQUIRED_PATTERNS: { test: RegExp; label: string }[] = [
  { test: /\bSTOP\b/, label: 'must instruct the experimenter to STOP' },
  { test: /grading\.json|\{\{GRADING_OUT\}\}/i, label: 'must write grading.json' },
  { test: /friction\.json|\{\{FRICTION_OUT\}\}/i, label: 'must write friction.json' },
  { test: /forbidden|do not|never/i, label: 'must forbid browser/aggregation/feedback/iteration' },
  { test: /browser|viewer/i, label: 'must explicitly forbid opening a browser/viewer' },
  { test: /increment/i, label: 'must emit incrementally' },
  {
    test: /top-level\s+`?expectations`?/i,
    label: 'must pin grading.json to the flat top-level `expectations`/`summary` shape',
  },
  {
    test: /`?evals`?\s+array|per-eval nesting/i,
    label: 'must forbid wrapping grading results in an `evals` array',
  },
];

export function assertPromptInvariants(prompt: string): void {
  for (const { test, label } of REQUIRED_PATTERNS) {
    if (!test.test(prompt)) throw new PromptInvariantError(label);
  }
}
