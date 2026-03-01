/**
 * Unit tests for install-helpers utilities
 *
 * Focuses on cross-platform edge cases that are hard to catch in system tests,
 * particularly Windows env var case-sensitivity behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGlobalNpmInstall } from '../src/commands/skills/install-helpers.js';

// ---------------------------------------------------------------------------
// isGlobalNpmInstall — cross-platform env var casing
// ---------------------------------------------------------------------------

describe('isGlobalNpmInstall', () => {
  // Save and restore env so tests don't bleed into each other
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear any npm lifecycle vars from the test runner's env
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase().startsWith('npm_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns true when all three lowercase npm vars are set (Unix convention)', () => {
    process.env['npm_config_global'] = 'true';
    process.env['npm_lifecycle_event'] = 'postinstall';
    process.env['npm_command'] = 'install';

    expect(isGlobalNpmInstall()).toBe(true);
  });

  it('returns true when all three uppercase npm vars are set (Windows convention)', () => {
    // Windows normalizes env var names to uppercase when passing to child processes.
    // isGlobalNpmInstall() must handle this casing to work on Windows CI.
    process.env['NPM_CONFIG_GLOBAL'] = 'true';
    process.env['NPM_LIFECYCLE_EVENT'] = 'postinstall';
    process.env['NPM_COMMAND'] = 'install';

    expect(isGlobalNpmInstall()).toBe(true);
  });

  it('returns true with mixed casing (simulates Windows env block dedup edge case)', () => {
    process.env['NPM_CONFIG_GLOBAL'] = 'true';
    process.env['npm_lifecycle_event'] = 'postinstall';
    process.env['NPM_COMMAND'] = 'install';

    expect(isGlobalNpmInstall()).toBe(true);
  });

  it('returns false when npm_config_global is missing', () => {
    process.env['npm_lifecycle_event'] = 'postinstall';
    process.env['npm_command'] = 'install';

    expect(isGlobalNpmInstall()).toBe(false);
  });

  it('returns false when npm_config_global is not "true"', () => {
    process.env['npm_config_global'] = 'false';
    process.env['npm_lifecycle_event'] = 'postinstall';
    process.env['npm_command'] = 'install';

    expect(isGlobalNpmInstall()).toBe(false);
  });

  it('returns false when npm_lifecycle_event is not "postinstall"', () => {
    process.env['npm_config_global'] = 'true';
    process.env['npm_lifecycle_event'] = 'prepare';
    process.env['npm_command'] = 'install';

    expect(isGlobalNpmInstall()).toBe(false);
  });

  it('returns false when npm_command is "link" (npm link should not trigger postinstall)', () => {
    process.env['npm_config_global'] = 'true';
    process.env['npm_lifecycle_event'] = 'postinstall';
    process.env['npm_command'] = 'link';

    expect(isGlobalNpmInstall()).toBe(false);
  });

  it('returns false when no npm vars are set', () => {
    expect(isGlobalNpmInstall()).toBe(false);
  });
});
