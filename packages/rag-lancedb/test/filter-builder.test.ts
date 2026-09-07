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

/**
 * 🔑 A minimal SQL `LIKE` evaluator, so the metacharacter tests below can assert the PROPERTY
 * — "this condition discriminates" — instead of a string shape.
 *
 * Asserting on the emitted text is what let the original defect through: the previous table
 * checked `not.toContain("LIKE '%%'")`, a literal that `LIKE '%%%'` does not contain, so a
 * pattern matching every row in the index passed a test written to forbid exactly that. Only
 * something that INTERPRETS the pattern can tell a filter from a tautology.
 */
type LikeToken = { kind: 'literal'; char: string } | { kind: 'one' } | { kind: 'many' };

const unquoteSQLLiteral = (literal: string): string => literal.replaceAll("''", "'");

const LIKE_WITH_ESCAPE = /^\w+ LIKE '(?<pattern>.*)' ESCAPE '(?<escape>.)'$/u;
const LIKE_BARE = /^\w+ LIKE '(?<pattern>.*)'$/u;

function parseLikeClause(clause: string): { pattern: string; escapeChar: string | undefined } {
  const withEscape = LIKE_WITH_ESCAPE.exec(clause);
  if (withEscape?.groups) {
    return {
      pattern: unquoteSQLLiteral(withEscape.groups['pattern'] ?? ''),
      escapeChar: withEscape.groups['escape'],
    };
  }

  const bare = LIKE_BARE.exec(clause);
  if (!bare?.groups) {
    throw new Error(`Not a single LIKE clause, so it cannot be evaluated: ${clause}`);
  }
  return { pattern: unquoteSQLLiteral(bare.groups['pattern'] ?? ''), escapeChar: undefined };
}

function tokenizeLikePattern(pattern: string, escapeChar: string | undefined): LikeToken[] {
  const tokens: LikeToken[] = [];
  let index = 0;

  while (index < pattern.length) {
    const char = pattern.charAt(index);

    if (escapeChar !== undefined && char === escapeChar) {
      const next = pattern.charAt(index + 1);
      if (next === '') {
        throw new Error(`Dangling escape character in LIKE pattern: ${pattern}`);
      }
      tokens.push({ kind: 'literal', char: next });
      index += 2;
      continue;
    }

    if (char === '%') {
      tokens.push({ kind: 'many' });
    } else if (char === '_') {
      tokens.push({ kind: 'one' });
    } else {
      tokens.push({ kind: 'literal', char });
    }
    index += 1;
  }

  return tokens;
}

/** Classic backtracking wildcard match: `%` is any run, `_` is exactly one character. */
function matchLikeTokens(tokens: readonly LikeToken[], value: string): boolean {
  let tokenIndex = 0;
  let valueIndex = 0;
  let lastManyToken = -1;
  let lastManyValue = 0;

  while (valueIndex < value.length) {
    const token = tokens[tokenIndex];

    if (token?.kind === 'many') {
      lastManyToken = tokenIndex;
      lastManyValue = valueIndex;
      tokenIndex += 1;
    } else if (token?.kind === 'one' || (token?.kind === 'literal' && token.char === value.charAt(valueIndex))) {
      tokenIndex += 1;
      valueIndex += 1;
    } else if (lastManyToken === -1) {
      return false;
    } else {
      lastManyValue += 1;
      tokenIndex = lastManyToken + 1;
      valueIndex = lastManyValue;
    }
  }

  while (tokens[tokenIndex]?.kind === 'many') {
    tokenIndex += 1;
  }
  return tokenIndex === tokens.length;
}

/** Does the emitted single-`LIKE` condition select a row whose column holds `value`? */
function likeClauseSelects(clause: string, value: string): boolean {
  const { pattern, escapeChar } = parseLikeClause(clause);
  return matchLikeTokens(tokenizeLikePattern(pattern, escapeChar), value);
}

describe('Filter Builder', () => {
  const TEST_DOMAIN = 'security';
  const EXPECTED_DOMAIN_FILTER = "domain = 'security'";
  const EXPECTED_AUTH_TAG_FILTER = "tags LIKE '%auth%'";

  describe('buildMetadataFilter', () => {
    it('should build string filter with exact match', () => {
      const zodType = z.string();
      const result = buildMetadataFilter('domain', TEST_DOMAIN, zodType);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should escape single quotes in string values', () => {
      const zodType = z.string();
      const result = buildMetadataFilter('title', "Bob's Document", zodType);
      expect(result).toBe("title = 'Bob''s Document'");
    });

    it('should build number filter with exact match', () => {
      const zodType = z.number();
      const result = buildMetadataFilter('priority', 1, zodType);
      expect(result).toBe("priority = 1");
    });

    it('should build boolean filter with exact match', () => {
      const zodType = z.boolean();
      const result = buildMetadataFilter('active', true, zodType);
      expect(result).toBe("active = 1");
    });

    it('should build array filter with LIKE query', () => {
      const zodType = z.array(z.string());
      const result = buildMetadataFilter('tags', 'auth', zodType);
      expect(result).toBe(EXPECTED_AUTH_TAG_FILTER);
    });

    // 🚨 THE MECHANISM IS STRINGIFICATION, NOT LENGTH — and the difference is the whole
    // defect. The array branch builds its LIKE pattern from `String(value)`, so EVERY
    // value that stringifies to the empty string produces `tags LIKE '%%'`: a pattern
    // matching every row in the index, returned to a caller who asked to be filtered.
    //
    // A guard written as `Array.isArray(value) && value.length === 0` closes the one
    // reported instance and leaves the mechanism wide open — `['']`, a bare `''` and
    // `[[]]` all still stringify to nothing and all still emitted the tautology. None of
    // them needs a type error to arrive: `filters.metadata` is deliberately open
    // (`z.record(z.string(), z.unknown())`), so each reaches here straight from a JSON
    // payload.
    //
    // So this table pins the PROPERTY — a value satisfiable by nothing emits the shared
    // always-false condition — rather than the example that was reported.
    const UNSATISFIABLE_ARRAY_VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
      { label: 'an empty array', value: [] },
      { label: 'an array holding one empty string', value: [''] },
      { label: 'a bare empty string', value: '' },
      { label: 'an array holding an empty array', value: [[]] },
    ];

    it.each(UNSATISFIABLE_ARRAY_VALUES)(
      'emits an always-false clause for $label, never a matches-everything LIKE',
      ({ value }) => {
        const zodType = z.array(z.string());

        const result = buildMetadataFilter('tags', value, zodType);

        expect(result).toBe('1 = 0');
        // Stated twice on purpose: `1 = 0` is what it MUST be, `LIKE '%%'` is what it must
        // never be. An assertion on the clause alone would still pass a future rewrite that
        // reintroduced the tautology under a different always-false spelling.
        expect(result).not.toContain("LIKE '%%'");
      },
    );

    it.each(UNSATISFIABLE_ARRAY_VALUES)(
      'gives $label the same answer through the public buildWhereClause path',
      ({ value }) => {
        const schema = z.object({ tags: z.array(z.string()) });

        expect(buildWhereClause({ metadata: { tags: value } }, schema)).toBe('1 = 0');
      },
    );

    it('does not turn a non-empty list into an always-false clause', () => {
      // The neighbour case, so the fix cannot pass by refusing every array.
      const zodType = z.array(z.string());
      const result = buildMetadataFilter('tags', ['auth'], zodType);
      expect(result).toBe(EXPECTED_AUTH_TAG_FILTER);
    });

    // 🔑 FINDING 4 — a multi-element list is matched ELEMENT BY ELEMENT, not as one CSV
    // substring. Arrays are stored by `serializeArray` in `schema.ts` as `value.join(',')`,
    // so the single-pattern form `tags LIKE '%auth,security%'` demanded that the caller
    // guess the STORED ORDER: a document tagged `security,auth` did not match, and the
    // caller got zero rows with nothing to say why.
    it('emits one LIKE per element, so a stored order the caller did not guess still matches', () => {
      const zodType = z.array(z.string());

      const result = buildMetadataFilter('tags', ['auth', 'security'], zodType);

      expect(result).toContain(EXPECTED_AUTH_TAG_FILTER);
      expect(result).toContain("tags LIKE '%security%'");
      // The pre-fix pattern, spelled out: no condition may embed the CSV separator and so
      // depend on adjacency in stored order.
      expect(result).not.toContain('auth,security');
    });

    it('ANDs the per-element conditions into one parenthesised fragment', () => {
      const zodType = z.array(z.string());

      const result = buildMetadataFilter('tags', ['auth', 'security'], zodType);

      expect(result).toBe("(tags LIKE '%auth%' AND tags LIKE '%security%')");
    });

    it('is unsatisfiable when ANY element of a multi-element list is empty', () => {
      // `['auth', '']` asks for a tag that is the empty string, which nothing has. Emitting
      // `LIKE '%auth%' AND LIKE '%%'` would silently drop the second half and answer a
      // question the caller did not ask.
      const zodType = z.array(z.string());

      expect(buildMetadataFilter('tags', ['auth', ''], zodType)).toBe('1 = 0');
    });

    // 🚨 THE MIRROR OF THE STRINGIFY-TO-NOTHING FAMILY, and it was left open. The guard above
    // closes "satisfiable by NOTHING"; this closes "satisfiable by EVERYTHING". The array
    // branch interpolates the member straight into a `LIKE` pattern, so a member that is
    // itself a LIKE metacharacter is read as a wildcard rather than as the character the
    // caller asked for: `['%']` emitted `tags LIKE '%%%'`, which matches every row in the
    // index, and `['_']` emitted `tags LIKE '%_%'`, which matches every non-empty one. Both
    // reach here without a type error because `filters.metadata` is deliberately open
    // (`z.record(z.string(), z.unknown())`), so a `%` straight out of a JSON payload turned a
    // request to be filtered into full-recall search.
    //
    // Neither new guard can see it: `assertQuerySupported` sees a supported key, and
    // `assertFiltersProducedConditions` counts one condition and is satisfied. Counting cannot
    // distinguish a condition that discriminates from one that does not — which is why the
    // table below EVALUATES the emitted pattern instead of asserting on its text. `decoy` is a
    // stored value that does NOT contain the member, chosen so the pre-fix pattern matched it.
    const LIKE_METACHARACTER_MEMBERS: ReadonlyArray<{
      label: string;
      member: string;
      decoy: string;
    }> = [
      { label: 'a bare percent', member: '%', decoy: 'auth' },
      { label: 'a bare underscore', member: '_', decoy: 'auth' },
      { label: 'a percent inside a word', member: 'a%b', decoy: 'axxxb' },
      { label: 'an underscore inside a word', member: 'a_b', decoy: 'axb' },
      // The escape character itself. Whatever scheme the builder chooses, escaping it must
      // itself be escaped, or `['\\']` silently becomes an escape of the closing `%`.
      { label: 'a bare backslash', member: '\\', decoy: 'auth' },
      {
        label: 'the escape character next to a wildcard',
        member: String.raw`a\%b`,
        decoy: String.raw`a\zzzb`,
      },
      { label: 'both wildcards at once', member: '%_%', decoy: 'auth' },
      { label: 'a realistic tag ending in percent', member: '100%', decoy: '100 percent' },
    ];

    it.each(LIKE_METACHARACTER_MEMBERS)(
      'treats $label as a literal, so the condition still discriminates',
      ({ member, decoy }) => {
        const zodType = z.array(z.string());

        const clause = buildMetadataFilter('tags', [member], zodType);

        // Not vacuously false: a row that really carries the member is still selected.
        expect(likeClauseSelects(clause, `x-${member}-y`)).toBe(true);
        expect(likeClauseSelects(clause, member)).toBe(true);
        // Not vacuously true: a row that does not carry it is NOT selected. This is the whole
        // defect — `LIKE '%%%'` answered `true` here for every value on earth.
        expect(likeClauseSelects(clause, decoy)).toBe(false);
        expect(likeClauseSelects(clause, '')).toBe(false);
      },
    );

    it('gives a metacharacter member the same answer through the public buildWhereClause path', () => {
      const schema = z.object({ tags: z.array(z.string()) });

      const clause = buildWhereClause({ metadata: { tags: ['%'] } }, schema);

      expect(clause).not.toBeNull();
      expect(likeClauseSelects(clause ?? '', 'a%b')).toBe(true);
      expect(likeClauseSelects(clause ?? '', 'auth')).toBe(false);
    });

    // 🔑 The other half of the fix: it must not be bought by changing what every working caller
    // already gets. These are the exact fragments emitted today, pinned byte-for-byte.
    it('leaves a metacharacter-free member byte-identical to the clause it emits today', () => {
      const zodType = z.array(z.string());

      expect(buildMetadataFilter('tags', ['auth'], zodType)).toBe(EXPECTED_AUTH_TAG_FILTER);
      expect(buildMetadataFilter('tags', 'auth', zodType)).toBe(EXPECTED_AUTH_TAG_FILTER);
      expect(buildMetadataFilter('tags', "user's-tag", zodType)).toBe("tags LIKE '%user''s-tag%'");
      expect(buildMetadataFilter('tags', ['auth', 'security'], zodType)).toBe(
        "(tags LIKE '%auth%' AND tags LIKE '%security%')",
      );
    });

    it('should escape single quotes in array filter values', () => {
      const zodType = z.array(z.string());
      const result = buildMetadataFilter('tags', "user's-tag", zodType);
      expect(result).toBe("tags LIKE '%user''s-tag%'");
    });

    it('should unwrap optional types', () => {
      const zodType = z.string().optional();
      const result = buildMetadataFilter('domain', TEST_DOMAIN, zodType);
      expect(result).toBe(EXPECTED_DOMAIN_FILTER);
    });

    it('should handle optional number types', () => {
      const zodType = z.number().optional();
      const result = buildMetadataFilter('priority', 2, zodType);
      expect(result).toBe("priority = 2");
    });

    it('should handle optional boolean types', () => {
      const zodType = z.boolean().optional();
      const result = buildMetadataFilter('archived', false, zodType);
      expect(result).toBe("archived = 0");
    });

    it('should handle optional array types', () => {
      const zodType = z.array(z.string()).optional();
      const result = buildMetadataFilter('keywords', 'security', zodType);
      expect(result).toBe("keywords LIKE '%security%'");
    });

    it('should convert camelCase keys to lowercase', () => {
      const zodType = z.string();
      const result = buildMetadataFilter('contentType', 'concepts', zodType);
      expect(result).toBe("contenttype = 'concepts'");
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
      expect(result).toBe("priority = 1");
    });

    it('should build clause for single boolean field', () => {
      const schema = z.object({ active: z.boolean() });
      const filters = { active: true };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("active = 1");
    });

    it('should build clause for single array field', () => {
      const schema = z.object({ tags: z.array(z.string()) });
      const filters = { tags: 'auth' };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe(EXPECTED_AUTH_TAG_FILTER);
    });

    it('should combine multiple filters with AND', () => {
      const schema = z.object({
        domain: z.string(),
        priority: z.number(),
      });
      const filters = { domain: TEST_DOMAIN, priority: 1 };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("domain = 'security' AND priority = 1");
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
        "domain = 'security' AND priority = 1 AND active = 1 AND tags LIKE '%auth%'"
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

    // 🚨 This test used to assert the OPPOSITE — that an unknown field is skipped and the
    // clause built from the remaining ones. It was pinning the bug. Skipping is the same
    // silent-widening failure the top-level guard refuses, and it became indefensible once
    // those refusals started telling callers to "move it to `filters.metadata`": under a
    // schema that lacks the field, obeying the remedy landed the caller back in the bug.
    it('should refuse a field the schema does not declare, rather than skipping it', () => {
      const schema = z.object({ domain: z.string() });
      const filters = { domain: TEST_DOMAIN, unknownField: 'value' };
      expect(() => buildMetadataWhereClause(filters, schema)).toThrow(
        /Unknown metadata filter field `unknownField`/,
      );
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
      expect(result).toBe("domain = 'security' AND priority = 1");
    });

    it('should convert camelCase to lowercase in combined filters', () => {
      const schema = z.object({
        contentType: z.string(),
        isActive: z.boolean(),
      });
      const filters = { contentType: 'concepts', isActive: true };
      const result = buildMetadataWhereClause(filters, schema);
      expect(result).toBe("contenttype = 'concepts' AND isactive = 1");
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
      expect(result).toBe("resourceid IN ('doc-123')");
    });

    it('should build clause for multiple resourceIds', () => {
      const filters = { resourceId: ['doc-123', 'doc-456'] };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("resourceid IN ('doc-123', 'doc-456')");
    });

    it('should handle empty resourceId array', () => {
      const filters = { resourceId: [] };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe('1 = 0');
    });

    it('should escape single quotes in resourceIds', () => {
      const filters = { resourceId: "doc's-file" };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("resourceid IN ('doc''s-file')");
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
        "resourceid IN ('doc-123') AND domain = 'security' AND priority = 1"
      );
    });

    it('should combine multiple resourceIds and metadata filters', () => {
      const filters = {
        resourceId: ['doc-123', 'doc-456'],
        metadata: { domain: TEST_DOMAIN },
      };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("resourceid IN ('doc-123', 'doc-456') AND domain = 'security'");
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
      expect(result).toBe("resourceid IN ('doc-123')");
    });
  });

  describe('SQL Injection Prevention', () => {
    const schema = z.object({ notes: z.string() });

    it('should escape malicious string with single quotes', () => {
      const filters = { metadata: { notes: "'; DROP TABLE users; --" } };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("notes = '''; DROP TABLE users; --'");
    });

    it('should escape resourceId with injection attempt', () => {
      const filters = { resourceId: "doc-123' OR '1'='1" };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("resourceid IN ('doc-123'' OR ''1''=''1')");
    });

    it('should handle multiple quotes in metadata', () => {
      const filters = { metadata: { notes: "It's a ''trap''" } };
      const result = buildWhereClause(filters, schema);
      expect(result).toBe("notes = 'It''s a ''''trap'''''");
    });
  });
});
