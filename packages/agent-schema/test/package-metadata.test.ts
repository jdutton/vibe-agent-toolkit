import { describe, expect, it } from 'vitest';

import {
  VatAgentMetadataSchema,
  VatPackageMetadataSchema,
  VatPureFunctionMetadataSchema,
  VatSkillMetadataSchema,
} from '../src/package-metadata.js';

// Test constants to avoid string duplication
const TEST_SKILL_NAME = 'vat-cat-agents';
// eslint-disable-next-line sonarjs/no-duplicate-string -- Constant definition for test data
const TEST_SKILL_SOURCE = './resources/skills/SKILL.md';
const TEST_SKILL_PATH = './dist/skills/vat-cat-agents';
const TEST_AGENT_NAME = 'agent-generator';
const TEST_AGENT_PATH = './agents/agent-generator';
const TEST_FUNCTION_NAME = 'haiku-validator';
const TEST_FUNCTION_PATH = './dist/pure-functions/haiku-validator';
const VAT_VERSION = '1.0';
const AGENT_BUNDLE_TYPE = 'agent-bundle' as const;

describe('VatSkillMetadataSchema', () => {
  it('should validate valid skill metadata', () => {
    const validSkill = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
    };

    const result = VatSkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it('should reject skill metadata with missing required fields', () => {
    const invalidSkill = {
      name: TEST_SKILL_NAME,
      // Missing source and path
    };

    const result = VatSkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });

  it('should reject empty skill name', () => {
    const invalidSkill = {
      name: '',
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
    };

    const result = VatSkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });
});

describe('VatAgentMetadataSchema', () => {
  it('should validate valid agent metadata with type', () => {
    const validAgent = {
      name: TEST_AGENT_NAME,
      path: TEST_AGENT_PATH,
      type: 'meta-agent',
    };

    const result = VatAgentMetadataSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it('should validate valid agent metadata without type', () => {
    const validAgent = {
      name: TEST_AGENT_NAME,
      path: TEST_AGENT_PATH,
    };

    const result = VatAgentMetadataSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it('should reject agent metadata with missing required fields', () => {
    const invalidAgent = {
      name: TEST_AGENT_NAME,
      // Missing path
    };

    const result = VatAgentMetadataSchema.safeParse(invalidAgent);
    expect(result.success).toBe(false);
  });
});

describe('VatPureFunctionMetadataSchema', () => {
  it('should validate valid pure function metadata with exports', () => {
    const validPureFunction = {
      name: TEST_FUNCTION_NAME,
      path: TEST_FUNCTION_PATH,
      exports: {
        mcp: './dist/mcp-servers/haiku-validator.js',
        cli: 'vat-cat-agents haiku-validate',
      },
    };

    const result = VatPureFunctionMetadataSchema.safeParse(validPureFunction);
    expect(result.success).toBe(true);
  });

  it('should validate pure function metadata without exports', () => {
    const validPureFunction = {
      name: TEST_FUNCTION_NAME,
      path: TEST_FUNCTION_PATH,
    };

    const result = VatPureFunctionMetadataSchema.safeParse(validPureFunction);
    expect(result.success).toBe(true);
  });

  it('should validate pure function metadata with partial exports', () => {
    const validPureFunction = {
      name: TEST_FUNCTION_NAME,
      path: TEST_FUNCTION_PATH,
      exports: {
        mcp: './dist/mcp-servers/haiku-validator.js',
      },
    };

    const result = VatPureFunctionMetadataSchema.safeParse(validPureFunction);
    expect(result.success).toBe(true);
  });
});

describe('VatPackageMetadataSchema', () => {
  it('should validate vat-example-cat-agents metadata (skills only)', () => {
    const catAgentsMetadata = {
      version: VAT_VERSION,
      type: AGENT_BUNDLE_TYPE,
      skills: [
        {
          name: TEST_SKILL_NAME,
          source: TEST_SKILL_SOURCE,
          path: TEST_SKILL_PATH,
        },
      ],
    };

    const result = VatPackageMetadataSchema.safeParse(catAgentsMetadata);
    expect(result.success).toBe(true);
  });

  it('should validate vat-development-agents metadata (skills + agents)', () => {
    const devAgentsMetadata = {
      version: VAT_VERSION,
      type: AGENT_BUNDLE_TYPE,
      skills: [
        {
          name: 'vibe-agent-toolkit',
          source: './resources/skills/SKILL.md',
          path: './dist/skills/vibe-agent-toolkit',
        },
      ],
      agents: [
        {
          name: 'agent-generator',
          path: './agents/agent-generator',
          type: 'meta-agent',
        },
        {
          name: 'resource-optimizer',
          path: './agents/resource-optimizer',
          type: 'pure-function',
        },
      ],
    };

    const result = VatPackageMetadataSchema.safeParse(devAgentsMetadata);
    expect(result.success).toBe(true);
  });

  it('should validate complete metadata with all artifact types', () => {
    const completeMetadata = {
      version: VAT_VERSION,
      type: 'toolkit' as const,
      skills: [
        {
          name: 'my-skill',
          source: './resources/skills/SKILL.md',
          path: './dist/skills/my-skill',
        },
      ],
      agents: [
        {
          name: 'my-agent',
          path: './agents/my-agent',
          type: 'llm-analyzer',
        },
      ],
      pureFunctions: [
        {
          name: 'my-function',
          path: './dist/pure-functions/my-function',
          exports: {
            mcp: './dist/mcp-servers/my-function.js',
            cli: 'my-package my-function',
          },
        },
      ],
      runtimes: ['vercel-ai-sdk', 'langchain', 'openai', 'claude-agent-sdk'],
    };

    const result = VatPackageMetadataSchema.safeParse(completeMetadata);
    expect(result.success).toBe(true);
  });

  it('should reject metadata with invalid version format', () => {
    const invalidMetadata = {
      version: '1.0.0', // Should be "1.0" not "1.0.0"
      type: 'agent-bundle' as const,
    };

    const result = VatPackageMetadataSchema.safeParse(invalidMetadata);
    expect(result.success).toBe(false);
  });

  it('should reject metadata with invalid type', () => {
    const invalidMetadata = {
      version: '1.0',
      type: 'invalid-type',
    };

    const result = VatPackageMetadataSchema.safeParse(invalidMetadata);
    expect(result.success).toBe(false);
  });

  it('should reject metadata with missing required fields', () => {
    const invalidMetadata = {
      // Missing version and type
      skills: [],
    };

    const result = VatPackageMetadataSchema.safeParse(invalidMetadata);
    expect(result.success).toBe(false);
  });

  it('should validate metadata with empty optional arrays', () => {
    const minimalMetadata = {
      version: VAT_VERSION,
      type: 'skill' as const,
      skills: [],
      agents: [],
      pureFunctions: [],
      runtimes: [],
    };

    const result = VatPackageMetadataSchema.safeParse(minimalMetadata);
    expect(result.success).toBe(true);
  });

  it('should validate minimal metadata (only required fields)', () => {
    const minimalMetadata = {
      version: VAT_VERSION,
      type: 'runtime' as const,
    };

    const result = VatPackageMetadataSchema.safeParse(minimalMetadata);
    expect(result.success).toBe(true);
  });
});
