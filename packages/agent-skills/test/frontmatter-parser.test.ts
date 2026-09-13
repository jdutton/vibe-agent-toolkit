import { describe, it, expect } from 'vitest';


import { parseFrontmatter } from '../src/parsers/frontmatter-parser.js';

import { createFrontmatter, createSkillContent } from './test-helpers.js';

describe('parseFrontmatter', () => {
  it('should extract frontmatter from SKILL.md', () => {
    const content = createSkillContent(
      { name: 'my-skill', description: 'Does something useful' },
      '# Content here',
    );

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe('my-skill');
      expect(result.frontmatter.description).toBe('Does something useful');
      expect(result.body).toBe('# Content here');
    }
  });

  it('should handle frontmatter with no trailing content', () => {
    const content = createFrontmatter({ name: 'my-skill', description: 'Test' });

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.body).toBe('');
    }
  });

  it('should handle frontmatter with metadata', () => {
    const content = createFrontmatter({
      name: 'my-skill',
      description: 'Test',
      metadata: {
        version: '1.0.0',
        author: 'Jeff',
      },
    });

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.metadata).toEqual({
        version: '1.0.0',
        author: 'Jeff',
      });
    }
  });

  it('should return error if no frontmatter delimiters', () => {
    const content = `# Just content, no frontmatter`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No frontmatter found');
    }
  });

  it('should return error if frontmatter not at start', () => {
    const content = `
Some text before
---
name: my-skill
description: Test
---`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('must start at beginning');
    }
  });

  it('should return error if only opening delimiter', () => {
    const content = `---
name: my-skill
description: Test`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('closing delimiter');
    }
  });

  it('should return error if invalid YAML', () => {
    const content = `---
name: my-skill
description: [unclosed array
---`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('YAML');
    }
  });

  it('should handle Windows line endings', () => {
    const content = `---\r\nname: my-skill\r\ndescription: Test\r\n---\r\nBody`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe('my-skill');
    }
  });
});

/**
 * A `---` block whose YAML is not a MAPPING is not frontmatter. `yaml.parse`
 * answers `null` for an empty document and `~`, a string for a bare scalar and
 * an array for a sequence — and the success arm's type says `Record<string,
 * unknown>`, so every consumer dereferenced it. `validateSkill` died with
 * `Cannot read properties of null (reading 'name')` and took the whole
 * `vat audit` run with it (exit 2, no per-file result for any plugin), while
 * two other consumers had grown private `null` guards that returned "nothing
 * declared" — three readers, three answers for one file. The seam now refuses
 * the shape once, and the refusal carries what was found so the message is
 * not "no frontmatter" over a file that plainly has a `---` block.
 */
describe('parseFrontmatter — a block that is not a YAML mapping', () => {
  const NON_MAPPINGS: ReadonlyArray<readonly [label: string, block: string, found: string]> = [
    ['empty', '', 'empty'],
    ['blank line', '\n', 'empty'],
    ['explicit null', '~', 'empty'],
    ['bare scalar', 'hello', 'a scalar'],
    ['sequence', '- a\n- b', 'a sequence'],
  ];

  for (const [label, block, found] of NON_MAPPINGS) {
    it(`refuses ${label}, naming what it found`, () => {
      const result = parseFrontmatter(`---\n${block}\n---\n# body\n`);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not a YAML mapping');
        expect(result.error).toContain(found);
      }
    });
  }

  // The control: a mapping with zero interesting keys is still a mapping.
  it('still accepts a mapping', () => {
    const result = parseFrontmatter('---\nname: x\n---\n');
    expect(result.success).toBe(true);
  });
});
