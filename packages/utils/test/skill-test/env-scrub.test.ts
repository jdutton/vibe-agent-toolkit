import { describe, expect, it } from 'vitest';

import {
  applyDeclaredEnv,
  buildForwardedEnv,
  formatForwardedEnvLine,
  protectedEnvNames,
} from '../../src/skill-test/env-scrub.js';

const HOME_DIR = '/home/u';
const BASE = {
  CLAUDE_CONFIG_DIR: `${HOME_DIR}/.claude`,
  ANTHROPIC_API_KEY: 'sk-key',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  ANTHROPIC_ADMIN_API_KEY: 'sk-admin',
  ANTHROPIC_BASE_URL: 'https://evil.example',
  ANTHROPIC_MODEL: 'claude-x',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'abc',
  CLAUDE_CODE_CHILD_SESSION: 'def',
  PATH: '/usr/bin',
  HOME: HOME_DIR,
} as NodeJS.ProcessEnv;

/** Host source for declared-env tests: BASE plus synthetic vendor-supplied vars. */
const DECLARED_SOURCE = {
  ...BASE,
  VENDOR_LICENSE_KEY: 'lic-123',
  FOO: 'host',
} as NodeJS.ProcessEnv;

/** A forwarded env built from BASE, used as the union base for declared-env tests. */
const FORWARDED_BASE = buildForwardedEnv(BASE, { scrubInferenceKey: false });

/** Synthetic injected-value literal reused across declared-env tests. */
const SNAPSHOT_PATH = '/x/snapshot.json';

describe('buildForwardedEnv', () => {
  it('forwards CLAUDE_CONFIG_DIR and the inference credential when not scrubbing', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-key');
  });

  it('ALWAYS scrubs ANTHROPIC_ADMIN_API_KEY', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.ANTHROPIC_ADMIN_API_KEY).toBeUndefined();
  });

  it('never forwards arbitrary ANTHROPIC_* (no prefix forwarding)', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('scrubs the inference credential when scrubInferenceKey is true', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: true });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
  });

  it('deletes CLAUDECODE and CLAUDE_CODE_* session vars', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('forwards PATH and HOME (process essentials) and listed model vars', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false, modelVars: ['ANTHROPIC_MODEL'] });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_MODEL).toBe('claude-x');
  });
});

describe('applyDeclaredEnv', () => {
  it('passEnv forwards a present source var', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['VENDOR_LICENSE_KEY'],
    });
    expect(result.env.VENDOR_LICENSE_KEY).toBe('lic-123');
    expect(result.passedThrough).toContain('VENDOR_LICENSE_KEY');
    expect(result.warnings).toHaveLength(0);
  });

  it('passEnv naming an absent source var is skipped without warning', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['MISSING_VENDOR_VAR'],
    });
    expect(result.env.MISSING_VENDOR_VAR).toBeUndefined();
    expect(result.passedThrough).not.toContain('MISSING_VENDOR_VAR');
    expect(result.warnings).toHaveLength(0);
  });

  it('passEnv naming a protected var is ignored with a warning, base value retained', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: { ...DECLARED_SOURCE, PATH: '/evil/bin' },
      passEnv: ['PATH'],
    });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.passedThrough).not.toContain('PATH');
    expect(result.warnings.some((w) => w.includes('PATH'))).toBe(true);
  });

  it('injectEnv unions a new key with its literal value', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { CUSTOMER_SNAPSHOT_PATH: SNAPSHOT_PATH },
    });
    expect(result.env.CUSTOMER_SNAPSHOT_PATH).toBe(SNAPSHOT_PATH);
    expect(result.injected).toContain('CUSTOMER_SNAPSHOT_PATH');
  });

  it('injectEnv naming a protected var is ignored with a warning, base value retained', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { PATH: '/evil/bin' },
    });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.injected).not.toContain('PATH');
    expect(result.warnings.some((w) => w.includes('PATH'))).toBe(true);
  });

  it('injectEnv wins over passEnv for the same key', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['FOO'],
      injectEnv: { FOO: 'explicit' },
    });
    expect(result.env.FOO).toBe('explicit');
    expect(result.injected).toContain('FOO');
    expect(result.passedThrough).not.toContain('FOO');
  });
});

describe('formatForwardedEnvLine', () => {
  it('shows names, redacts secrets and pass-through values, shows injected values', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['VENDOR_LICENSE_KEY'],
      injectEnv: { CUSTOMER_SNAPSHOT_PATH: SNAPSHOT_PATH },
    });
    const line = formatForwardedEnvLine(result.env, result);
    expect(line.startsWith('forwarded env: ')).toBe(true);
    expect(line).toContain('ANTHROPIC_API_KEY(redacted)');
    expect(line).toContain(`CUSTOMER_SNAPSHOT_PATH=${SNAPSHOT_PATH}`);
    expect(line).toContain('VENDOR_LICENSE_KEY(passed-through, redacted)');
    expect(line).not.toContain('sk-key');
    expect(line).not.toContain('lic-123');
  });
});

describe('protectedEnvNames', () => {
  it('includes process essentials, auth, admin, and passed model vars', () => {
    const names = protectedEnvNames(['ANTHROPIC_MODEL']);
    expect(names.has('PATH')).toBe(true);
    expect(names.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(names.has('ANTHROPIC_ADMIN_API_KEY')).toBe(true);
    expect(names.has('ANTHROPIC_MODEL')).toBe(true);
  });
});
