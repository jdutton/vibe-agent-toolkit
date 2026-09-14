/**
 * The base class of every error VAT throws on purpose.
 *
 * `code` is the one field a catch block may dispatch on. A message is prose
 * for a human and changes whenever the prose improves; a code is a contract
 * and changes only when the meaning does. Three packages used to recognise a
 * root-escape by `error.message.startsWith('safePath.joinUnderRoot:')`, which
 * held exactly until someone reworded the sentence — the ESLint restriction
 * on `.message.includes(…)` exists so nobody writes the fourth.
 *
 * The brand is a registry symbol rather than the class identity because the
 * class identity is not stable across the one boundary VAT crosses every day:
 * a `dist` copy of a class never `instanceof`-matches a `src` instance, and
 * `packages/cli` imports the same modules from both during tests.
 * `Symbol.for` is realm-global, so {@link isVatError} answers the same on both
 * sides.
 */

const VAT_ERROR_BRAND: unique symbol = Symbol.for('vat.error');

/** An error VAT threw on purpose, with a stable machine-readable `code`. */
export class VatError extends Error {
  /** Stable identity for dispatch — `SCREAMING_SNAKE`, never read from prose. */
  readonly code: string;
  readonly [VAT_ERROR_BRAND] = true;

  /**
   * @param code - The stable identity a catch block dispatches on
   * @param message - What went wrong, for a human
   * @param options - `cause`, as on a native Error
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/**
 * Whether `error` is a VAT error — optionally one carrying exactly `code`.
 *
 * Reads the brand and the `code` field, never the prototype chain, so an
 * instance produced by another copy of this module (a `dist` build beside a
 * `src` import) still answers yes. A foreign error that happens to carry a
 * `code` — every `node:fs` errno does — answers no: the brand is the claim.
 *
 * @param error - Anything a catch block received
 * @param code - When given, the exact code required
 */
export function isVatError(error: unknown, code?: string): error is VatError {
  if (typeof error !== 'object' || error === null) return false;
  if (!(VAT_ERROR_BRAND in error) || error[VAT_ERROR_BRAND] !== true) return false;
  const declared = (error as { code?: unknown }).code;
  if (typeof declared !== 'string') return false;
  return code === undefined || declared === code;
}

/**
 * Marks an error {@link prefixMessageOnce} has already prefixed. A registry
 * symbol on the error itself rather than a module-local `WeakSet`: under the
 * same src/dist duplication that justifies the `Symbol.for` brand above, a
 * per-module set would make "once" mean "once per copy of this module".
 */
const PREFIXED: unique symbol = Symbol.for('vat.error.prefixed');

/**
 * Prefix an error's message IN PLACE, exactly once per error object.
 *
 * In place rather than re-wrapped because the error's class is what its
 * catch blocks dispatch on (`GradingNonceError`, `RateLimitSignal`, …), and a
 * wrapper would flatten every class into one. Once, because a retried item or
 * a cached error object passes through the same seam more than once and must
 * not accumulate prefixes. "Once" is remembered per object, not detected by
 * re-reading the message — the previous check was `message.startsWith(prefix)`,
 * which is a dispatch on prose by another name.
 *
 * @param error - Anything a catch block received; a non-Error is left alone
 * @param prefix - Text to put before the message
 */
export function prefixMessageOnce(error: unknown, prefix: string): void {
  if (!(error instanceof Error) || PREFIXED in error) return;
  Object.defineProperty(error, PREFIXED, { value: true, enumerable: false });
  error.message = `${prefix}${error.message}`;
}
