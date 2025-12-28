/**
 * Configuration schemas for vibe-agent-toolkit
 */

import { z } from 'zod';

export const ResourceConfigSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  validation: z
    .object({
      checkLinks: z.boolean().optional(),
      checkAnchors: z.boolean().optional(),
      allowExternal: z.boolean().optional(),
    })
    .optional(),
});

export const ProjectConfigSchema = z.object({
  version: z.literal(1),
  resources: ResourceConfigSchema.optional(),
});

export type ResourceConfig = z.infer<typeof ResourceConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// Default configuration
export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  resources: {
    include: ['**/*.md'],
    exclude: ['node_modules/**', '**/test/fixtures/**'],
    validation: {
      checkLinks: true,
      checkAnchors: true,
      allowExternal: true,
    },
  },
};
