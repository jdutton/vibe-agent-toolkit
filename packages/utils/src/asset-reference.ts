import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { VatError } from './errors/vat-error.js';
import { isAbsolutePath, safePath } from './path-utils.js';

/**
 * A bare specifier Node could not resolve to a file: the package is not
 * installed, its `exports` map does not expose the subpath, or the file it
 * points at is not on disk. Always about the reference a user supplied, so a
 * caller reports it against that input — never as VAT's defect.
 */
export const ASSET_REFERENCE_UNRESOLVED_CODE = 'ASSET_REFERENCE_UNRESOLVED';

/**
 * A bare specifier whose package IS installed, but which Node could not read
 * its way through: a malformed or unreadable `package.json`, or an `exports`
 * map that is itself invalid. The reference names something; the package is
 * broken — so a caller reports it as an unreadable input, never as "missing".
 */
export const ASSET_REFERENCE_UNREADABLE_CODE = 'ASSET_REFERENCE_UNREADABLE';

/** Node's codes for "this specifier names nothing it can reach" — everything else is the package's fault. */
const NAMES_NOTHING_CODES: ReadonlySet<string> = new Set(['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

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
 * @throws {VatError} `ASSET_REFERENCE_UNRESOLVED`, with an actionable message and
 *   Node's error as `cause`, when a bare specifier names nothing Node can reach;
 *   `ASSET_REFERENCE_UNREADABLE` when the package is there and Node cannot read it
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
    if (!NAMES_NOTHING_CODES.has(errorCodeOf(cause) ?? '')) {
      throw new VatError(
        ASSET_REFERENCE_UNREADABLE_CODE,
        `Failed to resolve asset reference '${specifier}': its package is installed but Node cannot read it ` +
          `(a malformed or unreadable package.json, or an invalid "exports" map) — fix or reinstall the package.\n` +
          `Node error: ${formatResolutionError(cause)}`,
        { cause },
      );
    }
    throw new VatError(ASSET_REFERENCE_UNRESOLVED_CODE, formatActionableError(specifier, baseDir, cause), { cause });
  }
}

/**
 * Build a message that distinguishes the three common failure modes so callers
 * know where to look. Node's raw error often points at the resolved on-disk
 * path, which adopters easily misread as a VAT path-handling bug.
 */
function formatActionableError(specifier: string, baseDir: string, cause: unknown): string {
  const headline = formatResolutionError(cause);
  const code = errorCodeOf(cause);
  const missingPath = extractMissingModulePath(cause);

  // Mode 1: Node walked the package's `exports` map, computed an absolute
  // target path, and that file is not on disk. This is the most confusing
  // case for adopters: the package IS installed, the exports map IS correct,
  // but a build step in the target package didn't run (or produced different
  // output). Name the missing file explicitly and point at the publisher.
  if (code === 'MODULE_NOT_FOUND' && missingPath && missingPath !== specifier && isAbsolutePath(missingPath)) {
    // `existsSync` answers false for every failure and never throws, so no
    // guard around it: the question here is only whether the file is there.
    if (!existsSync(missingPath)) {
      return (
        `Failed to resolve asset reference '${specifier}': ` +
        `the package's "exports" map points to '${missingPath}', but that file does not exist on disk.\n` +
        `Hint: the target package was found, but a build step did not produce this file. ` +
        `Rebuild the publishing package (e.g., \`pnpm --filter <package> build\`) to generate the missing artifact, ` +
        `or verify the package's "exports" subpath pattern matches what its build emits.\n` +
        `Node error: ${headline}`
      );
    }
  }

  // Mode 2: Exports map didn't expose the requested subpath at all.
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return (
      `Failed to resolve asset reference '${specifier}': ` +
      `the target package does not expose this subpath in its "exports" map.\n` +
      `Hint: check the package's package.json "exports" field — only paths declared there are reachable via bare specifier.\n` +
      `Node error: ${headline}`
    );
  }

  // Mode 3: Package itself not installed / not reachable from baseDir.
  return (
    `Failed to resolve asset reference '${specifier}': ${headline}\n` +
    `Check the package's "exports" field, or run install in ${baseDir}.`
  );
}

/**
 * Node's MODULE_NOT_FOUND message has the form: `Cannot find module 'X'`.
 * Pull `X` out so we can decide whether the error refers to the original
 * specifier (package not installed) or to a resolved on-disk path (file
 * missing at exports target).
 */
const CANNOT_FIND_MODULE_RE = /Cannot find module '([^']+)'/;

function extractMissingModulePath(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const match = CANNOT_FIND_MODULE_RE.exec(cause.message);
  return match?.[1];
}

function isBareSpecifier(value: string): boolean {
  return BARE_SPECIFIER_RE.test(value);
}

function errorCodeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function isModuleNotFound(err: unknown): boolean {
  return errorCodeOf(err) === 'MODULE_NOT_FOUND';
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
