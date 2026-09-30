/**
 * Build-time validators for plugin declarations.
 *
 * - verifyPluginDirCaseMatch: guards against macOS/Windows case-insensitive FS drift
 *   (plugin: "foo-bar" -> plugins/Foo-Bar/ locally would break on Linux CI).
 * - verifyNoCaseCollidingPluginNames: rejects pairs whose toLowerCase() collides.
 * - parsePluginJsonFiles: parse-only JSON validation of hooks.json + .mcp.json
 *   (deep schema validation is Claude runtime's job).
 * - readAuthorPluginJson: the author's own .claude-plugin/plugin.json, parsed.
 *
 * A declaration mistake refuses `CONFIG_INVALID`; a plugin file that is not JSON
 * refuses `INPUT_UNREADABLE`.
 */

import { readFileSync, type Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

import { direntKindFollowing, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../../utils/command-refusal.js';
import { unstatablePathRefusal } from '../../../utils/project-root-policy.js';

/**
 * The value `read` returns, or `undefined` when there is nothing at `path`.
 * Any other failure is the input's refusal (`INPUT_UNREADABLE`), never an
 * absence — `existsSync` answers false for an EACCES too.
 */
function unlessAbsentSync<T>(path: string, read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw unstatablePathRefusal(path, error);
  }
}

/** {@link unlessAbsentSync} for an async read. */
async function unlessAbsent<T>(path: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw unstatablePathRefusal(path, error);
  }
}

/** Parse `text` as JSON, refusing text that is not JSON as `INPUT_UNREADABLE` under `label`. */
function parseJsonInput(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${label} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

export async function verifyPluginDirCaseMatch(
  projectRoot: string,
  pluginName: string,
): Promise<void> {
  const pluginsBase = safePath.join(projectRoot, 'plugins');
  const entries: Dirent[] | undefined = await unlessAbsent(pluginsBase, () => readdir(pluginsBase, { withFileTypes: true }));
  if (entries === undefined) return;

  const kinds = await Promise.all(entries.map((e) => direntKindFollowing(pluginsBase, e)));
  const matchInsensitive = entries.find(
    (e, i) => kinds[i] === 'directory' && e.name.toLowerCase() === pluginName.toLowerCase(),
  );
  if (matchInsensitive && matchInsensitive.name !== pluginName) {
    throw new CommandRefusalError(
      'CONFIG_INVALID',
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
      throw new CommandRefusalError(
        'CONFIG_INVALID',
        `Plugin name "${name}" is declared more than once across marketplaces. ` +
          `Plugin names must be globally unique within a repo; rename one.`,
      );
    }
    if (prior && prior !== name) {
      throw new CommandRefusalError(
        'CONFIG_INVALID',
        `Plugin names "${prior}" and "${name}" differ only in case. ` +
          `They would collide on case-insensitive filesystems; rename one.`,
      );
    }
    seen.set(key, name);
  }
}

async function parseJsonFileIfPresent(path: string, label: string): Promise<void> {
  const text = await unlessAbsent(path, () => readFile(path, 'utf-8'));
  if (text !== undefined) parseJsonInput(text, label);
}

/**
 * The author-supplied `.claude-plugin/plugin.json` in a plugin source dir, or
 * `undefined` when there is none.
 *
 * @throws {CommandRefusalError} `INPUT_UNREADABLE` when it cannot be read or is not JSON
 */
export function readAuthorPluginJson(
  pluginSourceDir: string,
): (Record<string, unknown> & { version?: string }) | undefined {
  const path = safePath.join(pluginSourceDir, '.claude-plugin', 'plugin.json');
  const text = unlessAbsentSync(path, () => readFileSync(path, 'utf-8'));
  return text === undefined
    ? undefined
    : parseJsonInput(text, 'Author .claude-plugin/plugin.json') as Record<string, unknown>;
}

export async function parsePluginJsonFiles(pluginSourceDir: string): Promise<void> {
  await parseJsonFileIfPresent(
    safePath.join(pluginSourceDir, 'hooks', 'hooks.json'),
    'hooks/hooks.json',
  );
  await parseJsonFileIfPresent(safePath.join(pluginSourceDir, '.mcp.json'), '.mcp.json');
}
