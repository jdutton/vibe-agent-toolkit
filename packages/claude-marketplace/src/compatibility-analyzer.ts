import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

import {
  classifyScriptFile,
  scanCodeBlocks,
  scanFrontmatter,
  scanHooksConfig,
  scanMcpConfig,
  scanPythonImports,
} from './scanners/index.js';
import type { CompatibilityEvidence, CompatibilityResult, ImpactLevel, Target, Verdict } from './types.js';
import { ALL_TARGETS } from './types.js';

/** File extensions treated as scripts by the scanner */
const SCRIPT_EXTENSIONS = new Set(['.py', '.sh', '.bash', '.mjs', '.js', '.cjs']);

/** File extensions that are markdown (skills, agents, commands) */
const MARKDOWN_EXTENSIONS = new Set(['.md']);

interface PluginManifest {
  name: string;
  version?: string;
  targets?: Target[];
}

interface FileCounts {
  totalFiles: number;
  skillFiles: number;
  scriptFiles: number;
  hookFiles: number;
  mcpConfigs: number;
}

/**
 * Read and parse .claude-plugin/plugin.json from the plugin directory.
 * Throws if the file does not exist or is invalid JSON.
 */
async function readPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from join(pluginDir, ...)
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed['name'] || typeof parsed['name'] !== 'string') {
    throw new Error(`plugin.json missing required "name" field in ${manifestPath}`);
  }

  const manifest: PluginManifest = { name: parsed['name'] };

  if (typeof parsed['version'] === 'string') {
    manifest.version = parsed['version'];
  }

  if (Array.isArray(parsed['targets'])) {
    manifest.targets = parsed['targets'] as Target[];
  }

  return manifest;
}

/**
 * Recursively collect all file paths relative to the root directory.
 * Skips the .claude-plugin directory itself (manifest is read separately).
 */
async function collectFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- recursive walk of user-provided plugin directory
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = toForwardSlash(relative(rootDir, fullPath));

      if (entry.isDirectory()) {
        // Skip the .claude-plugin metadata directory
        if (entry.name === '.claude-plugin') continue;
        await walk(fullPath);
      } else {
        files.push(relativePath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * Determine if an evidence item has meaningful impact (not all-ok).
 * Evidence where every target is 'ok' is informational noise and gets filtered out.
 */
function hasNonOkImpact(evidence: CompatibilityEvidence): boolean {
  return ALL_TARGETS.some(target => evidence.impact[target] !== 'ok');
}

/**
 * Aggregate evidence into a per-target verdict.
 * Worst impact wins: any 'incompatible' -> incompatible, any 'needs-review' -> needs-review.
 */
function aggregateVerdicts(evidence: CompatibilityEvidence[]): Record<Target, Verdict> {
  const result: Record<Target, Verdict> = {
    'claude-desktop': 'compatible',
    cowork: 'compatible',
    'claude-code': 'compatible',
  };

  for (const item of evidence) {
    for (const target of ALL_TARGETS) {
      const impact: ImpactLevel = item.impact[target];
      if (impact === 'incompatible') {
        result[target] = 'incompatible';
      } else if (impact === 'needs-review' && result[target] !== 'incompatible') {
        result[target] = 'needs-review';
      }
    }
  }

  return result;
}

/**
 * Scan a single markdown file for compatibility evidence.
 */
async function scanMarkdownFile(
  fullPath: string,
  relativePath: string,
): Promise<CompatibilityEvidence[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from collectFiles walk
  const content = await readFile(fullPath, 'utf8');
  return [
    ...scanCodeBlocks(content, relativePath),
    ...scanFrontmatter(content, relativePath),
  ];
}

/**
 * Scan a script file for compatibility evidence.
 * For Python files, also scans imports for third-party dependencies.
 */
async function scanScriptFile(
  fullPath: string,
  relativePath: string,
): Promise<CompatibilityEvidence[]> {
  const evidence: CompatibilityEvidence[] = [];

  const classification = classifyScriptFile(relativePath);
  if (classification) {
    evidence.push(classification);
  }

  if (extname(relativePath).toLowerCase() === '.py') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from collectFiles walk
    const content = await readFile(fullPath, 'utf8');
    evidence.push(...scanPythonImports(content, relativePath));
  }

  return evidence;
}

/**
 * Scan a hooks JSON file for compatibility evidence.
 */
async function scanHooksFile(
  fullPath: string,
  relativePath: string,
): Promise<CompatibilityEvidence[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from collectFiles walk
  const raw = await readFile(fullPath, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  return scanHooksConfig(config, relativePath);
}

/**
 * Scan an MCP config file for compatibility evidence.
 */
async function scanMcpFile(
  fullPath: string,
  relativePath: string,
): Promise<CompatibilityEvidence[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from collectFiles walk
  const raw = await readFile(fullPath, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  return scanMcpConfig(config, relativePath);
}

/**
 * Check if a file path matches a hooks config pattern.
 * Matches: hooks.json, hooks/hooks.json, hooks/*.json
 */
function isHooksFile(relativePath: string): boolean {
  if (relativePath === 'hooks.json') return true;
  // eslint-disable-next-line local/no-path-startswith -- relativePath already normalized via toForwardSlash in collectFiles
  return relativePath.startsWith('hooks/') && relativePath.endsWith('.json');
}

/**
 * Check if a file path is an MCP config file.
 */
function isMcpConfigFile(relativePath: string): boolean {
  return relativePath === '.mcp.json';
}

/**
 * Analyze a Claude plugin directory for compatibility across all target surfaces.
 *
 * Walks the plugin directory, runs relevant scanners on each file,
 * and aggregates evidence into per-target verdicts.
 *
 * @param pluginDir - Absolute path to the plugin root directory
 * @returns Aggregated compatibility result with evidence and verdicts
 * @throws If the directory does not contain a valid .claude-plugin/plugin.json
 */
export async function analyzeCompatibility(pluginDir: string): Promise<CompatibilityResult> {
  const manifest = await readPluginManifest(pluginDir);
  const files = await collectFiles(pluginDir);

  const allEvidence: CompatibilityEvidence[] = [];
  const counts: FileCounts = {
    totalFiles: files.length,
    skillFiles: 0,
    scriptFiles: 0,
    hookFiles: 0,
    mcpConfigs: 0,
  };

  for (const relativePath of files) {
    const fullPath = join(pluginDir, relativePath);
    const ext = extname(relativePath).toLowerCase();

    if (MARKDOWN_EXTENSIONS.has(ext)) {
      counts.skillFiles++;
      const evidence = await scanMarkdownFile(fullPath, relativePath);
      allEvidence.push(...evidence);
    } else if (SCRIPT_EXTENSIONS.has(ext)) {
      counts.scriptFiles++;
      const evidence = await scanScriptFile(fullPath, relativePath);
      allEvidence.push(...evidence);
    } else if (isHooksFile(relativePath)) {
      counts.hookFiles++;
      const evidence = await scanHooksFile(fullPath, relativePath);
      allEvidence.push(...evidence);
    } else if (isMcpConfigFile(relativePath)) {
      counts.mcpConfigs++;
      const evidence = await scanMcpFile(fullPath, relativePath);
      allEvidence.push(...evidence);
    }
  }

  // Filter out evidence where all targets are 'ok' (informational noise)
  const meaningfulEvidence = allEvidence.filter(hasNonOkImpact);

  return {
    plugin: manifest.name,
    version: manifest.version,
    declared: manifest.targets,
    analyzed: aggregateVerdicts(meaningfulEvidence),
    evidence: meaningfulEvidence,
    summary: counts,
  };
}
