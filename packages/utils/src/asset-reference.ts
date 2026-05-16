import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { safePath } from './path-utils.js';

// First segment must be a valid npm package name (scoped or unscoped),
// followed by `/` and at least one subpath segment. Paths starting with
// `.`, `/`, or a Windows drive letter are filesystem paths, never bare
// specifiers.
const BARE_SPECIFIER_RE = /^(?:@[^/]+\/[^/]+|[a-z0-9][a-z0-9._-]*)\/.+/i;

/**
 * Resolve a VAT "asset reference" to an absolute filesystem path.
 *
 * An asset reference is either:
 *   - A filesystem path (relative to baseDir, or absolute), OR
 *   - An npm bare specifier (`@scope/pkg/subpath` or `pkg/subpath`),
 *     resolved via Node module resolution from baseDir, honoring the
 *     target package's `exports` map.
 *
 * Bare specifiers let VAT consumers reference schemas (and future
 * config-supplied files) published as npm packages without hardcoding
 * the package's internal layout. The publisher's `exports` field owns
 * the layout; consumers stay portable.
 *
 * NOTE: this is a VAT-internal abstraction for locating files. It is NOT
 * an RFC 3986 URI reference and is intentionally NOT used by markdown link
 * walkers (including the `format: "uri-reference"` frontmatter checker) —
 * bare specifiers are not valid URIs and would not resolve in a renderer.
 *
 * @example
 *   resolveAssetReference('@scope/pkg/schemas/foo.json', '/proj')
 *     // -> '/proj/node_modules/@scope/pkg/dist/schemas/foo.json' (per the
 *     //    package's exports map)
 *   resolveAssetReference('./schemas/foo.json', '/proj')
 *     // -> '/proj/schemas/foo.json'
 *   resolveAssetReference('/abs/foo.json', '/proj')
 *     // -> '/abs/foo.json'
 *
 * @param specifier - The asset reference (path or bare npm specifier)
 * @param baseDir - Absolute directory used as the resolution anchor
 * @returns Absolute filesystem path to the asset
 * @throws Error with actionable message and `cause` on resolution failure
 */
export function resolveAssetReference(specifier: string, baseDir: string): string {
  if (!isBareSpecifier(specifier)) {
    return safePath.resolve(baseDir, specifier);
  }

  const requireFn = createRequire(pathToFileURL(safePath.join(baseDir, 'package.json')).href);

  try {
    return requireFn.resolve(specifier);
  } catch (cause) {
    // Unscoped bare specifiers can also be interpreted as relative paths
    // (e.g., `dir/file.json` with no installed package "dir"). Fall back
    // to path resolution. Scoped (`@scope/...`) has no such ambiguity —
    // surface the error.
    if (!specifier.startsWith('@') && isModuleNotFound(cause)) {
      return safePath.resolve(baseDir, specifier);
    }
    throw new Error(
      `Failed to resolve asset reference '${specifier}': ${formatResolutionError(cause)}\n` +
        `Check the package's "exports" field, or run install in ${baseDir}.`,
      { cause: cause as Error },
    );
  }
}

function isBareSpecifier(value: string): boolean {
  return BARE_SPECIFIER_RE.test(value);
}

function isModuleNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'MODULE_NOT_FOUND'
  );
}

function formatResolutionError(err: unknown): string {
  if (err instanceof Error) {
    // Node's MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED messages are
    // long and noisy; first line is the actionable summary.
    const firstLine = err.message.split('\n', 1)[0];
    return firstLine ?? err.message;
  }
  return String(err);
}
