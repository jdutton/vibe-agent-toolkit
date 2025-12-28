import { z } from 'zod';

/**
 * Resource definition
 */
export const ResourceSchema = z.object({
  path: z.string()
    .describe('Path to resource file or glob pattern'),

  type: z.enum(['prompt', 'schema', 'documentation', 'data', 'template'])
    .describe('Resource type'),

  template: z.enum(['mustache', 'handlebars', 'none'])
    .optional()
    .describe('Template engine (if applicable)'),

  fragment: z.boolean()
    .optional()
    .describe('Whether resource can be included/referenced by other resources'),
}).strict().describe('Resource definition');

export type Resource = z.infer<typeof ResourceSchema>;

/**
 * Resource registry (named collections of resources)
 */
export const ResourceRegistrySchema = z.record(
  z.union([
    ResourceSchema,
    z.record(ResourceSchema),
  ])
).describe('Resource registry mapping resource names to definitions');

export type ResourceRegistry = z.infer<typeof ResourceRegistrySchema>;
