import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { EvidenceRecord, Observation } from '@vibe-agent-toolkit/agent-skills';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

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
import type { CompatibilityResult, CompatibilityUnchecked, Target } from './types.js';
import { computeVerdicts } from './verdict-engine.js';
import { reasonOf, walkFollowingLinks } from './walk-following-links.js';

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
 * Every file in the plugin (paths relative to the plugin root), following
 * symlinks, plus every directory the walk could not list, spelled the way the
 * result carries it (see {@link uncheckedEntry}).
 *
 * Skips the `.claude-plugin` metadata directory (the manifest is read
 * separately). The walk itself is the one the settings checker uses, so the
 * two compat lanes see the same population — this one used to use
 * `Dirent.isDirectory()`, `false` for a symlink, and pushed a linked skill
 * directory as a FILE with no extension that nothing scanned.
 */
async function collectFiles(
  pluginDir: string,
  locationRoot: string,
): Promise<{ files: string[]; unchecked: CompatibilityUnchecked[] }> {
  const tree = await walkFollowingLinks(pluginDir, { skipDirectory: (name) => name === '.claude-plugin' });
  return {
    files: tree.files.map((file) => safePath.relative(pluginDir, file)),
    unchecked: tree.unlistable.map(({ path, reason }) => uncheckedEntry(path, reason, locationRoot)),
  };
}

/**
 * One `unchecked` entry, anchored at `locationRoot` like every evidence
 * location: an OS refusal names the path it refused absolutely, and every
 * other path in the result is root-relative, so the absolute spelling is
 * replaced wherever the message carries it.
 */
function uncheckedEntry(absolutePath: string, reason: string, locationRoot: string): CompatibilityUnchecked {
  const path = issueLocation(absolutePath, locationRoot) || '.';
  return { path, reason: reason.replaceAll(absolutePath, path) };
}

/** Which `summary` counter a scanned file lands in. */
type FileCounter = Exclude<keyof FileCounts, 'totalFiles'>;

/**
 * Scan one file by what it is; `undefined` for a file no scanner reads.
 * Throws the scanner's own error — the caller names the file as unchecked.
 */
async function scanFile(
  relativePath: string,
  fullPath: string,
  locationRoot: string,
): Promise<{ counter: FileCounter; evidence: EvidenceRecord[] } | undefined> {
  const ext = extname(relativePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return { counter: 'skillFiles', evidence: await scanMarkdownFile(fullPath, locationRoot) };
  }
  if (SCRIPT_EXTENSIONS.has(ext)) {
    return { counter: 'scriptFiles', evidence: await scanScriptFile(fullPath, locationRoot) };
  }
  if (isHooksFile(relativePath)) {
    return { counter: 'hookFiles', evidence: await scanHooksFile(fullPath, locationRoot) };
  }
  if (isMcpConfigFile(relativePath)) {
    return { counter: 'mcpConfigs', evidence: await scanMcpFile(fullPath, locationRoot) };
  }
  return undefined;
}

/**
 * Scan a single markdown file for compatibility evidence.
 */
async function scanMarkdownFile(
  fullPath: string,
  locationRoot: string,
): Promise<EvidenceRecord[]> {
  const content = await readFile(fullPath, 'utf8');
  return [
    ...scanCodeBlocks(content, fullPath, locationRoot),
    ...scanFrontmatter(content, fullPath, locationRoot),
  ];
}

/**
 * Scan a script file for compatibility evidence.
 * For Python files, also scans imports for third-party dependencies.
 */
async function scanScriptFile(
  fullPath: string,
  locationRoot: string,
): Promise<EvidenceRecord[]> {
  const evidence: EvidenceRecord[] = [];

  const classification = classifyScriptFile(fullPath, locationRoot);
  if (classification) {
    evidence.push(classification);
  }

  if (extname(fullPath).toLowerCase() === '.py') {
    const content = await readFile(fullPath, 'utf8');
    evidence.push(...scanPythonImports(content, fullPath, locationRoot));
  }

  return evidence;
}

/**
 * Scan a hooks JSON file for compatibility evidence.
 */
async function scanHooksFile(
  fullPath: string,
  locationRoot: string,
): Promise<EvidenceRecord[]> {
  const raw = await readFile(fullPath, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  return scanHooksConfig(config, fullPath, locationRoot);
}

/**
 * Scan an MCP config file for compatibility evidence.
 */
async function scanMcpFile(
  fullPath: string,
  locationRoot: string,
): Promise<EvidenceRecord[]> {
  const raw = await readFile(fullPath, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  return scanMcpConfig(config, fullPath, locationRoot);
}

/**
 * Check if a file path matches a hooks config pattern.
 * Matches: hooks.json, hooks/hooks.json, hooks/*.json
 */
function isHooksFile(relativePath: string): boolean {
  if (relativePath === 'hooks.json') return true;
  // eslint-disable-next-line local/no-path-startswith -- relativePath is forward-slashed by safePath.relative in collectFiles
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
 * @param locationRoot - The ONE base every emitted evidence `location.file` is
 *   expressed relative to. A caller analysing several plugins in one run (e.g.
 *   `vat audit`) MUST pass its invocation scan root, not each plugin directory,
 *   or the report mixes coordinate systems. Required: "relative to what?" has no
 *   safe default.
 * @param options - Optional analysis options; see {@link AnalyzeCompatibilityOptions}.
 *   `options.configTargets` lets callers thread a config-layer target declaration
 *   through to the verdict engine — plugin.json / marketplace.json targets still
 *   win when present.
 * @returns CompatibilityResult with evidence, observations, verdicts, counts,
 *   and `unchecked` — every path beneath the plugin the analysis could not
 *   read, list or parse. Those are named per path and the rest is analyzed;
 *   the result is a verdict over the files it names as read.
 * @throws Only for a failure that is plugin-wide: no valid
 *   `.claude-plugin/plugin.json`, or a plugin root that cannot be listed.
 */
export async function analyzeCompatibility(
  pluginDir: string,
  locationRoot: string,
  options?: AnalyzeCompatibilityOptions,
): Promise<CompatibilityResult> {
  const manifest = await readPluginManifest(pluginDir);
  const { files, unchecked: unlistable } = await collectFiles(pluginDir, locationRoot);

  const allEvidence: EvidenceRecord[] = [];
  const unchecked: CompatibilityUnchecked[] = [...unlistable];
  const counts: FileCounts = {
    totalFiles: files.length,
    skillFiles: 0,
    scriptFiles: 0,
    hookFiles: 0,
    mcpConfigs: 0,
  };

  // Each file is scanned on its own: one the filesystem refuses, or one whose
  // JSON will not parse, is named under `unchecked` and the rest are still
  // analyzed. This used to throw out of the whole plugin.
  for (const relativePath of files) {
    const fullPath = safePath.join(pluginDir, relativePath);
    try {
      const scanned = await scanFile(relativePath, fullPath, locationRoot);
      if (scanned === undefined) continue;
      counts[scanned.counter]++;
      allEvidence.push(...scanned.evidence);
    } catch (error) {
      unchecked.push(uncheckedEntry(fullPath, reasonOf(error), locationRoot));
    }
  }

  // Roll evidence up into capability observations.
  const observations: Observation[] = deriveScannerObservations(allEvidence);

  // Resolve effective targets from manifest + marketplace defaults.
  // Walk upward from the plugin dir to find an enclosing marketplace.json —
  // handles both the canonical layout (parent-of-plugin) and deeper layouts.
  // Config-layer targets are plumbed through by callers (e.g., the CLI) when
  // they have a config; the analyzer itself does not load YAML config.
  const marketplaceSearchStart = safePath.resolve(pluginDir, '..');
  const marketplaceTargets = await readMarketplaceDefaultTargets(marketplaceSearchStart);
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
    unchecked,
    summary: counts,
  };
}
