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

  it('auto keeps the key (no scrub) and reports api-key when a key is present', () => {
    const r = resolveAuth({ mode: 'auto', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.effectiveMechanism).toBe('api-key');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBe('sk');
  });

  it('inherit does NOT scrub when the post-scrub re-probe is not logged in', () => {
    // Probe reports a subscription only while the key is present; once scrubbed it
    // is not logged in, so decideScrub returns false and the key is forwarded.
    const noSubWithoutKey: AuthStatusProbe = (env) =>
      env['ANTHROPIC_API_KEY'] ? { loggedIn: true, authMethod: 'api-key' } : { loggedIn: false };
    const r = resolveAuth({ mode: 'inherit', sourceEnv: SUB_ENV, probe: noSubWithoutKey });
    expect(r.effectiveMechanism).toBe('api-key');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBe('sk');
  });

  it('inherit handles a null re-probe as not-logged-in (no scrub)', () => {
    const nullWithoutKey: AuthStatusProbe = (env) =>
      env['ANTHROPIC_API_KEY'] ? { loggedIn: true } : null;
    const r = resolveAuth({ mode: 'inherit', sourceEnv: SUB_ENV, probe: nullWithoutKey });
    expect(r.effectiveMechanism).toBe('api-key');
    expect(r.forwardedEnv.ANTHROPIC_API_KEY).toBe('sk');
  });

  it('subscription exits 2 when the probe returns null', () => {
    const nullProbe: AuthStatusProbe = () => null;
    expect(() => resolveAuth({ mode: 'subscription', sourceEnv: SUB_ENV, probe: nullProbe })).toThrow(
      AuthPreflightError,
    );
  });

  it('requireAuth mismatch refuses to spend tokens', () => {
    expect(() =>
      resolveAuth({ mode: 'api-key', requireAuth: 'subscription', sourceEnv: SUB_ENV, probe: realisticProbe }),
    ).toThrow(/Refusing to spend tokens/);
  });

  it('passes through authMethod and apiKeySource from the probe when present', () => {
    const r = resolveAuth({ mode: 'api-key', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.authMethod).toBe('claude.ai');
    expect(r.apiKeySource).toBe('ANTHROPIC_API_KEY');
  });

  it('omits apiKeySource when the probe does not report one (exactOptionalPropertyTypes)', () => {
    // Under subscription the key is scrubbed, so realisticProbe sees no key and
    // returns authMethod only — apiKeySource must be absent (not undefined).
    const r = resolveAuth({ mode: 'subscription', sourceEnv: SUB_ENV, probe: realisticProbe });
    expect(r.authMethod).toBe('claude.ai');
    expect('apiKeySource' in r).toBe(false);
  });

  it('omits both authMethod and apiKeySource when the probe reports neither', () => {
    const bareProbe: AuthStatusProbe = () => ({ loggedIn: true });
    const r = resolveAuth({ mode: 'subscription', sourceEnv: SUB_ENV, probe: bareProbe });
    expect('authMethod' in r).toBe(false);
    expect('apiKeySource' in r).toBe(false);
  });
});
