import { describe, expect, it } from 'vitest';

import {
  PackagingOptionsSchema,
  ValidationOverrideSchema,
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

describe('ValidationOverrideSchema', () => {
  it('should validate simple string override', () => {
    const simpleOverride = 'Acceptable because documentation explains workaround';

    const result = ValidationOverrideSchema.safeParse(simpleOverride);
    expect(result.success).toBe(true);
  });

  it('should validate object override with reason only', () => {
    const objectOverride = {
      reason: 'Legacy API compatibility required until v2.0',
    };

    const result = ValidationOverrideSchema.safeParse(objectOverride);
    expect(result.success).toBe(true);
  });

  it('should validate object override with reason and expiration', () => {
    const objectOverride = {
      reason: 'Temporary workaround for upstream bug',
      expires: '2026-06-30T00:00:00Z',
    };

    const result = ValidationOverrideSchema.safeParse(objectOverride);
    expect(result.success).toBe(true);
  });

  it('should reject empty string override', () => {
    const invalidOverride = '';

    const result = ValidationOverrideSchema.safeParse(invalidOverride);
    expect(result.success).toBe(false);
  });

  it('should reject object override with empty reason', () => {
    const invalidOverride = {
      reason: '',
      expires: '2026-06-30T00:00:00Z',
    };

    const result = ValidationOverrideSchema.safeParse(invalidOverride);
    expect(result.success).toBe(false);
  });

  it('should reject object override with invalid expiration format', () => {
    const invalidOverride = {
      reason: 'Valid reason',
      expires: '2026-06-30', // Not ISO 8601 datetime
    };

    const result = ValidationOverrideSchema.safeParse(invalidOverride);
    expect(result.success).toBe(false);
  });
});

describe('PackagingOptionsSchema', () => {
  it('should validate packaging options with resourceNaming', () => {
    const options = {
      resourceNaming: 'resource-id' as const,
    };

    const result = PackagingOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it('should validate packaging options with stripPrefix', () => {
    const options = {
      stripPrefix: 'src/skills/',
    };

    const result = PackagingOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it('should validate packaging options with both fields', () => {
    const options = {
      resourceNaming: 'preserve-path' as const,
      stripPrefix: 'resources/skills/',
    };

    const result = PackagingOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it('should validate empty packaging options', () => {
    const options = {};

    const result = PackagingOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it('should reject packaging options with invalid field types', () => {
    const invalidOptions = {
      resourceNaming: 'invalid-strategy', // Should be one of: basename, resource-id, preserve-path
    };

    const result = PackagingOptionsSchema.safeParse(invalidOptions);
    expect(result.success).toBe(false);
  });
});

describe('VatSkillMetadataSchema with validation overrides', () => {
  it('should validate skill metadata with simple override', () => {
    const skillWithOverride = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      ignoreValidationErrors: {
        'DUPLICATE_RESOURCE': 'Intentional duplication for testing',
      },
    };

    const result = VatSkillMetadataSchema.safeParse(skillWithOverride);
    expect(result.success).toBe(true);
  });

  it('should validate skill metadata with extended override', () => {
    const skillWithOverride = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      ignoreValidationErrors: {
        'MISSING_FRONTMATTER': {
          reason: 'Optional for examples',
          expires: '2026-12-31T23:59:59Z',
        },
      },
    };

    const result = VatSkillMetadataSchema.safeParse(skillWithOverride);
    expect(result.success).toBe(true);
  });

  it('should validate skill metadata with multiple overrides', () => {
    const skillWithOverrides = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      ignoreValidationErrors: {
        'DUPLICATE_RESOURCE': 'Intentional for testing',
        'MISSING_FRONTMATTER': {
          reason: 'Optional for examples',
          expires: '2026-12-31T23:59:59Z',
        },
        'BROKEN_LINK': 'External link unavailable during build',
      },
    };

    const result = VatSkillMetadataSchema.safeParse(skillWithOverrides);
    expect(result.success).toBe(true);
  });

  it('should validate skill metadata with packaging options', () => {
    const skillWithOptions = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      packagingOptions: {
        resourceNaming: 'resource-id' as const,
        stripPrefix: 'resources/skills/',
      },
    };

    const result = VatSkillMetadataSchema.safeParse(skillWithOptions);
    expect(result.success).toBe(true);
  });

  it('should validate skill metadata with both overrides and packaging options', () => {
    const completeSkill = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      ignoreValidationErrors: {
        'DUPLICATE_RESOURCE': 'Intentional duplication',
      },
      packagingOptions: {
        resourceNaming: 'preserve-path' as const,
      },
    };

    const result = VatSkillMetadataSchema.safeParse(completeSkill);
    expect(result.success).toBe(true);
  });

  it('should reject skill metadata with invalid override format', () => {
    const invalidSkill = {
      name: TEST_SKILL_NAME,
      source: TEST_SKILL_SOURCE,
      path: TEST_SKILL_PATH,
      ignoreValidationErrors: {
        'DUPLICATE_RESOURCE': '', // Empty reason
      },
    };

    const result = VatSkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });
});
