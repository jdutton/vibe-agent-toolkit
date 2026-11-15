import { everywhere, pathPresent, safePath } from '@vibe-agent-toolkit/utils';

/**
 * Resolve the per-plugin CHANGELOG file path for a marketplace publish.
 *
 * Resolution order:
 *   1. If `entry.changelog` is provided, treat it as a path relative to the
 *      plugin source dir. Returns the absolute path if the file exists; else
 *      `undefined` (a config-supplied path that doesn't resolve is a no-op).
 *   2. Otherwise, default to `<pluginSourceDir>/CHANGELOG.md` if that file
 *      exists; else `undefined`.
 *
 * The default path is anchored to the plugin's *source* dir (the `source`
 * field on the marketplace plugin entry, default `plugins/<name>`). Callers
 * pass the resolved source dir directly — this helper does not assume layout.
 *
 * @param within - The project root the plugin source lives in: every link on the way is read
 *   before the kernel follows it
 * @throws {FsFaultError} on side `source` when the OS refuses the probe — never read as "no changelog"
 */
export function resolvePluginChangelogPath(
  pluginSourceDir: string,
  entry: { changelog?: string | undefined },
  within: string,
): string | undefined {
  const present = (path: string): boolean => pathPresent(path, { follow: within }, everywhere('source'), 'probe');
  if (entry.changelog) {
    const configured = safePath.join(pluginSourceDir, entry.changelog);
    return present(configured) ? configured : undefined;
  }
  const defaulted = safePath.join(pluginSourceDir, 'CHANGELOG.md');
  return present(defaulted) ? defaulted : undefined;
}
