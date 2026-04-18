/**
 * Core types for Claude plugin compatibility analysis.
 *
 * Three Claude surfaces with different runtime capabilities:
 * - claude-chat: Most restrictive (MCP servers only, no local scripts)
 * - claude-cowork: Middle ground (VM with Python 3.10 + Node.js 22, restricted network)
 * - claude-code: Least restrictive (full local environment)
 */

import type { EvidenceRecord, Observation } from '@vibe-agent-toolkit/agent-skills';

import type { Verdict } from './verdict-engine.js';

/** Claude surface where plugins can run */
export type Target = 'claude-chat' | 'claude-cowork' | 'claude-code';

/** Where a compatibility signal was detected */
export type EvidenceSource =
  | 'declaration'       // Author-declared targets in plugin.json or frontmatter
  | 'frontmatter'       // allowed-tools in SKILL.md frontmatter
  | 'code-block'        // Fenced code blocks in markdown
  | 'script'            // Script files (.py, .sh, .mjs) in plugin directory
  | 'script-import'     // Import statements inside script files
  | 'hook'              // Hook handler commands in hooks.json
  | 'mcp-server'        // MCP server configs in .mcp.json
  | 'settings-conflict'; // Conflict with managed/user settings

/**
 * Output of a per-file scanner: raw evidence records plus the derived
 * capability observations rolled up from those records (the verdict layer
 * decides whether each observation produces an issue for a given target).
 */
export interface ScannerOutput {
  evidence: EvidenceRecord[];
  observations: Observation[];
}

/** Settings level (highest → lowest precedence) */
export type SettingsLevel =
  | 'managed'
  | 'project-local'
  | 'project'
  | 'user';

/** Type of conflict between plugin capabilities and settings policies */
export type SettingsConflictType =
  | 'tool-blocked'       // permissions.deny matches a tool the plugin uses
  | 'hook-disabled'      // disableAllHooks: true but plugin declares hooks
  | 'mcp-denied'         // deniedMcpServers blocks a server in .mcp.json
  | 'model-unavailable'; // availableModels doesn't include plugin's required model

/** A conflict between a plugin and active settings policies */
export interface SettingsConflict {
  type: SettingsConflictType;
  /** Human-readable explanation */
  detail: string;
  /** Settings key that caused the block, e.g. "permissions.deny" */
  blockedBy: string;
  /** The specific blocking value, e.g. "Bash(curl *)" */
  value: string;
  /** Absolute path to the settings file */
  settingsFile: string;
  settingsLevel: SettingsLevel;
}

/**
 * Aggregated compatibility result for a single plugin.
 *
 * Evidence is the raw per-pattern record. Observations are rolled-up
 * capability claims derived from evidence. Verdicts are emitted by the
 * verdict engine based on observations + effective targets.
 */
export interface CompatibilityResult {
  /** Plugin name from plugin.json */
  plugin: string;
  /** Plugin version from plugin.json (if present) */
  version?: string | undefined;
  /** Effective declared targets after resolving plugin/marketplace/config layers */
  declaredTargets: Target[] | undefined;
  /** All raw evidence records collected during analysis */
  evidence: EvidenceRecord[];
  /** Capability observations derived from evidence */
  observations: Observation[];
  /** Compat verdicts produced by the verdict engine */
  verdicts: Verdict[];
  /** Settings conflicts found (only present when --settings used) */
  settingsConflicts?: SettingsConflict[] | undefined;
  /** Summary counts for quick assessment */
  summary: {
    totalFiles: number;
    skillFiles: number;
    scriptFiles: number;
    hookFiles: number;
    mcpConfigs: number;
  };
}
