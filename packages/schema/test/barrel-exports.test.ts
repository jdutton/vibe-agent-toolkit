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
  'AgentInterfaceSchema',
  'AgentManifestSchema',
  'AgentMetadataSchema',
  'AgentSpecSchema',
  'AllowEntrySchema',
  'BuildMetadataSchema',
  'CODE_REGISTRY',
  'CONSISTENCY_CODES',
  'CUSTOM_CHECK_CODE_PATTERN_SOURCE',
  'CUSTOM_CHECK_CODE_PREFIX',
  'CompositionConfigSchema',
  'CredentialsConfigSchema',
  'EVENT_INVALID_RESPONSE',
  'EVENT_REJECTED',
  'EVENT_TIMEOUT',
  'EVENT_UNAVAILABLE',
  'ExitCode',
  'FindingSchema',
  'IssueCodeSchema',
  'IssueSeveritySchema',
  'LLMConfigSchema',
  'LLM_INVALID_OUTPUT',
  'LLM_RATE_LIMIT',
  'LLM_REFUSAL',
  'LLM_TIMEOUT',
  'LLM_TOKEN_LIMIT',
  'LLM_UNAVAILABLE',
  'MemoryConfigSchema',
  'NON_RETRYABLE_EVENT_ERRORS',
  'NON_RETRYABLE_LLM_ERRORS',
  'PackagingOptionsSchema',
  'PromptConfigSchema',
  'PromptsConfigSchema',
  'RAGConfigSchema',
  'REPORT_ENVELOPE_KEYS',
  'REPORT_STATUSES',
  'RESULT_ERROR',
  'RESULT_IN_PROGRESS',
  'RESULT_SUCCESS',
  'RETRYABLE_EVENT_ERRORS',
  'RETRYABLE_LLM_ERRORS',
  'ReportStatusSchema',
  'ResourceRegistrySchema',
  'ResourceSchema',
  'SEVERITIES',
  'SKILL_NAME_REGEX',
  'SKILL_NAME_REGEX_MESSAGE',
  'SchemaRefSchema',
  'SeverityCountsSchema',
  'SeveritySchema',
  'TestConfigSchema',
  'ToolAlternativeSchema',
  'ToolSchema',
  'ValidationConfigSchema',
  'ValidationIssueSchema',
  'VatAgentMetadataSchema',
  'VatPackageMetadataSchema',
  'VatPureFunctionMetadataSchema',
  'VatSkillMetadataSchema',
  'allowUnusedIssues',
  'applyAllowFilter',
  'buildErrorReport',
  'buildReport',
  'calculateValidationStatus',
  'compareSeverity',
  'countBySeverity',
  'createAllowUsageLedger',
  'createError',
  'createInProgress',
  'createRegistryIssue',
  'createSuccess',
  'customCheckCode',
  'errorDiagnostics',
  'exitCodeForSeverityCounts',
  'installLastResortExit',
  'isCustomCheckCode',
  'isExitCode',
  'reportSchema',
  'resolveSeverity',
  'runSingleUnitValidation',
  'runValidationFramework',
  'strongerSeverity',
  'toFindings',
  'toJsonSchema',
];

describe('@vibe-agent-toolkit/schema — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
