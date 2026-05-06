import { describe, expect, it } from 'vitest';

import { detectMissingRecommendedFields } from '../../src/validators/plugin-recommended-fields.js';

const PLUGIN_JSON_LOC = '/plugin/.claude-plugin/plugin.json';

describe('detectMissingRecommendedFields', () => {
  it('emits all three codes when description, author, and license are absent', () => {
    const issues = detectMissingRecommendedFields(
      { name: 'my-plugin', version: '1.0.0' },
      PLUGIN_JSON_LOC,
    );
    const codes = issues.map((i) => i.code).sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual([
      'PLUGIN_MISSING_AUTHOR',
      'PLUGIN_MISSING_DESCRIPTION',
      'PLUGIN_MISSING_LICENSE',
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe('info');
      expect(issue.location).toBe(PLUGIN_JSON_LOC);
      expect(issue.fix).toBeDefined();
    }
  });

  it('emits only PLUGIN_MISSING_AUTHOR when description and license are present', () => {
    const issues = detectMissingRecommendedFields(
      {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        license: 'MIT',
      },
      PLUGIN_JSON_LOC,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PLUGIN_MISSING_AUTHOR');
  });

  it('treats author with no name as missing', () => {
    const issues = detectMissingRecommendedFields(
      {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'x',
        license: 'MIT',
        author: {},
      },
      PLUGIN_JSON_LOC,
    );
    expect(issues.map((i) => i.code)).toContain('PLUGIN_MISSING_AUTHOR');
  });

  it('accepts author with only a name', () => {
    const issues = detectMissingRecommendedFields(
      {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'x',
        license: 'MIT',
        author: { name: 'Jane Doe' },
      },
      PLUGIN_JSON_LOC,
    );
    expect(issues).toHaveLength(0);
  });

  it('treats empty-string description and license as missing', () => {
    const issues = detectMissingRecommendedFields(
      {
        name: 'my-plugin',
        version: '1.0.0',
        description: '',
        license: '',
        author: { name: 'x' },
      },
      PLUGIN_JSON_LOC,
    );
    const codes = issues.map((i) => i.code).sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(['PLUGIN_MISSING_DESCRIPTION', 'PLUGIN_MISSING_LICENSE']);
  });
});
