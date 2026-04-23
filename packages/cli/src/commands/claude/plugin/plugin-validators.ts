/**
 * Build-time validators for plugin declarations.
 *
 * - verifyPluginDirCaseMatch: guards against macOS/Windows case-insensitive FS drift
 *   (plugin: "foo-bar" -> plugins/Foo-Bar/ locally would break on Linux CI).
 * - verifyNoCaseCollidingPluginNames: rejects pairs whose toLowerCase() collides.
 * - parsePluginJsonFiles: parse-only JSON validation of hooks.json + .mcp.json
 *   (deep schema validation is Claude runtime's job).
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

export async function verifyPluginDirCaseMatch(
  projectRoot: string,
  pluginName: string,
): Promise<void> {
  const pluginsBase = safePath.join(projectRoot, 'plugins');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(pluginsBase)) return;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const entries = await readdir(pluginsBase, { withFileTypes: true });
  const matchInsensitive = entries.find(
    (e) => e.isDirectory() && e.name.toLowerCase() === pluginName.toLowerCase(),
  );
  if (matchInsensitive && matchInsensitive.name !== pluginName) {
    throw new Error(
      `Plugin "${pluginName}" declared in config, but on-disk directory is "plugins/${matchInsensitive.name}/". ` +
        `Names must match exactly (case-sensitive). This check catches macOS/Windows case-insensitive FS drift ` +
        `that would break on Linux CI. Rename the directory or the config entry to match.`,
    );
  }
}

export function verifyNoCaseCollidingPluginNames(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    const prior = seen.get(key);
    if (prior === name) {
      throw new Error(
        `Plugin name "${name}" is declared more than once across marketplaces. ` +
          `Plugin names must be globally unique within a repo; rename one.`,
      );
    }
    if (prior && prior !== name) {
      throw new Error(
        `Plugin names "${prior}" and "${name}" differ only in case. ` +
          `They would collide on case-insensitive filesystems; rename one.`,
      );
    }
    seen.set(key, name);
  }
}

async function parseJsonFileIfPresent(path: string, label: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path
  if (!existsSync(path)) return;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path
    JSON.parse(await readFile(path, 'utf-8'));
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function parsePluginJsonFiles(pluginSourceDir: string): Promise<void> {
  await parseJsonFileIfPresent(
    safePath.join(pluginSourceDir, 'hooks', 'hooks.json'),
    'hooks/hooks.json',
  );
  await parseJsonFileIfPresent(safePath.join(pluginSourceDir, '.mcp.json'), '.mcp.json');
}
