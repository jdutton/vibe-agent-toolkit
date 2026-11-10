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

import type { ParseRoute } from '@vibe-agent-toolkit/resources';
import { isPathAbsentError } from '@vibe-agent-toolkit/utils';

import { parseFrontmatter } from './parsers/frontmatter-parser.js';

/**
 * Read the name a SKILL.md declares for itself.
 *
 * Returns `undefined` when there is no file at the path, it has no frontmatter,
 * or it declares no usable `name` — callers decide whether that is fatal or
 * whether some fallback (typically the directory leaf) applies.
 *
 * A file that IS there but could not be read (a permission refusal, a path
 * component that is a directory) throws: `undefined` means "declares no name",
 * and a refusal has not established that — a caller falling back to the
 * directory leaf would otherwise rename the skill on the operator's behalf.
 */
export function readDeclaredSkillName(skillMdPath: string, route: ParseRoute = {}): Promise<string | undefined> {
  let content: string;
  try {
    content = readFileSync(skillMdPath, 'utf-8');
  } catch (error) {
    return isPathAbsentError(error) ? Promise.resolve(undefined) : Promise.reject(error as Error);
  }
  return declaredSkillNameIn(content, route);
}

/**
 * The same answer, for a SKILL.md whose BYTES a caller already holds and whose
 * path may not exist on disk at all — an entry read out of a ZIP's central
 * directory being the case this was split out for.
 *
 * Deliberately the same function as the path-taking reader above rather than a
 * second parse beside it: two spellings of "what name does this declare" is
 * exactly how one lane starts answering differently from another.
 */
export async function declaredSkillNameIn(content: string, route: ParseRoute = {}): Promise<string | undefined> {
  // A block the parse worker refused for this run declares nothing this run can
  // read, so it is "no usable name" — the caller's fallback (the directory leaf)
  // applies, as for a SKILL.md with no frontmatter.
  const parsed = await parseFrontmatter(content, route);
  if (!parsed.success) return undefined;

  const declared = parsed.frontmatter['name'];
  if (typeof declared !== 'string') return undefined;

  const trimmed = declared.trim();
  return trimmed === '' ? undefined : trimmed;
}
