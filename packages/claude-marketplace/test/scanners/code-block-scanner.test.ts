import { describe, expect, it } from 'vitest';

import { scanCodeBlocks } from '../../src/scanners/code-block-scanner.js';
import { bashCodeBlock } from '../test-helpers.js';

describe('scanCodeBlocks', () => {
  it('returns empty array for markdown with no code blocks', () => {
    const content = '# Hello\n\nThis is plain markdown with no code.';
    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toEqual([]);
  });

  it('emits FENCED_SHELL_BLOCK evidence for a bash code block', () => {
    const result = scanCodeBlocks(bashCodeBlock('python3 scripts/calc.py'), 'SKILL.md');
    expect(result.some(e => e.patternId === 'FENCED_SHELL_BLOCK')).toBe(true);
  });

  it('emits EXTERNAL_CLI_AZ for an az invocation in a shell block', () => {
    const result = scanCodeBlocks(bashCodeBlock('az group list'), 'SKILL.md');
    expect(result.some(e => e.patternId === 'EXTERNAL_CLI_AZ')).toBe(true);
  });

  it('emits BROWSER_AUTH_AZ_LOGIN for an az login invocation', () => {
    const result = scanCodeBlocks(bashCodeBlock('az login'), 'SKILL.md');
    expect(result.some(e => e.patternId === 'BROWSER_AUTH_AZ_LOGIN')).toBe(true);
  });

  it('records location with file path and line number', () => {
    const content = [
      '# Usage',
      '',
      '```bash',
      'python3 scripts/unit-economics.py',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'skills/finance/SKILL.md');
    const fenced = result.find(e => e.patternId === 'FENCED_SHELL_BLOCK');
    expect(fenced?.location.file).toBe('skills/finance/SKILL.md');
    expect(fenced?.location.line).toBeGreaterThan(0);
  });

  it('handles multiple code blocks in one file', () => {
    const content = [
      '```bash',
      'az group list',
      '```',
      '',
      'Some text',
      '',
      '```bash',
      'aws s3 ls',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result.some(e => e.patternId === 'EXTERNAL_CLI_AZ')).toBe(true);
    expect(result.some(e => e.patternId === 'EXTERNAL_CLI_AWS')).toBe(true);
  });

  it('ignores non-executable code blocks (json, yaml, etc.)', () => {
    const content = [
      '```json',
      '{"command": "python3", "args": ["server.py"]}',
      '```',
      '',
      '```yaml',
      'runtime: python3',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toEqual([]);
  });
});
