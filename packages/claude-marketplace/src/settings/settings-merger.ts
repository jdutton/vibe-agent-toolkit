/**
 * Settings merger — apply precedence rules and produce EffectiveSettings with provenance.
 *
 * Scalars: last-writer-wins (highest precedence wins).
 * Permission rules: accumulated per-rule with individual provenance.
 *
 * Rule evaluation order (Claude Code): deny → ask → allow (first match wins).
 * Deny always blocks. Ask always prompts. Allow only fires if no deny/ask matched.
 */

import type { ManagedSettings, ProjectSettings, UserSettings } from '../schemas/settings.js';
import type { SettingsLevel } from '../types.js';



export interface SettingProvenance {
  level: SettingsLevel;
  /** Absolute path to the file this value came from */
  file: string;
}

/**
 * A scalar setting value with full provenance chain.
 * `overrode` is the value this replaced — linked list down to the lowest-priority source.
 */
export interface ProvenanceValue<T> {
  value: T;
  provenance: SettingProvenance;
  overrode?: ProvenanceValue<T> | undefined;
}

/**
 * A single permission rule with its source.
 * Rules ACCUMULATE across levels (unlike scalars which last-writer-wins).
 */
export interface ProvenanceRule {
  rule: string;
  provenance: SettingProvenance;
}

export interface EffectivePermissions {
  allow: ProvenanceRule[];
  deny: ProvenanceRule[];
  ask: ProvenanceRule[];
  defaultMode?: ProvenanceValue<string> | undefined;
  disableBypassPermissionsMode?: ProvenanceValue<string> | undefined;
}

export interface EffectiveSettings {
  model?: ProvenanceValue<string> | undefined;
  availableModels?: ProvenanceValue<string[]> | undefined;
  apiKeyHelper?: ProvenanceValue<string> | undefined;
  forceLoginMethod?: ProvenanceValue<string> | undefined;
  forceLoginOrgUUID?: ProvenanceValue<string> | undefined;
  autoUpdatesChannel?: ProvenanceValue<string> | undefined;
  disableAllHooks?: ProvenanceValue<boolean> | undefined;
  allowManagedHooksOnly?: ProvenanceValue<boolean> | undefined;
  outputStyle?: ProvenanceValue<string> | undefined;
  language?: ProvenanceValue<string> | undefined;
  permissions: EffectivePermissions;
}

export interface SettingsLayer {
  level: SettingsLevel;
  /** Absolute path to the settings file */
  file: string;
  settings: UserSettings | ProjectSettings | ManagedSettings;
}

function makeProvenance(level: SettingsLevel, file: string): SettingProvenance {
  return { level, file };
}

function mergeScalar<T>(
  current: ProvenanceValue<T> | undefined,
  newValue: T,
  provenance: SettingProvenance
): ProvenanceValue<T> {
  if (current === undefined) {
    return { value: newValue, provenance };
  }
  // New value overrides current (higher precedence came first in the array)
  return { value: current.value, provenance: current.provenance, overrode: { value: newValue, provenance } };
}

function setFirst<T>(
  current: ProvenanceValue<T> | undefined,
  newValue: T | undefined,
  provenance: SettingProvenance
): ProvenanceValue<T> | undefined {
  if (newValue === undefined || current !== undefined) return current;
  return { value: newValue, provenance };
}

function collectRules(
  rules: string[] | undefined,
  provenance: SettingProvenance
): ProvenanceRule[] {
  if (!rules) return [];
  return rules.map(rule => ({ rule, provenance }));
}

function mergeScalarFields(
  effective: EffectiveSettings,
  settings: UserSettings | ProjectSettings | ManagedSettings,
  provenance: SettingProvenance
): void {
  // model is present on all settings types
  if (settings.model !== undefined) {
    effective.model = mergeScalar(effective.model, settings.model, provenance);
  }

  // Managed-settings-only scalars (cast; extra fields are safe — passthrough schema)
  const managed = settings as ManagedSettings;
  effective.availableModels = setFirst(effective.availableModels, managed.availableModels, provenance);
  effective.apiKeyHelper = setFirst(effective.apiKeyHelper, managed.apiKeyHelper, provenance);
  effective.forceLoginMethod = setFirst(effective.forceLoginMethod, managed.forceLoginMethod, provenance);
  effective.forceLoginOrgUUID = setFirst(effective.forceLoginOrgUUID, managed.forceLoginOrgUUID, provenance);
  effective.autoUpdatesChannel = setFirst(effective.autoUpdatesChannel, managed.autoUpdatesChannel, provenance);
  effective.disableAllHooks = setFirst(effective.disableAllHooks, managed.disableAllHooks, provenance);
  effective.allowManagedHooksOnly = setFirst(effective.allowManagedHooksOnly, managed.allowManagedHooksOnly, provenance);
  effective.outputStyle = setFirst(effective.outputStyle, managed.outputStyle, provenance);
  effective.language = setFirst(effective.language, managed.language, provenance);
}

function mergePermissionFields(
  effective: EffectivePermissions,
  permissions: NonNullable<UserSettings['permissions']>,
  provenance: SettingProvenance
): void {
  effective.allow.push(...collectRules(permissions.allow, provenance));
  effective.deny.push(...collectRules(permissions.deny, provenance));
  effective.ask.push(...collectRules(permissions.ask, provenance));

  if (permissions.defaultMode !== undefined && effective.defaultMode === undefined) {
    effective.defaultMode = { value: permissions.defaultMode, provenance };
  }

  if (
    permissions.disableBypassPermissionsMode !== undefined &&
    effective.disableBypassPermissionsMode === undefined
  ) {
    effective.disableBypassPermissionsMode = {
      value: permissions.disableBypassPermissionsMode,
      provenance,
    };
  }
}

/**
 * Merge ordered layers (highest precedence first) into EffectiveSettings.
 * Scalars: highest-precedence layer wins.
 * Permission rules: accumulated across all layers, each tagged with its source.
 */
export function mergeSettingsLayers(layers: SettingsLayer[]): EffectiveSettings {
  const effective: EffectiveSettings = {
    permissions: {
      allow: [],
      deny: [],
      ask: [],
    },
  };

  for (const layer of layers) {
    const { level, file, settings } = layer;
    const provenance = makeProvenance(level, file);

    mergeScalarFields(effective, settings, provenance);

    if (settings.permissions) {
      mergePermissionFields(effective.permissions, settings.permissions, provenance);
    }
  }

  return effective;
}

export {type SettingsLevel} from '../types.js';
