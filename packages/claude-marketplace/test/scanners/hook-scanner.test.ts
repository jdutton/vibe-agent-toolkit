import { describe, expect, it } from 'vitest';

import { scanHooksConfig } from '../../src/scanners/hook-scanner.js';

const HOOKS_FILE = 'hooks/hooks.json';

describe('scanHooksConfig', () => {
  it('returns empty for hooks with no command handlers', () => {
    const config = {
      hooks: {
        PreToolUse: [{ type: 'prompt', prompt: 'Check safety' }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result).toEqual([]);
  });

  it('detects python3 in command handler as HOOK_COMMAND_INVOKES_BINARY evidence', () => {
    const config = {
      hooks: {
        SessionStart: [{
          type: 'command',
          command: 'python3 scripts/setup.py',
        }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result).toHaveLength(1);
    expect(result[0]?.patternId).toBe('HOOK_COMMAND_INVOKES_BINARY');
    expect(result[0]?.matchText).toContain('python3');
  });

  it('detects bash in command handler as HOOK_COMMAND_INVOKES_BINARY evidence', () => {
    const config = {
      hooks: {
        PostToolUse: [{
          type: 'command',
          command: 'bash scripts/validate.sh',
        }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result[0]?.patternId).toBe('HOOK_COMMAND_INVOKES_BINARY');
    expect(result[0]?.matchText).toContain('bash');
  });

  it('records node handler invocations as HOOK_COMMAND_INVOKES_BINARY (any binary is recorded)', () => {
    const config = {
      hooks: {
        PostToolUse: [{
          type: 'command',
          command: 'node scripts/check.mjs',
        }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result[0]?.patternId).toBe('HOOK_COMMAND_INVOKES_BINARY');
  });

  it('handles multiple hooks across multiple events', () => {
    const config = {
      hooks: {
        SessionStart: [
          { type: 'command', command: 'python3 scripts/init.py' },
        ],
        PostToolUse: [
          { type: 'command', command: 'bash scripts/lint.sh' },
        ],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('handles malformed config gracefully', () => {
    const result = scanHooksConfig({}, HOOKS_FILE);
    expect(result).toEqual([]);
  });
});
