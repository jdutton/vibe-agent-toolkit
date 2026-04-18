/**
 * Command classification: pure pattern detection.
 *
 * No impact information here — scanners emit evidence with pattern IDs,
 * and the verdict engine decides per-target outcomes downstream.
 */

export interface CommandRule {
  pattern: RegExp;
  /** Stable label for the rule (used as match-text hint and binary key). */
  signal: string;
}

/** Known binary names mapped to their canonical signal label. */
const KNOWN_BINARIES: ReadonlySet<string> = new Set([
  'bash', 'sh', 'node', 'npx', 'python', 'python3', 'uv',
]);

/** Commands whose presence in shell text we want to record. */
export const COMMAND_RULES: readonly CommandRule[] = [
  { pattern: /\bpip3?\s+install\b/, signal: 'pip install' },
  { pattern: /\bnpm\s+install\b/, signal: 'npm install' },
  { pattern: /\buv\s+(?:run|pip|sync)\b/, signal: 'uv' },
  { pattern: /\bpython3?\s+/, signal: 'python3' },
  { pattern: /\bbash\s+/, signal: 'bash' },
  // The `sh` pattern avoids matching file extensions like `.sh`
  { pattern: /(?<!\.)(?:^|[\s;|&])sh\s+/m, signal: 'sh' },
  { pattern: /\bnode\s+/, signal: 'node' },
] as const;

/**
 * Classify a command string against known command patterns.
 * Returns the first matching rule signal or undefined.
 */
export function classifyCommand(command: string): { signal: string } | undefined {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return { signal: rule.signal };
    }
  }
  return undefined;
}

/**
 * Classify a standalone binary name (e.g., "python3", "node", "uv").
 * Used for MCP server `command` fields where the value is a bare binary name.
 */
export function classifyCommandBinary(binary: string): { signal: string } | undefined {
  if (!KNOWN_BINARIES.has(binary)) return undefined;
  // Normalize python → python3 to match the rule label.
  const signal = binary === 'python' ? 'python3' : binary;
  return { signal };
}
