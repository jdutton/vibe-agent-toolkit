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

  it('detects Bash in allowed-tools as incompatible with desktop', () => {
    const content = [
      '---',
      'name: code-skill',
      'description: Needs bash',
      'allowed-tools: [Bash, Read, Write]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    const bashEvidence = result.find(e => e.signal === 'allowed-tools: Bash');
    expect(bashEvidence).toBeDefined();
    expect(bashEvidence?.impact['claude-desktop']).toBe('incompatible');
    expect(bashEvidence?.impact.cowork).toBe('needs-review');
    expect(bashEvidence?.impact['claude-code']).toBe('ok');
  });

  it('detects Edit in allowed-tools as incompatible with desktop', () => {
    const content = [
      '---',
      'name: edit-skill',
      'description: Needs edit',
      'allowed-tools: [Edit, Read]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    const editEvidence = result.find(e => e.signal === 'allowed-tools: Edit');
    expect(editEvidence).toBeDefined();
    expect(editEvidence?.impact['claude-desktop']).toBe('incompatible');
  });

  it('detects Write in allowed-tools as incompatible with desktop', () => {
    const content = [
      '---',
      'name: write-skill',
      'description: Needs write',
      'allowed-tools: [Write, Read]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    expect(result.some(e => e.signal === 'allowed-tools: Write')).toBe(true);
  });

  it('detects author-declared targets', () => {
    const content = [
      '---',
      'name: limited-skill',
      'description: Only for code',
      'targets: [claude-code, cowork]',
      '---',
    ].join('\n');

    const result = scanFrontmatter(content, 'SKILL.md');
    const declEvidence = result.find(e => e.source === 'declaration');
    expect(declEvidence).toBeDefined();
    expect(declEvidence?.impact['claude-desktop']).toBe('incompatible');
    expect(declEvidence?.impact.cowork).toBe('ok');
    expect(declEvidence?.impact['claude-code']).toBe('ok');
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

  it('handles frontmatter without allowed-tools or targets', () => {
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
