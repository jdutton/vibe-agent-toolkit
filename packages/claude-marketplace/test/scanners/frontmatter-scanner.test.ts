import { describe, expect, it } from 'vitest';

import { scanFrontmatter } from '../../src/scanners/frontmatter-scanner.js';

describe('scanFrontmatter', () => {
  it('returns empty array for skill with no compatibility-relevant frontmatter', () => {
    const content = [
      '---',
      'name: simple-skill',
      'description: A simple skill',
      '---',
      '# Simple Skill',
    ].join('\n');

    const result = scanFrontmatter(content, 'skills/simple/SKILL.md');
    expect(result).toEqual([]);
  });

  it('detects Bash in allowed-tools as ALLOWED_TOOLS_LOCAL_SHELL evidence', () => {
    const content = [
      '---',
      'name: code-skill',
      'description: Needs bash',
      'allowed-tools: [Bash, Read, Write]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    const evidence = result.find(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL');
    expect(evidence).toBeDefined();
    expect(evidence?.location.file).toBe('SKILL.md');
  });

  it('detects Edit in allowed-tools as ALLOWED_TOOLS_LOCAL_SHELL evidence', () => {
    const content = [
      '---',
      'name: edit-skill',
      'description: Needs edit',
      'allowed-tools: [Edit, Read]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    expect(result.some(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')).toBe(true);
  });

  it('detects Write in allowed-tools as ALLOWED_TOOLS_LOCAL_SHELL evidence', () => {
    const content = [
      '---',
      'name: write-skill',
      'description: Needs write',
      'allowed-tools: [Write, Read]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    expect(result.some(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')).toBe(true);
  });

  it('ignores Read and other non-restricted tools in allowed-tools', () => {
    const content = [
      '---',
      'name: read-only',
      'description: Read only',
      'allowed-tools: [Read, Glob, Grep]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    expect(result).toEqual([]);
  });

  it('handles frontmatter without allowed-tools', () => {
    const content = [
      '---',
      'name: basic',
      'description: Basic skill',
      'model: sonnet',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    expect(result).toEqual([]);
  });

  it('handles malformed frontmatter gracefully', () => {
    const content = '---\ninvalid yaml: [[[bad\n---\n# Content';
    const result = scanFrontmatter(content, 'SKILL.md');
    expect(Array.isArray(result)).toBe(true);
  });
});
