/**
 * resolveSkillReference — the project-aware front door for resolving a skill
 * reference (the `vat skill test run` subject; also the shared classifier `audit`
 * and `skill review` build on for per-skill config).
 *
 * THIS IS THE CANONICAL ENTRY POINT for "take a skill by name or path." Route
 * every command that accepts a skill reference through it (mirrors the
 * `resolveAssetReference` rule for config file references). Do NOT write a
 * parallel path-only resolver — that is the bug this module exists to prevent.
 *
 * Accepted grammar (subject and `--with` share it):
 *   <bare-name> | <path> | workspace:<pkg> | npm:<spec> | url:<u> | path:<dir> | vendored
 *
 * Two-consumer contract:
 *   - `vat skill test` calls this directly and BUILDS `buildable` results, then
 *     stages + tests the dist.
 *   - `audit` / `skill review` use {@link resolveSkillPackagingConfig} (re-exported
 *     here) to classify + validate SOURCE; they never materialize a build.
 * Callers should support the FULL surface, not narrow to paths.
 *
 * Disambiguation ladder:
 *   1. kind-prefixed / `vendored`                          → { kind: 'source', source }
 *      EXCEPT `path:<dir>`, which is a spelling of a definite path (the prefix only
 *      disambiguates path-vs-name) and so continues at rung 2 below.
 *   2a. definite path AT a declared skill's SOURCE dir      → buildable (same contract as a bare name; #159/#158)
 *   2b. definite path, otherwise                            → { kind: 'source', source: { path } }  (as-is; the `./<name>` escape lands here)
 *   3. bare name, no governing config     → existing dir ? source : not-found
 *   4. bare name matching a declared skill → buildable (preferred even on a dir collision; note the `./` escape —
 *      which only escapes to `source` when the colliding local dir is NOT the skill's own declared source dir; if it
 *      IS, rung 2a resolves `./<name>` to `buildable` too, so there is no escape from your own source)
 *   5. bare name, undeclared, existing dir → { kind: 'source', source: { path } }
 *   6. bare name, undeclared, not a dir   → name-miss
 *
 * PURE LOOKUP/CLASSIFICATION — no side effects, no build. Build is the caller's job.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  findDistributedSkillLocationBySource,
  skillNameToFsPath,
} from '@vibe-agent-toolkit/agent-skills';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';

import { loadConfigCached } from '../utils/config-loader.js';

import { classifyToken } from './classify.js';
import { getDiscoveredSkillsByPath, resolveSkillPackagingConfig } from './packaging-config.js';
import type { BuildableReference, DeclaredSkillLink, SkillDistribution, SkillReference } from './types.js';

function existingDir(p: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-supplied reference
  return existsSync(p);
}

/**
 * Compute where a declared skill builds to (pool `dist/skills/<fsName>` vs a
 * plugin-local tree-copy output). Single source of truth shared by the forward
 * path ({@link buildBuildable}) and the reverse path ({@link findDeclaredSkillForPath}),
 * so a path target is matched by the SAME rule it would have been built with.
 */
function computeSkillDistribution(
  name: string,
  sourcePath: string,
  configRoot: string,
  config: NonNullable<ReturnType<typeof loadConfigCached>>,
): { distribution: SkillDistribution; expectedDistDir: string } {
  const skillDir = safePath.resolve(safePath.join(safePath.resolve(sourcePath), '..'));
  const location = findDistributedSkillLocationBySource(config, configRoot, skillDir);
  if (location === undefined) {
    return {
      distribution: { kind: 'pool' },
      expectedDistDir: safePath.join(configRoot, 'dist', 'skills', skillNameToFsPath(name)),
    };
  }
  return {
    distribution: {
      kind: 'plugin-local',
      marketplaceName: location.marketplaceName,
      pluginName: location.pluginName,
      skillDirPath: location.skillDirPath,
    },
    expectedDistDir: location.skillOutputDir,
  };
}

/**
 * Shared config+discovery lookup for both the reverse (dist-path) and forward
 * (source-path) declared-skill matchers below: walk up from `absPath` (config-first,
 * so a monorepo package config beats the repo `.git`) to the governing config, then
 * return its declared-skills-by-path map. Undefined when there's no governing
 * config, or no `skills` section declared.
 */
/**
 * Shared engine for both the reverse (dist-path) and forward (source-path)
 * declared-skill matchers below: walk up from `absPath` (config-first, so a
 * monorepo package config beats the repo `.git`) to the governing config, then
 * scan its declared skills for the first one `matches` accepts. `matches` returns
 * the caller's result shape (or undefined to keep scanning) — the two matchers
 * differ only in WHICH path each declared skill is compared against and WHAT they
 * build from a hit, not in the walk-up/scan itself.
 */
async function findFirstDeclaredSkillEntry<T>(
  absPath: string,
  matches: (
    sourcePath: string,
    name: string,
    configRoot: string,
    config: NonNullable<ReturnType<typeof loadConfigCached>>,
  ) => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  const configRoot = findProjectRoot(absPath);
  if (configRoot === null) return undefined;
  const config = loadConfigCached(configRoot);
  if (config?.skills === undefined) return undefined;
  const byPath = await getDiscoveredSkillsByPath(config.skills, configRoot);
  for (const [sourcePath, name] of byPath.entries()) {
    const result = await matches(sourcePath, name, configRoot, config);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * Reverse-lookup: does this PATH target point at a declared skill's built dist?
 * Matches the resolved path against each declared skill's `expectedDistDir`.
 * Returns the linkage on a match, else undefined (a config-blind path). Pure
 * classification — no build, no side effects. Exported for reuse + tests.
 */
export async function findDeclaredSkillForPath(
  pathRef: string,
  cwd: string,
): Promise<DeclaredSkillLink | undefined> {
  const absPath = safePath.resolve(cwd, pathRef);
  return findFirstDeclaredSkillEntry(absPath, (sourcePath, name, configRoot, config) => {
    const { expectedDistDir } = computeSkillDistribution(name, sourcePath, configRoot, config);
    return safePath.resolve(expectedDistDir) === absPath
      ? { name, configRoot, sourcePath, expectedDistDir }
      : undefined;
  });
}

/**
 * Forward-lookup companion of {@link findDeclaredSkillForPath} (which matches a
 * DIST path): does this SOURCE path point at a declared skill's authored directory
 * (dirname of its SKILL.md)? A definite-path reference — subject OR a
 * `--with`/`--with-optional` companion given as `path:<source-dir>` — has no
 * bare-name grammar to trigger the `buildable` rung of the disambiguation ladder —
 * this is the reverse mapping that lets it get the SAME build treatment as a
 * bare-name reference (its `files:` injection runs before staging) without
 * inventing new syntax. Used directly by {@link resolveSkillReference} (the
 * subject rung) and by `resolveCompanionSpec` in run.ts (the companion rung).
 * Pure classification; no build. Returns undefined when the path matches no
 * declared skill (a reference outside this project's config — npm-packaged,
 * workspace, or an undeclared local dir — is unaffected and stays a plain source).
 */
export async function findDeclaredSkillForSourceDir(
  pathRef: string,
  cwd: string,
): Promise<BuildableReference | undefined> {
  const absPath = safePath.resolve(cwd, pathRef);
  return findFirstDeclaredSkillEntry(absPath, (sourcePath, name, configRoot, config) =>
    safePath.resolve(dirname(sourcePath)) === absPath ? buildBuildable(name, sourcePath, configRoot, config) : undefined,
  );
}

/**
 * Rung 2 of the disambiguation ladder: a definite path (absolute, has `/`, or
 * starts `.` — or the `path:<dir>` spelling of one, which routes here from
 * {@link resolveSkillReference}). A path AT a declared skill's SOURCE dir resolves to `buildable`,
 * exactly like the bare-name form (#159's contract, extended from the companion
 * side to the subject side: source != dist for every declared skill, so a real
 * run must build it, not tree-copy raw source). `--no-build` remains the escape
 * hatch. Otherwise the path is staged AS-IS (never rebuilt), but if it points at
 * a declared skill's built dist, link it back so the harness still honors that
 * skill's test: config. Extracted from {@link resolveSkillReference} to keep its
 * cognitive complexity within budget.
 */
async function resolveDefinitePath(ref: string, cwd: string): Promise<SkillReference> {
  const declaredSource = await findDeclaredSkillForSourceDir(ref, cwd);
  if (declaredSource !== undefined) return declaredSource;

  const declaredSkill = await findDeclaredSkillForPath(ref, cwd);
  return { kind: 'source', source: { path: ref }, ...(declaredSkill ? { declaredSkill } : {}) };
}

/**
 * Rungs 3-6 of the disambiguation ladder: a bare name, resolved against the
 * governing project config (or its absence). Extracted from
 * {@link resolveSkillReference} to keep its cognitive complexity within budget.
 */
async function resolveBareName(ref: string, cwd: string): Promise<SkillReference> {
  const configRoot = findProjectRoot(cwd);
  const dirCandidate = safePath.resolve(cwd, ref);

  if (configRoot === null) {
    return existingDir(dirCandidate)
      ? { kind: 'source', source: { path: ref } }
      : { kind: 'not-found', ref };
  }

  const config = loadConfigCached(configRoot);
  if (config?.skills === undefined) {
    // findProjectRoot can anchor on a bare `.git` dir with no governing VAT config
    // (or a config that declares no skills). That is the spec's "wild" rung — there
    // is nothing to name-resolve against, so it is an existing dir or `not-found`,
    // never a name-miss.
    return existingDir(dirCandidate)
      ? { kind: 'source', source: { path: ref } }
      : { kind: 'not-found', ref };
  }

  const byName = new Map<string, string>(); // name → abs SKILL.md path
  const byPath = await getDiscoveredSkillsByPath(config.skills, configRoot);
  for (const [skillMdPath, name] of byPath.entries()) byName.set(name, skillMdPath);

  const sourcePath = byName.get(ref);
  if (sourcePath !== undefined) {
    if (existingDir(dirCandidate)) {
      process.stderr.write(
        `note: '${ref}' matched a declared skill; testing its built dist. Use './${ref}' to test the local directory as-is.\n`,
      );
    }
    return buildBuildable(ref, sourcePath, configRoot, config);
  }

  if (existingDir(dirCandidate)) return { kind: 'source', source: { path: ref } };
  return {
    kind: 'name-miss',
    name: ref,
    configRoot,
    knownSkills: [...byName.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

export async function resolveSkillReference(ref: string, cwd: string): Promise<SkillReference> {
  const shape = classifyToken(ref);
  if (shape.shape === 'source-spec') {
    // `path:<dir>` is a DISAMBIGUATOR — it says "read this token as a path, not a
    // bare name" — not a build directive. So it takes the same rung-2 walk a bare
    // definite path takes: at a declared skill's source dir it is `buildable`,
    // anywhere else it is `source`. Spelling the same directory two ways must not
    // change whether VAT tests the dist or raw source; `--no-build` is the one
    // build directive. Scoped to `path:` alone: `workspace:`, `npm:`, `url:` and
    // `vendored` are not paths into this project tree and stay untouched.
    if ('path' in shape.source) return resolveDefinitePath(shape.source.path, cwd);
    return { kind: 'source', source: shape.source };
  }
  if (shape.shape === 'definite-path') return resolveDefinitePath(ref, cwd);
  return resolveBareName(ref, cwd);
}

async function buildBuildable(
  name: string,
  sourcePath: string,
  configRoot: string,
  config: NonNullable<ReturnType<typeof loadConfigCached>>,
): Promise<BuildableReference> {
  const packagingConfig = (await resolveSkillPackagingConfig(sourcePath)) ?? {};
  const { distribution, expectedDistDir } = computeSkillDistribution(name, sourcePath, configRoot, config);
  return { kind: 'buildable', name, sourcePath, configRoot, packagingConfig, distribution, expectedDistDir };
}
