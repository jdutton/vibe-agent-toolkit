/**
 * Unit tests for filter-builder
 *
 * Tests SQL WHERE clause generation with schema introspection.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildMetadataFilter,
  buildMetadataWhereClause,
  buildWhereClause,
} from '../src/filter-builder.js';

describe('Filter Builder', () => {
  const TEST_DOMAIN = 'security';
  const EXPECTED_DOMAIN_FILTER = "metadata.domain = 'security'";

  describe('buildMetadataFilter', () => {
    it('should build string filter with exact match', () => {
      const zodType = z.string();
      const result = buildMetadataFilter('domain', TEST_DOMAIN, zodType);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should escape single quotes in string values', () => {
      const zodType = z.string();
      const result = buildMetadataFilter('title', "Bob's Document", zodType);
      expect(result).toBe("metadata.title = 'Bob''s Document'");
    });

    it('should build number filter with exact match', () => {
      const zodType = z.number();
      const result = buildMetadataFilter('priority', 1, zodType);
      expect(result).toBe('metadata.priority = 1');
    });

    it('should build boolean filter with exact match', () => {
      const zodType = z.boolean();
      const result = buildMetadataFilter('active', true, zodType);
      expect(result).toBe('metadata.active = 1');
    });

    it('should build array filter with LIKE query', () => {
      const zodType = z.array(z.string());
      const result = buildMetadataFilter('tags', 'auth', zodType);
      expect(result).toBe("metadata.tags LIKE '%auth%'");
    });

    it('should escape single quotes in array filter values', () => {
      const zodType = z.array(z.string());
      const result = buildMetadataFilter('tags', "user's-tag", zodType);
      expect(result).toBe("metadata.tags LIKE '%user''s-tag%'");
    });

    it('should unwrap optional types', () => {
      const zodType = z.string().optional();
      const result = buildMetadataFilter('domain', TEST_DOMAIN, zodType);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should handle optional number types', () => {
      const zodType = z.number().optional();
      const result = buildMetadataFilter('priority', 2, zodType);
      expect(result).toBe('metadata.priority = 2');
    });

    it('should handle optional boolean types', () => {
      const zodType = z.boolean().optional();
      const result = buildMetadataFilter('archived', false, zodType);
      expect(result).toBe('metadata.archived = 0');
    });

    it('should handle optional array types', () => {
      const zodType = z.array(z.string()).optional();
      const result = buildMetadataFilter('keywords', 'security', zodType);
      expect(result).toBe("metadata.keywords LIKE '%security%'");
    });
  });

  describe('buildMetadataWhereClause', () => {
    it('should build clause for single string field', () => {
      const schema = z.object({ domain: z.string() });
      const filters = { domain: TEST_DOMAIN };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should build clause for single number field', () => {
      const schema = z.object({ priority: z.number() });
      const filters = { priority: 1 };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe('metadata.priority = 1');
    });

    it('should build clause for single boolean field', () => {
      const schema = z.object({ active: z.boolean() });
      const filters = { active: true };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe('metadata.active = 1');
    });

    it('should build clause for single array field', () => {
      const schema = z.object({ tags: z.array(z.string()) });
      const filters = { tags: 'auth' };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("metadata.tags LIKE '%auth%'");
    });

    it('should combine multiple filters with AND', () => {
      const schema = z.object({
        domain: z.string(),
        priority: z.number(),
      });
      const filters = { domain: TEST_DOMAIN, priority: 1 };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("metadata.domain = 'security' AND metadata.priority = 1");
    });

    it('should handle all field types together', () => {
      const schema = z.object({
        domain: z.string(),
        priority: z.number(),
        active: z.boolean(),
        tags: z.array(z.string()),
      });
      const filters = {
        domain: TEST_DOMAIN,
        priority: 1,
        active: true,
        tags: 'auth',
      };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe(
        "metadata.domain = 'security' AND metadata.priority = 1 AND metadata.active = 1 AND metadata.tags LIKE '%auth%'"
      );
    });

    it('should skip undefined values', () => {
      const schema = z.object({
        domain: z.string(),
        priority: z.number(),
      });
      const filters = { domain: TEST_DOMAIN, priority: undefined };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should skip fields not in schema', () => {
      const schema = z.object({ domain: z.string() });
      const filters = { domain: TEST_DOMAIN, unknownField: 'value' };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should return null for empty filters', () => {
      const schema = z.object({ domain: z.string() });
      const filters = {};
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBeNull();
    });

    it('should return null for undefined filters', () => {
      const schema = z.object({ domain: z.string() });
      const result = buildMetadataWhereClause(undefined, schema);
      expect(result).toBeNull();
    });

    it('should handle optional fields in schema', () => {
      const schema = z.object({
        domain: z.string().optional(),
        priority: z.number().optional(),
      });
      const filters = { domain: TEST_DOMAIN, priority: 1 };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("metadata.domain = 'security' AND metadata.priority = 1");
    });
  });

  describe('buildWhereClause', () => {
    const schema = z.object({
      domain: z.string(),
      priority: z.number(),
    });

    it('should build clause for resourceId only', () => {
      const filters = { resourceId: 'doc-123' };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc-123')");
    });

    it('should build clause for multiple resourceIds', () => {
      const filters = { resourceId: ['doc-123', 'doc-456'] };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc-123', 'doc-456')");
    });

    it('should handle empty resourceId array', () => {
      const filters = { resourceId: [] };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe('1 = 0');
    });

    it('should escape single quotes in resourceIds', () => {
      const filters = { resourceId: "doc's-file" };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc''s-file')");
    });

    it('should build clause for metadata only', () => {
      const filters = { metadata: { domain: TEST_DOMAIN } };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should combine resourceId and metadata filters', () => {
      const filters = {
        resourceId: 'doc-123',
        metadata: { domain: TEST_DOMAIN, priority: 1 },
      };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe(
        "`resourceId` IN ('doc-123') AND metadata.domain = 'security' AND metadata.priority = 1"
      );
    });

    it('should combine multiple resourceIds and metadata filters', () => {
      const filters = {
        resourceId: ['doc-123', 'doc-456'],
        metadata: { domain: TEST_DOMAIN },
      };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc-123', 'doc-456') AND metadata.domain = 'security'");
    });

    it('should return null for undefined filters', () => {
      const result = buildWhereClause(undefined, schema);
      expect(result).toBeNull();
    });

    it('should return null for empty filters object', () => {
      const filters = {};
      const result = buildWhereClause(filters, schema);
      expect(result).toBeNull();
    });

    it('should handle only empty metadata', () => {
      const filters = { metadata: {} };
      const result = buildWhereClause(filters, schema);
      expect(result).toBeNull();
    });

    it('should handle resourceId with empty metadata', () => {
      const filters = { resourceId: 'doc-123', metadata: {} };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc-123')");
    });
  });

  describe('SQL Injection Prevention', () => {
    const schema = z.object({ notes: z.string() });

    it('should escape malicious string with single quotes', () => {
      const filters = { metadata: { notes: "'; DROP TABLE users; --" } };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("metadata.notes = '''; DROP TABLE users; --'");
    });

    it('should escape resourceId with injection attempt', () => {
      const filters = { resourceId: "doc-123' OR '1'='1" };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("`resourceId` IN ('doc-123'' OR ''1''=''1')");
    });

    it('should handle multiple quotes in metadata', () => {
      const filters = { metadata: { notes: "It's a ''trap''" } };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("metadata.notes = 'It''s a ''''trap'''''");
    });
  });
});
