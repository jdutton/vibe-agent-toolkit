/**
 * Deterministic text rendering for the snapshots.
 *
 * Goldens are diffed by humans and by CI, so the rendering is line-oriented and
 * one fact per line: a red diff should name the row that moved, not present a
 * reflowed blob. JSON would be a smaller amount of code and a much worse diff.
 *
 * Every line is LF-terminated regardless of host, and every path is already
 * corpus-relative and forward-slashed by the time it arrives here.
 */

import type { EnumerationSnapshot, FrontmatterFieldFact, ParseFactSnapshot } from './types.js';

/** `true` / `false` / `-` for an unanswered column, so columns stay aligned in width. */
function flag(value: boolean | null): string {
  return value === null ? '-' : String(value);
}

/**
 * Render an enumeration snapshot.
 *
 * ⛔ Row order is reproduced exactly as captured and is **never** sorted here.
 * Arrival order decides which of two colliding files survives; sorting the
 * rendering would hide the only evidence of a reordering.
 *
 * @param snapshot - Snapshot to render
 * @returns Golden text, LF-terminated
 */
export function renderEnumerationSnapshot(snapshot: EnumerationSnapshot): string {
  const lines: string[] = [
    `# enumeration-snapshot`,
    `lane: ${snapshot.laneId}`,
    `corpus: ${snapshot.corpus}`,
    `route: ${snapshot.route}`,
    `gitAvailable: ${String(snapshot.gitAvailable)}`,
    `enumeratedCount: ${String(snapshot.enumerated.length)}`,
    `admittedCount: ${String(snapshot.admitted.length)}`,
    `collisionCount: ${String(snapshot.collisions.length)}`,
    `buildError: ${snapshot.buildError ?? '-'}`,
    '',
    '## enumerated (ordered, pre-deduplication)',
    '# ordinal\tpath\texists\tisDirectory\tgitignored\tisSymlink\tsymlinkResolves\tcontentKey',
  ];

  for (const [index, row] of snapshot.enumerated.entries()) {
    lines.push(
      [
        String(index),
        row.path,
        flag(row.exists),
        flag(row.isDirectory),
        flag(row.gitignored),
        flag(row.isSymlink),
        flag(row.symlinkResolves),
        row.contentKey ?? '-',
      ].join('\t'),
    );
  }

  lines.push('', '## admitted (ordered, post-deduplication)');
  for (const [index, path] of snapshot.admitted.entries()) {
    lines.push(`${String(index)}\t${path}`);
  }

  lines.push('', '## collisions (first-added-wins drops, in arrival order)');
  for (const collision of snapshot.collisions) {
    lines.push(`${collision.id}\twon=${collision.existingPath}\tdropped=${collision.conflictingPath}`);
  }

  lines.push('', '## restatementDrift');
  for (const drift of snapshot.restatementDrift) {
    lines.push(drift);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render an enumeration snapshot without its ordering.
 *
 * For corpora whose crawl was answered by a filesystem walk rather than by
 * `git ls-files`: `readdirSync` order is a property of the filesystem (ext4's
 * hashed directories, APFS, NTFS all differ), so an ordered golden captured on
 * one host does not hold on another. The set and the per-path attributes still
 * do, and those are what a cross-platform gate can assert. Ordering on that
 * route is asserted separately, as stability *within* a host.
 *
 * @param snapshot - Snapshot to render
 * @returns Golden text with rows sorted by path, LF-terminated
 */
export function renderEnumerationSnapshotUnordered(snapshot: EnumerationSnapshot): string {
  const sorted: EnumerationSnapshot = {
    ...snapshot,
    enumerated: [...snapshot.enumerated].sort((a, b) => a.path.localeCompare(b.path)),
    admitted: [...snapshot.admitted].sort((a, b) => a.localeCompare(b)),
    collisions: [...snapshot.collisions].sort((a, b) => a.id.localeCompare(b.id)),
    restatementDrift: [...snapshot.restatementDrift].sort((a, b) => a.localeCompare(b)),
  };
  return renderEnumerationSnapshot(sorted).replace(
    '## enumerated (ordered, pre-deduplication)',
    '## enumerated (SORTED BY PATH — walk route, order is filesystem-dependent)',
  );
}

/**
 * Render a parse-fact snapshot.
 *
 * Sorting is safe here and unsafe for enumeration: a parse fact is a function
 * of the blob alone, so nothing about it depends on the order documents were
 * discovered in.
 *
 * @param snapshot - Snapshot to render
 * @returns Golden text, LF-terminated
 */
export function renderParseFactSnapshot(snapshot: ParseFactSnapshot): string {
  const lines: string[] = [
    '# parse-fact-snapshot',
    `corpus: ${snapshot.corpus}`,
    `blobCount: ${String(snapshot.rows.length)}`,
    '',
  ];

  for (const row of snapshot.rows) {
    lines.push(`## blob ${row.contentKey}`);
    lines.push(`parser: ${row.parserKind}`);
    lines.push(`paths: ${(snapshot.pathsByKey[row.contentKey] ?? []).join(', ')}`);
    lines.push(`sizeBytes: ${String(row.sizeBytes)}`);
    lines.push(`estimatedTokenCount: ${String(row.estimatedTokenCount)}`);
    lines.push(`contentMatchesKey: ${String(row.contentMatchesKey)}`);
    lines.push(`frontmatterSource: ${renderMultiline(row.frontmatterSource)}`);
    // `-` is the absent field; `(none)` is a present-but-empty one. Collapsing
    // the two would hide a cache that normalises `undefined` into `[]`.
    lines.push(`frontmatterFields: ${renderFrontmatterFields(row.frontmatterFields)}`);
    lines.push(`anchors: ${renderList(row.anchors)}`);

    lines.push(`links: ${String(row.links.length)}`);
    for (const link of row.links) {
      lines.push(
        `  ${String(link.ordinal)}\t${link.type}\t${link.nodeType ?? '-'}\tline=${String(link.line ?? '-')}\thref=${link.href}\ttext=${renderInline(link.text)}`,
      );
    }

    lines.push(`headings: ${String(row.headings.length)}`);
    for (const heading of row.headings) {
      lines.push(
        `  ${String(heading.ordinal)}\th${String(heading.level)}\tslug=${heading.slug}\tline=${String(heading.line ?? '-')}\ttext=${renderInline(heading.text)}`,
      );
    }

    lines.push(`conditions: ${String(row.conditions.length)}`);
    for (const condition of row.conditions) {
      lines.push(`  ${condition.code}\tline=${String(condition.line ?? '-')}\t${renderInline(condition.message)}`);
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/** Collapse a value onto one line so a golden stays line-diffable. */
function renderInline(value: string): string {
  return value
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\t', String.raw`\t`);
}

/** Same, for an optional multi-line block. */
function renderMultiline(value: string | null): string {
  return value === null ? '-' : renderInline(value);
}

/**
 * Render an optional string list, keeping absent distinct from empty.
 *
 * `-` means the parse result omitted the field; `(none)` means it supplied an
 * empty one. Those are different observations about the contract, and a layer
 * that turns one into the other is exactly what this snapshot is watching for.
 *
 * @param values - The list, or null when the field was absent
 * @returns A one-line rendering
 */
function renderList(values: readonly string[] | null): string {
  if (values === null) {
    return '-';
  }
  return values.length === 0 ? '(none)' : values.map((value) => renderInline(value)).join(', ');
}

/**
 * Render frontmatter key/shape pairs, keeping absent distinct from empty.
 *
 * @param fields - The facts, or null when the parse result had no frontmatter
 * @returns A one-line rendering
 */
function renderFrontmatterFields(fields: readonly FrontmatterFieldFact[] | null): string {
  if (fields === null) {
    return '-';
  }
  return fields.length === 0 ? '(none)' : fields.map((field) => `${field.key}:${field.typeName}`).join(', ');
}
