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
  /** Plugin-local skill: packaged in place by `vat claude plugin build`. */
  | {
      kind: 'plugin-local';
      marketplaceName: string;
      pluginName: string;
      /** Dir path relative to the plugin's `skills/` dir — `group/nested` when nested. */
      skillDirPath: string;
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
 * Linkage from a PATH target back to the declared skill it materializes. Set on a
 * `source` result when the path resolves to a declared skill's built `expectedDistDir`
 * (reverse of {@link BuildableReference}). Lets `vat skill test` honor that skill's
 * persisted `test:` config (model / evals / timeout) and resolve the authored eval
 * suite relative to `sourcePath`'s dir — even though the subject is staged as-is,
 * never rebuilt. Absent when the path maps to no declared skill (config-blind target).
 */
export interface DeclaredSkillLink {
  /** The declared skill name whose dist this path is. */
  name: string;
  /** Absolute governing-config root (holds vibe-agent-toolkit.config.yaml). */
  configRoot: string;
  /** Absolute path to the skill's authored SKILL.md (its `evals/` sit beside it). */
  sourcePath: string;
  /** Absolute dir the declared skill builds to — the matched path. */
  expectedDistDir: string;
}

/**
 * The full result union of {@link resolveSkillReference}.
 *
 * - `buildable`  → build (real entry points), then test the dist.
 * - `source`     → test the tree as-is (already-built dist, external, or undeclared).
 *                  `declaredSkill` is set when a path target maps back to a declared
 *                  skill's dist (so its `test:` config is still honored).
 * - `name-miss`  → a bare name in a project that declares no such skill (error).
 * - `not-found`  → not a path and no governing config to resolve a name (error).
 */
export type SkillReference =
  | BuildableReference
  | { kind: 'source'; source: SkillSource; declaredSkill?: DeclaredSkillLink }
  | { kind: 'name-miss'; name: string; configRoot: string; knownSkills: string[] }
  | { kind: 'not-found'; ref: string };
