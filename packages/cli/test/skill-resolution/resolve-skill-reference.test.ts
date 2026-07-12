import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { resetSkillDiscoveryCache } from '../../src/skill-resolution/packaging-config.js';
import { resolveSkillReference } from '../../src/skill-resolution/resolve-skill-reference.js';

import { setupReferenceFixture } from './helpers.js';

const BUILDABLE = 'buildable';
const UNREACHABLE = 'unreachable';
const POOL_SKILL = 'my-pool-skill';
const PLUGIN_SKILL = 'my-plugin-skill';

describe('resolveSkillReference', () => {
  it('source-spec subject → source as-is', async () => {
    const r = await resolveSkillReference('npm:@s/x@1.0.0', process.cwd());
    expect(r).toEqual({ kind: 'source', source: { npm: '@s/x@1.0.0' } });
  });

  it('definite path → source as-is (never built)', async () => {
    const r = await resolveSkillReference('./dist/skills/whatever', process.cwd());
    expect(r).toEqual({ kind: 'source', source: { path: './dist/skills/whatever' } });
  });

  it('declared pool skill (bare name) → buildable, pool dist dir', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const r = await resolveSkillReference(POOL_SKILL, fx.root);
    expect(r.kind).toBe(BUILDABLE);
    if (r.kind !== 'buildable') throw new Error(UNREACHABLE);
    expect(r.distribution).toEqual({ kind: 'pool' });
    expect(r.expectedDistDir).toBe(fx.poolDistDir(POOL_SKILL));
    expect(r.sourcePath).toBe(fx.poolSkillMd(POOL_SKILL));
  });

  it('declared plugin-local skill → buildable, plugin output dir', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_SKILL] });
    resetSkillDiscoveryCache();
    const r = await resolveSkillReference(PLUGIN_SKILL, fx.root);
    expect(r.kind).toBe(BUILDABLE);
    if (r.kind !== 'buildable') throw new Error(UNREACHABLE);
    expect(r.distribution.kind).toBe('plugin-local');
    expect(r.expectedDistDir).toBe(fx.pluginDistDir(PLUGIN_SKILL));
  });

  it('bare name not declared, no governing config → not-found', async () => {
    const r = await resolveSkillReference('nonexistent-xyz', '/tmp');
    expect(r.kind).toBe('not-found');
  });

  it('bare name in project but undeclared and not a dir → name-miss', async () => {
    const fx = setupReferenceFixture({ pool: ['declared'] });
    resetSkillDiscoveryCache();
    const r = await resolveSkillReference('undeclared-name', fx.root);
    expect(r.kind).toBe('name-miss');
    if (r.kind !== 'name-miss') throw new Error(UNREACHABLE);
    expect(r.knownSkills).toContain('declared');
  });

  it('definite path AT a declared pool skill\'s dist → source WITH declaredSkill link', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const distPath = fx.poolDistDir(POOL_SKILL);
    const r = await resolveSkillReference(distPath, fx.root);
    expect(r.kind).toBe('source');
    if (r.kind !== 'source') throw new Error(UNREACHABLE);
    expect(r.source).toEqual({ path: distPath });
    expect(r.declaredSkill).toEqual({
      name: POOL_SKILL,
      configRoot: fx.root,
      sourcePath: fx.poolSkillMd(POOL_SKILL),
      expectedDistDir: distPath,
    });
  });

  it('definite path AT a declared plugin-local skill\'s dist → declaredSkill link', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_SKILL] });
    resetSkillDiscoveryCache();
    const distPath = fx.pluginDistDir(PLUGIN_SKILL);
    const r = await resolveSkillReference(distPath, fx.root);
    expect(r.kind).toBe('source');
    if (r.kind !== 'source') throw new Error(UNREACHABLE);
    expect(r.declaredSkill?.name).toBe(PLUGIN_SKILL);
    expect(r.declaredSkill?.expectedDistDir).toBe(distPath);
  });

  it('definite path NOT matching any declared dist → source, no declaredSkill link', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const r = await resolveSkillReference(safePath.join(fx.root, 'dist', 'skills', 'not-a-skill'), fx.root);
    expect(r.kind).toBe('source');
    if (r.kind !== 'source') throw new Error(UNREACHABLE);
    expect(r.declaredSkill).toBeUndefined();
  });
});
