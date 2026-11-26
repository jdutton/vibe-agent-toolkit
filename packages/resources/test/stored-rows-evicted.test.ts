/**
 * `StoredRowsEvictedError`: what a copy (or a stage's extending read) throws when a row the run was
 * served left the store before it was used. The lane narrows by the typed guard, never by text, and
 * a row-set eviction names exactly the evicted ids so the retry forgets those and nothing else.
 */

import { VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { computeContentKey } from '../src/content-key.js';
import {
  isStoredRowsEvicted,
  PROJECTION_STORE_ROWS_EVICTED_CODE,
  StoredRowsEvictedError,
  type RowSetId,
} from '../src/index.js';

const evictedId: RowSetId = { contentKey: computeContentKey(new TextEncoder().encode('{}'), 'none'), instance: 'data', variant: 'json' };

describe('StoredRowsEvictedError', () => {
  it('carries the blob tier and how many keys left', () => {
    const error = new StoredRowsEvictedError({ tier: 'blob', relation: 'blob_references', missing: 2 });
    expect(error.code).toBe(PROJECTION_STORE_ROWS_EVICTED_CODE);
    expect(error.eviction).toStrictEqual({ tier: 'blob', relation: 'blob_references', missing: 2 });
    expect(error.message).toContain('blob_references');
  });

  it('carries the row-set tier and exactly the evicted ids', () => {
    const error = new StoredRowsEvictedError({ tier: 'rowSet', relation: 'data__nodes', ids: [evictedId] });
    expect(error.eviction.tier === 'rowSet' ? error.eviction.ids : []).toStrictEqual([evictedId]);
  });
});

describe('isStoredRowsEvicted', () => {
  it('answers yes for either tier', () => {
    expect(isStoredRowsEvicted(new StoredRowsEvictedError({ tier: 'blob', relation: 'r', missing: 1 }))).toBe(true);
    expect(isStoredRowsEvicted(new StoredRowsEvictedError({ tier: 'rowSet', relation: 'r', ids: [evictedId] }))).toBe(true);
  });

  it('answers no for a VAT error carrying the code but no eviction, and for anything else', () => {
    expect(isStoredRowsEvicted(new VatError(PROJECTION_STORE_ROWS_EVICTED_CODE, 'text only'))).toBe(false);
    expect(isStoredRowsEvicted(new Error(PROJECTION_STORE_ROWS_EVICTED_CODE))).toBe(false);
    expect(isStoredRowsEvicted(undefined)).toBe(false);
  });
});
