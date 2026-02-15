/**
 * Core types for Claude plugin compatibility analysis.
 *
 * Three Claude surfaces with different runtime capabilities:
 * - claude-desktop: Most restrictive (MCP servers only, no local scripts)
 * - cowork: Middle ground (VM with Python 3.10 + Node.js 22, restricted network)
 * - claude-code: Least restrictive (full local environment)
 */

/** Claude surface where plugins can run */
export type Target = 'claude-desktop' | 'cowork' | 'claude-code';

/** All targets in order of restrictiveness (most to least) */
export const ALL_TARGETS: readonly Target[] = ['claude-desktop', 'cowork', 'claude-code'] as const;

/**
 * Three-tier verdict to handle ambiguity in static analysis.
 * - compatible: High confidence this works on the target
 * - needs-review: Signals detected but uncertain — curator decides
 * - incompatible: Definitive evidence it cannot work on the target
 */
export type Verdict = 'compatible' | 'needs-review' | 'incompatible';

/** Where a compatibility signal was detected */
export type EvidenceSource =
  | 'declaration'      // Author-declared targets in plugin.json or frontmatter
  | 'frontmatter'      // allowed-tools in SKILL.md frontmatter
  | 'code-block'       // Fenced code blocks in markdown
  | 'script'           // Script files (.py, .sh, .mjs) in plugin directory
  | 'script-import'    // Import statements inside script files
  | 'hook'             // Hook handler commands in hooks.json
  | 'mcp-server';      // MCP server configs in .mcp.json

/**
 * A single piece of compatibility evidence found during analysis.
 * Each evidence item records what was found, where, and how it impacts each target.
 */
export interface CompatibilityEvidence {
  /** What type of source produced this evidence */
  source: EvidenceSource;
  /** File where the signal was found (relative to plugin root) */
  file: string;
  /** Line number within the file (1-based, when applicable) */
  line?: number | undefined;
  /** Short description of the signal (e.g., "python3 command", "pip install") */
  signal: string;
  /** Human-readable detail explaining what was found */
  detail: string;
  /** Impact on each target surface */
  impact: Record<Target, 'ok' | 'needs-review' | 'incompatible'>;
}

/**
 * Aggregated compatibility result for a single plugin.
 * Plugin verdict = worst verdict across all evidence for each target.
 */
export interface CompatibilityResult {
  /** Plugin name from plugin.json */
  plugin: string;
  /** Plugin version from plugin.json (if present) */
  version?: string | undefined;
  /** Author-declared target surfaces (if present in plugin.json) */
  declared?: Target[] | undefined;
  /** Analyzed verdict per target */
  analyzed: Record<Target, Verdict>;
  /** All evidence collected during analysis */
  evidence: CompatibilityEvidence[];
  /** Summary counts for quick assessment */
  summary: {
    totalFiles: number;
    skillFiles: number;
    scriptFiles: number;
    hookFiles: number;
    mcpConfigs: number;
  };
}
