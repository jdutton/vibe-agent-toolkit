import { assembleClaudeArgs } from '@vibe-agent-toolkit/utils/skill-test';
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

  // `--max-turns` is functional but absent from `claude --help`, so a help-text
  // probe cannot see it. Failing the run on that would refuse every working
  // install; claiming it "supported" would be the lie the old exit-code probe
  // told about every flag. It is reported as unverifiable and does not gate.
  it('reports --max-turns as unverifiable without failing the run', () => {
    const r = runPreflight(baseInput({ flagParseProbe: (f) => f !== '--max-turns' }));
    expect(r.passed).toBe(true);
    const check = r.checks.find(c => c.name.includes('--max-turns'));
    expect(check?.passed).toBe(true);
    expect(check?.message).toMatch(/undocumented|not verifiable/i);
  });

  // The flag is what keeps the grading nonce and the answer key off a disk the
  // untrusted executor reads. A claude that cannot suppress session persistence
  // must stop the run, not silently persist.
  it('fails closed when --no-session-persistence is unsupported, and says why', () => {
    const r = runPreflight(baseInput({ flagParseProbe: (f) => f !== '--no-session-persistence' }));
    expect(r.passed).toBe(false);
    const check = r.checks.find(c => c.name.includes('--no-session-persistence'));
    expect(check?.passed).toBe(false);
    expect(check?.suggestion).toMatch(/nonce|answer key/i);
  });

  // Every flag vat's argv actually carries must be checked by SOMETHING — either
  // gated or explicitly declared unverifiable. This is the drift guard: adding a
  // flag to the spawn without adding it to one of the two lists fails here.
  it('reports on every flag the spawn argv passes', () => {
    const r = runPreflight(baseInput());
    const reported = new Set(
      r.checks.filter(c => c.name.startsWith('flag ')).map(c => c.name.slice('flag '.length)),
    );
    const spawned = assembleClaudeArgs({
      pluginDirs: ['/p'], sandboxDir: '/s', model: 'm', maxTurns: 1, maxBudgetUsd: 1,
    }).filter(a => a.startsWith('--'));
    // `--verbose`/`--add-dir`/`--model` are shape, not capability: their absence
    // would break the spawn loudly and immediately. The gated set is the one whose
    // silent absence would change BEHAVIOR without an error.
    const exempt = new Set(['--verbose', '--add-dir', '--model']);
    for (const flag of spawned) {
      if (exempt.has(flag)) continue;
      expect(reported, `spawn passes ${flag} but preflight never reports on it`).toContain(flag);
    }
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
