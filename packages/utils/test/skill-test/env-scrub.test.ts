import { describe, expect, it } from 'vitest';

import { buildForwardedEnv } from '../../src/skill-test/env-scrub.js';

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
