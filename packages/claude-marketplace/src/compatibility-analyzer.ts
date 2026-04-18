import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { EvidenceRecord, Observation } from '@vibe-agent-toolkit/agent-skills';
import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';

import { readMarketplaceDefaultTargets, resolveEffectiveTargets } from './marketplace-defaults.js';
import {
  classifyScriptFile,
  deriveScannerObservations,
  scanCodeBlocks,
  scanFrontmatter,
  scanHooksConfig,
  scanMcpConfig,
  scanPythonImports,
} from './scanners/index.js';
import type { CompatibilityResult, Target } from './types.js';
import { computeVerdicts } from './verdict-engine.js';

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
  const manifestPath = safePath.join(pluginDir, '.claude-plugin', 'plugin.json');
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
      const fullPath = safePath.join(dir, entry.name);
      const relativePath = toForwardSlash(safePath.relative(rootDir, fullPath));

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
 * Scan a single markdown file for compatibility evidence.
 */
async function scanMarkdownFile(
  fullPath: string,
  relativePath: string,
): Promise<EvidenceRecord[]> {
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
): Promise<EvidenceRecord[]> {
  const evidence: EvidenceRecord[] = [];

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
): Promise<EvidenceRecord[]> {
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
): Promise<EvidenceRecord[]> {
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
 * Options for {@link analyzeCompatibility}.
 */
export interface AnalyzeCompatibilityOptions {
  /**
   * Config-layer declared targets, typically drawn from
   * `vibe-agent-toolkit.config.yaml` (`skills.defaults.targets` plus any
   * per-skill `skills.config.<name>.targets`). These are considered only
   * when the plugin.json and marketplace.json do not declare targets —
   * see {@link resolveEffectiveTargets} for the precedence rules.
   *
   * When omitted, only plugin.json / marketplace.json targets are used and
   * behavior matches the pre-options call signature.
   */
  configTargets?: Target[];
}

/**
 * Analyze a Claude plugin directory for compatibility across all target surfaces.
 *
 * Walks the plugin directory, runs relevant scanners on each file,
 * derives capability observations from raw evidence, and computes
 * COMPAT_TARGET_* verdicts via the verdict engine using the effective
 * declared targets (plugin.json → marketplace.json → config layer).
 *
 * @param pluginDir - Absolute path to the plugin root directory
 * @param options - Optional analysis options; see {@link AnalyzeCompatibilityOptions}.
 *   `options.configTargets` lets callers thread a config-layer target declaration
 *   through to the verdict engine — plugin.json / marketplace.json targets still
 *   win when present.
 * @returns CompatibilityResult with evidence, observations, verdicts, and counts
 * @throws If the directory does not contain a valid .claude-plugin/plugin.json
 */
export async function analyzeCompatibility(
  pluginDir: string,
  options?: AnalyzeCompatibilityOptions,
): Promise<CompatibilityResult> {
  const manifest = await readPluginManifest(pluginDir);
  const files = await collectFiles(pluginDir);

  const allEvidence: EvidenceRecord[] = [];
  const counts: FileCounts = {
    totalFiles: files.length,
    skillFiles: 0,
    scriptFiles: 0,
    hookFiles: 0,
    mcpConfigs: 0,
  };

  for (const relativePath of files) {
    const fullPath = safePath.join(pluginDir, relativePath);
    const ext = extname(relativePath).toLowerCase();

    if (MARKDOWN_EXTENSIONS.has(ext)) {
      counts.skillFiles++;
      allEvidence.push(...await scanMarkdownFile(fullPath, relativePath));
    } else if (SCRIPT_EXTENSIONS.has(ext)) {
      counts.scriptFiles++;
      allEvidence.push(...await scanScriptFile(fullPath, relativePath));
    } else if (isHooksFile(relativePath)) {
      counts.hookFiles++;
      allEvidence.push(...await scanHooksFile(fullPath, relativePath));
    } else if (isMcpConfigFile(relativePath)) {
      counts.mcpConfigs++;
      allEvidence.push(...await scanMcpFile(fullPath, relativePath));
    }
  }

  // Roll evidence up into capability observations.
  const observations: Observation[] = deriveScannerObservations(allEvidence);

  // Resolve effective targets from manifest + marketplace defaults.
  // The marketplace dir is the parent of the plugin dir (per Claude plugin layout).
  // Config-layer targets are plumbed through by callers (e.g., the CLI) when
  // they have a config; the analyzer itself does not load YAML config.
  const marketplaceDir = safePath.resolve(pluginDir, '..');
  const marketplaceTargets = await readMarketplaceDefaultTargets(marketplaceDir);
  const effectiveTargets = resolveEffectiveTargets({
    configTargets: options?.configTargets,
    pluginTargets: manifest.targets,
    marketplaceTargets,
  });

  const verdicts = computeVerdicts({ observations, targets: effectiveTargets });

  return {
    plugin: manifest.name,
    version: manifest.version,
    declaredTargets: effectiveTargets,
    evidence: allEvidence,
    observations,
    verdicts,
    summary: counts,
  };
}
