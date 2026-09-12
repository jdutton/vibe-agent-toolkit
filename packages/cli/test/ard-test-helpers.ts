/**
 * Fixtures for the `vat ard` CLI suite.
 *
 * Extracted rather than repeated: two of the surface-collection cases differ
 * only in whether an `ard.entries` override is present, and jscpd runs against
 * a zero baseline (see `docs/writing-tests.md`).
 */

import { rmSync, writeFileSync } from 'node:fs';

import type { ArdEntryOverrides, ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';

/** The config file every fixture project declares its surfaces in. */
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/** The publisher every fixture is anchored at. */
export const FIXTURE_PUBLISHER = 'example.com';

/** The skill config key that is expected to be emitted. */
export const PUBLISHED_SKILL = 'vat-audit';

/** The skill config key that opts out of publishing. */
export const UNPUBLISHED_SKILL = 'work-in-progress';

/** The marketplace config key used by the override cases. */
export const FIXTURE_MARKETPLACE = 'vat-marketplace';

/** A project declaring two skills, one of them unpublished. */
export const SKILLS_PROJECT: ProjectConfig = {
  version: 1,
  skills: {
    include: ['skills/**/SKILL.md'],
    config: {
      [PUBLISHED_SKILL]: {},
      [UNPUBLISHED_SKILL]: { publish: false },
    },
  },
  ard: { publisher: FIXTURE_PUBLISHER, baseUrl: 'https://example.com/catalog' },
};

/** {@link SKILLS_PROJECT} plus one Claude marketplace and whatever overrides a case needs. */
function marketplaceProject(entries?: Record<string, ArdEntryOverrides>): ProjectConfig {
  return {
    ...SKILLS_PROJECT,
    ard: {
      ...SKILLS_PROJECT.ard,
      publisher: FIXTURE_PUBLISHER,
      ...(entries === undefined ? {} : { entries }),
    },
    claude: {
      marketplaces: {
        [FIXTURE_MARKETPLACE]: {
          owner: { name: 'Example' },
          plugins: [{ name: 'p', skills: '*' }],
        },
      },
    },
  };
}

/**
 * {@link SKILLS_PROJECT} plus one Claude marketplace, optionally carrying the
 * explicit `type` that is the only thing which makes a marketplace emittable.
 */
export function projectWithMarketplace(explicitType?: string): ProjectConfig {
  return marketplaceProject(
    explicitType === undefined ? undefined : { [FIXTURE_MARKETPLACE]: { type: explicitType } }
  );
}

/**
 * The same project, with the `ard.entries` map written out in full.
 *
 * Exists for the precedence cases, which need a BARE and a QUALIFIED key for the
 * one marketplace — the shape `projectWithMarketplace` cannot express, and the
 * shape nothing in the suite covered while two mutations reversing the
 * precedence stayed green.
 */
export function projectWithMarketplaceOverrides(
  entries: Record<string, ArdEntryOverrides>
): ProjectConfig {
  return marketplaceProject(entries);
}

/** The `ard.entries` key that names the fixture marketplace precisely. */
export const QUALIFIED_MARKETPLACE_KEY = `marketplace:${FIXTURE_MARKETPLACE}`;

/** The lines every ARD fixture shares: one discovered, published skill, then `ard.publisher`. */
const CONFIG_YAML_ARD_PREFIX = [
  'version: 1',
  'skills:',
  '  include: ["skills/**/SKILL.md"]',
  '  config:',
  `    ${PUBLISHED_SKILL}: {}`,
  'ard:',
  `  publisher: ${FIXTURE_PUBLISHER}`,
];

/** One config fixture: the shared prefix plus whatever `ard:` keys a case needs. */
function ardConfigYaml(...ardLines: readonly string[]): string {
  return [...CONFIG_YAML_ARD_PREFIX, ...ardLines, ''].join('\n');
}

/** The `ard.baseUrl` line every fixture that expects `url` entries carries. */
const BASE_URL_LINE = '  baseUrl: https://example.com/catalog';

/** Config YAML for a project with one published skill and an `ard:` block. */
export const CONFIG_YAML_WITH_ARD = ardConfigYaml(BASE_URL_LINE);

/** The dotted config key the removed-key fixture carries. */
export const REMOVED_RESOURCES_KEY = 'metadata';

/**
 * {@link CONFIG_YAML_WITH_ARD} plus a `resources:` block carrying a key VAT
 * removed from its schema in v0.1.16 and silently discarded for releases after.
 *
 * A real adopter still carries exactly this block, and when
 * `ResourcesConfigSchema` went strict it took `vat ard emit` down at config
 * load — a command that never reads `resources:` at all. The loader now warns
 * and continues; this fixture is what keeps that true for THIS command, which
 * has no other test touching a section it does not read.
 */
export const CONFIG_YAML_WITH_ARD_AND_REMOVED_KEY = [
  CONFIG_YAML_WITH_ARD,
  'resources:',
  `  ${REMOVED_RESOURCES_KEY}:`,
  '    frontmatter: true',
  '',
].join('\n');

/**
 * Config YAML whose `ard:` block has no `baseUrl`.
 *
 * The one shape that reaches a DERIVATION failure from a valid config: every
 * surface VAT collects carries a `urlPath` and no inline artifact document, so
 * without a base neither arm of ARD's `url` XOR `data` can be satisfied.
 */
export const CONFIG_YAML_ARD_WITHOUT_BASE_URL = ardConfigYaml();

/**
 * Config YAML declaring BOTH override keys for the one published skill.
 *
 * The qualified key wins and the bare block is never read — a fact the run has
 * to say out loud, since nothing else in the config tells the author their block
 * is dead.
 */
export const CONFIG_YAML_ARD_SHADOWED_KEYS = ardConfigYaml(
  BASE_URL_LINE,
  '  entries:',
  `    ${PUBLISHED_SKILL}:`,
  '      capabilities: ["FromBareKey"]',
  `    "skill:${PUBLISHED_SKILL}":`,
  '      capabilities: ["FromQualifiedKey"]'
);

/** Config YAML whose `ard.namespace` is a dot segment a URL resolver collapses. */
export const CONFIG_YAML_ARD_DOT_NAMESPACE = ardConfigYaml('  namespace: ".."', BASE_URL_LINE);

/** Config YAML for a project that never opted into ARD at all. */
export const CONFIG_YAML_WITHOUT_ARD = [
  'version: 1',
  'skills:',
  '  include: ["skills/**/SKILL.md"]',
  '',
].join('\n');

/** Write a project config into a fresh directory under `workDir`, and return it. */
export function projectWith(workDir: string, label: string, configYaml: string): string {
  const root = safePath.join(workDir, label);
  rmSync(root, { recursive: true, force: true });
  const real = mkdirSyncReal(root, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
  writeFileSync(safePath.join(real, CONFIG_FILENAME), configYaml, 'utf-8');
  return real;
}

/** Delete a project's config file, leaving the directory itself in place. */
export function removeConfigFile(root: string): void {
  rmSync(safePath.join(root, CONFIG_FILENAME), { force: true });
}

/**
 * {@link projectWith}, plus a real `SKILL.md` for {@link PUBLISHED_SKILL}.
 *
 * Separate from `projectWith` on purpose: the difference between the two is the
 * whole subject of the discovery cross-check, so a fixture that always planted
 * the file would make the "advertises a skill that is not there" case
 * unwritable.
 */
export function projectWithSkill(workDir: string, label: string, configYaml: string): string {
  const root = projectWith(workDir, label, configYaml);
  const skillDir = mkdirSyncReal(safePath.join(root, 'skills', PUBLISHED_SKILL), {
    recursive: true,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${PUBLISHED_SKILL}\ndescription: A fixture skill\n---\n\n# ${PUBLISHED_SKILL}\n`,
    'utf-8'
  );
  return root;
}
