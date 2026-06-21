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
