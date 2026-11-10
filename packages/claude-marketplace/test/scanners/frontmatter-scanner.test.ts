import { describe, expect, it } from 'vitest';

import { scanFrontmatter } from '../../src/scanners/frontmatter-scanner.js';
import { TEST_LOCATION_ROOT } from '../test-helpers.js';

describe('scanFrontmatter', () => {
  it('returns empty array for skill with no compatibility-relevant frontmatter', async () => {
    const content = [
      '---',
      'name: simple-skill',
      'description: A simple skill',
      '---',
      '# Simple Skill',
    ].join('\n');

    const result = await scanFrontmatter(content, 'skills/simple/SKILL.md', TEST_LOCATION_ROOT, {});
    expect(result).toEqual([]);
  });

  it('detects Bash in allowed-tools as ALLOWED_TOOLS_LOCAL_SHELL evidence', async () => {
    const content = [
      '---',
      'name: code-skill',
      'description: Needs bash',
      'allowed-tools: [Bash, Read, Write]',
      '---',
    ].join('\n');

    const result = await scanFrontmatter(content, 'SKILL.md', TEST_LOCATION_ROOT, {});
    const evidence = result.find(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL');
    expect(evidence).toBeDefined();
    expect(evidence?.location.file).toBe('SKILL.md');
  });

  it.each(['Edit', 'Write'])('detects %s in allowed-tools as ALLOWED_TOOLS_LOCAL_SHELL evidence', async (tool) => {
    const content = [
      '---',
      `name: ${tool.toLowerCase()}-skill`,
      `description: Needs ${tool.toLowerCase()}`,
      `allowed-tools: [${tool}, Read]`,
      '---',
    ].join('\n');

    const result = await scanFrontmatter(content, 'SKILL.md', TEST_LOCATION_ROOT, {});
    expect(result.some(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')).toBe(true);
  });

  it('ignores Read and other non-restricted tools in allowed-tools', async () => {
    const content = [
      '---',
      'name: read-only',
      'description: Read only',
      'allowed-tools: [Read, Glob, Grep]',
      '---',
    ].join('\n');

    const result = await scanFrontmatter(content, 'SKILL.md', TEST_LOCATION_ROOT, {});
    expect(result).toEqual([]);
  });

  it('handles frontmatter without allowed-tools', async () => {
    const content = [
      '---',
      'name: basic',
      'description: Basic skill',
      'model: sonnet',
      '---',
    ].join('\n');

    const result = await scanFrontmatter(content, 'SKILL.md', TEST_LOCATION_ROOT, {});
    expect(result).toEqual([]);
  });

  it('handles malformed frontmatter gracefully', async () => {
    const content = '---\ninvalid yaml: [[[bad\n---\n# Content';
    const result = await scanFrontmatter(content, 'SKILL.md', TEST_LOCATION_ROOT, {});
    expect(Array.isArray(result)).toBe(true);
  });
});
