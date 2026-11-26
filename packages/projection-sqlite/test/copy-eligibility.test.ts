/**
 * `isCopyEligible` reads its first primary-key column as the content key a copy filters by, so a
 * relation keyed first by anything else is refused, however its other key columns are typed. The
 * whole eligible set over the shipped registry is pinned in `run-database-stored-copy.integration.test.ts`.
 */

import { storedRelationSpecs, type StoredRelationSpec } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { isCopyEligible } from '../src/run-database.js';

/** A shipped stored relation, by SQL name. */
function relation(name: string): StoredRelationSpec {
  const spec = storedRelationSpecs().find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`no stored relation "${name}"`);
  return spec;
}

describe('isCopyEligible: the first key column is the content key', () => {
  it.each([
    // A blob-scoped table keyed first by free text, with no further key column to refuse it.
    ['skill_text_facts', ['h1']],
    // A row-set table keyed first by its ASCII enum rather than its content key.
    ['data__files', ['variant']],
  ])('refuses %s keyed first by %j', (name, primaryKey) => {
    const spec = relation(name);
    expect(isCopyEligible(spec), 'the shipped key is eligible, so the control is not vacuous').toBe(true);
    expect(isCopyEligible({ ...spec, primaryKey } as StoredRelationSpec)).toBe(false);
  });
});
