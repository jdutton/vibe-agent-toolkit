import { describe, it, expect } from 'vitest';

import { parseFrontmatter } from '../src/parsers/frontmatter-parser.js';

describe('parseFrontmatter', () => {
  it('should extract frontmatter from SKILL.md', () => {
    const content = `---
name: my-skill
description: Does something useful
---

# Content here`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe('my-skill');
      expect(result.frontmatter.description).toBe('Does something useful');
      expect(result.body).toBe('\n# Content here');
    }
  });

  it('should handle frontmatter with no trailing content', () => {
    const content = `---
name: my-skill
description: Test
---`;

    const result = parseFrontmatter(content);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.body).toBe('');
    }
  });

  it('should handle frontmatter with metadata', () => {
    const content = `---
name: my-skill
description: Test
metadata:
  version: 1.0.0
  author: Jeff
---`;

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
