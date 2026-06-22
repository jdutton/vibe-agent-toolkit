import { describe, expect, it } from 'vitest';

import { assembleClaudeArgs } from '../../src/skill-test/spawn-claude.js';

describe('assembleClaudeArgs', () => {
  // eslint-disable sonarjs/publicly-writable-directories -- test fixtures
  const sandboxPath = '/var/lib/sandbox';
  const subject = '/var/lib/sandbox/subject';
  const skillCreator = '/var/lib/sandbox/skill-creator';
  // eslint-enable sonarjs/publicly-writable-directories

  const base = {
    pluginDirs: [subject, skillCreator],
    sandboxDir: sandboxPath,
  };

  const PLUGIN_DIR = '--plugin-dir';
  const MAX_TURNS = '--max-turns';
  const MAX_BUDGET = '--max-budget-usd';
  const MODEL = '--model';
  const MODEL_VALUE = 'claude-x';
  const OUTPUT_FORMAT = '--output-format';
  const PERMISSION_MODE = '--permission-mode';

  /** Locate the value following a flag, or undefined when the flag is absent. */
  const valueAfter = (args: string[], flag: string): string | undefined =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

  it('sets --setting-sources to empty (built-ins remain, user/project settings suppressed)', () => {
    const args = assembleClaudeArgs(base);
    const i = args.indexOf('--setting-sources');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('');
  });

  it('passes --verbose (claude 2.x requires it when -p uses --output-format stream-json)', () => {
    const args = assembleClaudeArgs(base);
    expect(args).toContain(OUTPUT_FORMAT);
    expect(valueAfter(args, OUTPUT_FORMAT)).toBe('stream-json');
    // Without --verbose, claude exits 1: "--output-format=stream-json requires --verbose".
    expect(args).toContain('--verbose');
  });

  /** Extract the dirs that follow each --plugin-dir flag. */
  const pluginDirsIn = (args: string[]): string[] => args.filter((_, idx) => args[idx - 1] === PLUGIN_DIR);

  it('emits one --plugin-dir per staged item', () => {
    expect(pluginDirsIn(assembleClaudeArgs(base))).toEqual([subject, skillCreator]);
  });

  it('uses bypassPermissions and --add-dir for the sandbox', () => {
    const args = assembleClaudeArgs(base);
    expect(args).toContain(PERMISSION_MODE);
    expect(valueAfter(args, PERMISSION_MODE)).toBe('bypassPermissions');
    expect(valueAfter(args, '--add-dir')).toBe(sandboxPath);
  });

  it('never includes --prompt-file and never references the prompt file in argv (prompt is fed via stdin)', () => {
    const args = assembleClaudeArgs(base);
    // claude 2.x has no --prompt-file flag; the prompt is piped to stdin.
    expect(args).not.toContain('--prompt-file');
    // The prompt path must not appear anywhere in argv.
    expect(args.some(a => a.includes('experimenter-prompt.txt'))).toBe(false);
    // sanity: the prompt content is not inlined
    expect(args.join(' ')).not.toContain('STOP');
  });

  it('includes caps when provided', () => {
    const args = assembleClaudeArgs({ ...base, maxTurns: 30, maxBudgetUsd: 2, model: MODEL_VALUE });
    expect(valueAfter(args, MAX_TURNS)).toBe('30');
    expect(valueAfter(args, MAX_BUDGET)).toBe('2');
    expect(valueAfter(args, MODEL)).toBe(MODEL_VALUE);
  });

  it('omits caps when not provided', () => {
    const args = assembleClaudeArgs(base);
    expect(args).not.toContain(MAX_TURNS);
    expect(args).not.toContain(MAX_BUDGET);
    expect(args).not.toContain(MODEL);
  });

  it('emits the base args in the fixed expected order', () => {
    const args = assembleClaudeArgs({ pluginDirs: [], sandboxDir: sandboxPath });
    expect(args).toEqual([
      '-p',
      OUTPUT_FORMAT, 'stream-json',
      '--verbose',
      '--setting-sources', '',
      PERMISSION_MODE, 'bypassPermissions',
      '--add-dir', sandboxPath,
    ]);
  });

  it('emits no --plugin-dir when pluginDirs is empty', () => {
    expect(assembleClaudeArgs({ pluginDirs: [], sandboxDir: sandboxPath })).not.toContain(PLUGIN_DIR);
  });

  it('emits a single --plugin-dir pair for one staged item', () => {
    expect(pluginDirsIn(assembleClaudeArgs({ pluginDirs: [subject], sandboxDir: sandboxPath }))).toEqual([subject]);
  });

  it('includes --model alone when only model is set', () => {
    const args = assembleClaudeArgs({ ...base, model: MODEL_VALUE });
    expect(valueAfter(args, MODEL)).toBe(MODEL_VALUE);
    expect(valueAfter(args, MAX_TURNS)).toBeUndefined();
    expect(valueAfter(args, MAX_BUDGET)).toBeUndefined();
  });

  it('includes --max-turns alone (stringified) when only maxTurns is set', () => {
    const args = assembleClaudeArgs({ ...base, maxTurns: 7 });
    expect(valueAfter(args, MAX_TURNS)).toBe('7');
    expect(valueAfter(args, MODEL)).toBeUndefined();
    expect(valueAfter(args, MAX_BUDGET)).toBeUndefined();
  });

  it('includes --max-budget-usd alone (stringified) when only maxBudgetUsd is set', () => {
    const args = assembleClaudeArgs({ ...base, maxBudgetUsd: 1.5 });
    expect(valueAfter(args, MAX_BUDGET)).toBe('1.5');
    expect(valueAfter(args, MODEL)).toBeUndefined();
    expect(valueAfter(args, MAX_TURNS)).toBeUndefined();
  });
});
