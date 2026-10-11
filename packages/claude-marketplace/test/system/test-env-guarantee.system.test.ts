/**
 * The system tier spawns real processes, so the guarantee is asked of a CHILD too: it inherits the
 * scratch Claude directory and the armed guard, and the BUILT resolver in it fails closed.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { REFUSED_IN_A_TEST_PROCESS, runTestEnvCheck, TEST_ENV_GUARANTEE } from '../test-env-guarantee.js';

it.each(TEST_ENV_GUARANTEE)('the test-environment guarantee, in the system lane: %s', runTestEnvCheck);

const BUILT = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'index.js')).href;

/** Resolve the Claude directory in a child process running the built package, under `env`. */
function resolveInChild(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const script = `const { getClaudeUserPaths } = await import(${JSON.stringify(BUILT)}); process.stdout.write(getClaudeUserPaths().claudeDir);`;
  return spawnSync(NODE_EXECUTABLE, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
}

describe('the test-environment guarantee, in a process a system test spawns', () => {
  it('the child inherits the scratch Claude directory', () => {
    const child = resolveInChild(process.env);

    expect(child.status, child.stderr).toBe(0);
    expect(toForwardSlash(child.stdout)).toBe(toForwardSlash(process.env['CLAUDE_CONFIG_DIR'] ?? ''));
    expect(child.stdout).toContain('vat-test-no-claude-config-');
  });

  it('a child handed no CLAUDE_CONFIG_DIR is refused the real home\'s Claude directory: it exits non-zero, having resolved nothing', () => {
    const child = resolveInChild({ ...process.env, CLAUDE_CONFIG_DIR: '' });

    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toMatch(REFUSED_IN_A_TEST_PROCESS);
  });
});
