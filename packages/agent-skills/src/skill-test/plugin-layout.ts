/**
 * plugin-layout.ts — pure detection of whether a skill's true on-disk source dir
 * is part of a Claude plugin install.
 *
 * ADOPTER BUG this supports: VAT stages a plugin-distributed skill FLAT
 * (`<harness>/staged/<name>/scripts/report.mjs`), but the skill's own code invokes
 * `${CLAUDE_PLUGIN_ROOT}/skills/<name>/scripts/report.mjs`. In the flat harness that
 * file isn't at the expected relative location and CLAUDE_PLUGIN_ROOT is unset, so
 * the first call is MODULE_NOT_FOUND (one wasted experimenter turn, logged as a
 * path-assumption friction). The fix stages plugin skills under their REAL
 * plugin-root layout — and that begins by detecting the plugin root here.
 *
 * A directory is a Claude plugin root iff it contains `.claude-plugin/plugin.json`.
 * Given a skill's source dir we walk up its ancestors and stop at the NEAREST such
 * root. The existence probe is injected so this stays a pure, unit-testable function.
 */

import { dirname } from 'node:path';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** The plugin-manifest subpath that marks a directory as a Claude plugin root. */
const PLUGIN_MANIFEST_SUBPATH = '.claude-plugin/plugin.json';

/** Result of a positive plugin-layout detection. */
export interface PluginLayout {
  /** Forward-slash absolute path to the ancestor plugin root (holds `.claude-plugin/`). */
  pluginRoot: string;
  /**
   * Forward-slash path of the skill source dir RELATIVE to {@link pluginRoot}
   * (e.g. `skills/report-tools`). Used to recreate the plugin's nesting
   * in the harness so `${pluginRoot}/skills/<name>/...` resolves as it would in a
   * real install.
   */
  relPathUnderPlugin: string;
}

/**
 * Walk up from `skillSourceDir`; if any ancestor directory contains
 * `.claude-plugin/plugin.json`, the skill is plugin-distributed.
 *
 * @param skillSourceDir Absolute path to the skill's TRUE on-disk source directory
 *   (NOT a staged temp copy — the staged copy has lost its plugin ancestry).
 * @param fileExists Injected probe: returns true iff the given absolute path exists
 *   (production passes `existsSync`; tests pass a fake).
 * @returns `{ pluginRoot, relPathUnderPlugin }` for the nearest plugin ancestor, or
 *   `null` when no ancestor is a plugin root (standalone skill).
 */
export function detectPluginLayout(
  skillSourceDir: string,
  fileExists: (p: string) => boolean,
): PluginLayout | null {
  let current = toForwardSlash(skillSourceDir);
  // Walk up until the filesystem root (dirname is idempotent at the root).
  for (;;) {
    const marker = safePath.join(current, PLUGIN_MANIFEST_SUBPATH);
    if (fileExists(marker)) {
      return {
        pluginRoot: current,
        relPathUnderPlugin: safePath.relative(current, toForwardSlash(skillSourceDir)),
      };
    }
    const parent = toForwardSlash(dirname(current));
    if (parent === current) return null; // reached filesystem root, no plugin found
    current = parent;
  }
}
