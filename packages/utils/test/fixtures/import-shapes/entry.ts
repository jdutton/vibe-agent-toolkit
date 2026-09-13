/**
 * Fixture for `test/subpath-purity.test.ts`.
 *
 * One module edge of every shape a source file can write, so the purity
 * walker's detector is exercised rather than asserted. The detector used to be
 * `/from\s+'([^']+)'/gu` and saw ONLY the first of these; a lazy
 * `await import('…')` — the precise shape behind this repo's recorded "a lazy
 * import defers evaluation, not installation" trap — was invisible to the very
 * gate meant to catch it.
 *
 * The last line is the OTHER half of the fixture: prose that is textually an
 * import edge (`from "…"`) and semantically a sentence. Admitting double quotes
 * put it in range, and it must NOT be reported as a package.
 *
 * Not compiled (tsconfig includes `src/**` only) and not linted
 * (`**\/test/fixtures/**` is ignored), so these unresolvable packages are inert.
 */

import 'side-effect-pkg';
import defaultImport from "double-quoted-pkg";

export { id } from './re-exported.js';

/**
 * @returns A package loaded through a single-quoted dynamic import
 */
export async function lazySingle(): Promise<unknown> {
  return import('dynamic-single-pkg');
}

/**
 * @returns A package loaded through a double-quoted dynamic import
 */
export async function lazyDouble(): Promise<unknown> {
  return await import("dynamic-double-pkg");
}

/**
 * @returns A package loaded through CommonJS interop
 */
export function required(): unknown {
  return require('cjs-required-pkg');
}

export const notAnEdge = `(referenced from "${String(defaultImport)}")`;
