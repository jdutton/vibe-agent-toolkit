import { describe, expect, it } from 'vitest';

import { runPreflight, type PreflightInput } from '../../src/skill-test/preflight.js';

function baseInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    claudeVersionProbe: () => 'claude 2.1.183',
    flagParseProbe: () => true,
    authProbe: () => ({ loggedIn: true, authMethod: 'claude.ai' }),
    evalInputPaths: [],
    declaredDepDirs: [],
    integrityOk: () => true,
    costEstimate: { evalCount: 3, configurations: 1, runsPerQuery: 1 },
    authMode: 'subscription',
    sourceEnv: { CLAUDE_CONFIG_DIR: '/c' } as NodeJS.ProcessEnv,
    ...overrides,
  };
}

describe('runPreflight', () => {
  it('passes a healthy environment', () => {
    const r = runPreflight(baseInput());
    expect(r.passed).toBe(true);
    expect(r.resolvedAuth?.effectiveMechanism).toBe('subscription');
  });

  it('fails when claude binary is unreachable', () => {
    const r = runPreflight(baseInput({ claudeVersionProbe: () => null }));
    expect(r.passed).toBe(false);
    expect(r.checks.find(c => c.name.includes('claude'))?.passed).toBe(false);
  });

  it('keeps the --max-turns parse-probe (functional-but-undocumented)', () => {
    const r = runPreflight(baseInput({ flagParseProbe: (f) => f !== '--max-turns' }));
    expect(r.passed).toBe(false);
    expect(r.checks.some(c => c.name.includes('--max-turns'))).toBe(true);
  });

  it('fails when the integrity manifest does not verify', () => {
    const r = runPreflight(baseInput({ integrityOk: () => false }));
    expect(r.passed).toBe(false);
  });

  it('fails with a clear message when a required auth mechanism is not met', () => {
    const r = runPreflight(baseInput({
      authMode: 'api-key',
      requireAuth: 'subscription',
      sourceEnv: { CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'sk' } as NodeJS.ProcessEnv,
      authProbe: () => ({ loggedIn: true, apiKeySource: 'ANTHROPIC_API_KEY' }),
    }));
    expect(r.passed).toBe(false);
    expect(r.checks.some(c => /require-auth|mechanism/i.test(c.message))).toBe(true);
  });

  it('reports the cost estimate as a passing informational check', () => {
    const r = runPreflight(baseInput());
    const cost = r.checks.find(c => /cost|estimate/i.test(c.name));
    expect(cost?.message).toContain('3');
  });
});
