import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';

/**
 * Format types that discovery can detect
 */
export type DetectedFormat =
  | 'agent-skill'     // SKILL.md
  | 'vat-agent'       // agent.yaml
  | 'markdown'        // *.md (resource file)
  | 'unknown';        // Other files

/**
 * Options for scanning/discovery operations
 */
export interface ScanOptions {
  /** Path to scan (file or directory) */
  path: string;

  /** Recursive scan (search subdirectories) */
  recursive?: boolean;

  /** Include patterns (glob) */
  include?: string[];

  /** Exclude patterns (glob) */
  exclude?: string[];

  /** Follow symbolic links */
  followSymlinks?: boolean;
}

/**
 * Result of scanning a single file
 */
export interface ScanResult {
  /** Absolute path to file */
  path: string;

  /** Detected format */
  format: DetectedFormat;

  /** Is this file gitignored (likely build output) */
  isGitIgnored: boolean;

  /** Relative path from scan root */
  relativePath: string;
}

/**
 * Summary of scan operation
 */
export interface ScanSummary {
  /** All discovered files */
  results: ScanResult[];

  /** Total files scanned */
  totalScanned: number;

  /** Files by format */
  byFormat: Record<DetectedFormat, number>;

  /** Source files (not gitignored) */
  sourceFiles: ScanResult[];

  /** Build outputs (gitignored) */
  buildOutputs: ScanResult[];

  /**
   * Directories the recursive crawl could not LIST, so nothing beneath them is
   * in `results`. Empty when every listing succeeded, and always empty for a
   * non-recursive scan (nothing is walked).
   *
   * Carried rather than thrown because this scanner's callers are listings over
   * trees they do not own — `~/.claude/plugins` above all, where one root-owned
   * or quarantined directory is ordinary — and aborting the whole listing for
   * it destroys every skill already found. Carried rather than dropped because
   * a shorter `results` is indistinguishable from a complete one. Every caller
   * owes the reader this list; a caller that discards it has reintroduced the
   * silent shortfall.
   */
  unreadable: DirectoryRefusal[];
}
