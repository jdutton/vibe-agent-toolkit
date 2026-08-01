/**
 * Re-basing report `path` values onto the run's single stated root.
 *
 * A report states its coordinate system ONCE — `root:` — and every `path`
 * beneath it is relative to that. Producers keep absolute paths internally on
 * purpose: an absolute path is the identity every internal map keys on (compat
 * results, visited-path de-duplication, registry caches), and unlike a
 * `location` it is trivially recoverable, since an absolute path plus a known
 * root yields the relative form. Re-basing therefore happens once, at the
 * document boundary, and this module is that one place.
 *
 * Deliberately NOT a deep walk over every `path`-named property: re-basing is
 * not idempotent (`relative(root, someRelativeValue)` resolves the value
 * against the process cwd and produces nonsense), so a helper that guesses
 * which values are absolute would silently corrupt an already-relative one.
 * The caller names the nested carriers it owns instead.
 */

import { issueLocation } from '@vibe-agent-toolkit/utils';

/** The minimum shape this module re-bases: anything carrying a `path`. */
export interface PathEntry {
  path: string;
}

/**
 * Re-base one absolute path onto `root`, as a forward-slashed relative path.
 *
 * Pointing a report AT a single resource makes that resource the root, which
 * relativizes to the empty string. That is spelled `.` — the POSIX name for
 * "the root itself" — so no consumer has to special-case a blank value, and
 * `join(root, path)` still resolves.
 */
export function relativizePath(absolutePath: string, root: string): string {
  const relative = issueLocation(absolutePath, root);
  return relative === '' ? '.' : relative;
}

/** Whether an unknown value is shaped like something this module can re-base. */
function isPathEntry(value: unknown): value is PathEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { path?: unknown }).path === 'string'
  );
}

function relativizeEntry<T extends PathEntry>(
  entry: T,
  root: string,
  nestedKeys: readonly string[],
): T {
  const out = { ...entry, path: relativizePath(entry.path, root) };
  // The nested carriers are named by the caller, so they are not on T's known
  // keys; the bag view is the only way to reach them without demanding every
  // caller widen its own result type.
  const bag = out as unknown as Record<string, unknown>;
  for (const key of nestedKeys) {
    const nested = bag[key];
    if (!Array.isArray(nested)) continue;
    bag[key] = nested.map((item: unknown) =>
      isPathEntry(item) ? relativizeEntry(item, root, nestedKeys) : item,
    );
  }
  return out;
}

/**
 * Re-base the `path` of every entry — and of every entry inside the nested
 * carriers named by `nestedKeys`, at any depth — onto `root`.
 *
 * Returns new objects; the input is never mutated.
 *
 * @param entries - Report entries carrying absolute `path` values.
 * @param root - The single root the document states.
 * @param nestedKeys - Names of array-valued properties whose elements also
 *   carry an absolute `path` (audit passes `['linkedFiles']`). Omitting a
 *   carrier leaves its paths absolute, which is how a document ends up in two
 *   coordinate systems — so a producer that adds a carrier must name it here.
 */
export function relativizePathEntries<T extends PathEntry>(
  entries: readonly T[],
  root: string,
  nestedKeys: readonly string[] = [],
): T[] {
  return entries.map((entry) => relativizeEntry(entry, root, nestedKeys));
}
