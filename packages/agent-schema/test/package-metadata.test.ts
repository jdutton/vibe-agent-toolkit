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
const TEST_NAMESPACED_SKILL = 'vibe-agent-toolkit:resources';
const TEST_AGENT_NAME = 'agent-generator';
const TEST_AGENT_PATH = './agents/agent-generator';
const TEST_FUNCTION_NAME = 'haiku-validator';
const TEST_FUNCTION_PATH = './dist/pure-functions/haiku-validator';
const VAT_VERSION = '1.0';
const AGENT_BUNDLE_TYPE = 'agent-bundle' as const;

describe('VatSkillMetadataSchema', () => {
  it('should validate valid skill name string', () => {
    const result = VatSkillMetadataSchema.safeParse(TEST_SKILL_NAME);
    expect(result.success).toBe(true);
  });

  it('should validate namespaced skill name', () => {
    const result = VatSkillMetadataSchema.safeParse(TEST_NAMESPACED_SKILL);
    expect(result.success).toBe(true);
  });

  it('should reject non-string input', () => {
    const result = VatSkillMetadataSchema.safeParse({ name: TEST_SKILL_NAME });
    expect(result.success).toBe(false);
  });

  it('should reject empty skill name', () => {
    const result = VatSkillMetadataSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('should reject skill name with invalid characters', () => {
    const result = VatSkillMetadataSchema.safeParse('My Skill');
    expect(result.success).toBe(false);
  });

  it('should reject skill name exceeding max length', () => {
    const longName = 'a-' + 'b'.repeat(63);
    const result = VatSkillMetadataSchema.safeParse(longName);
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
      skills: [TEST_SKILL_NAME],
    };

    const result = VatPackageMetadataSchema.safeParse(catAgentsMetadata);
    expect(result.success).toBe(true);
  });

  it('should validate vat-development-agents metadata (skills + agents)', () => {
    const devAgentsMetadata = {
      version: VAT_VERSION,
      type: AGENT_BUNDLE_TYPE,
      skills: ['vibe-agent-toolkit'],
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
      skills: ['my-skill'],
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

  describe('linkFollowDepth', () => {
    it('should accept linkFollowDepth: 0', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: 0 });
      expect(result.success).toBe(true);
    });

    it('should accept linkFollowDepth: 5 (not capped)', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: 5 });
      expect(result.success).toBe(true);
    });

    it('should reject linkFollowDepth: -1 (negative)', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject linkFollowDepth: 1.5 (non-integer)', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should accept linkFollowDepth: "full"', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: 'full' });
      expect(result.success).toBe(true);
    });

    it('should reject linkFollowDepth: "partial" (invalid string)', () => {
      const result = PackagingOptionsSchema.safeParse({ linkFollowDepth: 'partial' });
      expect(result.success).toBe(false);
    });
  });

  describe('excludeReferencesFromBundle', () => {
    it('should accept rules array with defaultTemplate', () => {
      const options = {
        excludeReferencesFromBundle: {
          rules: [
            {
              patterns: ['**/*.pdf'],
            },
          ],
          defaultTemplate: '{{link.text}}',
        },
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });

    it('should accept empty rules array', () => {
      const options = {
        excludeReferencesFromBundle: {
          rules: [],
        },
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });

    it('should accept rule with custom template', () => {
      const options = {
        excludeReferencesFromBundle: {
          rules: [
            {
              patterns: ['knowledge-base/**/*.md'],
              template: 'Search for: {{link.text}} in {{skill.name}}',
            },
          ],
        },
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });

    it('should default rules to empty array when omitted', () => {
      const options = {
        excludeReferencesFromBundle: {},
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.excludeReferencesFromBundle?.rules).toEqual([]);
      }
    });

    it('should accept defaultTemplate string', () => {
      const options = {
        excludeReferencesFromBundle: {
          defaultTemplate: '{{link.text}} (see {{link.resource.fileName}})',
        },
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });

    it('should accept rule with patterns only (no template)', () => {
      const options = {
        excludeReferencesFromBundle: {
          rules: [
            {
              patterns: ['**/*.pdf'],
            },
          ],
        },
      };

      const result = PackagingOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });
  });
});

