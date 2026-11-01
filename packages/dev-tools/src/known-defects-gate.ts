/**
 * `bun run pre-release` refuses a stable version while a known-defects entry
 * carries {@link STABLE_TAG_BLOCKER_MARKER}; a prerelease is not gated.
 */

export const KNOWN_DEFECTS_PATH = 'docs/contributing/known-defects.md';

/** Alone on its line, under the entry's `###` heading. */
export const STABLE_TAG_BLOCKER_MARKER = '- **Blocks:** the stable tag';

const ENTRY_HEADING = /^### (.+)$/;

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
    if (line.trim() !== STABLE_TAG_BLOCKER_MARKER) continue;
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
