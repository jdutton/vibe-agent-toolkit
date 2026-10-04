/**
 * Settings auditor — entry point for vat audit settings command.
 */

import * as fs from 'node:fs/promises';
import { platform } from 'node:os';

import {
  summarizeIssues,
  type IssueSeverity,
  type SeverityCounts,
} from '@vibe-agent-toolkit/schema';
import { isPathAbsentError } from '@vibe-agent-toolkit/utils';

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

/**
 * A settings path we know how to look for, before anyone has looked.
 *
 * It carries NO `exists`/`readable`: a synchronous enumeration cannot know, and
 * a placeholder `false` is indistinguishable from "we checked and it is absent".
 * Only {@link resolveSettingsPaths} may answer that question.
 */
export interface SettingsPathCandidate {
  label: string;
  path: string;
  level: SettingsLevel;
  status?: 'error' | undefined;
  message?: string | undefined;
}

/** A candidate plus the answer to "is it there, and can we read it?". */
export interface SettingsPathEntry extends SettingsPathCandidate {
  /** `'undetermined'` when the probe itself failed — not the same as absent. */
  exists: boolean | 'undetermined';
  /** `'undetermined'` when the probe itself failed — not the same as unreadable. */
  readable: boolean | 'undetermined';
  /** The probe failure that made the answer undetermined (errno / error code). */
  accessError?: string | undefined;
}

export interface SettingsPathCandidatesResult {
  paths: SettingsPathCandidate[];
}

export interface SettingsPathsResult {
  paths: SettingsPathEntry[];
}

export type SettingsDetectedType = 'managed' | 'user' | 'project' | 'unknown';

/**
 * How the settings type was arrived at.
 *
 * `user` and `project` settings share one schema, so a file carrying no
 * managed-only field could be either. Returning `user` for that case answered a
 * question we had not settled; `ambiguous` says so out loud.
 */
export type SettingsTypeConfidence =
  /** The caller passed an explicit `--type`. */
  | 'declared'
  /** A managed-only field settled it. */
  | 'inferred'
  /** Could be user or project — the shared schema cannot tell them apart. */
  | 'ambiguous'
  /** The file does not parse as JSON (an unreadable one throws instead). */
  | 'undetermined';

/**
 * One thing wrong with (or worth noting about) a settings file — the fields of a
 * report `Finding` the validator knows. The file itself is the caller's: it
 * becomes the finding's `location`, the file you would open.
 */
export interface SettingsFinding {
  /** Not a `validation.severity` key: nothing that validates a settings file reads a project's validation config. */
  code: 'SETTINGS_FILE_INVALID' | 'SETTINGS_TYPE_AMBIGUOUS';
  severity: IssueSeverity;
  message: string;
  /** What to do about it. */
  fix: string;
  /** Dotted key path inside the settings document; absent when the finding is about the document as a whole. */
  field?: string;
}

/** "Is this settings file valid?" is `summary.errors > 0`; `status` is the literal `resultStatus`. */
export interface SettingsValidateResult {
  status: 'ok' | 'findings';
  /** The severity distribution of `findings`, as the report envelope publishes it. */
  summary: SeverityCounts;
  findings: SettingsFinding[];
  detectedType: SettingsDetectedType;
  typeConfidence: SettingsTypeConfidence;
}

/** Errno values that genuinely answer "it is not there". Anything else means we could not look. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/**
 * Probe a path for existence and readability.
 *
 * Returns `'undetermined'` for both when the probe failed for a reason that is
 * not "absent" (e.g. a permission error on a parent directory): claiming
 * `exists: false` there would report a determination we never made.
 */
export async function probePathAccess(
  filePath: string
): Promise<{
  exists: boolean | 'undetermined';
  readable: boolean | 'undetermined';
  accessError?: string;
}> {
  try {
    await fs.access(filePath, fs.constants.F_OK);
  } catch (err) {
    const code = errorCode(err);
    if (ABSENT_CODES.has(code)) {
      return { exists: false, readable: false };
    }
    return { exists: 'undetermined', readable: 'undetermined', accessError: code };
  }

  try {
    await fs.access(filePath, fs.constants.R_OK);
    return { exists: true, readable: true };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EACCES' || code === 'EPERM') {
      return { exists: true, readable: false };
    }
    return { exists: true, readable: 'undetermined', accessError: code };
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
 * Enumerate every settings path Claude could load, without looking at the disk.
 *
 * Deliberately returns {@link SettingsPathCandidate}s: this function cannot know
 * whether a path exists, so it says nothing about it. Use
 * {@link resolveSettingsPaths} for answers.
 */
export function getSettingsPaths(projectDir?: string): SettingsPathCandidatesResult {
  const paths: SettingsPathCandidate[] = [];
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
      level: 'managed',
    });
  }

  // Windows legacy path check (synchronous — callers must resolve async)
  if (platform() === 'win32') {
    paths.push({
      label: 'Managed settings (Windows legacy — ERROR)',
      path: WINDOWS_LEGACY_MANAGED_SETTINGS_PATH,
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
    level: 'user',
  });

  // Project paths
  if (projectDir) {
    const projectPaths = getClaudeProjectPaths(projectDir);
    paths.push(
      {
        label: 'Project settings',
        path: projectPaths.projectSettingsPath,
        level: 'project',
      },
      {
        label: 'Project local settings',
        path: projectPaths.projectSettingsLocalPath,
        level: 'project-local',
      }
    );
  }

  return { paths };
}

/**
 * Answer, for every candidate path, whether it exists and is readable.
 *
 * A probe that fails for any reason other than "absent" yields
 * `'undetermined'` plus an `accessError`, never a confident `false`.
 */
export async function resolveSettingsPaths(projectDir?: string): Promise<SettingsPathsResult> {
  const { paths } = getSettingsPaths(projectDir);

  const resolved: SettingsPathEntry[] = await Promise.all(
    paths.map(async (candidate) => {
      const access = await probePathAccess(candidate.path);
      return { ...candidate, ...access };
    })
  );

  return { paths: resolved };
}

function selectSchemaForType(type: SettingsDetectedType) {
  if (type === 'managed') return ManagedSettingsSchema;
  if (type === 'project') return ProjectSettingsSchema;
  return UserSettingsSchema;
}

const MANAGED_ONLY_FIELDS = [
  'availableModels', 'forceLoginMethod', 'forceLoginOrgUUID', 'apiKeyHelper',
  'companyAnnouncements', 'cleanupPeriodDays', 'disableAllHooks', 'allowManagedHooksOnly',
  'sandbox', 'enableAllProjectMcpServers', 'autoUpdatesChannel',
];

/**
 * Detect the type of a settings file by examining its fields.
 *
 * Returns the confidence alongside the type. Without it, the `user` fallback —
 * chosen only because user and project share one schema — was indistinguishable
 * from a file we had actually identified as a user settings file.
 */
function detectSettingsType(
  raw: unknown
): { detectedType: SettingsDetectedType; typeConfidence: SettingsTypeConfidence } {
  if (typeof raw !== 'object' || raw === null) {
    return { detectedType: 'unknown', typeConfidence: 'undetermined' };
  }

  const obj = raw as Record<string, unknown>;
  for (const field of MANAGED_ONLY_FIELDS) {
    if (field in obj) return { detectedType: 'managed', typeConfidence: 'inferred' };
  }

  // Both user and project use the same SharedSettingsSchema, so this file could
  // be either. The schema choice does not depend on the answer; the LABEL does.
  return { detectedType: 'user', typeConfidence: 'ambiguous' };
}

const INVALID_FILE_FIX =
  'Fix the field the finding names (its `field` is the dotted key path), or the JSON syntax, then re-run vat audit settings --file.';

/**
 * Validate a specific settings file against the appropriate schema.
 *
 * @throws The read error for an absent or refused file — nothing was read, so it is no finding.
 */
export async function validateSettingsFile(
  filePath: string,
  typeHint?: Exclude<SettingsDetectedType, 'unknown'>
): Promise<SettingsValidateResult> {
  // A read error propagates (see @throws); only content that does not parse is a finding.
  const content = await fs.readFile(filePath, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (err) {
    return buildValidateResult(
      [{ code: 'SETTINGS_FILE_INVALID', message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`, severity: 'error', fix: INVALID_FILE_FIX }],
      'unknown',
      'undetermined',
    );
  }

  const detected = detectSettingsType(raw);
  const detectedType = typeHint ?? detected.detectedType;
  const typeConfidence: SettingsTypeConfidence =
    typeHint === undefined ? detected.typeConfidence : 'declared';
  const schema = selectSchemaForType(detectedType);

  const findings: SettingsFinding[] = [];
  if (typeConfidence === 'ambiguous') {
    findings.push({
      code: 'SETTINGS_TYPE_AMBIGUOUS',
      message:
        'Could not determine whether this is a user or project settings file — they share one ' +
        'schema. Validated as "user"; pass --type to state which it is.',
      severity: 'info',
      fix: 'Pass --type user or --type project to state which it is.',
    });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const e of result.error.errors) {
      // A violation at the document's root has no key path: the finding is about the whole file.
      const field = e.path.join('.');
      findings.push({ code: 'SETTINGS_FILE_INVALID', ...(field === '' ? {} : { field }), message: e.message, severity: 'error', fix: INVALID_FILE_FIX });
    }
  }

  return buildValidateResult(findings, detectedType, typeConfidence);
}

function buildValidateResult(
  findings: SettingsFinding[],
  detectedType: SettingsDetectedType,
  typeConfidence: SettingsTypeConfidence,
): SettingsValidateResult {
  return { ...summarizeIssues(findings), findings, detectedType, typeConfidence };
}

/** One field present in a settings file. */
export interface SettingsFileField {
  key: string;
  value?: string;
  count?: number;
}

/**
 * Get summary of fields present in a settings file (for --file output).
 *
 * Returns `null` when there is nothing to list: the file is not there, is not
 * JSON, or is not an object. `[]` means the file parsed and genuinely declares
 * no fields.
 *
 * A file the OS refuses (`EACCES`, `EISDIR`) throws, as it does from
 * {@link validateSettingsFile}; an ABSENT file is `null` here but throws there.
 */
export async function getSettingsFileFields(
  filePath: string
): Promise<SettingsFileField[] | null> {
  const raw = await readSettingsObject(filePath);
  if (raw === null) return null;

  const fields: SettingsFileField[] = [];
  summarizeFields(raw, fields);
  return fields;
}

/**
 * The parsed object at `filePath`, or `null` when there is nothing to list —
 * absent, not JSON, or JSON that is not an object. A refusal propagates.
 */
async function readSettingsObject(filePath: string): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return null;
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  return raw as Record<string, unknown>;
}

function summarizeFields(obj: Record<string, unknown>, fields: SettingsFileField[]): void {

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
}

export {type EffectiveSettings, type SettingsLayer} from './settings-merger.js';
export {type ReadSettingsOptions} from './settings-reader.js';