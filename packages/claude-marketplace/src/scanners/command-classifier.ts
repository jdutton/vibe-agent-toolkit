import type { ImpactLevel, Target } from '../types.js';
import { IMPACT_ALL_OK, IMPACT_INCOMPATIBLE_DESKTOP, IMPACT_NEEDS_REVIEW_DESKTOP } from '../types.js';

export interface CommandRule {
  pattern: RegExp;
  signal: string;
  impact: Record<Target, ImpactLevel>;
}

/** Maps known binary names to their compatibility impact */
const BINARY_IMPACTS: Record<string, { signal: string; impact: Record<Target, ImpactLevel> }> = {
  bash: { signal: 'bash', impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP } },
  node: { signal: 'node', impact: { ...IMPACT_ALL_OK } },
  npx: { signal: 'npx', impact: { ...IMPACT_ALL_OK } },
  python: { signal: 'python3', impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP } },
  python3: { signal: 'python3', impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP } },
  sh: { signal: 'sh', impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP } },
  uv: { signal: 'uv', impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP } },
};

/** Commands and their impact on each target */
export const COMMAND_RULES: readonly CommandRule[] = [
  {
    pattern: /\bpip3?\s+install\b/,
    signal: 'pip install',
    impact: { ...IMPACT_INCOMPATIBLE_DESKTOP },
  },
  {
    pattern: /\bnpm\s+install\b/,
    signal: 'npm install',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  {
    pattern: /\buv\s+(?:run|pip|sync)\b/,
    signal: 'uv',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  {
    pattern: /\bpython3?\s+/,
    signal: 'python3',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  {
    pattern: /\bbash\s+/,
    signal: 'bash',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  {
    // The `sh` pattern avoids matching file extensions like `.sh`
    pattern: /(?<!\.)(?:^|[\s;|&])sh\s+/m,
    signal: 'sh',
    impact: { ...IMPACT_NEEDS_REVIEW_DESKTOP },
  },
  {
    pattern: /\bnode\s+/,
    signal: 'node',
    impact: { ...IMPACT_ALL_OK },
  },
] as const;

/**
 * Classify a command string against known command patterns.
 * Returns the first matching rule or undefined.
 */
export function classifyCommand(
  command: string,
): { signal: string; impact: Record<Target, ImpactLevel> } | undefined {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return { signal: rule.signal, impact: { ...rule.impact } };
    }
  }
  return undefined;
}

/**
 * Classify a standalone binary name (e.g., "python3", "node", "uv").
 * Unlike classifyCommand which matches regex patterns against full command strings,
 * this performs an exact lookup for MCP server command binaries.
 */
export function classifyCommandBinary(
  binary: string,
): { signal: string; impact: Record<Target, ImpactLevel> } | undefined {
  const entry = BINARY_IMPACTS[binary];
  if (!entry) return undefined;
  return { signal: entry.signal, impact: { ...entry.impact } };
}
