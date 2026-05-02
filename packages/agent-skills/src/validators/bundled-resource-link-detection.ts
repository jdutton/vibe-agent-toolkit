/**
 * Bundled-resource link detector.
 *
 * Emits SKILL_REFERENCES_BUT_NO_LINKS at info severity when a skill
 * directory contains scripts/, references/, or assets/ subdirectories
 * but neither SKILL.md's body nor any transitively linked file points
 * into them via a markdown link.
 *
 * Plugin-dev's "Mistake 4: Missing Resource References" — bundled assets
 * the body never links to are dead weight in the install. The author
 * intended progressive disclosure but forgot to wire up the references.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- skill paths validated upstream */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

const BUNDLED_SUBDIRS = ['scripts', 'references', 'assets'] as const;

/** Read SKILL.md content (best-effort) — empty string if unreadable. */
function readSkillContent(skillPath: string): string {
  try {
    return readFileSync(skillPath, 'utf-8');
  } catch {
    return '';
  }
}

/** Subdirectory exists AND contains at least one file (recursive). */
function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && isNonEmptyDir(safePath.join(dir, entry.name))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Body or linked file references the subdir via path containing `<sub>/`. */
function bodyMentionsSubdir(body: string, sub: string): boolean {
  // Lightweight check: the sub-dir name occurs as part of a markdown
  // path, e.g. `(scripts/cli.mjs)` or `[x](references/detail.md)`. We
  // accept any occurrence of `<sub>/` since false negatives (a real
  // link the heuristic misses) are worse than false positives at info.
  return body.includes(`${sub}/`);
}

/** Linked file path is inside the subdir. */
function linkedFilesCoverSubdir(
  linkedFiles: readonly string[],
  skillDir: string,
  sub: string,
): boolean {
  const subDir = safePath.join(skillDir, sub);
  return linkedFiles.some((f) => {
    const rel = safePath.relative(subDir, f);
    return !rel.startsWith('..') && rel.length > 0;
  });
}

/**
 * @param skillPath Absolute path to SKILL.md
 * @param skillDir Absolute path to the skill directory (typically dirname(skillPath))
 * @param linkedFiles Absolute paths of files reached during BFS link traversal
 */
export function detectBundledResourceWithoutLinks(
  skillPath: string,
  skillDir: string,
  linkedFiles: readonly string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = readSkillContent(skillPath);
  const baseDir = skillDir.length > 0 ? skillDir : dirname(skillPath);

  for (const sub of BUNDLED_SUBDIRS) {
    const subPath = safePath.join(baseDir, sub);
    if (!isNonEmptyDir(subPath)) continue;
    if (bodyMentionsSubdir(body, sub)) continue;
    if (linkedFilesCoverSubdir(linkedFiles, baseDir, sub)) continue;

    const entry = CODE_REGISTRY.SKILL_REFERENCES_BUT_NO_LINKS;
    issues.push({
      severity: entry.defaultSeverity,
      code: 'SKILL_REFERENCES_BUT_NO_LINKS',
      message: `Skill directory contains "${sub}/" but no markdown link from SKILL.md or linked files points into it.`,
      location: subPath,
      fix: entry.fix,
      reference: entry.reference,
    });
  }

  return issues;
}
