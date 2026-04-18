import { describe, it, expect } from 'vitest';

import type { Target } from '../src/types.js';
import { computeVerdicts } from '../src/verdict-engine.js';

const LOCAL_SHELL = 'CAPABILITY_LOCAL_SHELL';
const BROWSER_AUTH = 'CAPABILITY_BROWSER_AUTH';
const EXTERNAL_CLI = 'CAPABILITY_EXTERNAL_CLI';
const INCOMPATIBLE = 'COMPAT_TARGET_INCOMPATIBLE';

const CHAT: Target = 'claude-chat';
const COWORK: Target = 'claude-cowork';
const CODE: Target = 'claude-code';

function obs(code: string, payload?: Record<string, unknown>) {
  return { code, summary: code, payload, supportingEvidence: [] };
}

describe('computeVerdicts', () => {
  it('expected: no verdict when target covers capability', () => {
    const verdicts = computeVerdicts({
      observations: [obs(LOCAL_SHELL)],
      targets: [CODE],
    });
    expect(verdicts).toEqual([]);
  });

  it('incompatible: claude-chat lacks localShell', () => {
    const verdicts = computeVerdicts({
      observations: [obs(LOCAL_SHELL)],
      targets: [CHAT],
    });
    expect(verdicts).toHaveLength(1);
    const [first] = verdicts;
    expect(first?.code).toBe(INCOMPATIBLE);
    expect(first?.target).toBe(CHAT);
  });

  it('incompatible: claude-cowork lacks browser', () => {
    const verdicts = computeVerdicts({
      observations: [obs(BROWSER_AUTH)],
      targets: [COWORK],
    });
    expect(verdicts[0]?.code).toBe(INCOMPATIBLE);
  });

  it('needs-review: claude-code has shell but not a specific binary', () => {
    const verdicts = computeVerdicts({
      observations: [obs(EXTERNAL_CLI, { binary: 'az' })],
      targets: [CODE],
    });
    expect(verdicts[0]?.code).toBe('COMPAT_TARGET_NEEDS_REVIEW');
  });

  it('expected: claude-cowork has python3 pre-installed', () => {
    const verdicts = computeVerdicts({
      observations: [obs(EXTERNAL_CLI, { binary: 'python3' })],
      targets: [COWORK],
    });
    expect(verdicts).toEqual([]);
  });

  it('undeclared: emits COMPAT_TARGET_UNDECLARED when no targets', () => {
    const verdicts = computeVerdicts({
      observations: [obs(LOCAL_SHELL)],
      targets: undefined,
    });
    expect(verdicts[0]?.code).toBe('COMPAT_TARGET_UNDECLARED');
  });

  it('undeclared: one verdict per distinct observation code', () => {
    const verdicts = computeVerdicts({
      observations: [
        obs(LOCAL_SHELL),
        obs(LOCAL_SHELL),
        obs(BROWSER_AUTH),
      ],
      targets: undefined,
    });
    expect(
      verdicts.map(v => v.observationCode).sort((a, b) => a.localeCompare(b)),
    ).toEqual([BROWSER_AUTH, LOCAL_SHELL]);
  });

  it('explicit empty targets: every observation incompatible', () => {
    const verdicts = computeVerdicts({
      observations: [obs(LOCAL_SHELL), obs(BROWSER_AUTH)],
      targets: [],
    });
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every(v => v.code === INCOMPATIBLE)).toBe(true);
  });

  it('multi-target: only mismatched target emits verdict', () => {
    const verdicts = computeVerdicts({
      observations: [obs(LOCAL_SHELL)],
      targets: [CHAT, CODE],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.target).toBe(CHAT);
  });
});
