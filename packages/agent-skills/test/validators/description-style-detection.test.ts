/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
/**
 * Unit tests for description-style-detection.ts
 *
 * SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE — detects when a package of sibling skills
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

/** Build a SKILL.md fixture record with `description:` in a particular YAML scalar style. */
function skillFixture(
  path: string,
  descriptionBlock: string,
  preamble = '',
): { path: string; rawContent: string } {
  const rawContent = `---\n${preamble}description: ${descriptionBlock}\n---\n`;
  return { path, rawContent };
}

/** Classify a `description:` block by wrapping it in the expected prefix. */
function classify(descriptionBlock: string): ReturnType<typeof classifyDescriptionYamlStyle> {
  return classifyDescriptionYamlStyle(`description: ${descriptionBlock}`);
}

const PATH_A = '/a/SKILL.md';
const PATH_B = '/b/SKILL.md';
const PATH_C = '/c/SKILL.md';

describe('classifyDescriptionYamlStyle', () => {
  it('classifies folded style with >-', () => {
    expect(classify('>-\n  inline text')).toBe('folded');
  });

  it('classifies folded style with >', () => {
    expect(classify('>\n  text')).toBe('folded');
  });

  it('classifies literal style with |', () => {
    expect(classify('|\n  text')).toBe('literal');
  });

  it('classifies literal style with |-', () => {
    expect(classify('|-\n  text')).toBe('literal');
  });

  it('classifies inline double-quoted', () => {
    expect(classify('"double quoted"')).toBe('inline-double');
  });

  it('classifies inline single-quoted', () => {
    expect(classify("'single quoted'")).toBe('inline-single');
  });

  it('classifies inline plain', () => {
    expect(classify('plain text no quotes')).toBe('inline-plain');
  });

  it('returns null when no description line is present', () => {
    expect(classifyDescriptionYamlStyle('name: my-skill\n')).toBe(null);
  });

  it('tolerates trailing whitespace on the marker', () => {
    expect(classify('>-   \n  text')).toBe('folded');
  });
});

describe('detectMixedDescriptionStyles', () => {
  it('returns no issues when all skills share one style', () => {
    const issues = detectMixedDescriptionStyles([
      skillFixture(PATH_A, '>-\n  desc a', 'name: a\n'),
      skillFixture(PATH_B, '>-\n  desc b', 'name: b\n'),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('fires on every skill when styles are mixed across the package', () => {
    const issues = detectMixedDescriptionStyles([
      skillFixture(PATH_A, '>-\n  desc a', 'name: a\n'),
      skillFixture(PATH_B, '"desc b inline"', 'name: b\n'),
    ]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.code).toBe('SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE');
      expect(issue.severity).toBe('warning');
      expect(issue.message).toContain('mixed YAML styles');
    }
    expect(issues.map((i) => i.location)).toEqual([PATH_A, PATH_B]);
  });

  it('reports the observed style set in the message', () => {
    const issues = detectMixedDescriptionStyles([
      skillFixture(PATH_A, '>-\n  d'),
      skillFixture(PATH_B, '"d"'),
      skillFixture(PATH_C, 'plain'),
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain('folded');
    expect(issues[0]!.message).toContain('inline-double');
    expect(issues[0]!.message).toContain('inline-plain');
  });

  it('skips skills whose description style could not be classified', () => {
    const issues = detectMixedDescriptionStyles([
      { path: PATH_A, rawContent: '---\nname: a\n---\n' },
      skillFixture(PATH_B, '>-\n  d'),
    ]);
    // only one style observed — no mixing
    expect(issues).toHaveLength(0);
  });

  it('returns no issues for a single-skill package', () => {
    const issues = detectMixedDescriptionStyles([skillFixture(PATH_A, '>-\n  d')]);
    expect(issues).toHaveLength(0);
  });
});
