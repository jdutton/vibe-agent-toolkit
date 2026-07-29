import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

import type { EvidenceRecord } from '../evidence/index.js';

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
  /** Raw evidence records collected during validation. Rendered in --verbose. */
  evidence?: EvidenceRecord[];
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

  /**
   * Root that every emitted `ValidationIssue.location` is expressed relative
   * to. Defaults to the same `findProjectRoot(dirname(skillPath)) ?? skill dir`
   * fallback `validateSkillForPackaging` uses, so both skills-lane entry points
   * answer "relative to what?" identically. Pass it explicitly when batching
   * skills so one report speaks in one coordinate system.
   */
  projectRoot?: string;

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

/**
 * One recognized manifest surface at a directory's root layer.
 *
 * Unlike {@link ResourceFormat} — which is the single-answer API used by
 * `detectResourceFormat()` — `Surface` is emitted by `enumerateSurfaces()`
 * which returns *every* manifest found in the same directory. A directory can
 * contain multiple surfaces: e.g., a skill-claude-plugin has both `agent-skill`
 * (root SKILL.md) and `claude-plugin` (.claude-plugin/plugin.json) surfaces.
 *
 * The `path` field points to the file to hand the validator: the SKILL.md path
 * for skills, the directory path for plugin/marketplace (those validators resolve
 * `<dir>/.claude-plugin/<manifest>.json` themselves).
 */
export type Surface =
  | { type: 'agent-skill'; path: string }
  | { type: 'claude-plugin'; path: string }
  | { type: 'marketplace'; path: string };
