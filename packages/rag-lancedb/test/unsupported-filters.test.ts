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
 * 🔑 The guard is an ALLOWLIST, and the `unknown keys` block below is why. An earlier
 * shape enumerated the four fields known to be unimplemented, which closed four
 * instances and left the class open: a typo'd `resourceid`, or a field lifted from a
 * design document, still widened in silence.
 *
 * 🔴 Red-first: before the guard, every `toThrow` here failed by returning `null`,
 * which is precisely the "no condition produced ⇒ no WHERE clause ⇒ full recall" path.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildWhereClause } from '../src/filter-builder.js';

/**
 * Reach the runtime guard with a shape the TypeScript surface already rejects.
 *
 * The refusal has two layers and this cast selects the lower one. A typed caller gets a
 * COMPILE error — `RAGQuery['filters']` declares neither `tags` nor an arbitrary key — and
 * that is the better refusal of the two. The runtime guard exists for the JavaScript
 * caller, the JSON payload and the `as` cast, who never meet the type.
 *
 * @param filters - The filter object to smuggle past the compiler
 * @returns The same object, typed as the builder's parameter
 */
function asUntypedFilters(filters: Record<string, unknown>): { resourceId?: string | string[] } {
  return filters as { resourceId?: string | string[] };
}

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
        buildWhereClause(asUntypedFilters({ dateRange: { start: new Date(0), end: new Date(1) } }), schema),
      ).toThrow(/dateRange/);
    });

    it('names the widening in the message, so the caller learns the direction of the failure', () => {
      expect(() =>
        buildWhereClause(asUntypedFilters({ dateRange: { start: new Date(0), end: new Date(1) } }), schema),
      ).toThrow(/entire index/);
    });
  });

  describe('metadata fields declared at the wrong position', () => {
    // Each case asserts the key and its OWN remedy together. Asserting only
    // /filters\.metadata/ would pass even if the remedies were swapped between keys —
    // that substring appears in every message in the table, including dateRange's.
    it.each([
      [/`filters\.tags`: move it to `filters\.metadata\.tags`/, { tags: ['auth'] }],
      [/`filters\.type`: move it to `filters\.metadata\.type`/, { type: 'guide' }],
      [
        /`filters\.headingPath`: move it to `filters\.metadata\.headingPath`/,
        { headingPath: 'Architecture > RAG Design' },
      ],
    ])('pairs the key with its own remedy: %s', (pattern, filters) => {
      expect(() => buildWhereClause(asUntypedFilters(filters), schema)).toThrow(pattern);
    });

    it('honours the same fields under filters.metadata', () => {
      const result = buildWhereClause({ metadata: { type: 'guide' } }, schema);
      expect(result).toBe("type = 'guide'");
    });
  });

  describe('unknown keys — the class, not just the four known instances', () => {
    // This is what an allowlist buys and a blocklist cannot. None of these keys was ever
    // enumerated as unimplemented, and each of them silently widened before.
    it.each([
      ['a case typo on the one filter that works', { resourceid: 'doc-1' }],
      ['a field lifted from a design document', { keywords: ['oauth'] }],
      ['a plausible-sounding invention', { filePath: 'docs/security/**' }],
    ])('throws on %s', (_label, filters) => {
      expect(() => buildWhereClause(asUntypedFilters(filters), schema)).toThrow(/Unsupported RAG query field/);
    });

    it('names the keys it does read, so the caller can correct the spelling', () => {
      expect(() => buildWhereClause(asUntypedFilters({ resourceid: 'doc-1' }), schema)).toThrow(
        /`resourceId` and `metadata`/,
      );
    });
  });

  describe('undeclared metadata fields also refuse', () => {
    // The remedy above sends callers to `filters.metadata`. Under a metadata schema that
    // does not declare the field, the old code SKIPPED it — so obeying the remedy landed
    // the caller straight back in the widening bug it was meant to escape.
    const narrowSchema = z.object({ domain: z.string().optional() });

    it('throws on a metadata field the schema does not declare', () => {
      expect(() => buildWhereClause({ metadata: { tags: ['auth'] } }, narrowSchema)).toThrow(
        /Unknown metadata filter field `tags`/,
      );
    });

    it('lists the fields the schema does declare', () => {
      expect(() => buildWhereClause({ metadata: { tags: ['auth'] } }, narrowSchema)).toThrow(/`domain`/);
    });

    it('throws on a case mismatch, which the lowercased column names make easy to hit', () => {
      expect(() => buildWhereClause({ metadata: { headingpath: 'A > B' } }, schema)).toThrow(
        /Unknown metadata filter field `headingpath`/,
      );
    });
  });

  describe('a filter that resolves to nothing is refused too', () => {
    // The backstop an allowlist structurally cannot provide: the key IS supported, so no
    // key check fires, and the value still produces no condition. `{ tags: opts.tags }`
    // with an undefined `opts.tags` is the likeliest real-world shape of this.
    it('throws when every metadata value is undefined', () => {
      expect(() => buildWhereClause({ metadata: { type: undefined } }, schema)).toThrow(
        /resolved to nothing/,
      );
    });

    it('does NOT throw for a metadata object with no keys at all', () => {
      // Stating no criteria is not the same as stating criteria that vanished.
      expect(buildWhereClause({ metadata: {} }, schema)).toBeNull();
    });
  });

  describe('the guard reports every offender at once', () => {
    it('names all present unsupported keys in one error', () => {
      let message = '';
      try {
        buildWhereClause(asUntypedFilters({ tags: ['auth'], type: 'guide' }), schema);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/filters\.tags/);
      expect(message).toMatch(/filters\.type/);
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
      expect(buildWhereClause(asUntypedFilters({ resourceId: 'doc-123', tags: undefined }), schema)).toBe(
        "resourceid IN ('doc-123')",
      );
    });
  });
});
