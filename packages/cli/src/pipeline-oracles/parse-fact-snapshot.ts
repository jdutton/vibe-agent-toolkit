/**
 * Oracle 2 — the parse-fact snapshot.
 *
 * Facts a parse produces from one blob, keyed by content key rather than by
 * path. That is not a stylistic choice: it is what makes this snapshot double
 * as the parse cache's correctness oracle. If two paths key the same and their
 * facts differ, a content-addressed cache is unsound; if the same bytes key
 * differently across runs, it is useless. Both are visible here and neither is
 * visible in command output.
 */

import { parseHtml, parseMarkdown, readContentWithKey } from '@vibe-agent-toolkit/resources';
import type { HeadingNode, ParseResult, ResourceLink } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

import { relativize } from './path-facts.js';
import type { ConditionFact, HeadingFact, LinkFact, ParseFactRow, ParseFactSnapshot } from './types.js';

/**
 * Capture parse facts for a set of absolute paths.
 *
 * @param absolutePaths - Paths to parse; unreadable ones are skipped, not fatal
 * @param options - Corpus root (for relativizing) and label
 * @returns The snapshot, rows ordered by content key
 */
export async function captureParseFactSnapshot(
  absolutePaths: readonly string[],
  options: { corpusRoot: string; corpus: string },
): Promise<ParseFactSnapshot> {
  const corpusRoot = safePath.resolve(options.corpusRoot);
  const byKey = new Map<string, ParseFactRow>();
  const pathsByKey = new Map<string, string[]>();

  for (const absolutePath of absolutePaths) {
    const keyed = await readKeyedOrSkip(absolutePath);
    if (keyed === null) {
      continue;
    }

    const paths = pathsByKey.get(keyed.key) ?? [];
    paths.push(relativize(absolutePath, corpusRoot));
    pathsByKey.set(keyed.key, paths);

    if (byKey.has(keyed.key)) {
      // Already parsed under this key. Re-parsing would be the cache's job to
      // avoid; not re-parsing here is the same claim, asserted.
      continue;
    }

    const parsed = await parseOrNull(absolutePath, keyed.parserKind);
    if (parsed === null) {
      continue;
    }
    byKey.set(keyed.key, toRow(keyed.key, keyed.parserKind, keyed.content, parsed));
  }

  return {
    corpus: options.corpus,
    rows: [...byKey.values()].sort((a, b) => a.contentKey.localeCompare(b.contentKey)),
    pathsByKey: Object.fromEntries(
      [...pathsByKey.entries()]
        .map(([key, paths]) => [key, [...paths].sort((a, b) => a.localeCompare(b))] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/** Read+key a path, or report null when it cannot be read. */
async function readKeyedOrSkip(
  absolutePath: string,
): Promise<{ key: string; content: string; parserKind: string } | null> {
  try {
    return await readContentWithKey(absolutePath);
  } catch {
    return null;
  }
}

/** Parse via the same discriminator the registry uses. */
async function parseOrNull(absolutePath: string, parserKind: string): Promise<ParseResult | null> {
  try {
    return parserKind === 'html' ? await parseHtml(absolutePath) : await parseMarkdown(absolutePath);
  } catch {
    return null;
  }
}

/** Assemble one row from a parse result. */
function toRow(
  contentKey: string,
  parserKind: string,
  content: string,
  parsed: ParseResult,
): ParseFactRow {
  return {
    contentKey,
    parserKind,
    sizeBytes: parsed.sizeBytes,
    estimatedTokenCount: parsed.estimatedTokenCount,
    links: parsed.links.map(toLinkFact),
    headings: flattenHeadings(parsed.headings),
    frontmatterSource: extractFrontmatterSource(content),
    conditions: collectConditions(parsed),
  };
}

/**
 * One link occurrence with its ordinal.
 *
 * The ordinal is the addressable part. `href` alone is not an identity — a
 * document may link the same target ten times, and "link 7 moved" is a
 * different finding from "a link changed target".
 */
function toLinkFact(link: ResourceLink, index: number): LinkFact {
  return {
    ordinal: index,
    href: link.href,
    text: link.text,
    type: link.type,
    line: link.line ?? null,
    nodeType: link.nodeType ?? null,
  };
}

/**
 * Flatten the heading tree into document order with ordinals.
 *
 * `HeadingNode` nests children, which is the right shape for a table of
 * contents and the wrong shape for diffing: a heading moving one level changes
 * the whole subtree's position in the nested rendering. Flat + explicit level
 * makes the diff say what actually changed.
 */
function flattenHeadings(headings: readonly HeadingNode[]): HeadingFact[] {
  const flat: HeadingFact[] = [];
  const walk = (nodes: readonly HeadingNode[]): void => {
    for (const node of nodes) {
      flat.push({
        ordinal: flat.length,
        level: node.level,
        text: node.text,
        slug: node.slug,
        line: node.line ?? null,
      });
      if (node.children !== undefined) {
        walk(node.children);
      }
    }
  };
  walk(headings);
  return flat;
}

/** Matches a leading YAML frontmatter block, capturing its body verbatim. */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Extract the frontmatter block **as written**.
 *
 * Deliberately the raw source rather than the parsed object. Round-tripping
 * parsed YAML through JSON is lossy in ways a validator notices: `.inf` and
 * `.nan` become `null`, `!!binary` becomes a Buffer envelope, and cyclic
 * anchors make `JSON.stringify` throw so those documents would silently never
 * be recorded at all. A snapshot that stored the object would report two
 * different things for one document depending on whether it had been through a
 * cache.
 *
 * @param content - The full document text
 * @returns The frontmatter body, or null when there is none
 */
export function extractFrontmatterSource(content: string): string | null {
  const match = FRONTMATTER_BLOCK.exec(content);
  return match?.[1] ?? null;
}

/**
 * Parse-time oddities, as rows over an open vocabulary.
 *
 * Adding a new kind of oddity is adding rows, never changing this shape — which
 * is the same reason the projection schema is rows rather than columns.
 */
function collectConditions(parsed: ParseResult): ConditionFact[] {
  const conditions: ConditionFact[] = [];

  if (parsed.frontmatterError !== undefined) {
    conditions.push({ code: 'FRONTMATTER_INVALID_YAML', message: parsed.frontmatterError, line: 1 });
  }
  for (const error of parsed.parseErrors ?? []) {
    conditions.push({
      code: 'MALFORMED_HTML',
      message: error.message,
      line: error.line ?? null,
    });
  }
  for (const reference of parsed.unresolvedReferences ?? []) {
    conditions.push({
      code: 'LINK_UNRESOLVED_REFERENCE',
      message: reference.label,
      line: reference.line,
    });
  }

  return conditions.sort(
    (a, b) => a.code.localeCompare(b.code) || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message),
  );
}
