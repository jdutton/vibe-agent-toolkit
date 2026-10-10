/**
 * The test-environment guarantee, asked in EVERY tier's lane: a test process never resolves user
 * state — the Claude directory, a user-scope skills directory — to somebody's real home.
 *
 * It is two halves. The shared vitest setup points `CLAUDE_CONFIG_DIR` at scratch (the default a
 * test gets) and arms `VAT_TEST_USER_STATE_UNDER`; the product's resolvers then fail CLOSED when a
 * test strips the default without pointing `HOME` at a temp directory. One suite, declared by each
 * tier's own file, because a lane that loads no setup file passes every other test and is the lane
 * the guarantee is absent in — a red in the turbo lane of one package is how that was last found.
 */

import { homedir } from 'node:os';
import { delimiter } from 'node:path';

import { canonicalPath, normalizedTmpdir, relativeEscapesRoot, resolveSkillTarget, safePath, TEST_USER_STATE_UNDER, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { expect, vi } from 'vitest';

import { getClaudeUserPaths } from '../src/paths/claude-paths.js';

const isUnder = (root: string, path: string): boolean => !relativeEscapesRoot(safePath.relative(canonicalPath(root), canonicalPath(path)));

/** What every refusal of the guard says, whichever resolver raised it. */
export const REFUSED_IN_A_TEST_PROCESS = /outside .* refusing to resolve it in a test process/;

/**
 * The guarantee, as named checks. Each tier's file declares them under its own lane's name
 * ({@link runTestEnvCheck}): the suite is one, the lanes that must load the setup are three.
 */
export const TEST_ENV_GUARANTEE: readonly (readonly [name: string, check: () => void])[] = [
  ['the Claude configuration a test sees by default is scratch under the temp directory, never unset', (): void => {
    const configured = process.env['CLAUDE_CONFIG_DIR'] ?? '';
    expect(configured).not.toBe('');
    expect(isUnder(normalizedTmpdir(), configured), configured).toBe(true);
    expect(isUnder(safePath.join(homedir(), '.claude'), configured), configured).toBe(false);
    expect(isUnder(normalizedTmpdir(), getClaudeUserPaths().claudeDir)).toBe(true);
  }],
  ['the fail-closed guard is armed, naming the temp tree', (): void => {
    const trees = (process.env[TEST_USER_STATE_UNDER] ?? '').split(delimiter).map((tree) => toForwardSlash(tree));
    expect(trees).toContain(toForwardSlash(normalizedTmpdir()));
  }],
  ['a test that unsets CLAUDE_CONFIG_DIR is refused the real home\'s Claude directory', (): void => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(() => getClaudeUserPaths()).toThrow(REFUSED_IN_A_TEST_PROCESS);
  }],
  ['a test that blanks CLAUDE_CONFIG_DIR is refused it too', (): void => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(() => getClaudeUserPaths()).toThrow(REFUSED_IN_A_TEST_PROCESS);
  }],
  ['a user-scope skills directory under the real home is refused, for a target that is not Claude', (): void => {
    expect(() => resolveSkillTarget('codex', 'user', normalizedTmpdir())).toThrow(REFUSED_IN_A_TEST_PROCESS);
  }],
];

/**
 * One check of {@link TEST_ENV_GUARANTEE}, as the body of `it.each`: the env stubs it made are undone
 * whatever it found.
 */
export function runTestEnvCheck(_name: string, check: () => void): void {
  try {
    check();
  } finally {
    vi.unstubAllEnvs();
  }
}
