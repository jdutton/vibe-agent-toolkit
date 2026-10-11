/**
 * Whether this run asked for `--debug` — read by the refusal path, which has
 * no logger of its own.
 *
 * `--debug` exists to name the THROW SITE. A refusal is a user's mistake, so
 * without the flag it publishes its message alone; with it, every refusal
 * writes its diagnostics (the stack) to stderr, and `INTERNAL_ERROR` always
 * does. `bin.ts` sets this once, at dispatch, from the parsed option.
 */

let enabled = false;

/**
 * Record whether this run asked for `--debug`.
 *
 * @param on - The parsed `--debug` value
 */
export function setDebugDiagnostics(on: boolean): void {
  enabled = on;
}

/** Whether every refusal should write its diagnostics to stderr. */
export function debugDiagnosticsEnabled(): boolean {
  return enabled;
}
