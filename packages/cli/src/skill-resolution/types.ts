/**
 * Result of resolving a skill reference (a CLI subject like `my-skill`,
 * `./dist/skills/x`, or `npm:@scope/s@1.2.3`). See {@link resolveSkillReference}
 * for the full grammar and the disambiguation ladder.
 */

import type { SkillPackagingConfig, SkillSource } from '@vibe-agent-toolkit/agent-skills';

/** Where `vat build` places a declared skill's output. */
export type SkillDistribution =
  /** Pool skill: built by `packageSkill` to `dist/skills/<fsSafeName>`. */
  | { kind: 'pool' }
  /** Plugin-local tree-copy skill: shipped via `vat claude plugin build`. */
  | {
      kind: 'plugin-local';
      marketplaceName: string;
      pluginName: string;
      skillDirName: string;
    };

/**
 * A project-local reference (a bare NAME matching a declared skill) that must be
 * BUILT and then tested from its dist. The new path this plan adds.
 */
export interface BuildableReference {
  kind: 'buildable';
  /** The declared skill name. */
  name: string;
  /** Absolute path to the skill's authored SKILL.md (the build input). */
  sourcePath: string;
  /** Absolute path to the governing config root (holds vibe-agent-toolkit.config.yaml). */
  configRoot: string;
  /** Merged packaging config (defaults + per-skill), used to drive the build. */
  packagingConfig: SkillPackagingConfig;
  /** How/where this skill ships. */
  distribution: SkillDistribution;
  /** Absolute dir where the build places the skill (what gets staged + tested). */
  expectedDistDir: string;
}

/**
 * The full result union of {@link resolveSkillReference}.
 *
 * - `buildable`  → build (real entry points), then test the dist.
 * - `source`     → test the tree as-is (already-built dist, external, or undeclared).
 * - `name-miss`  → a bare name in a project that declares no such skill (error).
 * - `not-found`  → not a path and no governing config to resolve a name (error).
 */
export type SkillReference =
  | BuildableReference
  | { kind: 'source'; source: SkillSource }
  | { kind: 'name-miss'; name: string; configRoot: string; knownSkills: string[] }
  | { kind: 'not-found'; ref: string };
