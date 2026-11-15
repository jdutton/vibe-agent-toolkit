/**
 * The `.` barrel's runtime export set — a ratchet, both ways. How to react when
 * this fails is written on `findBarrelDrift` in
 * `packages/dev-tools/src/pin-barrel-exports.ts`; in one line: a removal is a
 * breaking change (restore it, or record it in CHANGELOG.md), an addition is
 * deliberate and needs a consumer outside this package before it is added here.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

const BARREL_EXPORTS = [
  'AllowEntrySchema',
  'CODE_REGISTRY',
  'COLUMN_REQUIRES_LINE_JSON_RULE',
  'CONSISTENCY_CODES',
  'CUSTOM_CHECK_CODE_PATTERN_SOURCE',
  'CUSTOM_CHECK_CODE_PREFIX',
  'ExitCode',
  'FS_FAULT_REFUSALS',
  'FindingCodeSchema',
  'FindingSchema',
  'GateSchema',
  'IssueCodeSchema',
  'IssueSeveritySchema',
  'PROJECT_LOCATION_RULE',
  'REFUSAL_CODES',
  'REPORT_ENVELOPE_KEYS',
  'REPORT_STATUSES',
  'RefusalCodeSchema',
  'ReportStatusSchema',
  'SEVERITIES',
  'SKILL_NAME_REGEX',
  'SKILL_NAME_REGEX_MESSAGE',
  'SeverityCountsSchema',
  'SeveritySchema',
  'ValidationConfigSchema',
  'ValidationIssueObjectSchema',
  'ValidationIssueSchema',
  'VatPackageMetadataSchema',
  'VatSkillMetadataSchema',
  'allowUnusedIssues',
  'anchoredAt',
  'applyAllowFilter',
  'buildErrorReport',
  'buildReport',
  'columnRequiresLine',
  'compareSeverity',
  'countBySeverity',
  'createAllowUsageLedger',
  'createRegistryIssue',
  'customCheckCode',
  'errorDiagnostics',
  'exitCodeForReport',
  'exitCodeOfChild',
  'fsFaultRefusal',
  'installLastResortExit',
  'isAbsoluteOnAnyHost',
  'isCustomCheckCode',
  'isExitCode',
  'isProjectLocation',
  'presenceImplies',
  'projectLocationOf',
  'reportSchema',
  'resolveFindings',
  'resolveSeverity',
  'resultStatus',
  'runSingleUnitValidation',
  'runValidationFramework',
  'strongerSeverity',
  'summarizeIssues',
  'toFindings',
  'toJsonSchema',
  'withAddedFindings',
  'withDurationMs',
];

describe('@vibe-agent-toolkit/schema — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
