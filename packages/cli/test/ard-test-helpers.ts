/**
 * Fixtures for the `vat ard` CLI suite.
 *
 * Extracted rather than repeated: two of the surface-collection cases differ
 * only in whether an `ard.entries` override is present, and jscpd runs against
 * a zero baseline (see `docs/writing-tests.md`).
 */

import { rmSync, writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';

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

/**
 * {@link SKILLS_PROJECT} plus one Claude marketplace, optionally carrying the
 * explicit `type` that is the only thing which makes a marketplace emittable.
 */
export function projectWithMarketplace(explicitType?: string): ProjectConfig {
  return {
    ...SKILLS_PROJECT,
    ard: {
      ...SKILLS_PROJECT.ard,
      publisher: FIXTURE_PUBLISHER,
      ...(explicitType === undefined
        ? {}
        : { entries: { [FIXTURE_MARKETPLACE]: { type: explicitType } } }),
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

/** Config YAML for a project with one published skill and an `ard:` block. */
export const CONFIG_YAML_WITH_ARD = [
  'version: 1',
  'skills:',
  '  include: ["skills/**/SKILL.md"]',
  '  config:',
  `    ${PUBLISHED_SKILL}: {}`,
  'ard:',
  `  publisher: ${FIXTURE_PUBLISHER}`,
  '  baseUrl: https://example.com/catalog',
  '',
].join('\n');

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
  writeFileSync(safePath.join(real, 'vibe-agent-toolkit.config.yaml'), configYaml, 'utf-8');
  return real;
}
