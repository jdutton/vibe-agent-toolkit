/**
 * Unit tests for withPluginRootEnv — the pure seam that injects CLAUDE_PLUGIN_ROOT
 * into the spawn env when the subject skill is plugin-distributed.
 *
 * We set CLAUDE_PLUGIN_ROOT explicitly so the harness mirrors a real plugin install
 * (the skill's own code reads `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`). Standalone
 * subjects leave the env untouched.
 */

import { describe, expect, it } from 'vitest';

import { withPluginRootEnv } from '../../src/skill-test/plugin-env.js';

describe('withPluginRootEnv', () => {
  const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test' };

  it('injects CLAUDE_PLUGIN_ROOT when the subject is plugin-distributed', () => {
    const out = withPluginRootEnv(base, '/harness/staged/acme-platform-abc123');
    expect(out.CLAUDE_PLUGIN_ROOT).toBe('/harness/staged/acme-platform-abc123');
    // The rest of the env is preserved verbatim.
    expect(out.PATH).toBe('/usr/bin');
    expect(out.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('leaves the env unchanged when the subject is standalone (null plugin root)', () => {
    const out = withPluginRootEnv(base, null);
    expect('CLAUDE_PLUGIN_ROOT' in out).toBe(false);
    expect(out).toEqual(base);
  });

  it('does not mutate the input env object', () => {
    const input = { ...base };
    withPluginRootEnv(input, '/harness/staged/p');
    expect('CLAUDE_PLUGIN_ROOT' in input).toBe(false);
  });
});
