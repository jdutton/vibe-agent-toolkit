/**
 * Transform allowlist for linkAuth rewrite templates.
 *
 * Rewrite `to:` templates may call transforms over named regex captures —
 * e.g. `${base64url(u)}` for Microsoft Graph share-ids. The allowed set is
 * frozen in this file: adding a transform requires a VAT PR (see issue #113
 * design §4.1). There is no arbitrary-evaluation path.
 *
 * v1 inputs are assumed to be ASCII URL host/path captures. Non-ASCII edge
 * cases (lone surrogates) are pinned by tests so future regressions surface.
 */

type TransformFn = (input: string) => string;

const TRANSFORMS = {
  base64url: (s: string) => Buffer.from(s, 'utf8').toString('base64url'),
  urlencode: (s: string) => encodeURIComponent(s),
  lower: (s: string) => s.toLowerCase(),
} as const satisfies Record<string, TransformFn>;

export type TransformName = keyof typeof TRANSFORMS;

/**
 * The closed allowlist of transform names. Callers parsing rewrite templates
 * can validate transform calls (e.g. `${base64url(u)}`) against this list at
 * config-load time, surfacing typos before any URL is rewritten.
 */
export const ALLOWED_TRANSFORMS: readonly TransformName[] = Object.freeze(
  Object.keys(TRANSFORMS) as TransformName[],
);

/**
 * Thrown by `applyTransform` when called with a name not in the closed
 * allowlist. The message names the bad transform and the full allowlist so
 * a misconfigured macro surfaces a clear error at load time.
 */
export class UnknownTransformError extends Error {
  constructor(name: string) {
    super(`Unknown transform "${name}". Allowed: ${ALLOWED_TRANSFORMS.join(', ')}.`);
    this.name = 'UnknownTransformError';
  }
}

/**
 * Dispatch a transform by name on a string input.
 *
 * Security claim: only the names in `ALLOWED_TRANSFORMS` resolve; any other
 * input throws `UnknownTransformError`. Lookup uses `Object.hasOwn` to block
 * prototype-chain keys (`toString`, `__proto__`, `constructor`, …) that a
 * `name in TRANSFORMS` check would let through.
 *
 * @throws {UnknownTransformError} if `name` is not in the allowlist
 * @throws {URIError} from `urlencode` on lone-surrogate inputs — deliberate;
 *   v1 callers pass URL-derived captures that cannot legally contain these
 */
export function applyTransform(name: string, input: string): string {
  if (!Object.hasOwn(TRANSFORMS, name)) {
    throw new UnknownTransformError(name);
  }
  return TRANSFORMS[name as TransformName](input);
}
