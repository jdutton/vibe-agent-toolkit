import { describe, expect, it } from 'vitest';

import {
  assertPromptInvariants,
  buildExperimenterPrompt,
  DEFAULT_EXPERIMENTER_PROMPT,
  PromptInvariantError,
} from '../../src/skill-test/experimenter-prompt.js';

const opts = {
  subjectPath: '/h/subject',
  evalsPath: '/h/subject/evals/evals.json',
  gradingOut: '/h/results/grading.json',
  frictionOut: '/h/results/friction.json',
  workspacesRoot: '/w',
  baseline: false,
};

describe('buildExperimenterPrompt', () => {
  it('embeds the staged subject + artifact paths', () => {
    const p = buildExperimenterPrompt(opts);
    expect(p).toContain('/h/subject');
    expect(p).toContain('/h/results/grading.json');
    expect(p).toContain('/h/results/friction.json');
  });

  it('the default prompt satisfies all invariants', () => {
    expect(() => assertPromptInvariants(DEFAULT_EXPERIMENTER_PROMPT)).not.toThrow();
  });

  it('pins grading.json to the flat top-level shape and forbids an evals[] wrapper', () => {
    // Bug E: an under-specified shape let the grader nest results under `evals[]`,
    // which parseGradingJson rejects. The prompt must pin the flat shape so the
    // grader emits what vat reads.
    expect(DEFAULT_EXPERIMENTER_PROMPT).toMatch(/top-level\s+`?expectations`?/i);
    expect(DEFAULT_EXPERIMENTER_PROMPT).toMatch(/`?evals`?\s+array/i);
  });

  it('feeds expected_output to the grader as context (without making it a checklist item)', () => {
    // expected_output is optional prose; when present it should inform grading but
    // the pass/fail verdict stays pinned to the `expectations` entries.
    expect(DEFAULT_EXPERIMENTER_PROMPT).toMatch(/expected_output/);
    expect(DEFAULT_EXPERIMENTER_PROMPT).toMatch(/context/i);
  });

  it('mentions the baseline A/B only when enabled', () => {
    expect(buildExperimenterPrompt({ ...opts, baseline: true })).toMatch(/baseline|without the skill/i);
    expect(buildExperimenterPrompt(opts)).not.toMatch(/without the skill/i);
  });
});

describe('assertPromptInvariants', () => {
  it('rejects an override that omits the STOP directive', () => {
    expect(() => assertPromptInvariants('grade evals and write grading.json and friction.json. Do not open a browser.')).toThrow(PromptInvariantError);
  });

  it('rejects an override that fails to forbid the browser viewer', () => {
    expect(() => assertPromptInvariants('Do exactly this then STOP. Write grading.json and friction.json.')).toThrow(PromptInvariantError);
  });
});

describe('buildExperimenterPrompt — workspacesRoot token', () => {
  it('substitutes WORKSPACES_ROOT and leaves no template placeholders', () => {
    const prompt = buildExperimenterPrompt({
      subjectPath: '/staged/subject',
      evalsPath: '/staged/subject/evals/evals.json',
      gradingOut: '/results/grading.json',
      frictionOut: '/results/friction.json',
      workspacesRoot: '/harness/workspaces',
      baseline: false,
    });
    expect(prompt).toContain('/harness/workspaces');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('still passes all prompt invariants with the workspace line present', () => {
    const prompt = buildExperimenterPrompt({
      subjectPath: '/s', evalsPath: '/e', gradingOut: '/g', frictionOut: '/f',
      workspacesRoot: '/w', baseline: true,
    });
    expect(() => assertPromptInvariants(prompt)).not.toThrow();
  });
});
