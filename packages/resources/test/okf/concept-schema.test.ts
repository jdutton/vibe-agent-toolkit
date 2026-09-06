/**
 * The OKF concept-document frontmatter schema.
 *
 * ⭐ The property this suite exists to protect is **permissiveness**. Reading an
 * adopter's bundle is consuming external data, and OKF requires tolerating
 * unknown keys (§4.1) and unknown `type` values (§4.1, §11). A `.strict()`
 * reader here would refuse documents the specification calls conformant — the
 * `schema-strictness` rule's "liberal in what you accept" half, not an
 * exception carved for OKF.
 *
 * What the schema DOES close is what the specification itself closes: the one
 * required key, and the two keys that are REQUIRED-within-a-mapping.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { OkfConceptFrontmatterSchema } from '../../src/schemas/okf-concept.js';

/** Every `additionalProperties` value in the committed JSON Schema artifact. */
function committedAdditionalProperties(): unknown[] {
  const path = safePath.join(import.meta.dirname, '..', '..', 'schemas', 'okf-concept-frontmatter.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path built from this test file's own location
  const artifact: unknown = JSON.parse(readFileSync(path, 'utf8'));

  const values: unknown[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'additionalProperties') values.push(value);
      visit(value);
    }
  };
  visit(artifact);
  return values;
}

/** Parse and return the flattened field errors, so assertions name a key. */
function fieldErrors(value: unknown): string[] {
  const result = OkfConceptFrontmatterSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('OkfConceptFrontmatterSchema', () => {
  describe('the one required key', () => {
    it('accepts a document carrying nothing but type', () => {
      // §4.1: "a concept carrying just `type` is fully conformant (§11)".
      expect(OkfConceptFrontmatterSchema.safeParse({ type: 'Metric' }).success).toBe(true);
    });

    it('accepts a type value no registry has ever heard of', () => {
      // §4.1: type values are not registered centrally.
      const parsed = OkfConceptFrontmatterSchema.safeParse({ type: 'Claims Adjudication Rule' });
      expect(parsed.success).toBe(true);
    });

    it('refuses a document with no type', () => {
      expect(fieldErrors({ title: 'No type here' })).toEqual(['type']);
    });

    it('refuses a whitespace-only type, which is not a non-empty string', () => {
      expect(fieldErrors({ type: '   ' })).toEqual(['type']);
    });
  });

  describe('permissiveness', () => {
    it('passes unknown top-level keys through instead of rejecting them', () => {
      const parsed = OkfConceptFrontmatterSchema.parse({
        type: 'BigQuery Table',
        acme_internal_owner: 'team:data-platform',
      });

      expect(parsed).toMatchObject({ acme_internal_owner: 'team:data-platform' });
    });

    it('passes unknown keys inside a sources entry through', () => {
      const parsed = OkfConceptFrontmatterSchema.parse({
        type: 'Metric',
        sources: [{ resource: 'https://example.com/schema', confidence: 'high' }],
      });

      expect(parsed.sources?.[0]).toMatchObject({ confidence: 'high' });
    });

    it('accepts a status value outside the three conventional ones', () => {
      // §5.4 names draft/stable/deprecated, but §11 makes every constraint
      // beyond items 1-3 soft guidance — a fourth value does not make the
      // bundle non-conformant, so the reader must not refuse it.
      expect(OkfConceptFrontmatterSchema.safeParse({ type: 'Metric', status: 'archived' }).success)
        .toBe(true);
    });
  });

  describe('the committed JSON Schema artifact', () => {
    it('never closes an object, at any depth', () => {
      // The `.json` sibling is what an adopter actually points a collection's
      // `frontmatterSchema` at, so permissiveness has to hold in the ARTIFACT,
      // not only in the TypeScript. A single `false` here would refuse
      // conformant bundles for every consumer of the published schema.
      const values = committedAdditionalProperties();

      expect(values.length).toBeGreaterThan(0);
      expect(values).not.toContain(false);
    });

    it('carries the non-empty type constraint that a transform would have dropped', () => {
      const path = safePath.join(import.meta.dirname, '..', '..', 'schemas', 'okf-concept-frontmatter.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path built from this test file's own location
      const artifact = readFileSync(path, 'utf8');

      expect(artifact).toContain(String.raw`"pattern": "\\S"`);
    });
  });

  describe('shapes the specification does close', () => {
    it('requires resource within a sources entry', () => {
      expect(fieldErrors({ type: 'Metric', sources: [{ id: 'ga4' }] })).toEqual([
        'sources.0.resource',
      ]);
    });

    it('requires by within generated', () => {
      expect(fieldErrors({ type: 'Metric', generated: { at: '2026-06-20T22:53:05Z' } })).toEqual([
        'generated.by',
      ]);
    });
  });

  describe('interop shapes a real bundle produces', () => {
    it('accepts a bare verified mapping as well as a list', () => {
      // §5.2: "Consumers MUST treat a bare mapping as a one-element list".
      const bare = { type: 'Metric', verified: { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' } };
      const list = { type: 'Metric', verified: [{ by: 'process:nightly', at: '2026-06-26T02:00:00Z' }] };

      expect(OkfConceptFrontmatterSchema.safeParse(bare).success).toBe(true);
      expect(OkfConceptFrontmatterSchema.safeParse(list).success).toBe(true);
    });

    it('accepts a datetime that YAML decoded to a Date as well as one it left a string', () => {
      // Whether `2026-09-23T00:00:00Z` arrives as a string or a Date is decided
      // by the YAML schema in force (1.2 core leaves it a string; 1.1 and an
      // explicit `!!timestamp` produce a Date), which is the producer's choice
      // and not something a reader may refuse over.
      const asString = { type: 'Metric', stale_after: '2026-09-23T00:00:00Z' };
      const asDate = { type: 'Metric', stale_after: new Date('2026-09-23T00:00:00Z') };

      expect(OkfConceptFrontmatterSchema.safeParse(asString).success).toBe(true);
      expect(OkfConceptFrontmatterSchema.safeParse(asDate).success).toBe(true);
    });

    it('accepts the tags list and the recommended fields together', () => {
      const parsed = OkfConceptFrontmatterSchema.parse({
        type: 'BigQuery Table',
        title: 'Customer Orders',
        description: 'One row per completed customer order across all channels.',
        resource: 'https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders',
        tags: ['sales', 'orders', 'revenue'],
        generated: { by: 'reference_agent/gemini-2.5-pro', at: '2026-05-28T14:30:00Z' },
        usage_window: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
      });

      expect(parsed.tags).toEqual(['sales', 'orders', 'revenue']);
    });
  });
});
