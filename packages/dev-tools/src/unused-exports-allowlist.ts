/**
 * The unused-export ratchet's allowlist: its shape, its parser, and where the
 * data lives. The entries themselves are in `unused-exports-allowlist.txt`
 * beside this module — one `<file> <name> <reason>` per line — because 565
 * rows of one shape are data, and a code analyser that normalises literals
 * reads them as 998 duplicated lines. Read and written by
 * `packages/dev-tools/src/unused-exports.ts` (`bun run unused-exports`).
 *
 * The list may only SHRINK. `reason` is `test-only` (a test reaches the
 * name — the export exists for that test) or `dead` (nothing does). Both are
 * read off `packages/<pkg>/test/` — an import of the module plus a whole-
 * identifier mention of the name — a hint and not a proof.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';

export type UnusedExportReason = 'test-only' | 'dead';

export interface UnusedExportName {
  readonly name: string;
  readonly reason: UnusedExportReason;
}

export interface UnusedExportFile {
  /** Repo-relative, forward-slash path of the module. */
  readonly file: string;
  readonly unused: readonly UnusedExportName[];
}

/** The committed data file, absolute. */
export const UNUSED_EXPORTS_ALLOWLIST_PATH: string = resolveFromImportMeta(import.meta.url, 'unused-exports-allowlist.txt');

const REASONS: ReadonlySet<string> = new Set<UnusedExportReason>(['test-only', 'dead']);

function isReason(value: string): value is UnusedExportReason {
  return REASONS.has(value);
}

/**
 * Parse the data file's text: `#` lines and blank lines are ignored; every
 * other line is `<file> <name> <reason>`. Rows are grouped by file in the
 * order they appear, so a sorted file parses to a sorted list.
 *
 * @throws {Error} naming the 1-based line for a row that is not three fields
 *   or whose reason is not one of the two — a malformed list must not read as
 *   a shorter one.
 */
export function parseAllowlist(text: string): UnusedExportFile[] {
  const byFile = new Map<string, UnusedExportName[]>();
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      throw new Error(`unused-exports allowlist line ${String(index + 1)}: expected "<file> <name> <reason>", got "${line}"`);
    }
    const [file, name, reason] = fields as [string, string, string];
    if (!isReason(reason)) {
      throw new Error(`unused-exports allowlist line ${String(index + 1)}: unknown reason "${reason}" (test-only | dead)`);
    }
    byFile.set(file, [...(byFile.get(file) ?? []), { name, reason }]);
  }
  return [...byFile.entries()].map(([file, unused]) => ({ file, unused }));
}

/** The committed allowlist, parsed. */
export function loadUnusedExportsAllowlist(): UnusedExportFile[] {
  return parseAllowlist(readFileSync(UNUSED_EXPORTS_ALLOWLIST_PATH, 'utf8'));
}
