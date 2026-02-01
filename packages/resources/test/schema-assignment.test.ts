/**
 * Tests for schema assignment pipeline
 *
 * Tests Phase 4 schema assignment:
 * - Collection-imposed schemas
 * - CLI-imposed schemas
 * - Deduplication (same schema from multiple sources)
 * - Assignment pipeline order
 */

import { describe, expect, it } from 'vitest';

import {
  addCLISchema,
  addCollectionSchema,
  assignSchemas,
} from '../src/schema-assignment.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';
import type { SchemaReference } from '../src/types/resources.js';

describe('Schema Assignment', () => {
  const SCHEMA_PATH = './schema.json';
  const DOCS_SCHEMA_PATH = './docs-schema.json';
  const GUIDES_SCHEMA_PATH = './guides-schema.json';
  const CLI_SCHEMA_PATH = './cli-schema.json';
  const SELF_SCHEMA_PATH = './self-schema.json';
  const MARKDOWN_PATTERN = '**/*.md';

  describe('addCollectionSchema', () => {
    it('should add collection schema when defined', () => {
      const existingSchemas: SchemaReference[] = [];
      const collectionConfig: CollectionConfig = {
        include: [MARKDOWN_PATTERN],
        validation: {
          frontmatterSchema: DOCS_SCHEMA_PATH,
        },
      };

      const result = addCollectionSchema(existingSchemas, 'docs', collectionConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        schema: DOCS_SCHEMA_PATH,
        source: 'docs',
        applied: false,
      });
    });

    it('should not add schema when validation.frontmatterSchema is undefined', () => {
      const existingSchemas: SchemaReference[] = [];
      const collectionConfig: CollectionConfig = {
        include: [MARKDOWN_PATTERN],
      };

      const result = addCollectionSchema(existingSchemas, 'docs', collectionConfig);

      expect(result).toHaveLength(0);
    });

    it('should not duplicate schema if already present', () => {
      const existingSchemas: SchemaReference[] = [
        { schema: SCHEMA_PATH, source: 'self', applied: false },
      ];
      const collectionConfig: CollectionConfig = {
        include: [MARKDOWN_PATTERN],
        validation: {
          frontmatterSchema: SCHEMA_PATH,
        },
      };

      const result = addCollectionSchema(existingSchemas, 'docs', collectionConfig);

      // Should not add duplicate
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('self');
    });
  });

  describe('addCLISchema', () => {
    it('should add CLI schema', () => {
      const existingSchemas: SchemaReference[] = [];

      const result = addCLISchema(existingSchemas, CLI_SCHEMA_PATH);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        schema: CLI_SCHEMA_PATH,
        source: 'cli',
        applied: false,
      });
    });

    it('should not duplicate schema if already present', () => {
      const existingSchemas: SchemaReference[] = [
        { schema: SCHEMA_PATH, source: 'self', applied: false },
      ];

      const result = addCLISchema(existingSchemas, SCHEMA_PATH);

      // Should not add duplicate
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('self');
    });
  });

  describe('assignSchemas', () => {
    it('should apply full pipeline: self + collection + CLI', () => {
      const selfSchemas: SchemaReference[] = [
        { schema: SELF_SCHEMA_PATH, source: 'self', applied: false },
      ];

      const collectionsConfig = {
        docs: {
          include: ['docs/**/*.md'],
          validation: { frontmatterSchema: DOCS_SCHEMA_PATH },
        },
        guides: {
          include: ['guides/**/*.md'],
          validation: { frontmatterSchema: GUIDES_SCHEMA_PATH },
        },
      };

      const result = assignSchemas(
        selfSchemas,
        ['docs', 'guides'],
        collectionsConfig,
        CLI_SCHEMA_PATH
      );

      expect(result).toHaveLength(4);
      expect(result.map((r) => ({ schema: r.schema, source: r.source }))).toEqual([
        { schema: SELF_SCHEMA_PATH, source: 'self' },
        { schema: DOCS_SCHEMA_PATH, source: 'docs' },
        { schema: GUIDES_SCHEMA_PATH, source: 'guides' },
        { schema: CLI_SCHEMA_PATH, source: 'cli' },
      ]);
    });

    it('should deduplicate schemas from multiple sources', () => {
      const selfSchemas: SchemaReference[] = [
        { schema: SCHEMA_PATH, source: 'self', applied: false },
      ];

      const collectionsConfig = {
        docs: {
          include: [MARKDOWN_PATTERN],
          validation: { frontmatterSchema: SCHEMA_PATH },
        },
      };

      const result = assignSchemas(
        selfSchemas,
        ['docs'],
        collectionsConfig,
        SCHEMA_PATH
      );

      // Only one schema, first source (self) wins
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('self');
    });

    it('should handle empty collections', () => {
      const selfSchemas: SchemaReference[] = [
        { schema: SELF_SCHEMA_PATH, source: 'self', applied: false },
      ];

      const result = assignSchemas(selfSchemas, [], {}, CLI_SCHEMA_PATH);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.source)).toEqual(['self', 'cli']);
    });

    it('should handle collections without validation config', () => {
      const selfSchemas: SchemaReference[] = [];

      const collectionsConfig = {
        docs: {
          include: [MARKDOWN_PATTERN],
          // No validation config
        },
      };

      const result = assignSchemas(selfSchemas, ['docs'], collectionsConfig);

      expect(result).toHaveLength(0);
    });

    it('should handle no CLI schema', () => {
      const selfSchemas: SchemaReference[] = [];

      const collectionsConfig = {
        docs: {
          include: [MARKDOWN_PATTERN],
          validation: { frontmatterSchema: DOCS_SCHEMA_PATH },
        },
      };

      const result = assignSchemas(selfSchemas, ['docs'], collectionsConfig);

      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('docs');
    });
  });
});
