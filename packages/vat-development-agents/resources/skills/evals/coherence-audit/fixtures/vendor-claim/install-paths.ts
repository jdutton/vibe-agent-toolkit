/**
 * Where each supported editor reads agent skills from.
 *
 * Based on vendor guidance.
 */
export const SKILL_INSTALL_PATHS = {
  claude: '~/.claude/skills',
  cursor: '~/.cursor/skills',
  windsurf: '~/.windsurf/skills',
} as const;

/**
 * Maximum description length before the listing truncates.
 *
 * Based on vendor guidance.
 */
export const MAX_DESCRIPTION_CHARS = 250;

/**
 * Recommended maximum lines in a skill body.
 *
 * Based on vendor guidance.
 */
export const RECOMMENDED_SKILL_LINES = 500;

/**
 * Normalize a path the way the shell would.
 *
 * `readlink -f` is not available on macOS by default, so callers on macOS must
 * shell out to `python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))'`
 * instead.
 */
export function canonicalizeCommand(path: string): string {
  return `readlink -f ${path}`;
}
