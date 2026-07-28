/**
 * PURE classification of a skill reference token — no filesystem, no config.
 * The IO-bound disambiguation (existing-dir vs declared-skill) lives in
 * {@link resolveSkillReference}; this module decides only the *syntactic* shape.
 */
import { isAbsolute } from 'node:path';

import type { SkillSource } from '@vibe-agent-toolkit/agent-skills';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

const SOURCE_KINDS = new Set(['workspace', 'npm', 'url', 'path']);

/**
 * Parse the `kind:value` source half of a reference (also used by `--with`).
 * Grammar: `vendored` | `workspace:<x>` | `npm:<x>` | `url:<x>` | `path:<x>`.
 * (No `sha256` here — it arrives only via config descriptors, matching the
 * pre-existing `--with` grammar.)
 */
export function parseSourceSpec(src: string): SkillSource {
  if (src === 'vendored') return { vendored: true };
  const colon = src.indexOf(':');
  const kind = colon === -1 ? src : src.slice(0, colon);
  const value = colon === -1 ? '' : src.slice(colon + 1);
  if (!SOURCE_KINDS.has(kind)) {
    throw new Error(
      `skill source must be workspace:|npm:|url:|path:|vendored. Got: ${src}`,
    );
  }
  if (value === '') {
    throw new Error(`skill source is missing a value: ${src}`);
  }
  switch (kind) {
    case 'workspace': return { workspace: value };
    case 'npm': return { npm: value };
    case 'url': return { url: value };
    default: return { path: value };
  }
}

/** Syntactic shape of a reference token (pure ladder rule 1). */
export type TokenShape =
  | { shape: 'source-spec'; source: SkillSource }
  | { shape: 'definite-path' }
  | { shape: 'bare-name'; token: string };

/** True when the token carries a recognized `kind:` prefix or is `vendored`. */
function isSourceSpec(ref: string): boolean {
  if (ref === 'vendored') return true;
  const colon = ref.indexOf(':');
  return colon > 0 && SOURCE_KINDS.has(ref.slice(0, colon));
}

/**
 * Classify a reference token's syntactic shape (no IO):
 *  - a `kind:` prefix / `vendored` → `source-spec` (note: `resolveSkillReference`
 *    re-routes the `path:` arm through its definite-path rung, because that prefix
 *    only disambiguates path-vs-name and must not change build treatment)
 *  - absolute, or contains a path separator, or starts with `.` → `definite-path`
 *    (ladder rule 1: "always a path; never name-resolved" — incl. the `./<name>`
 *    escape that forces a colliding local dir over a declared skill. That escape
 *    only lands on `source`: if the local dir IS the declared skill's own source
 *    dir, rung 2a resolves `./<name>` to `buildable` anyway, so there is no escape
 *    from your own source — only from an unrelated dir that merely shares the name)
 *  - otherwise a bare word → `bare-name` (resolved against config + fs by the caller)
 */
export function classifyToken(ref: string): TokenShape {
  if (isSourceSpec(ref)) return { shape: 'source-spec', source: parseSourceSpec(ref) };
  const fwd = toForwardSlash(ref);
  if (isAbsolute(ref) || fwd.includes('/') || fwd.startsWith('.')) {
    return { shape: 'definite-path' };
  }
  return { shape: 'bare-name', token: ref };
}
