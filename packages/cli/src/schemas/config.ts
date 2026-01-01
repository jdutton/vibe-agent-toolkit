/**
 * Configuration schemas for vibe-agent-toolkit
 */

import { z } from 'zod';

// Metadata configuration
export const MetadataConfigSchema = z.object({
  frontmatter: z.boolean().optional().describe('Parse YAML frontmatter for metadata'),
  inference: z
    .object({
      type: z.enum(['by-directory', 'by-filename', 'none']).optional(),
      tags: z.enum(['by-heading', 'by-directory', 'none']).optional(),
    })
    .optional()
    .describe('Metadata inference strategies'),
  defaults: z
    .object({
      type: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Default metadata values'),
});

// Resource collection configuration
export const ResourceCollectionSchema = z.object({
  include: z.array(z.string()).describe('Glob patterns for files to include'),
  exclude: z.array(z.string()).optional().describe('Glob patterns for files to exclude'),
  metadata: MetadataConfigSchema.optional().describe('Metadata configuration for this collection'),
});

// Resource defaults and collections
export const ResourcesConfigSchema = z
  .object({
    include: z
      .array(z.string())
      .optional()
      .describe('Glob patterns for files to include (applies to all collections unless overridden)'),
    exclude: z
      .array(z.string())
      .optional()
      .describe('Glob patterns for files to exclude (applies to all collections unless overridden)'),
    metadata: MetadataConfigSchema.optional().describe('Metadata configuration (applies to all collections unless overridden)'),
    collections: z
      .record(z.string(), ResourceCollectionSchema)
      .optional()
      .describe('Named resource collections for reuse'),
    validation: z
      .object({
        checkLinks: z.boolean().optional(),
        checkAnchors: z.boolean().optional(),
        allowExternal: z.boolean().optional(),
      })
      .optional()
      .describe('Resource validation settings'),
  })
  .strict();

// Agent discovery configuration
export const AgentsConfigSchema = z.object({
  include: z.array(z.string()).describe('Glob patterns for agent directories'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
  external: z
    .array(z.string())
    .optional()
    .describe('External agent dependencies (npm packages with semver)'),
});

// RAG embedding configuration
export const RAGEmbeddingConfigSchema = z.object({
  provider: z.enum(['transformers-js', 'openai']).describe('Embedding provider'),
  model: z.string().describe('Model identifier'),
});

// RAG chunking configuration
export const RAGChunkingConfigSchema = z.object({
  targetSize: z.number().int().positive().describe('Target chunk size in tokens'),
  paddingFactor: z
    .number()
    .min(0)
    .max(1)
    .describe('Safety factor for token counting (0.0-1.0)'),
});

// RAG store configuration
export const RAGStoreSchema = z.object({
  db: z.string().describe('Database path (relative to project root)'),
  resources: z.string().describe('Named resource collection to use'),
  embedding: RAGEmbeddingConfigSchema.optional().describe('Override default embedding config'),
  chunking: RAGChunkingConfigSchema.optional().describe('Override default chunking config'),
});

// RAG configuration
export const RAGConfigSchema = z.object({
  defaults: z
    .object({
      embedding: RAGEmbeddingConfigSchema.optional(),
      chunking: RAGChunkingConfigSchema.optional(),
    })
    .optional()
    .describe('Default configuration for all RAG stores'),
  stores: z
    .record(z.string(), RAGStoreSchema)
    .optional()
    .describe('Named RAG stores for semantic search'),
});

// Root project configuration
export const ProjectConfigSchema = z
  .object({
    version: z.literal(1).describe('Configuration schema version'),
    resources: ResourcesConfigSchema.optional().describe('Resource management configuration'),
    agents: AgentsConfigSchema.optional().describe('Agent discovery configuration'),
    rag: RAGConfigSchema.optional().describe('RAG semantic search configuration'),
  })
  .strict();

export type MetadataConfig = z.infer<typeof MetadataConfigSchema>;
export type ResourceCollection = z.infer<typeof ResourceCollectionSchema>;
export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type RAGEmbeddingConfig = z.infer<typeof RAGEmbeddingConfigSchema>;
export type RAGChunkingConfig = z.infer<typeof RAGChunkingConfigSchema>;
export type RAGStore = z.infer<typeof RAGStoreSchema>;
export type RAGConfig = z.infer<typeof RAGConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// Default configuration
export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  resources: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    metadata: {
      frontmatter: true,
    },
    validation: {
      checkLinks: true,
      checkAnchors: true,
      allowExternal: true,
    },
  },
  rag: {
    defaults: {
      embedding: {
        provider: 'transformers-js',
        model: 'Xenova/all-MiniLM-L6-v2',
      },
      chunking: {
        targetSize: 512,
        paddingFactor: 0.9,
      },
    },
  },
};
