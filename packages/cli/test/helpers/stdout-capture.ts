/**
 * Shared test helper: capture process.stdout.write output.
 *
 * Usage:
 *   const restore = captureStdout(captured);
 *   try { ... } finally { restore(); }
 */

/**
 * Intercept process.stdout.write and collect all output into `captured`.
 * Returns a restore function that must be called in a finally block.
 */
export function captureStdout(captured: string[]): () => void {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}
