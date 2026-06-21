import { describe, expect, it } from 'vitest';

import { AuthPreflightError, resolveAuth, type AuthStatusProbe } from '../../src/skill-test/auth-resolver.js';

const SUB_ENV = { CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'sk' } as NodeJS.ProcessEnv;

/** Probe that reports a subscription when the key is scrubbed, else apiKeySource. */
const realisticProbe: AuthStatusProbe = (env) => {
  if (env['ANTHROPIC_API_KEY']) {
    return { loggedIn: true, authMethod: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY' };
  }
  return { loggedIn: true, authMethod: 'claude.ai' };
};

describe('resolveAuth', () => {
  it('inherit scrubs the key when a subscription is present (post-scrub re-probe)', () => {
    const r = resolveAuth({ mode: 'inherit', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.effectiveMechanism).toBe('subscription');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('subscription forces OAuth, scrubs the key', () => {
    const r = resolveAuth({ mode: 'subscription', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.effectiveMechanism).toBe('subscription');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('subscription exits 2 when no subscription is logged in', () => {
    const noLogin: AuthStatusProbe = () => ({ loggedIn: false });
    expect(() => resolveAuth({ mode: 'subscription', sourceEnv: SUB_ENV, probe: noLogin })).toThrow(AuthPreflightError);
  });

  it('api-key requires a key, forwards it', () => {
    const r = resolveAuth({ mode: 'api-key', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.effectiveMechanism).toBe('api-key');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBe('sk');
  });

  it('api-key exits 2 when no key present', () => {
    expect(() =>
      resolveAuth({ mode: 'api-key', sourceEnv: { CLAUDE_CONFIG_DIR: '/c' }, probe: realisticProbe }),
    ).toThrow(AuthPreflightError);
  });

  it('requireAuth=subscription fails exit 2 when effective is api-key', () => {
    expect(() =>
      resolveAuth({ mode: 'api-key', requireAuth: 'subscription', sourceEnv: SUB_ENV, probe: realisticProbe }),
    ).toThrow(AuthPreflightError);
  });

  it('AuthPreflightError carries exitCode 2', () => {
    expect.assertions(1);
    try {
      resolveAuth({ mode: 'api-key', sourceEnv: { CLAUDE_CONFIG_DIR: '/c' }, probe: realisticProbe });
    } catch (e) {
      expect((e as AuthPreflightError).exitCode).toBe(2);
    }
  });
});
