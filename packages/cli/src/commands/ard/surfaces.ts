/**
 * Reading the project config for the surfaces an ARD manifest can advertise.
 *
 * Everything here is pure — config in, surfaces out — so the derivation rules
 * are unit-testable without touching a filesystem or a manifest.
 *
 * ## Two collectors, because two rules
 *
 * A **skill** derives its media type from the surface kind alone, so every
 * published skill becomes an entry with no author action. A **marketplace**, an
 * **OKF bundle** and an MCP server derive nothing: the ARD specification names
 * no media type for any of them (see `deriveArdMediaType`), so they are emitted
 * only when the author supplies `ard.entries.<name>.type`, and are otherwise
 * *reported as skipped* — never silently dropped, and never guessed at.
 */

import {
  defaultArdNamespace,
  type ArdConfig,
  type ArdSurface,
  type ArdSurfaceKind,
  type ProjectConfig,
} from '@vibe-agent-toolkit/resources';

/** A surface VAT declined to emit, and the reason a reader can act on. */
export interface SkippedArdSurface {
  readonly name: string;
  readonly kind: ArdSurfaceKind;
  readonly reason: string;
}

export interface ArdSurfaceCollection {
  readonly surfaces: readonly ArdSurface[];
  readonly skipped: readonly SkippedArdSurface[];
}

/** Facts that apply to every surface in a run, derived once by the caller. */
export interface ArdSurfaceDefaults {
  /** The project's own package version, when it has one. */
  readonly version?: string | undefined;
}

/**
 * The path appended to `ard.baseUrl`, mirroring the URN's namespace segment.
 *
 * A convention, not a discovered fact: VAT knows what it publishes but not how
 * an adopter hosts it. `ard.baseUrl` is the knob that makes it right, and it is
 * the one field an author must set for URLs to be derivable at all.
 */
function urlPathFor(kind: ArdSurfaceKind, name: string, ard: ArdConfig): string {
  return `${ard.namespace ?? defaultArdNamespace(kind)}/${name}`;
}

/**
 * Build one surface.
 *
 * ⚠️ `displayName` is the config key **verbatim**. De-slugging it into
 * `Vat Skill Authoring` would invent capitalisation VAT has no source for, and
 * this lane's whole discipline is that a plausible fabrication is worse than an
 * honest plain value. A richer caller that has read a `SKILL.md` title should
 * pass a better one — `buildArdEntry` takes whatever it is given.
 */
function makeSurface(
  kind: ArdSurfaceKind,
  name: string,
  ard: ArdConfig,
  defaults: ArdSurfaceDefaults
): ArdSurface {
  return {
    kind,
    name,
    displayName: name,
    urlPath: urlPathFor(kind, name, ard),
    ...(defaults.version === undefined ? {} : { version: defaults.version }),
  };
}

/** Skills the project actually publishes, in config order. */
function collectSkillSurfaces(
  config: ProjectConfig,
  ard: ArdConfig,
  defaults: ArdSurfaceDefaults,
  surfaces: ArdSurface[],
  skipped: SkippedArdSurface[]
): void {
  const skills = config.skills;
  if (skills === undefined) return;

  // 🪤 `skills.config` is OPTIONAL in VAT — glob discovery via `skills.include`
  // is the ordinary way to declare skills, and this repo's own config uses it.
  // Returning quietly here meant a project with discovered-but-unconfigured
  // skills emitted `{"entries": []}` and exited 0, saying nothing: the headline
  // use case producing nothing, silently, for the common shape. Found by
  // running the command, not by reading it.
  //
  // Reported through the existing `skipped` channel rather than as an error,
  // because an empty manifest is a legal artifact and the run did not fail —
  // what was wrong was the silence. Absence of a `skills` block entirely is NOT
  // reported: there is nothing to advertise and no mistake to point at, and a
  // warning there would train people to ignore this one.
  if (skills.config === undefined || Object.keys(skills.config).length === 0) {
    skipped.push({
      name: '(discovered skills)',
      kind: 'skill',
      reason:
        'skills.config is empty, so no skill was advertised. ARD entries are derived per named skill; add `skills.config.<name>` for each skill you want announced. Discovery globs alone (`skills.include`) do not name them.',
    });
    return;
  }

  const fallbackPublish = skills.defaults?.publish ?? true;
  for (const [name, packaging] of Object.entries(skills.config)) {
    if ((packaging.publish ?? fallbackPublish) === false) {
      skipped.push({
        name,
        kind: 'skill',
        reason: 'skills.config.' + name + '.publish is false — an unpublished skill is not advertised.',
      });
      continue;
    }
    surfaces.push(makeSurface('skill', name, ard, defaults));
  }
}

/**
 * Surfaces the specification names no media type for.
 *
 * Emitted only on an explicit `ard.entries.<name>.type`. The skip reason names
 * the config key, so the fix is readable from the terminal without opening
 * documentation.
 */
function collectOverrideOnlySurfaces(
  names: readonly string[],
  kind: ArdSurfaceKind,
  ard: ArdConfig,
  defaults: ArdSurfaceDefaults,
  surfaces: ArdSurface[],
  skipped: SkippedArdSurface[]
): void {
  for (const name of names) {
    if (ard.entries?.[name]?.type === undefined) {
      skipped.push({
        name,
        kind,
        reason:
          // No indefinite article: `kind` interpolates to `mcp-server` and
          // `okf-bundle` as well as `skill`, so a hardcoded "a" is wrong for
          // half the vocabulary and "a/an" cannot be chosen from the kind
          // without a rule this message does not deserve.
          `the ARD specification names no media type for surface kind "${kind}", so VAT derives none. ` +
          `Set \`ard.entries.${name}.type\` to advertise it.`,
      });
      continue;
    }
    surfaces.push(makeSurface(kind, name, ard, defaults));
  }
}

/**
 * Every surface the project config declares, split into what VAT will emit and
 * what it declined to.
 *
 * @throws never — a config with no `ard` block yields an empty collection; the
 *   caller decides whether that is a failure (`runArdEmit` does).
 */
export function collectArdSurfaces(
  config: ProjectConfig,
  defaults: ArdSurfaceDefaults
): ArdSurfaceCollection {
  const surfaces: ArdSurface[] = [];
  const skipped: SkippedArdSurface[] = [];
  const ard = config.ard;
  if (ard === undefined) return { surfaces, skipped };

  collectSkillSurfaces(config, ard, defaults, surfaces, skipped);
  collectOverrideOnlySurfaces(
    Object.keys(config.claude?.marketplaces ?? {}),
    'marketplace',
    ard,
    defaults,
    surfaces,
    skipped
  );
  collectOverrideOnlySurfaces(
    Object.keys(config.okf?.bundles ?? {}),
    'okf-bundle',
    ard,
    defaults,
    surfaces,
    skipped
  );
  return { surfaces, skipped };
}
