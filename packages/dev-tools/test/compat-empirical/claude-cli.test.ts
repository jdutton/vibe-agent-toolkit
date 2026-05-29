import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSubscriptionEnv,
  requireOAuthToken,
  resolveOAuthToken,
} from '../../src/compat-empirical/runtimes/shared/claude-cli.js';

const OAUTH_TOKEN_ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

describe('buildSubscriptionEnv', () => {
  it('injects the OAuth token and strips every API credential', () => {
    const env = buildSubscriptionEnv(
      { ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 'tok', PATH: '/usr/bin' },
      { token: 'oauth-123' },
    );
    expect(env[OAUTH_TOKEN_ENV_KEY]).toBe('oauth-123');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('sets HOME-family vars only when homeDir is provided', () => {
    const fakeHome = '/home/test-profile';

    const without = buildSubscriptionEnv({}, { token: 't' });
    expect(without['HOME']).toBeUndefined();

    const withHome = buildSubscriptionEnv({}, { token: 't', homeDir: fakeHome });
    expect(withHome['HOME']).toBe(fakeHome);
    expect(withHome['USERPROFILE']).toBe(fakeHome);
    expect(withHome['XDG_CONFIG_HOME']).toBe(`${fakeHome}/.config`);
  });
});

describe('requireOAuthToken', () => {
  it('throws a setup-token message when the token is unset', () => {
    const prev = process.env[OAUTH_TOKEN_ENV_KEY];
    delete process.env[OAUTH_TOKEN_ENV_KEY];
    try {
      expect(() => requireOAuthToken()).toThrow(/claude setup-token/);
    } finally {
      if (prev !== undefined) process.env[OAUTH_TOKEN_ENV_KEY] = prev;
    }
  });

  it('returns the token when set', () => {
    const prev = process.env[OAUTH_TOKEN_ENV_KEY];
    process.env[OAUTH_TOKEN_ENV_KEY] = 'oauth-xyz';
    try {
      expect(requireOAuthToken()).toBe('oauth-xyz');
    } finally {
      if (prev === undefined) delete process.env[OAUTH_TOKEN_ENV_KEY];
      else process.env[OAUTH_TOKEN_ENV_KEY] = prev;
    }
  });
});

describe('resolveOAuthToken', () => {
  const ENV_KEY = OAUTH_TOKEN_ENV_KEY;
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => { if (prev === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prev; });

  it('returns the env token without prompting when set', async () => {
    process.env[ENV_KEY] = 'env-token';
    let prompted = false;
    const token = await resolveOAuthToken(async () => { prompted = true; return 'should-not-be-used'; });
    expect(token).toBe('env-token');
    expect(prompted).toBe(false);
  });

  it('prompts the operator when env is unset, then caches into env', async () => {
    const raw = '  pasted-token  ';
    const trimmed = raw.trim();
    const token = await resolveOAuthToken(async () => raw);
    expect(token).toBe(trimmed);
    expect(process.env[ENV_KEY]).toBe(trimmed);
  });

  it('throws a setup-token message when the operator enters nothing', async () => {
    await expect(resolveOAuthToken(async () => '   ')).rejects.toThrow(/claude setup-token/);
  });
});
