import { describe, expect, it } from 'vitest';

import { scanCodeBlocks } from '../../src/scanners/code-block-scanner.js';
import { bashCodeBlock, impact } from '../test-helpers.js';

describe('scanCodeBlocks', () => {
  it('returns empty array for markdown with no code blocks', () => {
    const content = '# Hello\n\nThis is plain markdown with no code.';
    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toEqual([]);
  });

  const NEEDS_REVIEW = impact('needs-review');

  it.each([
    { cmd: 'python3 scripts/unit-economics.py --sales-costs 500000', signal: 'python3', expected: NEEDS_REVIEW },
    { cmd: 'pip install pandas numpy', signal: 'pip install', expected: impact('incompatible') },
    { cmd: 'npm install express', signal: 'npm install', expected: NEEDS_REVIEW },
    { cmd: 'node scripts/process.mjs --input data.json', signal: 'node', expected: impact() },
    { cmd: 'bash scripts/setup.sh', signal: 'bash', expected: NEEDS_REVIEW },
  ])('detects "$signal" command in bash code block', ({ cmd, signal, expected }) => {
    const result = scanCodeBlocks(bashCodeBlock(cmd), 'SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: 'code-block', signal, impact: expected });
  });

  it('includes file path and line number in evidence', () => {
    const content = [
      '# Usage',
      '',
      '```bash',
      'python3 scripts/unit-economics.py',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'skills/finance/SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBe('skills/finance/SKILL.md');
    expect(result[0]?.line).toBeGreaterThan(0);
  });

  it('detects uv run command', () => {
    const result = scanCodeBlocks(bashCodeBlock('uv run python scripts/analyze.py'), 'SKILL.md');
    expect(result.some(e => e.signal === 'uv')).toBe(true);
  });

  it('handles multiple code blocks in one file', () => {
    const content = [
      '```bash',
      'python3 scripts/a.py',
      '```',
      '',
      'Some text',
      '',
      '```bash',
      'pip install requests',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result.length).toBeGreaterThanOrEqual(2);
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

  it('scans unlabeled code blocks for commands', () => {
    const result = scanCodeBlocks(['```', 'python3 scripts/calculate.py', '```'].join('\n'), 'SKILL.md');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
