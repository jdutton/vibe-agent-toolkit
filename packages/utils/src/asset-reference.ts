import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { isAbsolutePath, safePath } from './path-utils.js';

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
    throw new Error(formatActionableError(specifier, baseDir, cause), { cause: cause as Error });
  }
}

/**
 * Build a message that distinguishes the three common failure modes so callers
 * know where to look. Node's raw error often points at the resolved on-disk
 * path, which adopters easily misread as a VAT path-handling bug.
 */
function formatActionableError(specifier: string, baseDir: string, cause: unknown): string {
  const headline = formatResolutionError(cause);
  const code = (cause as { code?: string } | null)?.code;
  const missingPath = extractMissingModulePath(cause);

  // Mode 1: Node walked the package's `exports` map, computed an absolute
  // target path, and that file is not on disk. This is the most confusing
  // case for adopters: the package IS installed, the exports map IS correct,
  // but a build step in the target package didn't run (or produced different
  // output). Name the missing file explicitly and point at the publisher.
  if (code === 'MODULE_NOT_FOUND' && missingPath && missingPath !== specifier && isAbsolutePath(missingPath)) {
    const fileExists = safeExistsSync(missingPath);
    if (!fileExists) {
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

function safeExistsSync(filePath: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a Node-resolved exports target, used only to refine the error message
    return existsSync(filePath);
  } catch {
    return false;
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
