import { describe, it, expect } from 'vitest';

import {
  ClaudeSkillFrontmatterSchema,
  VATClaudeSkillFrontmatterSchema
} from '../src/schemas/claude-skill-frontmatter.js';

describe('ClaudeSkillFrontmatterSchema', () => {
  describe('required fields', () => {
    it('should validate minimal valid frontmatter', () => {
      const data = {
        name: 'my-skill',
        description: 'Does something useful',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it('should reject missing name', () => {
      const data = {
        description: 'Does something useful',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it('should reject missing description', () => {
      const data = {
        name: 'my-skill',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(false);
    });
  });

  describe('name validation', () => {
    it('should accept valid names', () => {
      const validNames = [
        'my-skill',
        'skill-name',
        'skill-123',
        'a',
        'long-skill-name-with-many-parts',
      ];

      for (const name of validNames) {
        const result = ClaudeSkillFrontmatterSchema.safeParse({
          name,
          description: 'Test',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid names', () => {
      const invalidNames = [
        'MySkill',           // Uppercase
        'my_skill',          // Underscore
        'my--skill',         // Consecutive hyphens
        '-my-skill',         // Starts with hyphen
        'my-skill-',         // Ends with hyphen
        'my skill',          // Space
        'a'.repeat(65),      // Too long (>64 chars)
      ];

      for (const name of invalidNames) {
        const result = ClaudeSkillFrontmatterSchema.safeParse({
          name,
          description: 'Test',
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('description validation', () => {
    it('should accept valid descriptions', () => {
      const data = {
        name: 'my-skill',
        description: 'A short description',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it('should reject empty description', () => {
      const data = {
        name: 'my-skill',
        description: '',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it('should reject too long description', () => {
      const data = {
        name: 'my-skill',
        description: 'x'.repeat(1025),
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    it('should accept license field', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        license: 'MIT',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it('should accept compatibility field', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        compatibility: 'Requires git and docker',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it('should accept metadata field', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        metadata: {
          version: '1.0.0',
          author: 'Test',
        },
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it('should accept allowed-tools field', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        'allowed-tools': 'Bash Read Write',
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });
  });

  describe('strict mode (console compatibility)', () => {
    it('should reject unknown top-level fields', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        version: '1.0.0', // Should be in metadata
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it('should allow custom fields in metadata', () => {
      const data = {
        name: 'my-skill',
        description: 'Test',
        metadata: {
          version: '1.0.0',
          customField: 'value',
        },
      };

      const result = ClaudeSkillFrontmatterSchema.safeParse(data);

      expect(result.success).toBe(true);
    });
  });
});

describe('VATClaudeSkillFrontmatterSchema', () => {
  it('should require metadata.version', () => {
    const data = {
      name: 'my-skill',
      description: 'Test',
      metadata: {
        author: 'Jeff',
      },
    };

    const result = VATClaudeSkillFrontmatterSchema.safeParse(data);

    expect(result.success).toBe(false);
  });

  it('should validate with metadata.version', () => {
    const data = {
      name: 'my-skill',
      description: 'Test',
      metadata: {
        version: '1.0.0',
      },
    };

    const result = VATClaudeSkillFrontmatterSchema.safeParse(data);

    expect(result.success).toBe(true);
  });

  it('should allow additional metadata fields', () => {
    const data = {
      name: 'my-skill',
      description: 'Test',
      metadata: {
        version: '1.0.0',
        author: 'Jeff',
        custom: 'value',
      },
    };

    const result = VATClaudeSkillFrontmatterSchema.safeParse(data);

    expect(result.success).toBe(true);
  });
});
