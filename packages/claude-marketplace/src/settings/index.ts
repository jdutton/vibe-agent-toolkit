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

export {
  isSubsumedBy,
  matchesAllowRule,
  matchesBashRule,
  matchesDenyRule,
  matchesPathRule,
  matchesPermissionRule,
} from './permission-matcher.js';
export type { BashRuleType, ParsedBashRule, PermissionLane } from './permission-matcher.js';

export type { ReadSettingsOptions } from './settings-reader.js';
export { readEffectiveSettings, readSettingsLayers } from './settings-reader.js';

export type {
  SettingsAuditResult,
  SettingsFileField,
  SettingsFinding,
  SettingsPathCandidate,
  SettingsPathCandidatesResult,
  SettingsPathEntry,
  SettingsPathsResult,
  SettingsTypeConfidence,
  SettingsValidateResult,
} from './settings-auditor.js';
export {
  auditSettings,
  getSettingsPaths,
  getSettingsFileFields,
  probePathAccess,
  resolveSettingsPaths,
  summarizeSettingsFindings,
  validateSettingsFile,
} from './settings-auditor.js';

export { checkSettingsCompatibility } from './settings-compat-checker.js';

export type { RuleConflict, RuleConflictKind } from './settings-conflict-analyzer.js';
export { analyzeRuleConflicts } from './settings-conflict-analyzer.js';
