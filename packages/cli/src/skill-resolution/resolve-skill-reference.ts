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
 *   1. kind-prefixed / `vendored`         → { kind: 'source', source }
 *   2. absolute / has `/` / starts `.`    → { kind: 'source', source: { path } }  (as-is; the `./<name>` escape lands here)
 *   3. bare name, no governing config     → existing dir ? source : not-found
 *   4. bare name matching a declared skill → buildable (preferred even on a dir collision; note the `./` escape)
 *   5. bare name, undeclared, existing dir → { kind: 'source', source: { path } }
 *   6. bare name, undeclared, not a dir   → name-miss
 *
 * PURE LOOKUP/CLASSIFICATION — no side effects, no build. Build is the caller's job.
 */
import { existsSync } from 'node:fs';

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
      skillDirName: location.skillDirName,
    },
    expectedDistDir: location.skillOutputDir,
  };
}

/**
 * Reverse-lookup: does this PATH target point at a declared skill's built dist? Walks
 * up from the path (config-first, so a monorepo package config beats the repo `.git`)
 * to the governing config, then matches the resolved path against each declared skill's
 * `expectedDistDir`. Returns the linkage on a match, else undefined (a config-blind
 * path). Pure classification — no build, no side effects. Exported for reuse + tests.
 */
export async function findDeclaredSkillForPath(
  pathRef: string,
  cwd: string,
): Promise<DeclaredSkillLink | undefined> {
  const absPath = safePath.resolve(cwd, pathRef);
  const configRoot = findProjectRoot(absPath);
  if (configRoot === null) return undefined;
  const config = loadConfigCached(configRoot);
  if (config?.skills === undefined) return undefined;

  const byPath = await getDiscoveredSkillsByPath(config.skills, configRoot);
  for (const [sourcePath, name] of byPath.entries()) {
    const { expectedDistDir } = computeSkillDistribution(name, sourcePath, configRoot, config);
    if (safePath.resolve(expectedDistDir) === absPath) {
      return { name, configRoot, sourcePath, expectedDistDir };
    }
  }
  return undefined;
}

export async function resolveSkillReference(ref: string, cwd: string): Promise<SkillReference> {
  const shape = classifyToken(ref);
  if (shape.shape === 'source-spec') return { kind: 'source', source: shape.source };
  if (shape.shape === 'definite-path') {
    // A path is staged AS-IS (never rebuilt), but if it points at a declared skill's
    // built dist, link it back so the harness still honors that skill's test: config.
    const declaredSkill = await findDeclaredSkillForPath(ref, cwd);
    return { kind: 'source', source: { path: ref }, ...(declaredSkill ? { declaredSkill } : {}) };
  }

  // bare-name: needs config + fs.
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
