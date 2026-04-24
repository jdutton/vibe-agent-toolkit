/**
 * Provenance metadata for a `vat audit <git-url>` invocation. Captured
 * after the shallow clone resolves, used to render the header that
 * precedes audit output and to keep paths in output repo-relative
 * (independent of the random tempdir name).
 */
export interface Provenance {
  /** The URL the user typed, preserved as-is for reproducibility. */
  url: string;
  /** Branch or tag name (the actual ref cloned). */
  ref: string;
  /** Resolved commit SHA of the cloned ref's HEAD. */
  commit: string;
  /** Subpath within the cloned repo, if specified. */
  subpath?: string;
}

/**
 * Render the provenance header for a URL audit. Always ends with a newline.
 */
export function renderProvenanceHeader(p: Provenance): string {
  let header = `Audited: ${p.url} @ ${p.ref} (commit ${p.commit})\n`;
  if (p.subpath) {
    header += `Subpath: ${p.subpath}\n`;
  }
  return header;
}

/**
 * Walk a JSON-serializable structure and replace any string value that
 * begins with `tempRoot` with its repo-relative equivalent (no leading
 * separator, forward slashes only — matches the format paths take in
 * existing audit output).
 *
 * Pure: returns a new structure, does not mutate the input.
 */
export function rewritePathsInResults<T>(value: T, tempRoot: string): T {
  // Normalize tempRoot to ensure a clean prefix match. Both POSIX and
  // Windows-style separators must be handled because audit outputs may
  // include either depending on the host.
  const root = tempRoot.endsWith('/') ? tempRoot.slice(0, -1) : tempRoot;
  const rootForward = root.replaceAll('\\', '/');
  return rewrite(value, root, rootForward);
}

function rewrite<T>(value: T, root: string, rootForward: string): T {
  if (typeof value === 'string') {
    return rewriteString(value, root, rootForward) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, root, rootForward)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewrite(v, root, rootForward);
    }
    return out as T;
  }
  return value;
}

function rewriteString(s: string, root: string, rootForward: string): string {
  if (s.startsWith(root)) {
    const tail = s.slice(root.length).replace(/^[/\\]/, '');
    return tail.replaceAll('\\', '/');
  }
  if (s.startsWith(rootForward)) {
    const tail = s.slice(rootForward.length).replace(/^[/\\]/, '');
    return tail.replaceAll('\\', '/');
  }
  return s;
}
