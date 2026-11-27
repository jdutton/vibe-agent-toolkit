/**
 * The identity of one row set: the content key of its bytes, the instance that read them, and the
 * variant it read them as. The ledger (`row_set_keys`) and every row-set table are keyed by these
 * three fields directly; there is no hash of them.
 *
 * {@link rowSetIdText} is the one place the triple is joined into text, for a `Set` or `Map` key.
 * Nothing parses that text back: a caller holding one keeps the {@link RowSetId} beside it.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import { orderContentKeys, type ContentKey } from '../content-key.js';
import type { DataInstance, DataVariant } from '../schemas/projection-data.js';

/** One row set's identity. */
export interface RowSetId {
  /** The content key of the bytes, as the population keyed them. */
  readonly contentKey: ContentKey;
  /** The instance whose tables hold the row set. */
  readonly instance: DataInstance;
  /** How the instance read the bytes. */
  readonly variant: DataVariant;
}

/** A {@link RowSetId} as text, from {@link rowSetIdText} only: equal exactly when the ids are. */
export type RowSetIdText = string & { readonly __brand: 'RowSetIdText' };

/**
 * One row set's identity as text, for a `Set` or `Map` key. NUL-separated: no field holds a NUL.
 *
 * @param id - The row set
 * @returns Its text; two ids give the same text exactly when their three fields are equal
 */
export function rowSetIdText(id: RowSetId): RowSetIdText {
  return `${String(id.contentKey)}\0${id.instance}\0${id.variant}` as RowSetIdText;
}

/**
 * The one order over row-set ids: content key (by `orderContentKeys`), then instance, then variant.
 *
 * @param a - An id
 * @param b - Another id
 * @returns Negative, zero or positive, as `Array.prototype.sort` takes
 */
export function compareRowSetIds(a: RowSetId, b: RowSetId): number {
  return orderContentKeys(a.contentKey, b.contentKey)
    || compareCodeUnits(a.instance, b.instance)
    || compareCodeUnits(a.variant, b.variant);
}
