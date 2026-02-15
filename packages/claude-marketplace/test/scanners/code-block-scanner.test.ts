import { describe, expect, it } from 'vitest';

import { scanCodeBlocks } from '../../src/scanners/code-block-scanner.js';

const NEEDS_REVIEW = 'needs-review';

describe('scanCodeBlocks', () => {
  it('returns empty array for markdown with no code blocks', () => {
    const content = '# Hello\n\nThis is plain markdown with no code.';
    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toEqual([]);
  });

  it('detects python3 command in bash code block', () => {
    const content = [
      '# Usage',
      '',
      '```bash',
      'python3 scripts/unit-economics.py --sales-costs 500000',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'skills/finance/SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'code-block',
      file: 'skills/finance/SKILL.md',
      signal: 'python3',
      impact: {
        'claude-desktop': NEEDS_REVIEW,
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
    expect(result[0]?.line).toBeGreaterThan(0);
  });

  it('detects pip install as incompatible with desktop', () => {
    const content = [
      '```bash',
      'pip install pandas numpy',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal: 'pip install',
      impact: {
        'claude-desktop': 'incompatible',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('detects npm install as needs-review for desktop', () => {
    const content = [
      '```bash',
      'npm install express',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal: 'npm install',
      impact: {
        'claude-desktop': NEEDS_REVIEW,
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('treats node commands as compatible everywhere', () => {
    const content = [
      '```bash',
      'node scripts/process.mjs --input data.json',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal: 'node',
      impact: {
        'claude-desktop': 'ok',
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('detects bash/sh script invocation', () => {
    const content = [
      '```bash',
      'bash scripts/setup.sh',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal: 'bash',
      impact: {
        'claude-desktop': NEEDS_REVIEW,
        cowork: 'ok',
        'claude-code': 'ok',
      },
    });
  });

  it('detects uv run command', () => {
    const content = [
      '```bash',
      'uv run python scripts/analyze.py',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
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
    const content = [
      '```',
      'python3 scripts/calculate.py',
      '```',
    ].join('\n');

    const result = scanCodeBlocks(content, 'SKILL.md');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
