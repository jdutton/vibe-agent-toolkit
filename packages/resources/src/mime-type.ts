/**
 * What type is this file? — the single lookup parser routing consults.
 *
 * Pure string in, value out. No filesystem, no config, no I/O: the answer is a
 * function of the path text alone, which is what lets a caller type a *historical*
 * blob that is not on disk, and lets the projection describe a corpus it has not
 * read.
 *
 * ## Why a MIME type at all, when routing only needs `markdown | html`
 *
 * Because "we do not parse this" and "we do not know what this is" are different
 * facts, and a corpus report that cannot tell them apart is lying about its own
 * coverage. A tree of 8,000 files where 6,000 are `.ts` and 40 are
 * `.fraud-ingest-job` should say exactly that — not "6,040 unparsed". So typing is
 * separated from routing: {@link mimeTypeForPath} answers *what it is*, and
 * {@link parserKindForMimeType} answers *what runs over it*, and most types
 * legitimately answer the second question with `null`.
 *
 * ## Why `null` and not `application/octet-stream`
 *
 * `application/octet-stream` is a **claim**: "these are opaque bytes." We are in no
 * position to make it from a path string — a `.fraud-ingest-job` file is
 * overwhelmingly likely to be text we simply have no name for. Returning `null`
 * says "no type recorded", which a caller can distinguish from "known to be
 * binary" and can later refine (by sniffing, by config) without first having to
 * disprove an assertion this module invented. A default of `octet-stream` would
 * make every unknown look deliberately classified, and the number of unknowns —
 * the one number that tells us where this table needs to grow — would read as
 * zero forever.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * Which document parser a type routes to.
 *
 * Declared structurally here rather than imported from `content-key.ts`, whose
 * `ParserKind` is being reworked in parallel. The two are the same set today and a
 * follow-up reconciles them into one definition — see the report accompanying this
 * change.
 */
export type DocumentParserKind = 'markdown' | 'html';

/**
 * The three types that route to a parser, named because two independent tables
 * below must agree on them exactly. A typo in a repeated literal would produce a
 * type nothing routes — silently unparsed rather than loudly wrong.
 */
const TEXT_MARKDOWN = 'text/markdown'; // RFC 7763
const TEXT_HTML = 'text/html';
const TEXT_PLAIN = 'text/plain';

/**
 * Extensionless well-knowns.
 *
 * These are the files every repository carries with no extension at all. They are
 * prose, so `text/plain` is both true and useful — it is the one type that routes
 * to the markdown parser without claiming the file is markdown.
 *
 * Listed in the conventional all-caps spelling; lookup upper-cases the candidate, so
 * `readme`, `Readme` and `README` all hit. That is deliberate: the casing carries no
 * information here — nothing in this set has a case-distinct sibling that means
 * something else — and a case-sensitive table would silently drop the lowercase
 * `readme` that half the ecosystem writes.
 */
const WELL_KNOWN_BASENAMES = new Map<string, string>(
  ['README', 'CHANGELOG', 'LICENSE', 'LICENCE', 'CONTRIBUTING', 'NOTICE', 'AUTHORS', 'COPYING'].map((name) => [
    name,
    TEXT_PLAIN,
  ]),
);

/**
 * Extension → MIME type, grouped so each type is written once and every extension
 * that means it sits beside it.
 *
 * Registered IANA types are used wherever one exists. Where none does, a
 * conventional `text/x-*` / `application/x-*` value is used and marked below, so a
 * later reader can tell which values are standards and which are this project's
 * choices. The distinction matters if these strings ever cross a wire.
 *
 * ⚠️ `text/plain` here means **prose** — it is the value that routes to the markdown
 * parser (see {@link parserKindForMimeType}). Never assign it to a format that
 * merely happens to be text, such as a lockfile; give that its own type.
 */
const EXTENSION_GROUPS: ReadonlyArray<readonly [readonly string[], string]> = [
  // Documents — the only entries that route to a parser.
  [['.md', '.markdown'], TEXT_MARKDOWN],
  [['.html', '.htm'], TEXT_HTML],
  [['.txt'], TEXT_PLAIN],

  // Source.
  // `text/x-typescript` is conventional: IANA's registered type for `.ts` is
  // video/mp2t (MPEG transport stream), which this is emphatically not.
  [['.ts', '.mts', '.cts'], 'text/x-typescript'],
  [['.js', '.mjs', '.cjs'], 'text/javascript'], // RFC 9239 (application/javascript is obsoleted)
  [['.py'], 'text/x-python'], // conventional
  [['.sh'], 'application/x-sh'], // conventional
  [['.ps1'], 'application/x-powershell'], // conventional
  [['.cs'], 'text/x-csharp'], // conventional
  [['.sql'], 'application/sql'], // RFC 6922
  [['.graphql'], 'application/graphql'], // conventional
  [['.tf', '.hcl'], 'text/x-hcl'], // conventional

  // Data and config.
  [['.json'], 'application/json'], // RFC 8259
  [['.jsonl'], 'application/x-ndjson'], // conventional
  [['.yaml', '.yml'], 'application/yaml'], // RFC 9512
  [['.toml'], 'application/toml'],
  [['.csv'], 'text/csv'], // RFC 4180
  [['.tsv'], 'text/tab-separated-values'],
  [['.xml'], 'application/xml'], // RFC 7303
  [['.lock'], 'text/x-lockfile'], // conventional — text, but NOT prose; see the warning above

  // Presentation.
  [['.svg'], 'image/svg+xml'],
  [['.css'], 'text/css'],
  [['.scss'], 'text/x-scss'], // conventional

  // Test artifacts.
  [['.snap'], 'text/x-snapshot'], // conventional
];

const EXTENSION_TYPES = new Map<string, string>(
  EXTENSION_GROUPS.flatMap(([extensions, mimeType]) => extensions.map((ext): [string, string] => [ext, mimeType])),
);

/** MIME type → parser. Absent means "run no document parser over this". */
const PARSER_BY_MIME_TYPE = new Map<string, DocumentParserKind>([
  [TEXT_MARKDOWN, 'markdown'],
  [TEXT_HTML, 'html'],
  [TEXT_PLAIN, 'markdown'],
]);

/**
 * Split a path into its basename and lower-cased extension.
 *
 * Normalizes separators first so a Windows `C:\repo\README` yields `README` rather
 * than the whole string — CI runs on Windows, and a POSIX `basename()` applied to a
 * backslash path silently returns the entire path, which would make every
 * extensionless well-known miss on exactly one of the two platforms.
 *
 * The extension rule matches Node's `path.extname` deliberately: a dot at position
 * 0 of the basename is part of the NAME, not a separator, so `.gitignore` has no
 * extension. Matching the platform's own definition means there is one rule to
 * reason about rather than two that can disagree.
 */
function splitPath(filePath: string): { base: string; ext: string } {
  const normalized = toForwardSlash(filePath);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return { base, ext: dot > 0 ? base.slice(dot).toLowerCase() : '' };
}

/**
 * Determine the MIME type of a path, by name alone.
 *
 * Resolution order:
 * 1. If the path has **no extension**, the well-known basename table
 *    (case-insensitive). This is why `README` is typed but `README.md` never
 *    reaches this rung — the extension is strictly better evidence, and treating
 *    the basename as higher precedence would stop every repository's README from
 *    being parsed as markdown.
 * 2. Otherwise the extension table, on the lower-cased extension.
 * 3. Otherwise `null` — "no type recorded", which is NOT `application/octet-stream`.
 *    See the module docstring for why that distinction is load-bearing.
 *
 * @param filePath - Path the document is (or was) at; need not exist. POSIX or
 *   Windows separators both work.
 * @returns The MIME type, or `null` if this module has no name for it
 */
export function mimeTypeForPath(filePath: string): string | null {
  const { base, ext } = splitPath(filePath);
  const table = ext === '' ? WELL_KNOWN_BASENAMES : EXTENSION_TYPES;
  const key = ext === '' ? base.toUpperCase() : ext;
  return table.get(key) ?? null;
}

/**
 * Decide which document parser, if any, a MIME type routes to.
 *
 * `text/plain` routes to **markdown**, which looks surprising and is not: CommonMark
 * degrades gracefully on plain text — an unmarked-up file parses to paragraphs,
 * which is the correct reading of it — so a `.txt` or an extensionless `README`
 * yields real, if unadorned, document structure. The alternative is dropping prose
 * on the floor because it lacks a `.md`, which loses far more than a stray emphasis
 * marker being honoured costs.
 *
 * Everything else, including `null`, returns `null`: do not run a document parser.
 * A typed-but-unparsed file is the normal case, not a gap.
 *
 * @param mimeType - A type from {@link mimeTypeForPath}, or `null` for an untyped file
 * @returns The parser to run, or `null` to run none
 */
export function parserKindForMimeType(mimeType: string | null): DocumentParserKind | null {
  return mimeType === null ? null : (PARSER_BY_MIME_TYPE.get(mimeType) ?? null);
}
