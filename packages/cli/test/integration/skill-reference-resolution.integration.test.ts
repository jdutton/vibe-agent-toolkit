/**
 * Integration tests for {@link resolveSkillReference} against synthetic temp
 * projects (no mocks). Exercises the full disambiguation ladder end-to-end —
 * config discovery, the per-skill packaging-config walk-up, and pool vs
 * plugin-local distribution/`expectedDistDir` derivation — plus audit/review
 * migration parity for the shared `resolveSkillPackagingConfig` /
 * `stripValidationAllowForDisplay` pair.
 *
 * Fixtures are synthetic (reuse the prior-wave `setupReferenceFixture` helper);
 * never a real adopter skill.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- tests read/write synthetic fixtures at dynamic temp paths */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  resetSkillDiscoveryCache,
  resolveSkillPackagingConfig,
  stripValidationAllowForDisplay,
} from '../../src/skill-resolution/packaging-config.js';
import { resolveSkillReference } from '../../src/skill-resolution/resolve-skill-reference.js';
import { setupReferenceFixture } from '../skill-resolution/helpers.js';

const POOL_SKILL = 'my-pool-skill';
const PLUGIN_SKILL = 'my-plugin-skill';

const createdRoots: string[] = [];

/** Build a synthetic fixture and remember its root for afterEach cleanup. */
function fixture(spec: Parameters<typeof setupReferenceFixture>[0]): ReturnType<typeof setupReferenceFixture> {
  const fx = setupReferenceFixture(spec);
  createdRoots.push(fx.root);
  return fx;
}

/**
 * Mutate the helper-generated config's `skills:` block in place (parse → mutate
 * → re-stringify) so a fixture can declare per-skill `config`/`defaults` blocks
 * the helper does not write. Keeps the helper's marketplace/include structure.
 */
function augmentSkillsConfig(root: string, mutate: (skills: Record<string, unknown>) => void): void {
  const file = safePath.join(root, 'vibe-agent-toolkit.config.yaml');
  const doc = parseYaml(readFileSync(file, 'utf8')) as { skills?: Record<string, unknown> };
  doc.skills ??= {};
  mutate(doc.skills);
  writeFileSync(file, stringifyYaml(doc));
}

beforeEach(() => {
  resetSkillDiscoveryCache();
});

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveSkillReference (integration, synthetic temp projects)', () => {
  it('declared pool skill (bare name) → buildable, pool distribution, dist/skills/ dir', async () => {
    const fx = fixture({ pool: [POOL_SKILL] });

    const r = await resolveSkillReference(POOL_SKILL, fx.root);

    expect(r.kind).toBe('buildable');
    if (r.kind !== 'buildable') throw new Error('unreachable');
    expect(r.distribution).toEqual({ kind: 'pool' });
    expect(toForwardSlash(r.expectedDistDir)).toBe(toForwardSlash(fx.poolDistDir(POOL_SKILL)));
    expect(toForwardSlash(r.expectedDistDir)).toContain(`/dist/skills/${POOL_SKILL}`);
    expect(toForwardSlash(r.sourcePath)).toBe(toForwardSlash(fx.poolSkillMd(POOL_SKILL)));
    expect(r.packagingConfig).toBeDefined();
  });

  it('declared plugin-local-with-files skill → buildable, plugin-local distribution, tree-copied output dir', async () => {
    const fx = fixture({ pluginLocal: [PLUGIN_SKILL] });
    // Fabricate the plugin-local-with-files shape: a skills.config.<name>.files entry.
    augmentSkillsConfig(fx.root, (skills) => {
      skills['config'] = {
        [PLUGIN_SKILL]: { files: [{ source: 'extra.txt', dest: 'extra.txt' }] },
      };
    });

    const r = await resolveSkillReference(PLUGIN_SKILL, fx.root);

    expect(r.kind).toBe('buildable');
    if (r.kind !== 'buildable') throw new Error('unreachable');
    expect(r.distribution.kind).toBe('plugin-local');
    if (r.distribution.kind !== 'plugin-local') throw new Error('unreachable');
    expect(r.distribution.skillDirName).toBe(PLUGIN_SKILL);
    expect(r.distribution.marketplaceName).toBe('fixture-mp');
    expect(r.distribution.pluginName).toBe('fixture-plug');
    // expectedDistDir is exactly the computeTreeCopiedSkillLocations skillOutputDir.
    expect(toForwardSlash(r.expectedDistDir)).toBe(toForwardSlash(fx.pluginDistDir(PLUGIN_SKILL)));
    // The per-skill files entry flows through the merge into packagingConfig.
    expect(r.packagingConfig.files).toEqual([{ source: 'extra.txt', dest: 'extra.txt' }]);
  });

  it('bare name of an undeclared but existing directory → source { path }', async () => {
    const fx = fixture({ pool: ['declared-skill'] });
    mkdirSyncReal(safePath.join(fx.root, 'some-tool'), { recursive: true });

    const r = await resolveSkillReference('some-tool', fx.root);

    expect(r).toEqual({ kind: 'source', source: { path: 'some-tool' } });
  });

  it('bare name miss in a project → name-miss with sorted knownSkills', async () => {
    const fx = fixture({ pool: ['beta-skill', 'alpha-skill'] });

    const r = await resolveSkillReference('undeclared-name', fx.root);

    expect(r.kind).toBe('name-miss');
    if (r.kind !== 'name-miss') throw new Error('unreachable');
    expect(r.name).toBe('undeclared-name');
    expect(toForwardSlash(r.configRoot)).toBe(toForwardSlash(fx.root));
    expect(r.knownSkills).toEqual(['alpha-skill', 'beta-skill']);
  });

  it('audit/review parity: shared resolver returns the defaults+per-skill merge; strip-allow is audit-only', async () => {
    const fx = fixture({ pool: ['parity-skill'] });
    augmentSkillsConfig(fx.root, (skills) => {
      skills['defaults'] = { stripPrefix: 'team-', linkFollowDepth: 1 };
      skills['config'] = {
        'parity-skill': {
          linkFollowDepth: 2,
          validation: {
            severity: { SKILL_LENGTH_EXCEEDS_RECOMMENDED: 'warning' },
            allow: { PACKAGED_UNREFERENCED_FILE: [{ reason: 'consumed at runtime' }] },
          },
        },
      };
    });

    // Review view: full merge keeps validation.allow.
    const full = await resolveSkillPackagingConfig(fx.poolSkillMd('parity-skill'));
    expect(full).not.toBeNull();
    if (full === null) throw new Error('unreachable');
    // defaults + per-skill merge: defaults-only field flows through, per-skill wins on linkFollowDepth.
    expect(full.stripPrefix).toBe('team-');
    expect(full.linkFollowDepth).toBe(2);
    expect(full.validation).toEqual({
      severity: { SKILL_LENGTH_EXCEEDS_RECOMMENDED: 'warning' },
      allow: { PACKAGED_UNREFERENCED_FILE: [{ paths: ['**/*'], reason: 'consumed at runtime' }] },
    });

    // Audit view: strip-allow drops validation.allow but keeps validation.severity.
    const display = stripValidationAllowForDisplay(full);
    expect(display.stripPrefix).toBe('team-');
    expect(display.linkFollowDepth).toBe(2);
    expect(display.validation).toEqual({ severity: { SKILL_LENGTH_EXCEEDS_RECOMMENDED: 'warning' } });
    expect('allow' in (display.validation ?? {})).toBe(false);
  });
});
