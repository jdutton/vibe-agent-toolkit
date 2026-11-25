/**
 * Bundled-resource link detector.
 *
 * Emits SKILL_REFERENCES_BUT_NO_LINKS at info severity when a skill
 * directory contains a bundled subdirectory (the content-type routing
 * categories plus the claude-web `references/` layout) holding files that
 * neither SKILL.md's body nor any transitively linked file points at.
 *
 * Plugin-dev's "Mistake 4: Missing Resource References" — bundled assets
 * the body never links to are dead weight in the install. The author
 * intended progressive disclosure but forgot to wire up the references.
 *
 * Two properties are load-bearing:
 *
 * 1. **The vocabulary is derived, never re-listed.** A hardcoded list drifts
 *    from `content-type-routing.ts` — which routes `.md` and every unknown
 *    extension to `resources/` — and a subdirectory missing from the list
 *    makes the detector structurally unable to fire on it.
 *
 * 2. **Coverage is per file, not per directory.** A single live mention must
 *    not mask dead siblings: the real `command-development` skill ships 7
 *    files under `references/` and mentions only 2 of them, and a
 *    directory-granular check reported nothing at all.
 *
 * A file counts as referenced when its skill-relative path appears anywhere
 * in the body — markdown link target, inline code span, or bare prose alike —
 * or when link traversal reached it. Fenced code blocks are deliberately NOT
 * parsed out: that approach was tried and rejected as too fragile.
 */


import { readdirSync } from 'node:fs';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { appendAll, direntKindFollowingSync, FollowedWalk, type FsSide, isPathAbsentError, issueLocation, safePath, withFsFaultSync } from '@vibe-agent-toolkit/utils';

import { CLAUDE_WEB_REFERENCES_SUBDIR, TARGET_SUBDIR_CATEGORIES } from '../content-type-routing.js';

/**
 * Subdirectories a packaged skill may bundle resources into.
 *
 * Derived from the content-type routing categories (the single source of
 * truth for extension→subdirectory mapping) plus the claude-web-specific
 * `references/` layout name. De-duplicated so promoting `references` to a
 * routing category later cannot produce a doubled finding.
 */
const BUNDLED_SUBDIRS: readonly string[] = [
  ...new Set<string>([...TARGET_SUBDIR_CATEGORIES, CLAUDE_WEB_REFERENCES_SUBDIR]),
];

/** How many dead file names the message spells out before summarising. */
const MAX_LISTED_FILES = 5;

/**
 * Every file under `dir`, recursively, as paths relative to `baseDir`
 * (forward-slash normalised by safePath). Empty when `dir` is absent or
 * contains no files. A directory that is there and REFUSED throws: `[]` is
 * this check's "nothing bundled, nothing to say", and a listing the OS would
 * not hand over has not established that.
 */
function listFilesRelative(dir: string, baseDir: string, side: FsSide): string[] {
  // The skill directory is the tree walked: every link beneath it is read before the kernel follows it,
  // and a directory the walk cannot resolve is a fault on the side the caller says the skill tree is on.
  return listFilesUnder(dir, baseDir, side, undefined);
}

function listFilesUnder(dir: string, baseDir: string, side: FsSide, walk: FollowedWalk | undefined): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
  const guard = walk ?? new FollowedWalk(side, baseDir);
  if (walk === undefined) guard.enter(dir);
  const found: string[] = [];
  for (const entry of entries) {
    const child = safePath.join(dir, entry.name);
    // Followed: a linked resource is a bundled resource for link purposes. A
    // link back into the tree is refused by the walk guard, not recursed. A
    // refused probe or link chain is a fault on the skill tree's side, never "absent".
    const kind = withFsFaultSync(
      { side, origin: 'content', action: `examine the bundled resource at ${child}`, path: child },
      () => direntKindFollowingSync(dir, entry, baseDir),
    );
    if (kind === 'file') {
      found.push(safePath.relative(baseDir, child));
    } else if (kind === 'directory') {
      guard.enter(child);
      appendAll(found, listFilesUnder(child, baseDir, side, guard));
    }
  }
  return found;
}

/**
 * Body points at this file.
 *
 * Substring match on the skill-relative path, so `[x](references/a.md)`,
 * `(./references/a.md)`, `` `references/a.md` `` and a bare prose
 * `references/a.md` all count. Deliberately liberal: at info severity a
 * missed finding beats a wrong one.
 */
function bodyMentionsFile(body: string, relPath: string): boolean {
  return body.includes(relPath);
}

/** Link traversal reached this exact file. */
function linkedFilesCoverFile(linkedFiles: ReadonlySet<string>, absPath: string): boolean {
  return linkedFiles.has(safePath.resolve(absPath));
}

/** Human-readable file list, truncated so the message stays scannable. */
function summariseFiles(relPaths: readonly string[]): string {
  const shown = relPaths.slice(0, MAX_LISTED_FILES).join(', ');
  const hidden = relPaths.length - MAX_LISTED_FILES;
  return hidden > 0 ? `${shown} (and ${hidden} more)` : shown;
}

/**
 * @param readBody Reads the SKILL.md text, called at most once and only when a
 *   bundled file is not covered by a link: the validator's own read when it read
 *   the file, a read of it when the run's store served it. A refused read throws;
 *   a best-effort read here once turned a refusal into an empty body, i.e. into
 *   "nothing mentions these files"
 * @param skillDir Absolute path to the skill directory
 * @param linkedFiles Absolute paths of files reached during BFS link traversal
 * @param locationRoot Root the emitted `location` is expressed relative to
 * @param side The side of the caller's verb the skill tree is on (an author's skill is `source`, a ZIP
 *   extracted into $TMPDIR is `environment`): a directory the walk cannot resolve is a fault there
 */
export async function detectBundledResourceWithoutLinks(
  readBody: () => Promise<string>,
  skillDir: string,
  linkedFiles: readonly string[],
  locationRoot: string,
  side: FsSide,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const linked = new Set(linkedFiles.map((f) => safePath.resolve(f)));
  const uncovered = BUNDLED_SUBDIRS.map((sub) => {
    const subPath = safePath.join(skillDir, sub);
    const bundled = listFilesRelative(subPath, skillDir, side);
    const unlinked = bundled.filter((rel) => !linkedFilesCoverFile(linked, safePath.join(skillDir, rel)));
    return { sub, subPath, bundled, unlinked };
  }).filter((entry) => entry.unlinked.length > 0);
  // Read only when a bundled file is not covered by a link: a warm run whose
  // SKILL.md the store served reads it for nothing else.
  if (uncovered.length === 0) return issues;
  const text = await readBody();

  for (const { sub, subPath, bundled, unlinked } of uncovered) {
    const unreferenced = unlinked.filter((rel) => !bodyMentionsFile(text, rel));
    if (unreferenced.length === 0) continue;

    const entry = CODE_REGISTRY.SKILL_REFERENCES_BUT_NO_LINKS;
    issues.push({
      severity: entry.defaultSeverity,
      code: 'SKILL_REFERENCES_BUT_NO_LINKS',
      message:
        `Skill directory contains "${sub}/" with ${unreferenced.length} of ${bundled.length} ` +
        `file(s) that nothing in SKILL.md or its linked files points at: ` +
        `${summariseFiles(unreferenced)}.`,
      location: issueLocation(subPath, locationRoot),
      fix: entry.fix,
      reference: entry.reference,
    });
  }

  return issues;
}
