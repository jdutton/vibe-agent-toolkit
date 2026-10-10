/**
 * Resolve effective targets from layered sources.
 *
 * Priority (highest to lowest): plugin.json → marketplace.json → config.yaml.
 * Absence at all layers means no declaration — not "assumed compatible."
 */

import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import type { Target } from './types.js';

interface MarketplaceManifest {
  name?: string;
  defaults?: { targets?: Target[] };
}

/**
 * Maximum number of parent directories to walk when searching for a
 * `.claude-plugin/marketplace.json`. Ten is well beyond any sane plugin
 * layout and prevents pathological walks when no marketplace exists.
 */
const MAX_WALK_DEPTH = 10;

/**
 * Basenames that indicate the walk has escaped the plugin's natural tree.
 * If the current directory's basename matches one of these, stop walking.
 */
const WALK_STOP_BASENAMES = new Set(['node_modules', '.git']);

/**
 * Walk upward from `startingDir` looking for a `.claude-plugin/marketplace.json`.
 *
 * Handles both the canonical layout (marketplace is the parent of the plugin
 * dir) and deeper layouts where the marketplace lives further up the tree.
 *
 * Returns `undefined` if no marketplace.json is found within the walk bounds,
 * or if the found manifest is invalid JSON or lacks `defaults.targets` — a
 * corrupt manifest is reported by the inventory lane that owns it, not here.
 *
 * A manifest that is THERE and the OS refuses to read (`EACCES`, `EISDIR`) is
 * neither absent nor corrupt, and propagates: walking past it would answer
 * "no marketplace here" for a marketplace that is here, and the caller
 * (`analyzeCompatibility`, via `vat audit`) already reports a thrown analysis
 * as "could not run", with the reason, rather than as no verdict.
 */
export function readMarketplaceDefaultTargets(
  startingDir: string,
): Promise<Target[] | undefined> {
  return walkUpForTargets(startingDir, 0);
}

/** One level of {@link readMarketplaceDefaultTargets}'s upward walk. */
async function walkUpForTargets(currentDir: string, depth: number): Promise<Target[] | undefined> {
  // Max depth exceeded without finding a marketplace.
  if (depth >= MAX_WALK_DEPTH) return undefined;
  if (WALK_STOP_BASENAMES.has(basename(currentDir))) return undefined;

  const manifestPath = safePath.join(currentDir, '.claude-plugin', 'marketplace.json');
  let raw: string | undefined;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    // Not present here — keep walking. Anything else stays loud.
    if (!isPathAbsentError(error)) throw error;
  }
  if (raw !== undefined) {
    return targetsOf(raw);
  }

  const parent = dirname(currentDir);
  // Filesystem root reached.
  if (parent === currentDir) return undefined;
  return walkUpForTargets(parent, depth + 1);
}

/**
 * The `defaults.targets` a marketplace.json declares, or `undefined` when the
 * text is not JSON or declares none. The found manifest ends the walk either
 * way — a parent's defaults are not this marketplace's.
 */
function targetsOf(raw: string): Target[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { defaults } = parsed as MarketplaceManifest;
  return Array.isArray(defaults?.targets) ? defaults.targets : undefined;
}

/**
 * Resolve effective targets. Plugin overrides marketplace overrides config.
 * Explicit empty array at any layer means "no runtimes" — not "fall back."
 */
export function resolveEffectiveTargets(params: {
  configTargets: Target[] | undefined;
  pluginTargets: Target[] | undefined;
  marketplaceTargets: Target[] | undefined;
}): Target[] | undefined {
  if (params.pluginTargets !== undefined) return params.pluginTargets;
  if (params.marketplaceTargets !== undefined) return params.marketplaceTargets;
  if (params.configTargets !== undefined) return params.configTargets;
  return undefined;
}
