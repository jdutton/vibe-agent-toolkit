/**
 * Resolve effective targets from layered sources.
 *
 * Priority (highest to lowest): plugin.json → marketplace.json → config.yaml.
 * Absence at all layers means no declaration — not "assumed compatible."
 */

import { readFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { Target } from './types.js';

interface MarketplaceManifest {
  name?: string;
  defaults?: { targets?: Target[] };
}

export async function readMarketplaceDefaultTargets(
  marketplaceDir: string,
): Promise<Target[] | undefined> {
  const manifestPath = safePath.join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath.join
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as MarketplaceManifest;
    if (Array.isArray(parsed.defaults?.targets)) {
      return parsed.defaults.targets;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
