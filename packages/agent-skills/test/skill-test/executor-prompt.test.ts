import { describe, expect, it } from 'vitest';

import {
  assertExecutorPromptInvariants,
  buildExecutorPrompt,
} from '../../src/skill-test/executor-prompt.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';

const SUBJECT_PATH = '/h/subject';
const baseOpts = {
  task: 'Summarize the quarterly report and flag any risks.',
  subjectPath: SUBJECT_PATH,
};

describe('buildExecutorPrompt', () => {
  it('includes the task text verbatim', () => {
    const prompt = buildExecutorPrompt(baseOpts);
    expect(prompt).toContain(baseOpts.task);
  });

  it('points at the staged subject path', () => {
    const prompt = buildExecutorPrompt(baseOpts);
    expect(prompt).toContain(SUBJECT_PATH);
  });

  it('omits any workspace clause when workspaceDir is not given', () => {
    const prompt = buildExecutorPrompt(baseOpts);
    expect(prompt).not.toMatch(/working directory/i);
  });

  it('states the working directory when workspaceDir is given', () => {
    const prompt = buildExecutorPrompt({ ...baseOpts, workspaceDir: '/w/eval-1' });
    expect(prompt).toContain('/w/eval-1');
    expect(prompt).toMatch(/working directory/i);
  });

  // The skill-absent arm of a --baseline run. The staged subject dir holds the
  // SKILL.md AND any executable the skill ships, so naming it hands the control
  // the whole treatment — the prompt must be silent about it.
  it('omits the subject clause entirely when subjectPath is absent', () => {
    const prompt = buildExecutorPrompt({ task: baseOpts.task });

    expect(prompt).toBe(baseOpts.task);
    expect(prompt).not.toContain(SUBJECT_PATH);
    expect(prompt).not.toMatch(/relevant files/i);
  });

  it('still states the working directory when subjectPath is absent', () => {
    const prompt = buildExecutorPrompt({ task: baseOpts.task, workspaceDir: '/w/eval-1' });

    expect(prompt).toContain('/w/eval-1');
    expect(prompt).not.toMatch(/relevant files/i);
    expect(() => assertExecutorPromptInvariants(prompt, baseOpts.task)).not.toThrow();
  });

  it('never mentions testing, evaluation, or grading', () => {
    const prompt = buildExecutorPrompt({ ...baseOpts, workspaceDir: '/w/eval-1' });
    expect(() => assertExecutorPromptInvariants(prompt, baseOpts.task)).not.toThrow();
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain('being tested');
    expect(lower).not.toContain('this is an eval');
    expect(lower).not.toContain('you are being evaluated');
    expect(lower).not.toContain('grading');
  });
});

describe('assertExecutorPromptInvariants', () => {
  it('passes on a clean prompt', () => {
    const prompt = buildExecutorPrompt(baseOpts);
    expect(() => assertExecutorPromptInvariants(prompt, baseOpts.task)).not.toThrow();
  });

  it('throws PromptInvariantError when OUR scaffolding contains a breaker', () => {
    // Task is clean; the breaker lives in the non-task (scaffolding) part.
    const task = 'Summarize the report.';
    const prompt = `${task}\n\nNote: you are being tested on this.`;
    expect(() => assertExecutorPromptInvariants(prompt, task)).toThrow(PromptInvariantError);
  });

  it('throws (case-insensitive) on each blinding-breaker phrase in scaffolding', () => {
    const task = 'Do the work.';
    const withBreaker = (breaker: string): string => `${task}\n${breaker}`;
    expect(() => assertExecutorPromptInvariants(withBreaker('This IS AN EVAL of your ability.'), task))
      .toThrow(PromptInvariantError);
    expect(() => assertExecutorPromptInvariants(withBreaker('You Are Being Evaluated right now.'), task))
      .toThrow(PromptInvariantError);
    expect(() => assertExecutorPromptInvariants(withBreaker('We will be Grading your response.'), task))
      .toThrow(PromptInvariantError);
  });

  it('does NOT throw when ONLY the adopter task contains a breaker phrase', () => {
    // A legitimate task may naturally contain denylist words — it must not be policed.
    const task = 'Grade the essay and note you are being evaluated on tone.';
    const prompt = buildExecutorPrompt({ task, subjectPath: SUBJECT_PATH });
    expect(() => assertExecutorPromptInvariants(prompt, task)).not.toThrow();
  });

  it('throws when the task is empty', () => {
    expect(() => assertExecutorPromptInvariants('anything', '')).toThrow(PromptInvariantError);
    expect(() => assertExecutorPromptInvariants('anything', '   \n  ')).toThrow(PromptInvariantError);
  });

  it('throws when the task is not present in the prompt', () => {
    expect(() => assertExecutorPromptInvariants('some scaffolding only', 'the missing task'))
      .toThrow(PromptInvariantError);
  });
});
