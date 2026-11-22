/**
 * The run's ONE parse routing: which document parser, if any, a path goes to.
 *
 * Distinct from {@link parserKindForPath} in `content-key.ts`, which routes by the
 * built-in extension table alone. A collection may declare a `mimeType` that
 * overrides that table, and a lane that must agree with the projection lane about
 * whether a file is prose routes through the run's resolver, here. The registry's
 * read, the sizing tally and the overlap gate all call this function; a second
 * copy is how the parse route and the content key's parse-route component drift
 * apart (content-key.ts).
 */

import { NO_PARSER_KIND, type ParserKind } from './content-key.js';
import { parserKindForMimeType } from './mime-type.js';
import { relativize, type CollectionMimeResolver } from './projection/realizations.js';

/**
 * @param absolutePath - The resolved path to route
 * @param resolver - The run's collection MIME resolver; it falls back to the
 *   built-in table for every path no declaration matches
 * @param baseDir - The directory declarations are relative to, or undefined to
 *   match them against the absolute path
 * @returns The parser kind, or `none` when nothing parses this type
 */
export function parserKindForResolvedPath(
  absolutePath: string,
  resolver: CollectionMimeResolver,
  baseDir: string | undefined,
): ParserKind {
  const declaredMime = resolver.mimeFor(absolutePath, baseDir === undefined ? absolutePath : relativize(absolutePath, baseDir));
  return parserKindForMimeType(declaredMime) ?? NO_PARSER_KIND;
}
