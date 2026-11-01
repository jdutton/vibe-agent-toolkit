/**
 * `bun run pre-release` refuses a stable version while a known-defects entry
 * carries {@link STABLE_TAG_BLOCKER_MARKER}; a prerelease is not gated.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

export const KNOWN_DEFECTS_PATH = 'docs/contributing/known-defects.md';

/** Alone on its line, under the entry's `###` heading. */
export const STABLE_TAG_BLOCKER_MARKER = '- **Blocks:** the stable tag';

const ENTRY_HEADING = /^### (.+)$/;
/**
 * Anything that looks like a `Blocks` field — a list line whose first word,
 * bold or not, starts with "block" (`Blocks`, `Blocking`, `Blocker`, any case) —
 * so a misspelt marker throws rather than failing open.
 */
const LOOKS_LIKE_A_MARKER = /^\s*[-*+]\s+(?:\*\*)?block/i;
const INLINE_CODE = /`[^`]*`/g;

export function isPrereleaseVersion(version: string): boolean {
  return /-(rc|alpha|beta|dev|canary)\./i.test(version);
}

/** Blocking entries' headings; a marker above every heading throws rather than failing open. */
export function stableTagBlockers(markdown: string): string[] {
  const blockers: string[] = [];
  let entry: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = ENTRY_HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      entry = heading[1].trim();
      continue;
    }
    if (line.trim() !== STABLE_TAG_BLOCKER_MARKER) {
      if (LOOKS_LIKE_A_MARKER.test(line.replaceAll(INLINE_CODE, ''))) {
        throw new Error(`${KNOWN_DEFECTS_PATH}: "${line.trim()}" is not the marker "${STABLE_TAG_BLOCKER_MARKER}"`);
      }
      continue;
    }
    if (entry === undefined) {
      throw new Error(`${KNOWN_DEFECTS_PATH}: "${STABLE_TAG_BLOCKER_MARKER}" appears before any ### entry heading`);
    }
    if (!blockers.includes(entry)) blockers.push(entry);
  }
  return blockers;
}

/** Why `version` may not be released, or undefined when it may. */
export function stableTagRefusal(version: string, markdown: string): string | undefined {
  if (isPrereleaseVersion(version)) return undefined;
  const blockers = stableTagBlockers(markdown);
  if (blockers.length === 0) return undefined;
  const entries = blockers.length === 1 ? '1 entry' : `${blockers.length} entries`;
  const list = blockers.map((blocker) => '  - ' + blocker).join('\n');
  return `v${version} is a stable version, and ${KNOWN_DEFECTS_PATH} has ${entries} blocking the stable tag:\n${list}`;
}

/** The known-defects register under `root`, as text. */
export function readKnownDefects(root: string): string {
  return readFileSync(safePath.join(root, KNOWN_DEFECTS_PATH), 'utf8');
}

/**
 * Check 16's whole decision for `bun run pre-release`. The register is read
 * only when release readiness asks, so a run that gates nothing reads nothing.
 */
export function releaseReadinessDefectRefusal(options: {
  version: string;
  releaseReadiness: boolean;
  register: () => string;
}): string | undefined {
  if (!options.releaseReadiness) return undefined;
  return stableTagRefusal(options.version, options.register());
}
