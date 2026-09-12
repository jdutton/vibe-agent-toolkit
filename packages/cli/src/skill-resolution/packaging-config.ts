/**
 * Shared per-skill packaging-config resolution.
 *
 * The nearest-ancestor config walk-up that {@link resolveSkillReference},
 * `vat audit`, and `vat skill review` all use to resolve a single SKILL.md to
 * its governing `skills.config` block. Lives here (not in audit) because three
 * commands depend on it; future CLI work extends THIS, not a fourth copy.
 *
 * Does NOT compose configs across VAT projects — only the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml` contributes.
 */
import type { DeclaredEvalSuite, SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';

import { type DiscoveryOptions, discoverSkillsFromConfig } from '../commands/skills/skill-discovery.js';
import { ConfigLoadError, type loadConfig, loadConfigCached } from '../utils/config-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../utils/skill-packaging-config.js';

/** configRoot → (abs SKILL.md path → declared skill name). One expansion per root. */
const skillDiscoveryCache = new Map<string, Map<string, string>>();

/** configRoot → the project's declared eval suites. One discovery + merge per root. */
const declaredEvalSuiteCache = new Map<string, DeclaredEvalSuite[]>();

/** Clear the per-root discovery caches (call when fixtures mutate between in-process runs). */
export function resetSkillDiscoveryCache(): void {
  skillDiscoveryCache.clear();
  declaredEvalSuiteCache.clear();
}

/**
 * The project's declared eval suites for the config root governing `skillPath`.
 *
 * The single-skill counterpart to `collectDeclaredEvalSuites`: commands that resolve one
 * SKILL.md at a time (`vat audit`, `vat skill review`, `vat skill test`) still need the
 * WHOLE project's declarations, because test input is a project-wide rule — another
 * skill's eval suite is an answer key no matter whose bundle is being built.
 *
 * Memoized per config root so a run over N skills under one root pays for discovery
 * once, not N times — and served from the SAME discovery {@link getDiscoveredSkillsByPath}
 * ran for {@link resolveSkillPackagingConfig}, so one root is crawled once per run, not
 * once per question, and a crawl that refuses answers both questions the same way.
 * Returns `[]` when there is no governing config or no skills section — wild mode,
 * where there is no project to enumerate.
 *
 * ⚠️ Swallows exactly one failure: a config that cannot be LOADED (`ConfigLoadError`),
 * which the caller's own config resolution has already reported. A failed DISCOVERY is
 * not that and propagates — see {@link resolveSkillPackagingConfig} for what it means.
 * The old bare `catch` here treated the two alike, so a refused directory listing
 * quietly became "this project declares no eval suites".
 */
export async function resolveProjectDeclaredEvalSuites(
  skillPath: string,
  discovery: DiscoveryOptions = {},
): Promise<DeclaredEvalSuite[]> {
  const projectRoot = findProjectRoot(safePath.resolve(safePath.join(skillPath, '..')));
  if (projectRoot === null) return [];
  const cached = declaredEvalSuiteCache.get(projectRoot);
  if (cached !== undefined) return cached;

  let suites: DeclaredEvalSuite[] = [];
  try {
    const config = loadConfigCached(projectRoot);
    if (config?.skills !== undefined) {
      const byPath = await getDiscoveredSkillsByPath(config.skills, projectRoot, discovery);
      suites = collectDeclaredEvalSuites(
        config.skills,
        [...byPath.entries()].map(([sourcePath, name]) => ({ name, sourcePath })),
      );
    }
  } catch (err) {
    if (!(err instanceof ConfigLoadError)) throw err;
    // Already reported by the caller's own config load; degrade to the subject's own
    // declaration rather than aborting the run.
    suites = [];
  }
  declaredEvalSuiteCache.set(projectRoot, suites);
  return suites;
}

/**
 * The config root's declared skills, as absolute SKILL.md path → declared name.
 *
 * One expansion of `skills.include` per root per run. A discovery that THROWS is
 * not memoized — the next question re-asks the filesystem — and by default it
 * throws whenever the crawl refuses a directory it cannot list
 * (`DirectoryListingRefusedError` from `@vibe-agent-toolkit/utils/crawl`): the
 * declared population is then unknown, and the caller decides whether that stops
 * the command or degrades it. A caller that degrades passes `discovery.onUnreadable`
 * and gets every skill the crawl COULD see, with the refusal handed to its
 * handler — see `DiscoveryOptions`. Nothing here decides for them.
 *
 * ⚠️ The memo is per root, not per policy: the first question about a root
 * decides how that root's refusals are handled for the rest of the run. Every
 * command resets the memo at its start (`resetSkillDiscoveryCache`), and only
 * `vat audit` degrades, so a run never mixes the two.
 */
export async function getDiscoveredSkillsByPath(
  skillsSection: NonNullable<ReturnType<typeof loadConfig>>['skills'],
  configRoot: string,
  discovery: DiscoveryOptions = {},
): Promise<Map<string, string>> {
  const cached = skillDiscoveryCache.get(configRoot);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  if (skillsSection !== undefined) {
    const discovered = await discoverSkillsFromConfig(skillsSection, configRoot, discovery);
    for (const entry of discovered) {
      map.set(safePath.resolve(entry.sourcePath), entry.name);
    }
  }
  skillDiscoveryCache.set(configRoot, map);
  return map;
}

/**
 * Resolve the merged packaging config for one SKILL.md by walking UP to its
 * nearest-ancestor config and matching the skill by absolute path. Returns the
 * FULL merge (`skills.defaults` + `skills.config[name]`, keeping
 * `validation.allow`). `null` when there is no governing config, no `skills`
 * section, or the skill is not declared (wild mode).
 *
 * 🚨 `null` means "no config governs this skill" and NOTHING else. Two failures
 * propagate instead of being folded into it, because both mean the answer is
 * unknown rather than "none":
 *   - `ConfigLoadError` — the governing config exists and could not be loaded;
 *   - `DirectoryListingRefusedError` — the config loaded, but expanding its
 *     `skills.include` reached a directory the crawl could not list, so the
 *     declared population (and whether this skill is in it) is unknown.
 * The second used to be swallowed by a bare `catch { return null; }` around the
 * discovery, with no stated reason. Under it, ONE `chmod 000` directory anywhere
 * an include pattern reaches returned `null` for EVERY skill under the config:
 * `vat audit` validated them all config-free, reported `success`, exited 0 and
 * named the directory only under `--debug`. A caller that would rather degrade
 * than stop passes `discovery.onUnreadable` — `vat audit` does, files a
 * `SCAN_PATH_UNREADABLE` finding on the directory, and every skill the crawl
 * could still see keeps its config; the rest stop, as the same refusal already
 * stops `vat skills validate` and `vat skills build`.
 */
export async function resolveSkillPackagingConfig(
  skillPath: string,
  discovery: DiscoveryOptions = {},
): Promise<SkillPackagingConfig | null> {
  const absSkillPath = safePath.resolve(skillPath);
  const skillDir = safePath.resolve(safePath.join(absSkillPath, '..'));
  const projectRoot = findProjectRoot(skillDir);
  if (projectRoot === null) return null;
  const config = loadConfigCached(projectRoot);
  if (config?.skills === undefined) return null;

  const byPath = await getDiscoveredSkillsByPath(config.skills, projectRoot, discovery);
  const matchedName = byPath.get(absSkillPath);
  if (matchedName === undefined) return null;

  const { defaults, config: perSkillConfig } = config.skills;
  return mergeSkillPackagingConfig(
    defaults as Record<string, unknown> | undefined,
    perSkillConfig?.[matchedName] as Record<string, unknown> | undefined,
  );
}

/**
 * Audit's display variant: keep `validation.severity`, drop `validation.allow`
 * (audit shows every finding, including ones an `allow` entry would suppress).
 * Drops `validation` entirely when no severity is present.
 */
export function stripValidationAllowForDisplay(config: SkillPackagingConfig): SkillPackagingConfig {
  const out: SkillPackagingConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && key !== 'validation') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  const validation = (config as { validation?: { severity?: unknown; allow?: unknown } }).validation;
  if (validation?.severity !== undefined) {
    (out as Record<string, unknown>)['validation'] = { severity: validation.severity };
  }
  return out;
}
