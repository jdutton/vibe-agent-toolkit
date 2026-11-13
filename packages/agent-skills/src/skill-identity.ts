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

import { isPerRunParseRefusal, type MeasuredContent, type ParseRoute, readContentForParse } from '@vibe-agent-toolkit/resources';
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
 * component that is a directory), one past the parse input cap (refused by its
 * size before it is read, as every lane that parses it refuses it), or whose
 * frontmatter the parse worker refused for this run, throws: `undefined` means
 * "declares no name", and none has established that — a caller falling back to
 * the directory leaf would otherwise rename the skill on the operator's behalf.
 *
 * `route` is required (`{ dispatcher: undefined }` for a one-off read), as on every parse lane: a caller
 * that holds the run's dispatcher states it, never drops it by omission.
 */
export async function readDeclaredSkillName(skillMdPath: string, route: ParseRoute): Promise<string | undefined> {
  let read: MeasuredContent;
  try {
    read = await readContentForParse(skillMdPath, 'markdown', route);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
  return declaredSkillNameIn(read, route);
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
export async function declaredSkillNameIn(input: MeasuredContent, route: ParseRoute): Promise<string | undefined> {
  const parsed = await parseFrontmatter(input, route);
  if (!parsed.success) {
    // Refused for this run is not "declares no name": thrown, never a fallback.
    if (isPerRunParseRefusal(parsed.cause)) throw parsed.cause;
    return undefined;
  }

  const declared = parsed.frontmatter['name'];
  if (typeof declared !== 'string') return undefined;

  const trimmed = declared.trim();
  return trimmed === '' ? undefined : trimmed;
}
