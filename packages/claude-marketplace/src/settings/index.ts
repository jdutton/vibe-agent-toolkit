export type {
  EffectivePermissions,
  EffectiveSettings,
  ProvenanceRule,
  ProvenanceValue,
  SettingProvenance,
  SettingsLayer,
  SettingsLevel,
} from './settings-merger.js';
export { mergeSettingsLayers } from './settings-merger.js';

export { matchesBashRule, matchesPathRule, matchesPermissionRule, isSubsumedBy } from './permission-matcher.js';
export type { BashRuleType, ParsedBashRule } from './permission-matcher.js';

export type { ReadSettingsOptions } from './settings-reader.js';
export { readEffectiveSettings, readSettingsLayers } from './settings-reader.js';

export type {
  SettingsAuditResult,
  SettingsPathEntry,
  SettingsPathsResult,
  SettingsValidateResult,
} from './settings-auditor.js';
export {
  auditSettings,
  getSettingsPaths,
  getSettingsFileFields,
  resolveSettingsPaths,
  validateSettingsFile,
} from './settings-auditor.js';

export { checkSettingsCompatibility } from './settings-compat-checker.js';

export type { RuleConflict, RuleConflictKind } from './settings-conflict-analyzer.js';
export { analyzeRuleConflicts } from './settings-conflict-analyzer.js';
