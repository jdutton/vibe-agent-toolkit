import type { IssueCode as RegistryIssueCode, IssueSeverity as RegistryIssueSeverity } from './code-registry.js';

export type { IssueCode as RegistryIssueCode, EmittedSeverity } from './code-registry.js';

/** Three-level severity for the unified validation framework. */
export type IssueSeverity = RegistryIssueSeverity;

/** Codes outside the overridable framework — structural reports. */
export type InfoCode =
  | 'FILE_STRUCTURE_REPORT'
  | 'RESOURCE_INVENTORY'
  | 'METADATA_SUMMARY'
  | 'SKILL_IMPLICIT_REFERENCE'
  | 'SKILL_UNREFERENCED_FILE';

/** Codes outside the overridable framework — structural prerequisites / errors that are not subject to severity overrides. */
export type NonOverridableCode =
  | 'SKILL_MISSING_FRONTMATTER'
  | 'SKILL_MISSING_NAME'
  | 'SKILL_MISSING_DESCRIPTION'
  | 'SKILL_NAME_INVALID'
  | 'SKILL_NAME_RESERVED_WORD'
  | 'SKILL_NAME_XML_TAGS'
  | 'SKILL_DESCRIPTION_XML_TAGS'
  | 'SKILL_DESCRIPTION_TOO_LONG'
  | 'SKILL_DESCRIPTION_EMPTY'
  | 'SKILL_MISCONFIGURED_LOCATION'
  | 'LINK_INTEGRITY_BROKEN'
  | 'PATH_STYLE_WINDOWS'
  | 'INVALID_FRONTMATTER'
  | 'MISSING_NAME'
  | 'RESERVED_WORD_IN_NAME'
  | 'FILENAME_COLLISION'
  | 'DUPLICATE_FILES_DEST'
  | 'PLUGIN_MISSING_MANIFEST'
  | 'PLUGIN_INVALID_JSON'
  | 'PLUGIN_INVALID_SCHEMA'
  | 'PLUGIN_MISSING_VERSION'
  | 'MARKETPLACE_MISSING_MANIFEST'
  | 'MARKETPLACE_INVALID_JSON'
  | 'MARKETPLACE_INVALID_SCHEMA'
  | 'MARKETPLACE_MISSING_LICENSE'
  | 'MARKETPLACE_MISSING_README'
  | 'MARKETPLACE_MISSING_CHANGELOG'
  | 'MARKETPLACE_MISSING_VERSION'
  | 'REGISTRY_MISSING_FILE'
  | 'REGISTRY_INVALID_JSON'
  | 'REGISTRY_INVALID_SCHEMA'
  | 'UNKNOWN_FORMAT'
  | 'SKILL_TOO_LONG'
  | 'REFERENCE_MISSING_TOC'
  | 'DESCRIPTION_FIRST_PERSON'
  | 'RESOURCE_UNREACHABLE'
  | 'SKILL_CONSOLE_INCOMPATIBLE';

/** Full code space: registry codes (overridable) + info codes + structural/non-overridable codes. */
export type IssueCode = RegistryIssueCode | InfoCode | NonOverridableCode;

export interface ValidationIssue {
  /**
   * Resolved severity after the validation framework runs.
   * The 'info' variant is a transitional concession for InfoCode emissions
   * (FILE_STRUCTURE_REPORT, RESOURCE_INVENTORY, etc.) and will be folded into
   * IssueSeverity once those emitters are wired to the framework in later phases.
   */
  severity: IssueSeverity | 'info';
  code: IssueCode;
  message: string;
  location?: string;
  fix?: string;
  /** Stable anchor into docs/validation-codes.md (e.g. '#link_outside_project'). */
  reference?: string;
}

export interface ValidationResult {
  path: string;
  type: 'agent-skill' | 'vat-agent' | 'claude-plugin' | 'marketplace' | 'registry' | 'unknown';
  status: 'success' | 'warning' | 'error';
  summary: string;
  issues: ValidationIssue[];
  metadata?: {
    name?: string;
    description?: string;
    version?: string;
    lineCount?: number;
    referenceFiles?: number;
  };
  /** Validation results for transitively linked markdown files */
  linkedFiles?: LinkedFileValidationResult[];
}

/**
 * Validation result for a single linked markdown file (not SKILL.md)
 */
export interface LinkedFileValidationResult {
  /** Absolute path to the linked file */
  path: string;
  /** Line count of the file */
  lineCount: number;
  /** Number of links found in this file */
  linksFound: number;
  /** Number of links successfully validated */
  linksValidated: number;
  /** Issues found in this file */
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  /** Path to SKILL.md file */
  skillPath: string;

  /** Root directory (for resolving relative links) */
  rootDir?: string;

  /** Treat as VAT-generated skill (stricter validation) */
  isVATGenerated?: boolean;

  /** Check for files in skill directory that aren't referenced in markdown content */
  checkUnreferencedFiles?: boolean;
}

/**
 * Discriminated union representing different resource formats that can be validated
 */
export type ResourceFormat =
  | { type: 'claude-plugin'; path: string }
  | { type: 'marketplace'; path: string }
  | { type: 'installed-plugins-registry'; path: string; filename: string }
  | { type: 'known-marketplaces-registry'; path: string; filename: string }
  | { type: 'unknown'; path: string; reason?: string };
