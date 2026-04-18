import type { ImpactLevel, Target } from '../types.js';

import { ALL_OK, CHAT_INCOMPATIBLE, CHAT_NEEDS_REVIEW } from './impact-constants.js';

export interface CommandRule {
  pattern: RegExp;
  signal: string;
  impact: Record<Target, ImpactLevel>;
}

/** Maps known binary names to their compatibility impact */
const BINARY_IMPACTS: Record<string, { signal: string; impact: Record<Target, ImpactLevel> }> = {
  bash: { signal: 'bash', impact: { ...CHAT_NEEDS_REVIEW } },
  node: { signal: 'node', impact: { ...ALL_OK } },
  npx: { signal: 'npx', impact: { ...ALL_OK } },
  python: { signal: 'python3', impact: { ...CHAT_NEEDS_REVIEW } },
  python3: { signal: 'python3', impact: { ...CHAT_NEEDS_REVIEW } },
  sh: { signal: 'sh', impact: { ...CHAT_NEEDS_REVIEW } },
  uv: { signal: 'uv', impact: { ...CHAT_NEEDS_REVIEW } },
};

/** Commands and their impact on each target */
export const COMMAND_RULES: readonly CommandRule[] = [
  {
    pattern: /\bpip3?\s+install\b/,
    signal: 'pip install',
    impact: { ...CHAT_INCOMPATIBLE },
  },
  {
    pattern: /\bnpm\s+install\b/,
    signal: 'npm install',
    impact: { ...CHAT_NEEDS_REVIEW },
  },
  {
    pattern: /\buv\s+(?:run|pip|sync)\b/,
    signal: 'uv',
    impact: { ...CHAT_NEEDS_REVIEW },
  },
  {
    pattern: /\bpython3?\s+/,
    signal: 'python3',
    impact: { ...CHAT_NEEDS_REVIEW },
  },
  {
    pattern: /\bbash\s+/,
    signal: 'bash',
    impact: { ...CHAT_NEEDS_REVIEW },
  },
  {
    // The `sh` pattern avoids matching file extensions like `.sh`
    pattern: /(?<!\.)(?:^|[\s;|&])sh\s+/m,
    signal: 'sh',
    impact: { ...CHAT_NEEDS_REVIEW },
  },
  {
    pattern: /\bnode\s+/,
    signal: 'node',
    impact: { ...ALL_OK },
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
