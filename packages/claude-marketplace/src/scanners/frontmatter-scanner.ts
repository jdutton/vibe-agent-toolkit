import { parse as parseYaml } from 'yaml';

import type { CompatibilityEvidence, ImpactLevel, Target } from '../types.js';
import { ALL_TARGETS, IMPACT_ALL_OK, IMPACT_DESKTOP_INCOMPATIBLE_COWORK_REVIEW } from '../types.js';

/** Tools that require local environment access */
const RESTRICTED_TOOLS: Record<string, { impact: Record<Target, ImpactLevel> }> = {
  Bash: { impact: { ...IMPACT_DESKTOP_INCOMPATIBLE_COWORK_REVIEW } },
  Edit: { impact: { ...IMPACT_DESKTOP_INCOMPATIBLE_COWORK_REVIEW } },
  Write: { impact: { ...IMPACT_DESKTOP_INCOMPATIBLE_COWORK_REVIEW } },
  NotebookEdit: { impact: { ...IMPACT_DESKTOP_INCOMPATIBLE_COWORK_REVIEW } },
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function scanAllowedTools(
  allowedTools: unknown[],
  filePath: string,
): CompatibilityEvidence[] {
  const evidence: CompatibilityEvidence[] = [];
  for (const tool of allowedTools) {
    const toolName = String(tool);
    const restriction = RESTRICTED_TOOLS[toolName];
    if (restriction) {
      evidence.push({
        source: 'frontmatter',
        file: filePath,
        signal: `allowed-tools: ${toolName}`,
        detail: `Skill requires "${toolName}" tool which needs local environment access`,
        impact: { ...restriction.impact },
      });
    }
  }
  return evidence;
}

function scanTargetsDeclaration(
  targets: unknown[],
  filePath: string,
): CompatibilityEvidence | undefined {
  const declaredTargets = new Set(targets.map(String));
  const excludedTargets = ALL_TARGETS.filter(t => !declaredTargets.has(t));
  if (excludedTargets.length === 0) return undefined;

  const impact: Record<Target, ImpactLevel> = { ...IMPACT_ALL_OK };
  for (const t of excludedTargets) {
    impact[t] = 'incompatible';
  }
  return {
    source: 'declaration',
    file: filePath,
    signal: `targets: [${targets.map(String).join(', ')}]`,
    detail: `Author declares plugin targets: ${targets.map(String).join(', ')}. Not listed: ${excludedTargets.join(', ')}`,
    impact,
  };
}

/**
 * Scan SKILL.md frontmatter for compatibility-relevant declarations.
 * Checks `allowed-tools` for restricted tools and `targets` for author-declared surfaces.
 */
export function scanFrontmatter(content: string, filePath: string): CompatibilityEvidence[] {
  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch) return [];

  const rawYaml = fmMatch[1];
  if (rawYaml === undefined) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(rawYaml) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];

  const evidence: CompatibilityEvidence[] = [];

  const allowedTools = parsed['allowed-tools'];
  if (Array.isArray(allowedTools)) {
    evidence.push(...scanAllowedTools(allowedTools, filePath));
  }

  const targets = parsed['targets'];
  if (Array.isArray(targets)) {
    const targetEvidence = scanTargetsDeclaration(targets, filePath);
    if (targetEvidence) {
      evidence.push(targetEvidence);
    }
  }

  return evidence;
}
