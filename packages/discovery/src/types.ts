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
}
