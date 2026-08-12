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

/* eslint-disable security/detect-non-literal-fs-filename -- skill paths validated upstream */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

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

/** Read SKILL.md content (best-effort) — empty string if unreadable. */
function readSkillContent(skillPath: string): string {
  try {
    return readFileSync(skillPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Every file under `dir`, recursively, as paths relative to `baseDir`
 * (forward-slash normalised by safePath). Empty when `dir` is absent,
 * unreadable, or contains no files.
 */
function listFilesRelative(dir: string, baseDir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = safePath.join(dir, entry.name);
      if (entry.isFile()) {
        found.push(safePath.relative(baseDir, child));
      } else if (entry.isDirectory()) {
        found.push(...listFilesRelative(child, baseDir));
      }
    }
  } catch {
    return [];
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
 * @param skillPath Absolute path to SKILL.md
 * @param skillDir Absolute path to the skill directory (typically dirname(skillPath))
 * @param linkedFiles Absolute paths of files reached during BFS link traversal
 * @param locationRoot Root the emitted `location` is expressed relative to
 */
export function detectBundledResourceWithoutLinks(
  skillPath: string,
  skillDir: string,
  linkedFiles: readonly string[],
  locationRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = readSkillContent(skillPath);
  const baseDir = skillDir.length > 0 ? skillDir : dirname(skillPath);
  const linked = new Set(linkedFiles.map((f) => safePath.resolve(f)));

  for (const sub of BUNDLED_SUBDIRS) {
    const subPath = safePath.join(baseDir, sub);
    const bundled = listFilesRelative(subPath, baseDir);
    if (bundled.length === 0) continue;

    const unreferenced = bundled.filter(
      (rel) =>
        !bodyMentionsFile(body, rel) && !linkedFilesCoverFile(linked, safePath.join(baseDir, rel)),
    );
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
