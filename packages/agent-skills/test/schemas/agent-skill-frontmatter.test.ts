import { describe, expect, it } from 'vitest';

import {
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema,
} from '../../src/schemas/agent-skill-frontmatter.js';

const TEST_SKILL_NAME = 'test-skill';
const TEST_DESCRIPTION = 'A skill';

describe('AgentSkillFrontmatterSchema', () => {
  describe('Claude Code frontmatter fields', () => {
    it('accepts argument-hint field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, 'argument-hint': 'Enter a URL' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts disable-model-invocation boolean', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, 'disable-model-invocation': true };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts user-invocable boolean', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, 'user-invocable': false };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts model field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, model: 'sonnet' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts context field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, context: 'fork' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts agent field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, agent: 'code-reviewer' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts hooks object', () => {
      const fm = {
        name: TEST_SKILL_NAME,
        description: TEST_DESCRIPTION,
        hooks: {
          PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo done' }] }],
        },
      };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts a complete real-world Claude Code skill frontmatter', () => {
      const fm = {
        name: 'code-reviewer',
        description: 'Reviews code changes for quality',
        'allowed-tools': 'Read, Glob, Grep, Bash',
        model: 'opus',
        'user-invocable': true,
        'argument-hint': 'Describe what to review',
        context: 'fork',
      };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });
  });

  describe('agentskills.io fields', () => {
    it('accepts license field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, license: 'MIT' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts compatibility field', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, compatibility: 'Requires git' };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts metadata record', () => {
      const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION, metadata: { version: '1.0.0' } };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });
  });

  describe('optional name and description', () => {
    it('accepts frontmatter without name (defaults to directory name)', () => {
      const fm = { description: TEST_DESCRIPTION };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts frontmatter without description', () => {
      const fm = { name: TEST_SKILL_NAME };
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });

    it('accepts empty frontmatter', () => {
      const fm = {};
      expect(AgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
    });
  });

  describe('validation', () => {
    it('rejects name with uppercase', () => {
      const fm = { name: 'TestSkill', description: TEST_DESCRIPTION };
      const result = AgentSkillFrontmatterSchema.safeParse(fm);
      expect(result.success).toBe(false);
    });

    it('rejects name longer than 64 chars', () => {
      const fm = { name: 'a'.repeat(65), description: TEST_DESCRIPTION };
      const result = AgentSkillFrontmatterSchema.safeParse(fm);
      expect(result.success).toBe(false);
    });
  });
});

describe('VATAgentSkillFrontmatterSchema', () => {
  it('requires metadata.version', () => {
    const fm = { name: TEST_SKILL_NAME, description: TEST_DESCRIPTION };
    const result = VATAgentSkillFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(false);
  });

  it('accepts VAT skill with version', () => {
    const fm = {
      name: TEST_SKILL_NAME,
      description: TEST_DESCRIPTION,
      metadata: { version: '1.0.0' },
    };
    expect(VATAgentSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
  });

  it('requires name for VAT skills', () => {
    const fm = { description: TEST_DESCRIPTION, metadata: { version: '1.0.0' } };
    const result = VATAgentSkillFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(false);
  });

  it('requires description for VAT skills', () => {
    const fm = { name: TEST_SKILL_NAME, metadata: { version: '1.0.0' } };
    const result = VATAgentSkillFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(false);
  });
});
