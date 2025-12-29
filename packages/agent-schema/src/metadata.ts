import { z } from 'zod';

/**
 * Build metadata (optional, added by build process)
 */
export const BuildMetadataSchema = z.object({
  timestamp: z.string().datetime().describe('Build timestamp (ISO 8601)'),
  vatVersion: z.string().describe('VAT toolkit version used'),
  commit: z.string().optional().describe('Git commit hash'),
}).strict().describe('Build metadata added during packaging');

export type BuildMetadata = z.infer<typeof BuildMetadataSchema>;

/**
 * Agent metadata
 */
export const AgentMetadataSchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens')
    .describe('Agent identifier (kebab-case)'),

  version: z.string()
    // Semver regex: major.minor.patch with optional pre-release and build metadata
    // The regex is structured to avoid catastrophic backtracking by:
    // 1. Using non-capturing groups (?:...)
    // 2. Limiting character classes to specific sets (no overlapping)
    // 3. Anchoring with ^ and $
    // eslint-disable-next-line security/detect-unsafe-regex, sonarjs/regex-complexity -- Safe: structured to prevent backtracking, complexity needed for semver spec
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?$/, 'Must be valid semver')
    .optional()
    .describe('Agent version (semver format, optional - can come from package.json)'),

  description: z.string()
    .optional()
    .describe('Human-readable description of agent purpose'),

  author: z.string()
    .optional()
    .describe('Agent author or organization'),

  license: z.string()
    .optional()
    .describe('License identifier (e.g., MIT, Apache-2.0)'),

  tags: z.array(z.string())
    .optional()
    .describe('Tags for categorization and discovery'),

  build: BuildMetadataSchema
    .optional()
    .describe('Build metadata (added by build process)'),
}).strict().describe('Agent metadata');

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;
