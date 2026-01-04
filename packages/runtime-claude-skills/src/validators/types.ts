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
  | 'LINK_INTEGRITY_BROKEN'
  | 'PATH_STYLE_WINDOWS'
  // Critical errors - Plugins
  | 'PLUGIN_MISSING_MANIFEST'
  | 'PLUGIN_INVALID_JSON'
  | 'PLUGIN_INVALID_SCHEMA'
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
  | 'METADATA_SUMMARY';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  location?: string;
  fix?: string;
}

export interface ValidationResult {
  path: string;
  type: 'claude-skill' | 'vat-agent' | 'claude-plugin' | 'marketplace' | 'registry';
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
}

export interface ValidateOptions {
  /** Path to SKILL.md file */
  skillPath: string;

  /** Root directory (for resolving relative links) */
  rootDir?: string;

  /** Treat as VAT-generated skill (stricter validation) */
  isVATGenerated?: boolean;
}
