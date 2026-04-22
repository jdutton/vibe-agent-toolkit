/**
 * Detect name collisions between pool skills and plugin-local skills
 * within a single plugin's selection set.
 *
 * Rules (from spec section Design -> Skill stream + Validation v1):
 * - Exact (case-sensitive) collision -> error.
 * - Case-insensitive collision -> error (protects adopters on case-insensitive FS
 *   from shipping artifacts that break on Linux CI).
 * - Two different plugins may each have a local skill with the same name.
 * - Collisions block only the offending plugin; callers iterate per-plugin.
 */

export interface SkillRef {
  name: string;
  origin: 'pool' | 'plugin-local';
  plugin?: string;
  sourcePath: string;
}

export interface SkillCollision {
  kind: 'exact' | 'case-insensitive';
  plugin: string | undefined;
  a: SkillRef;
  b: SkillRef;
  message: string;
}

function classifyCollision(a: SkillRef, b: SkillRef): SkillCollision['kind'] | undefined {
  if (a.origin === b.origin) return undefined;
  if (a.name === b.name) return 'exact';
  if (a.name.toLowerCase() === b.name.toLowerCase()) return 'case-insensitive';
  return undefined;
}

function buildCollision(a: SkillRef, b: SkillRef, kind: SkillCollision['kind']): SkillCollision {
  const plugin = a.origin === 'plugin-local' ? a.plugin : b.plugin;
  const message =
    `Skill name collision in plugin "${plugin ?? '?'}" (${kind}): ` +
    `"${a.name}" (${a.origin} at ${a.sourcePath}) conflicts with ` +
    `"${b.name}" (${b.origin} at ${b.sourcePath}). ` +
    `Rename one skill to resolve. Pool skills are addressable via skills.config[<name>]; ` +
    `plugin-local skills are scoped to their plugin directory.`;
  return { kind, plugin, a, b, message };
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
