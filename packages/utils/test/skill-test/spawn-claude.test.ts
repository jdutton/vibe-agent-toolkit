import { describe, expect, it } from 'vitest';

import { assembleClaudeArgs } from '../../src/skill-test/spawn-claude.js';

describe('assembleClaudeArgs', () => {
  // eslint-disable sonarjs/publicly-writable-directories -- test fixtures
  const sandboxPath = '/var/lib/sandbox';
  const promptPath = '/var/lib/sandbox/experimenter-prompt.txt';
  const subject = '/var/lib/sandbox/subject';
  const skillCreator = '/var/lib/sandbox/skill-creator';
  // eslint-enable sonarjs/publicly-writable-directories

  const base = {
    promptFile: promptPath,
    pluginDirs: [subject, skillCreator],
    sandboxDir: sandboxPath,
  };

  it('sets --setting-sources to empty (built-ins remain, user/project settings suppressed)', () => {
    const args = assembleClaudeArgs(base);
    const i = args.indexOf('--setting-sources');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('');
  });

  it('emits one --plugin-dir per staged item', () => {
    const args = assembleClaudeArgs(base);
    const dirs = args.filter((_, idx) => args[idx - 1] === '--plugin-dir');
    expect(dirs).toEqual([subject, skillCreator]);
  });

  it('uses bypassPermissions and --add-dir for the sandbox', () => {
    const args = assembleClaudeArgs(base);
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args[args.indexOf('--add-dir') + 1]).toBe(sandboxPath);
  });

  it('never places the prompt text in argv (only the file flag)', () => {
    const args = assembleClaudeArgs(base);
    expect(args.some(a => a.includes('experimenter-prompt.txt'))).toBe(true);
    // sanity: the prompt content is not inlined
    expect(args.join(' ')).not.toContain('STOP');
  });

  it('includes caps when provided', () => {
    const args = assembleClaudeArgs({ ...base, maxTurns: 30, maxBudgetUsd: 2, model: 'claude-x' });
    expect(args[args.indexOf('--max-turns') + 1]).toBe('30');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-x');
  });

  it('omits caps when not provided', () => {
    const args = assembleClaudeArgs(base);
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--model');
  });
});
