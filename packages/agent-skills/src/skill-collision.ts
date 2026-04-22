/**
 * Detect name collisions between plugin-local skills across different plugins.
 *
 * Rules:
 * - Exact (case-sensitive) collision across plugins -> error.
 * - Case-insensitive collision across plugins -> error (protects adopters on
 *   case-insensitive filesystems from shipping artifacts that break on Linux CI).
 * - Two skills with the same name inside the same plugin are not flagged here;
 *   such duplicates are unreachable from normal discovery (one SKILL.md per
 *   directory, unique directory names per plugin). If encountered, the caller
 *   is expected to have surfaced it earlier.
 */

export interface SkillRef {
  name: string;
  plugin: string;
  sourcePath: string;
}

export interface SkillCollision {
  kind: 'exact' | 'case-insensitive';
  a: SkillRef;
  b: SkillRef;
  message: string;
}

/**
 * Classify a pair of skill refs as an exact / case-insensitive collision.
 *
 * Returns undefined for same-plugin pairs (not a cross-plugin collision) and
 * for name mismatches. The same-plugin guard is defensive: discovery emits one
 * SkillRef per SKILL.md, so same-plugin duplicates should not normally reach
 * this function.
 */
function classifyCollision(a: SkillRef, b: SkillRef): SkillCollision['kind'] | undefined {
  if (a.plugin === b.plugin) return undefined;
  if (a.name === b.name) return 'exact';
  if (a.name.toLowerCase() === b.name.toLowerCase()) return 'case-insensitive';
  return undefined;
}

function buildCollision(a: SkillRef, b: SkillRef, kind: SkillCollision['kind']): SkillCollision {
  const message =
    `Skill name collision (${kind}): ` +
    `"${a.name}" in plugin "${a.plugin}" (${a.sourcePath}) conflicts with ` +
    `"${b.name}" in plugin "${b.plugin}" (${b.sourcePath}). ` +
    `Skill names must be unique across plugins — rename one to resolve.`;
  return { kind, a, b, message };
}

export function detectSkillCollisions(refs: readonly SkillRef[]): SkillCollision[] {
  const collisions: SkillCollision[] = [];

  for (let i = 0; i < refs.length; i++) {
    const a = refs[i];
    if (!a) continue;
    for (let j = i + 1; j < refs.length; j++) {
      const b = refs[j];
      if (!b) continue;
      const kind = classifyCollision(a, b);
      if (kind) collisions.push(buildCollision(a, b, kind));
    }
  }

  return collisions;
}
