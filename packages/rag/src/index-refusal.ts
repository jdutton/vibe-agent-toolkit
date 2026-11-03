import { isVatError, VatError } from '@vibe-agent-toolkit/utils';

import type { IndexResult } from './interfaces/index.js';

/** The store's refusal under its own `code`, carrying what the batch recorded before it. */
export class IndexBatchRefusedError extends VatError {
  readonly partial: IndexResult;

  constructor(refusal: VatError, partial: IndexResult) {
    super(refusal.code, refusal.message, { cause: refusal });
    this.partial = partial;
  }
}

/** A refused batch's partial result, read by brand and field so a `dist` copy of the class answers too. */
export function partialIndexResultOf(error: unknown): IndexResult | undefined {
  return isVatError(error) && 'partial' in error ? (error as IndexBatchRefusedError).partial : undefined;
}
