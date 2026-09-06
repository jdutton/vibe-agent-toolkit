/**
 * Unsupported filters must refuse, not widen.
 *
 * VAT's published query surface declares six filter fields. Four of them reach no
 * shipped provider at the position they are declared, and the failure direction is
 * the point: an unread field contributes no SQL condition, and
 * `LanceDBRAGProvider.query()` applies a WHERE clause only when one was produced —
 * so a query whose ONLY filter is an unimplemented one used to degrade into an
 * unfiltered full-recall vector search over the entire index. Plausible-looking
 * results, drawn from exactly the documents the filter was meant to exclude, with
 * no error and no warning.
 *
 * A RAG filter is usually a correctness or access boundary, so silently widening it
 * is closer to a data-exposure defect than to a missing feature. These tests pin the
 * refusal.
 *
 * 🔴 Red-first: before the guard, every `toThrow` here failed by returning `null`
 * (dateRange/tags/type/headingPath at the top level of `filters`), which is precisely
 * the "no condition produced ⇒ no WHERE clause ⇒ full recall" path.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildWhereClause } from '../src/filter-builder.js';

describe('unsupported filters refuse rather than widen', () => {
  const schema = z.object({
    domain: z.string().optional(),
    tags: z.array(z.string()).optional(),
    type: z.string().optional(),
    headingPath: z.string().optional(),
  });

  describe('filters implemented at no position', () => {
    it('throws on dateRange rather than returning an unfiltered search', () => {
      expect(() =>
        buildWhereClause({ dateRange: { start: new Date(0), end: new Date(1) } }, schema),
      ).toThrow(/dateRange/);
    });

    it('names the widening in the message, so the caller learns the direction of the failure', () => {
      expect(() =>
        buildWhereClause({ dateRange: { start: new Date(0), end: new Date(1) } }, schema),
      ).toThrow(/entire index/);
    });
  });

  describe('metadata fields declared at the wrong position', () => {
    // Each case carries its own literal pattern rather than building one from the key:
    // a RegExp assembled from test data is both a lint finding and a weaker assertion,
    // since a typo'd key would still produce a pattern that matches itself.
    it.each([
      [/\btags\b/, { tags: ['auth'] }],
      [/\btype\b/, { type: 'guide' }],
      [/\bheadingPath\b/, { headingPath: 'Architecture > RAG Design' }],
    ])('throws on the top-level key matching %s', (pattern, filters) => {
      expect(() => buildWhereClause(filters, schema)).toThrow(pattern);
    });

    it.each([
      ['tags', { tags: ['auth'] }],
      ['type', { type: 'guide' }],
      ['headingPath', { headingPath: 'Architecture > RAG Design' }],
    ])('points %s at filters.metadata, where it IS honoured', (_key, filters) => {
      expect(() => buildWhereClause(filters, schema)).toThrow(/filters\.metadata/);
    });

    it('honours the same fields under filters.metadata', () => {
      const result = buildWhereClause({ metadata: { type: 'guide' } }, schema);
      expect(result).toBe("type = 'guide'");
    });
  });

  describe('the guard reports every offender at once', () => {
    it('names all present unsupported keys in one error', () => {
      let message = '';
      try {
        buildWhereClause({ tags: ['auth'], type: 'guide' }, schema);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/tags/);
      expect(message).toMatch(/type/);
    });
  });

  describe('supported filters are untouched', () => {
    it('still builds a resourceId clause', () => {
      expect(buildWhereClause({ resourceId: 'doc-123' }, schema)).toBe("resourceid IN ('doc-123')");
    });

    it('still returns null for no filters at all', () => {
      expect(buildWhereClause({}, schema)).toBeNull();
    });

    it('does not fire on an explicitly undefined unsupported key', () => {
      expect(buildWhereClause({ resourceId: 'doc-123', tags: undefined }, schema)).toBe(
        "resourceid IN ('doc-123')",
      );
    });
  });
});
