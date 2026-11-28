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
import { DataVariantSchema, type DataVariant } from '../schemas/projection-data.js';
import { TsVariantSchema, type TsVariant } from '../schemas/projection-ts.js';

/** Each row-set instance, and the variants it reads bytes as. */
export interface RowSetVariants {
  readonly data: DataVariant;
  readonly ts: TsVariant;
}

/** A row-set instance. */
export type RowSetInstanceId = keyof RowSetVariants;

/** One row set's identity under one instance: the instance's own variants only. */
export interface RowSetIdOf<Instance extends RowSetInstanceId> {
  /** The content key of the bytes, as the population keyed them. */
  readonly contentKey: ContentKey;
  /** The instance whose tables hold the row set. */
  readonly instance: Instance;
  /** How the instance read the bytes. */
  readonly variant: RowSetVariants[Instance];
}

/** One row set's identity: an instance paired with one of its own variants, never another's. */
export type RowSetId = { readonly [Instance in RowSetInstanceId]: RowSetIdOf<Instance> }[RowSetInstanceId];

/** Each instance's variants, as the schemas declare them. */
const VARIANTS_OF: { readonly [Instance in RowSetInstanceId]: ReadonlySet<string> } = {
  data: new Set(DataVariantSchema.options),
  ts: new Set(TsVariantSchema.options),
};

/**
 * A row set's identity from a stored row's untyped `variant`, checked against the instance's own
 * variants: the one place an id is built from text a row holds.
 *
 * @param contentKey - The content key of the bytes
 * @param instance - The instance of the table the row came from
 * @param variant - The row's `variant`
 * @returns The id
 * @throws TypeError When `variant` is not one of the instance's variants
 */
export function rowSetIdOf(contentKey: ContentKey, instance: RowSetInstanceId, variant: unknown): RowSetId {
  if (typeof variant !== 'string' || !VARIANTS_OF[instance].has(variant)) {
    throw new TypeError(`A "${instance}" row set has no variant ${String(variant)}`);
  }
  return { contentKey, instance, variant } as RowSetId;
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
