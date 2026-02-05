/**
 * System tests for custom metadata workflows
 *
 * End-to-end tests demonstrating custom metadata in realistic scenarios:
 * - Multi-domain knowledge base with super schema pattern
 * - Schema evolution via database rebuild
 * - Complex nested metadata objects
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { TransformersEmbeddingProvider } from '@vibe-agent-toolkit/rag';
import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTempDir, createTestMarkdownFile } from '../test-helpers.js';

describe('Custom metadata system tests', () => {
  let tempDir: string;
  let dbPath: string;
  const embeddingProvider = new TransformersEmbeddingProvider();

  // Test constants
  const DOCUMENTATION_CATEGORY = 'documentation';
  const BACKEND_DOMAIN = 'backend';
  const AUTHOR_NAME = 'Jane Doe';
  const AUTHOR_EMAIL = 'jane@example.com';
  const REVIEWER_NAME = 'John Smith';

  beforeEach(async () => {
    tempDir = await createTempDir();
    dbPath = join(tempDir, 'db');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should support multi-domain knowledge base with super schema', async () => {
    // Define super schema with fields from multiple domains
    const SuperSchema = z.object({
      filePath: z.string(),
      // Security domain
      threatLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      compliance: z.array(z.string()).optional(),
      // API domain
      httpMethod: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
      endpoint: z.string().optional(),
      deprecated: z.boolean().optional(),
      // Tutorial domain
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
      estimatedMinutes: z.number().optional(),
    });

    type SuperMetadata = z.infer<typeof SuperSchema>;

    // Create provider with super schema
    const provider = await LanceDBRAGProvider.create<SuperMetadata>({
      dbPath,
      embeddingProvider,
      metadataSchema: SuperSchema,
    });

    try {
      // Create resources from different domains
      const securityDoc = await createTestMarkdownFile(
        tempDir,
        'security.md',
        '# Security Vulnerability\n\nCritical XSS vulnerability found in user input validation.'
      );

      const apiDoc = await createTestMarkdownFile(
        tempDir,
        'api.md',
        '# User API Endpoint\n\nGET endpoint for fetching user profiles.'
      );

      const tutorialDoc = await createTestMarkdownFile(
        tempDir,
        'tutorial.md',
        '# Getting Started Tutorial\n\nLearn the basics in 15 minutes.'
      );

      const resources: ResourceMetadata[] = [
        {
          id: 'security-1',
          filePath: securityDoc,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '0000000000000000000000000000000000000000000000000000000000000001',
          frontmatter: {
            filePath: securityDoc,
            domain: 'security',
            threatLevel: 'critical',
            compliance: ['OWASP', 'PCI-DSS'],
          },
        },
        {
          id: 'api-1',
          filePath: apiDoc,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '0000000000000000000000000000000000000000000000000000000000000002',
          frontmatter: {
            filePath: apiDoc,
            domain: 'api',
            httpMethod: 'GET',
            endpoint: '/api/users/:id',
            deprecated: false,
          },
        },
        {
          id: 'tutorial-1',
          filePath: tutorialDoc,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '0000000000000000000000000000000000000000000000000000000000000003',
          frontmatter: {
            filePath: tutorialDoc,
            domain: 'tutorial',
            difficulty: 'beginner',
            estimatedMinutes: 15,
          },
        },
      ];

      // Index all resources
      const indexResult = await provider.indexResources(resources);
      expect(indexResult.errors).toEqual([]);
      expect(indexResult.resourcesIndexed).toBe(3);

      // Query security domain with threatLevel filter
      const securityResults = await provider.query({
        text: 'security vulnerability',
        filters: {
          metadata: {
            threatLevel: 'critical',
          },
        },
      });

      expect(securityResults.chunks.length).toBeGreaterThan(0);
      expect(securityResults.chunks.every((chunk) => chunk.threatLevel === 'critical')).toBe(true);

      // Query API domain with httpMethod filter
      const apiResults = await provider.query({
        text: 'api endpoint',
        filters: {
          metadata: {
            httpMethod: 'GET',
          },
        },
      });

      expect(apiResults.chunks.length).toBeGreaterThan(0);
      expect(apiResults.chunks.every((chunk) => chunk.httpMethod === 'GET')).toBe(true);

      // Query tutorial domain with difficulty filter
      const tutorialResults = await provider.query({
        text: 'getting started',
        filters: {
          metadata: {
            difficulty: 'beginner',
          },
        },
      });

      expect(tutorialResults.chunks.length).toBeGreaterThan(0);
      expect(tutorialResults.chunks.every((chunk) => chunk.difficulty === 'beginner')).toBe(true);

      // Verify chunks have correct metadata types
      const securityChunk = securityResults.chunks[0];
      if (securityChunk) {
        expect(securityChunk.threatLevel).toBe('critical');
        expect(securityChunk.compliance).toEqual(['OWASP', 'PCI-DSS']);
      }

      const apiChunk = apiResults.chunks[0];
      if (apiChunk) {
        expect(apiChunk.httpMethod).toBe('GET');
        expect(apiChunk.endpoint).toBe('/api/users/:id');
        expect(apiChunk.deprecated).toBe(false);
      }

      const tutorialChunk = tutorialResults.chunks[0];
      if (tutorialChunk) {
        expect(tutorialChunk.difficulty).toBe('beginner');
        expect(tutorialChunk.estimatedMinutes).toBe(15);
      }
    } finally {
      await provider.close();
    }
  });

  it('should support schema evolution via database rebuild', async () => {
    // Phase 1: V1 Schema (basic fields)
    const SchemaV1 = z.object({
      filePath: z.string(),
      category: z.string().optional(),
    });

    type MetadataV1 = z.infer<typeof SchemaV1>;

    const providerV1 = await LanceDBRAGProvider.create<MetadataV1>({
      dbPath,
      embeddingProvider,
      metadataSchema: SchemaV1,
    });

    try {
      // Create and index resources with V1 schema
      const docV1 = await createTestMarkdownFile(
        tempDir,
        'doc-v1.md',
        '# Version 1 Document\n\nThis uses the V1 schema.'
      );

      const resourcesV1: ResourceMetadata[] = [
        {
          id: 'doc-v1',
          filePath: docV1,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '1111111111111111111111111111111111111111111111111111111111111111',
          frontmatter: {
            filePath: docV1,
            category: DOCUMENTATION_CATEGORY,
          },
        },
      ];

      const indexResultV1 = await providerV1.indexResources(resourcesV1);
      expect(indexResultV1.errors).toEqual([]);
      expect(indexResultV1.resourcesIndexed).toBe(1);

      // Query V1 schema
      const resultsV1 = await providerV1.query({
        text: 'version 1',
        filters: {
          metadata: {
            category: DOCUMENTATION_CATEGORY,
          },
        },
      });

      expect(resultsV1.chunks.length).toBeGreaterThan(0);
      expect(resultsV1.chunks[0]?.category).toBe(DOCUMENTATION_CATEGORY);
    } finally {
      await providerV1.close();
    }

    // Delete database to simulate schema evolution
    await rm(dbPath, { recursive: true, force: true });

    // Phase 2: V2 Schema (adds domain and priority fields)
    const SchemaV2 = z.object({
      filePath: z.string(),
      category: z.string().optional(),
      domain: z.string().optional(),
      priority: z.number().optional(),
    });

    type MetadataV2 = z.infer<typeof SchemaV2>;

    const providerV2 = await LanceDBRAGProvider.create<MetadataV2>({
      dbPath,
      embeddingProvider,
      metadataSchema: SchemaV2,
    });

    try {
      // Create and index resources with V2 schema
      const docV2 = await createTestMarkdownFile(
        tempDir,
        'doc-v2.md',
        '# Version 2 Document\n\nThis uses the V2 schema with new fields.'
      );

      const resourcesV2: ResourceMetadata[] = [
        {
          id: 'doc-v2',
          filePath: docV2,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '2222222222222222222222222222222222222222222222222222222222222222',
          frontmatter: {
            filePath: docV2,
            category: 'documentation',
            domain: BACKEND_DOMAIN,
            priority: 1,
          },
        },
      ];

      const indexResultV2 = await providerV2.indexResources(resourcesV2);
      expect(indexResultV2.errors).toEqual([]);
      expect(indexResultV2.resourcesIndexed).toBe(1);

      // Query V2 schema with new fields
      const resultsV2 = await providerV2.query({
        text: 'version 2',
        filters: {
          metadata: {
            domain: BACKEND_DOMAIN,
            priority: 1,
          },
        },
      });

      expect(resultsV2.chunks.length).toBeGreaterThan(0);
      const chunk = resultsV2.chunks[0];
      if (chunk) {
        expect(chunk.category).toBe(DOCUMENTATION_CATEGORY);
        expect(chunk.domain).toBe(BACKEND_DOMAIN);
        expect(chunk.priority).toBe(1);
      }
    } finally {
      await providerV2.close();
    }
  });

  it('should handle complex nested metadata objects', async () => {
    // Define schema with nested objects and arrays
    const ComplexSchema = z.object({
      filePath: z.string(),
      author: z.object({
        name: z.string(),
        email: z.string(),
      }).optional(),
      reviewers: z.array(
        z.object({
          name: z.string(),
          approved: z.boolean(),
        })
      ).optional(),
      tags: z.array(z.string()).optional(),
    });

    type ComplexMetadata = z.infer<typeof ComplexSchema>;

    const provider = await LanceDBRAGProvider.create<ComplexMetadata>({
      dbPath,
      embeddingProvider,
      metadataSchema: ComplexSchema,
    });

    try {
      // Create resource with complex nested metadata
      const complexDoc = await createTestMarkdownFile(
        tempDir,
        'complex.md',
        '# Complex Document\n\nDocument with nested metadata structures.'
      );

      const resources: ResourceMetadata[] = [
        {
          id: 'complex-1',
          filePath: complexDoc,
          links: [],
          headings: [],
          sizeBytes: 100,
          estimatedTokenCount: 20,
          modifiedAt: new Date(),
          checksum: '3333333333333333333333333333333333333333333333333333333333333333',
          frontmatter: {
            filePath: complexDoc,
            author: {
              name: AUTHOR_NAME,
              email: AUTHOR_EMAIL,
            },
            reviewers: [
              { name: REVIEWER_NAME, approved: true },
              { name: 'Alice Johnson', approved: false },
            ],
            tags: ['documentation', 'review', 'draft'],
          },
        },
      ];

      // Index the resource
      const indexResult = await provider.indexResources(resources);
      expect(indexResult.errors).toEqual([]);
      expect(indexResult.resourcesIndexed).toBe(1);

      // Query and retrieve chunks
      const results = await provider.query({
        text: 'complex document',
        limit: 5,
      });

      expect(results.chunks.length).toBeGreaterThan(0);

      // Verify nested objects deserialize correctly
      const chunk = results.chunks[0];
      if (chunk) {
        expect(chunk.author).toEqual({
          name: AUTHOR_NAME,
          email: AUTHOR_EMAIL,
        });

        expect(chunk.reviewers).toEqual([
          { name: REVIEWER_NAME, approved: true },
          { name: 'Alice Johnson', approved: false },
        ]);

        expect(chunk.tags).toEqual(['documentation', 'review', 'draft']);
      }

      // Verify type safety (TypeScript should know these fields exist)
      if (chunk?.author) {
        const authorName: string = chunk.author.name;
        const authorEmail: string = chunk.author.email;
        expect(authorName).toBe(AUTHOR_NAME);
        expect(authorEmail).toBe(AUTHOR_EMAIL);
      }

      if (chunk?.reviewers) {
        const firstReviewer = chunk.reviewers[0];
        if (firstReviewer) {
          const reviewerName: string = firstReviewer.name;
          const reviewerApproved: boolean = firstReviewer.approved;
          expect(reviewerName).toBe(REVIEWER_NAME);
          expect(reviewerApproved).toBe(true);
        }
      }
    } finally {
      await provider.close();
    }
  });
});
