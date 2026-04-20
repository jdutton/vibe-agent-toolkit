/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
/* eslint-disable sonarjs/no-duplicate-string -- Test fixtures intentionally reuse path/content literals across cases */
/**
 * Unit tests for description-style-detection.ts
 *
 * SKILL_DESCRIPTION_STALE_IN_PACKAGE — detects when a package of sibling skills
 * mixes YAML scalar styles across their `description` frontmatter lines.
 *
 * The detector is standalone pending pipeline wiring — it is exercised here so
 * the classifier stays correct, and so the follow-up wiring task only has to
 * connect the call site.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyDescriptionYamlStyle,
  detectMixedDescriptionStyles,
} from '../../src/validators/description-style-detection.js';

describe('classifyDescriptionYamlStyle', () => {
  it('classifies folded style with >-', () => {
    expect(classifyDescriptionYamlStyle('description: >-\n  inline text')).toBe('folded');
  });

  it('classifies folded style with >', () => {
    expect(classifyDescriptionYamlStyle('description: >\n  text')).toBe('folded');
  });

  it('classifies literal style with |', () => {
    expect(classifyDescriptionYamlStyle('description: |\n  text')).toBe('literal');
  });

  it('classifies literal style with |-', () => {
    expect(classifyDescriptionYamlStyle('description: |-\n  text')).toBe('literal');
  });

  it('classifies inline double-quoted', () => {
    expect(classifyDescriptionYamlStyle('description: "double quoted"')).toBe('inline-double');
  });

  it('classifies inline single-quoted', () => {
    expect(classifyDescriptionYamlStyle("description: 'single quoted'")).toBe('inline-single');
  });

  it('classifies inline plain', () => {
    expect(classifyDescriptionYamlStyle('description: plain text no quotes')).toBe('inline-plain');
  });

  it('returns null when no description line is present', () => {
    expect(classifyDescriptionYamlStyle('name: my-skill\n')).toBe(null);
  });

  it('tolerates trailing whitespace on the marker', () => {
    expect(classifyDescriptionYamlStyle('description: >-   \n  text')).toBe('folded');
  });
});

describe('detectMixedDescriptionStyles', () => {
  it('returns no issues when all skills share one style', () => {
    const issues = detectMixedDescriptionStyles([
      { path: '/a/SKILL.md', rawContent: '---\nname: a\ndescription: >-\n  desc a\n---\n' },
      { path: '/b/SKILL.md', rawContent: '---\nname: b\ndescription: >-\n  desc b\n---\n' },
    ]);
    expect(issues).toHaveLength(0);
  });

  it('fires on every skill when styles are mixed across the package', () => {
    const issues = detectMixedDescriptionStyles([
      { path: '/a/SKILL.md', rawContent: '---\nname: a\ndescription: >-\n  desc a\n---\n' },
      { path: '/b/SKILL.md', rawContent: '---\nname: b\ndescription: "desc b inline"\n---\n' },
    ]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.code).toBe('SKILL_DESCRIPTION_STALE_IN_PACKAGE');
      expect(issue.severity).toBe('warning');
      expect(issue.message).toContain('mixed YAML styles');
    }
    expect(issues.map((i) => i.location)).toEqual(['/a/SKILL.md', '/b/SKILL.md']);
  });

  it('reports the observed style set in the message', () => {
    const issues = detectMixedDescriptionStyles([
      { path: '/a/SKILL.md', rawContent: '---\ndescription: >-\n  d\n---\n' },
      { path: '/b/SKILL.md', rawContent: '---\ndescription: "d"\n---\n' },
      { path: '/c/SKILL.md', rawContent: '---\ndescription: plain\n---\n' },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain('folded');
    expect(issues[0]!.message).toContain('inline-double');
    expect(issues[0]!.message).toContain('inline-plain');
  });

  it('skips skills whose description style could not be classified', () => {
    const issues = detectMixedDescriptionStyles([
      { path: '/a/SKILL.md', rawContent: '---\nname: a\n---\n' },
      { path: '/b/SKILL.md', rawContent: '---\ndescription: >-\n  d\n---\n' },
    ]);
    // only one style observed — no mixing
    expect(issues).toHaveLength(0);
  });

  it('returns no issues for a single-skill package', () => {
    const issues = detectMixedDescriptionStyles([
      { path: '/a/SKILL.md', rawContent: '---\ndescription: >-\n  d\n---\n' },
    ]);
    expect(issues).toHaveLength(0);
  });
});
