/**
 * Settings reader — discover and read Claude settings files in precedence order.
 *
 * Precedence (highest → lowest):
 * 1. managed (system-wide, IT admin)
 * 2. project-local (<projectDir>/.claude/settings.local.json)
 * 3. project (<projectDir>/.claude/settings.json)
 * 4. user (`getClaudeUserPaths().userSettingsPath` — honours `CLAUDE_CONFIG_DIR`)
 */

import * as fs from 'node:fs/promises';

import { classifyFsFault, everyInOrder, isPathAbsentError, VatError } from '@vibe-agent-toolkit/utils';

import { CLAUDE_USER_STATE_UNREADABLE_CODE } from '../install/plugin-registry.js';
import { getClaudeProjectPaths, getClaudeUserPaths } from '../paths/claude-paths.js';
import { getManagedSettingsCandidatePaths } from '../paths/managed-settings-path.js';
import {
  ManagedSettingsSchema,
  ProjectSettingsSchema,
  UserSettingsSchema,
} from '../schemas/settings.js';
import type { SettingsLevel } from '../types.js';

import { mergeSettingsLayers } from './settings-merger.js';
import type { EffectiveSettings, SettingsLayer } from './settings-merger.js';



export interface ReadSettingsOptions {
  /** For discovering .claude/settings.json */
  projectDir?: string | undefined;
  /** Explicit override — use this file instead of the system managed-settings path */
  settingsFile?: string | undefined;
}

/**
 * Only an ABSENT file is no layer. One the OS refuses is present and unread, so
 * skipping it would let the run answer as if that layer said nothing: it is a
 * classified fault on the settings file, an input this audit reads (`source`,
 * origin `config`).
 *
 * @throws FsFaultError for a file the OS refuses; VatError {@link CLAUDE_USER_STATE_UNREADABLE_CODE}
 *   for one that is not JSON, naming the file
 */
async function tryReadJson(filePath: string): Promise<unknown> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isPathAbsentError(err)) return null;
    throw classifyFsFault(err, { side: 'source', origin: 'config', action: 'read a settings file', path: filePath });
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (err) {
    throw new VatError(CLAUDE_USER_STATE_UNREADABLE_CODE, `Failed to parse settings file ${filePath}: ${String(err)}`, { cause: err });
  }
}

function selectSettingsSchema(level: SettingsLevel) {
  if (level === 'managed') return ManagedSettingsSchema;
  if (level === 'project' || level === 'project-local') return ProjectSettingsSchema;
  return UserSettingsSchema;
}

async function tryReadLayer(
  filePath: string,
  level: SettingsLevel
): Promise<SettingsLayer | null> {
  const raw = await tryReadJson(filePath);
  if (raw === null) return null;

  const schema = selectSettingsSchema(level);
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new VatError(
      CLAUDE_USER_STATE_UNREADABLE_CODE,
      `Invalid settings file ${filePath}: ${JSON.stringify(result.error)}`
    );
  }

  return {
    level,
    file: filePath,
    settings: result.data,
  };
}

async function tryAddLayer(
  layers: SettingsLayer[],
  filePath: string,
  level: SettingsLevel
): Promise<void> {
  const layer = await tryReadLayer(filePath, level);
  if (layer !== null) layers.push(layer);
}

async function readManagedLayer(options: ReadSettingsOptions): Promise<SettingsLayer | null> {
  if (options.settingsFile) {
    return tryReadLayer(options.settingsFile, 'managed');
  }
  let found: SettingsLayer | null = null;
  // In order: the first candidate present wins, and an unreadable one refuses before any later one is read.
  await everyInOrder(getManagedSettingsCandidatePaths(), async (candidate) => {
    found = await tryReadLayer(candidate, 'managed');
    return found === null;
  });
  return found;
}

/**
 * Read all available settings layers in precedence order (highest first).
 * Skips files that don't exist. Throws a classified filesystem fault for a file the
 * OS refuses, and {@link CLAUDE_USER_STATE_UNREADABLE_CODE} for one that does not
 * parse or fails its schema.
 */
export async function readSettingsLayers(
  options: ReadSettingsOptions = {}
): Promise<SettingsLayer[]> {
  const layers: SettingsLayer[] = [];

  // 1. Managed settings (or explicit override)
  const managedLayer = await readManagedLayer(options);
  if (managedLayer !== null) layers.push(managedLayer);

  // 2 & 3. Project settings (local overrides base)
  if (options.projectDir) {
    const { projectSettingsLocalPath, projectSettingsPath } = getClaudeProjectPaths(options.projectDir);
    await tryAddLayer(layers, projectSettingsLocalPath, 'project-local');
    await tryAddLayer(layers, projectSettingsPath, 'project');
  }

  // 4. User settings
  await tryAddLayer(layers, getClaudeUserPaths().userSettingsPath, 'user');

  return layers;
}

/**
 * Convenience: read all layers and merge into EffectiveSettings.
 */
export async function readEffectiveSettings(
  options: ReadSettingsOptions = {}
): Promise<EffectiveSettings> {
  const layers = await readSettingsLayers(options);
  return mergeSettingsLayers(layers);
}

export {type EffectiveSettings, type SettingsLayer} from './settings-merger.js';
