/**
 * Settings auditor — entry point for vat audit settings command.
 */

import * as fs from 'node:fs/promises';
import { platform } from 'node:os';

import { getClaudeProjectPaths, getClaudeUserPaths } from '../paths/claude-paths.js';
import {
  getManagedSettingsCandidatePaths,
  WINDOWS_LEGACY_MANAGED_SETTINGS_PATH,
} from '../paths/managed-settings-path.js';
import {
  ManagedSettingsSchema,
  ProjectSettingsSchema,
  UserSettingsSchema,
} from '../schemas/settings.js';
import type { SettingsLevel } from '../types.js';

import type { EffectiveSettings, SettingsLayer } from './settings-merger.js';
import { readSettingsLayers } from './settings-reader.js';
import type { ReadSettingsOptions } from './settings-reader.js';



export interface SettingsAuditResult {
  effective: EffectiveSettings;
  /** All loaded layers in precedence order */
  layers: SettingsLayer[];
}

export interface SettingsPathEntry {
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  level: SettingsLevel;
  status?: 'error' | undefined;
  message?: string | undefined;
}

export interface SettingsPathsResult {
  paths: SettingsPathEntry[];
}

export type SettingsDetectedType = 'managed' | 'user' | 'project' | 'unknown';

export interface SettingsValidateResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  detectedType: SettingsDetectedType;
}

async function checkPathAccess(
  filePath: string
): Promise<{ exists: boolean; readable: boolean }> {
  try {
     
    await fs.access(filePath, fs.constants.F_OK);
  } catch {
    return { exists: false, readable: false };
  }

  try {
     
    await fs.access(filePath, fs.constants.R_OK);
    return { exists: true, readable: true };
  } catch {
    return { exists: true, readable: false };
  }
}

/**
 * Perform a settings audit — load all layers and merge.
 */
export async function auditSettings(
  options: ReadSettingsOptions = {}
): Promise<SettingsAuditResult> {
  const layers = await readSettingsLayers(options);
  const { mergeSettingsLayers } = await import('./settings-merger.js');
  const effective = mergeSettingsLayers(layers);
  return { effective, layers };
}

/**
 * Get all known settings paths with existence and readability status.
 */
export function getSettingsPaths(projectDir?: string): SettingsPathsResult {
  const paths: SettingsPathEntry[] = [];
  const managedCandidates = getManagedSettingsCandidatePaths();

  // Managed settings
  const managedLabel = (() => {
    const p = platform();
    if (p === 'darwin') return 'Managed settings (macOS)';
    if (p === 'linux') return 'Managed settings (Linux)';
    if (p === 'win32') return 'Managed settings (Windows)';
    return 'Managed settings';
  })();

  for (const candidate of managedCandidates) {
    paths.push({
      label: managedLabel,
      path: candidate,
      exists: false,  // Will be resolved async — callers use auditSettings for resolved status
      readable: false,
      level: 'managed',
    });
  }

  // Windows legacy path check (synchronous — callers must resolve async)
  if (platform() === 'win32') {
    paths.push({
      label: 'Managed settings (Windows legacy — ERROR)',
      path: WINDOWS_LEGACY_MANAGED_SETTINGS_PATH,
      exists: false,
      readable: false,
      level: 'managed',
      status: 'error',
      message: `Legacy path — migrate to C:\\Program Files\\ClaudeCode\\`,
    });
  }

  // User paths
  const userPaths = getClaudeUserPaths();
  paths.push({
    label: 'User settings',
    path: userPaths.userSettingsPath,
    exists: false,
    readable: false,
    level: 'user',
  });

  // Project paths
  if (projectDir) {
    const projectPaths = getClaudeProjectPaths(projectDir);
    paths.push(
      {
        label: 'Project settings',
        path: projectPaths.projectSettingsPath,
        exists: false,
        readable: false,
        level: 'project',
      },
      {
        label: 'Project local settings',
        path: projectPaths.projectSettingsLocalPath,
        exists: false,
        readable: false,
        level: 'project-local',
      }
    );
  }

  return { paths };
}

/**
 * Resolve actual path access status (async version of getSettingsPaths).
 */
export async function resolveSettingsPaths(projectDir?: string): Promise<SettingsPathsResult> {
  const { paths } = getSettingsPaths(projectDir);

  const resolved = await Promise.all(
    paths.map(async (entry) => {
      // For error-marked paths (Windows legacy), only check existence
      const { exists, readable } = await checkPathAccess(entry.path);

      // If Windows legacy path exists, it's an error
      if (entry.status === 'error' && exists) {
        return { ...entry, exists, readable };
      }

      return { ...entry, exists, readable };
    })
  );

  return { paths: resolved };
}

function selectSchemaForType(type: SettingsDetectedType) {
  if (type === 'managed') return ManagedSettingsSchema;
  if (type === 'project') return ProjectSettingsSchema;
  return UserSettingsSchema;
}

/**
 * Detect the type of a settings file by examining its fields.
 */
function detectSettingsType(
  raw: unknown
): SettingsDetectedType {
  if (typeof raw !== 'object' || raw === null) return 'unknown';

  const obj = raw as Record<string, unknown>;
  const managedOnlyFields = [
    'availableModels', 'forceLoginMethod', 'forceLoginOrgUUID', 'apiKeyHelper',
    'companyAnnouncements', 'cleanupPeriodDays', 'disableAllHooks', 'allowManagedHooksOnly',
    'sandbox', 'enableAllProjectMcpServers', 'autoUpdatesChannel',
  ];

  for (const field of managedOnlyFields) {
    if (field in obj) return 'managed';
  }

  // Both user and project use the same SharedSettingsSchema — default to user
  return 'user';
}

/**
 * Validate a specific settings file against the appropriate schema.
 */
export async function validateSettingsFile(
  filePath: string,
  typeHint?: Exclude<SettingsDetectedType, 'unknown'>
): Promise<SettingsValidateResult> {
  let raw: unknown;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-provided path
    const content = await fs.readFile(filePath, 'utf-8');
    raw = JSON.parse(content) as unknown;
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: '', message: `Failed to read/parse file: ${String(err)}` }],
      detectedType: 'unknown',
    };
  }

  const detectedType = typeHint ?? detectSettingsType(raw);
  const schema = selectSchemaForType(detectedType);

  const result = schema.safeParse(raw);

  if (result.success) {
    return { valid: true, errors: [], detectedType };
  }

  const errors = result.error.errors.map(e => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return { valid: false, errors, detectedType };
}

/**
 * Get summary of fields present in a settings file (for --file output).
 */
export async function getSettingsFileFields(
  filePath: string
): Promise<Array<{ key: string; value?: string; count?: number }>> {
  let raw: unknown;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-provided path
    const content = await fs.readFile(filePath, 'utf-8');
    raw = JSON.parse(content) as unknown;
  } catch {
    return [];
  }

  if (typeof raw !== 'object' || raw === null) return [];

  const obj = raw as Record<string, unknown>;
  const fields: Array<{ key: string; value?: string; count?: number }> = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      fields.push({ key, count: value.length });
    } else if (typeof value === 'object' && value !== null) {
      // For objects like permissions, report sub-arrays
      const sub = value as Record<string, unknown>;
      for (const [subKey, subVal] of Object.entries(sub)) {
        if (Array.isArray(subVal)) {
          fields.push({ key: `${key}.${subKey}`, count: subVal.length });
        }
      }
    } else {
      fields.push({ key, value: String(value) });
    }
  }

  return fields;
}

export {type EffectiveSettings, type SettingsLayer} from './settings-merger.js';
export {type ReadSettingsOptions} from './settings-reader.js';