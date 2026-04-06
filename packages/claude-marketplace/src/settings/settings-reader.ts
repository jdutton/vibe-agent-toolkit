/**
 * Settings reader — discover and read Claude settings files in precedence order.
 *
 * Precedence (highest → lowest):
 * 1. managed (system-wide, IT admin)
 * 2. project-local (<projectDir>/.claude/settings.local.json)
 * 3. project (<projectDir>/.claude/settings.json)
 * 4. user (~/.claude/settings.json)
 */

import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

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

async function tryReadJson(filePath: string): Promise<unknown> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are system-controlled
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as unknown;
  } catch (err) {
    if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      return null;
    }
    throw new Error(`Failed to parse settings file ${filePath}: ${String(err)}`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
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
    throw new Error(
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
  const candidates = getManagedSettingsCandidatePaths();
  for (const candidate of candidates) {
    const layer = await tryReadLayer(candidate, 'managed');
    if (layer !== null) return layer;
  }
  return null;
}

/**
 * Read all available settings layers in precedence order (highest first).
 * Skips files that don't exist or aren't readable.
 * Throws for malformed JSON/YAML in files that DO exist.
 */
export async function readSettingsLayers(
  options: ReadSettingsOptions = {}
): Promise<SettingsLayer[]> {
  const layers: SettingsLayer[] = [];
  const home = homedir();

  // 1. Managed settings (or explicit override)
  const managedLayer = await readManagedLayer(options);
  if (managedLayer !== null) layers.push(managedLayer);

  // 2 & 3. Project settings (local overrides base)
  if (options.projectDir) {
    await tryAddLayer(layers, `${options.projectDir}/.claude/settings.local.json`, 'project-local');
    await tryAddLayer(layers, `${options.projectDir}/.claude/settings.json`, 'project');
  }

  // 4. User settings
  await tryAddLayer(layers, safePath.join(home, '.claude', 'settings.json'), 'user');

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
