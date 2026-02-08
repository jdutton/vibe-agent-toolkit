export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  // Critical errors - Skills
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
  // Critical errors - Plugins
  | 'PLUGIN_MISSING_MANIFEST'
  | 'PLUGIN_INVALID_JSON'
  | 'PLUGIN_INVALID_SCHEMA'
  // Critical errors - Marketplaces
  | 'MARKETPLACE_MISSING_MANIFEST'
  | 'MARKETPLACE_INVALID_JSON'
  | 'MARKETPLACE_INVALID_SCHEMA'
  // Critical errors - Registries
  | 'REGISTRY_MISSING_FILE'
  | 'REGISTRY_INVALID_JSON'
  | 'REGISTRY_INVALID_SCHEMA'
  // Critical errors - Format detection
  | 'UNKNOWN_FORMAT'
  // Warnings
  | 'SKILL_TOO_LONG'
  | 'REFERENCE_DEPTH_EXCEEDED'
  | 'REFERENCE_MISSING_TOC'
  | 'DESCRIPTION_FIRST_PERSON'
  | 'RESOURCE_UNREACHABLE'
  | 'SKILL_CONSOLE_INCOMPATIBLE'
  // Info
  | 'FILE_STRUCTURE_REPORT'
  | 'RESOURCE_INVENTORY'
  | 'METADATA_SUMMARY'
  | 'SKILL_UNREFERENCED_FILE';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  location?: string;
  fix?: string;
}

export interface ValidationResult {
  path: string;
  type: 'claude-skill' | 'vat-agent' | 'claude-plugin' | 'marketplace' | 'registry' | 'unknown';
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
