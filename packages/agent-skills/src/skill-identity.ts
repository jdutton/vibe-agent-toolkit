/**
 * A skill's identity: the name it declares for itself.
 *
 * VAT keys on the SKILL.md frontmatter `name` everywhere it matters — the build
 * names its output directory after it, the plugin-build collision referee
 * matches on it, and `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH` tells authors to align
 * `plugin.json` *to* it. The directory a skill happens to sit in is incidental:
 * an archive extracted to a temp path has no meaningful directory name at all.
 *
 * Consumers that need the name should read it here rather than deriving it from
 * a path, so every lane answers the question the same way.
 */

import { readFileSync } from 'node:fs';

import { parseFrontmatter } from './parsers/frontmatter-parser.js';

/**
 * Read the name a SKILL.md declares for itself.
 *
 * Returns `undefined` when the file is unreadable, has no frontmatter, or
 * declares no usable `name` — callers decide whether that is fatal or whether
 * some fallback (typically the directory leaf) applies.
 */
export function readDeclaredSkillName(skillMdPath: string): string | undefined {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied skill path
    content = readFileSync(skillMdPath, 'utf-8');
  } catch {
    return undefined;
  }

  const parsed = parseFrontmatter(content);
  if (!parsed.success) return undefined;

  const declared = parsed.frontmatter['name'];
  if (typeof declared !== 'string') return undefined;

  const trimmed = declared.trim();
  return trimmed === '' ? undefined : trimmed;
}
