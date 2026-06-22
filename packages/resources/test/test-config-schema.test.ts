import { describe, expect, it } from 'vitest';

import {
  SkillPackagingConfigSchema,
  TestConfigSchema,
} from '../src/schemas/project-config.js';

describe('TestConfigSchema', () => {
  it('accepts a full valid test block', () => {
    const parsed = TestConfigSchema.parse({
      model: 'claude-sonnet-4-5',
      maxTurns: 30,
      maxBudgetUsd: 2.5,
      timeout: 600,
      stall: 60,
      evals: 'evals/evals.json',
      experimenterPrompt: 'prompts/experimenter.txt',
      auth: 'inherit',
      requireAuth: 'subscription',
      baseline: false,
      skillCreator: { vendored: true },
      with: [{ workspace: 'bar' }, { npm: '@scope/s@1.2.3' }],
      optional: [{ path: '../baz' }],
    });
    expect(parsed.auth).toBe('inherit');
    expect(parsed.with?.[1]).toEqual({ npm: '@scope/s@1.2.3' });
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => TestConfigSchema.parse({ bogus: true })).toThrow();
  });

  it('rejects an invalid auth mode', () => {
    expect(() => TestConfigSchema.parse({ auth: 'token' })).toThrow();
  });

  it('rejects a url source missing the url field', () => {
    expect(() => TestConfigSchema.parse({ with: [{ sha256: 'abc' }] })).toThrow();
  });

  it('accepts an env map', () => {
    const parsed = TestConfigSchema.parse({
      env: {
        CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snapshot.json',
        VENDOR_REGION: 'us',
      },
    });
    expect(parsed.env?.CUSTOMER_SNAPSHOT_PATH).toBe('${fixturesDir}/snapshot.json');
  });

  it('accepts a passEnv array', () => {
    const parsed = TestConfigSchema.parse({ passEnv: ['VENDOR_LICENSE_KEY'] });
    expect(parsed.passEnv).toEqual(['VENDOR_LICENSE_KEY']);
  });

  it('rejects a passEnv containing an empty string', () => {
    expect(() => TestConfigSchema.parse({ passEnv: [''] })).toThrow();
  });

  it('rejects a non-string env value', () => {
    expect(() => TestConfigSchema.parse({ env: { X: 123 } })).toThrow();
  });

  it('is reachable as SkillPackagingConfigSchema.test', () => {
    const parsed = SkillPackagingConfigSchema.parse({
      test: { auth: 'subscription' },
    });
    expect(parsed.test?.auth).toBe('subscription');
  });
});
