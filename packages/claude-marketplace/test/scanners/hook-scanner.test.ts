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

  it('detects python3 in command handler', () => {
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
    expect(result[0]).toMatchObject({
      source: 'hook',
      signal: 'hook-command: python3',
      impact: {
        'claude-desktop': 'needs-review',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('detects bash in command handler', () => {
    const config = {
      hooks: {
        PostToolUse: [{
          type: 'command',
          command: 'bash scripts/validate.sh',
        }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result[0]?.signal).toBe('hook-command: bash');
  });

  it('treats node handlers as compatible everywhere', () => {
    const config = {
      hooks: {
        PostToolUse: [{
          type: 'command',
          command: 'node scripts/check.mjs',
        }],
      },
    };
    const result = scanHooksConfig(config, HOOKS_FILE);
    expect(result[0]?.impact['claude-desktop']).toBe('ok');
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
