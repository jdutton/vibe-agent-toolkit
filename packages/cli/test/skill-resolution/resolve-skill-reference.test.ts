import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { resetSkillDiscoveryCache } from '../../src/skill-resolution/packaging-config.js';
import {
  findDeclaredSkillForSourceDir,
  resolveSkillReference,
} from '../../src/skill-resolution/resolve-skill-reference.js';

import { setupReferenceFixture, type ReferenceFixture } from './helpers.js';

const BUILDABLE = 'buildable';
const UNREACHABLE = 'unreachable';
const POOL_SKILL = 'my-pool-skill';
const PLUGIN_SKILL = 'my-plugin-skill';
const PLUGIN_LOCAL = 'plugin-local';
const UNDECLARED_DIR = 'not-a-skill-dir';

/** The `buildable` shape a declared skill's reference must resolve to. */
interface BuildableExpectation {
  name: string;
  distributionKind: string;
  distDir: string;
}

/**
 * Shared assertion for "resolved to `buildable` for this declared skill" — the shape
 * EVERY spelling of that skill's reference (bare name, definite path, `path:<dir>`)
 * must produce identically: a path is not a second, weaker way to reach the same
 * declared skill.
 */
function expectBuildableSkill(
  r: Awaited<ReturnType<typeof resolveSkillReference>>,
  expected: BuildableExpectation,
): void {
  expect(r.kind).toBe(BUILDABLE);
  if (r.kind !== 'buildable') throw new Error(UNREACHABLE);
  expect(r.name).toBe(expected.name);
  expect(r.distribution.kind).toBe(expected.distributionKind);
  expect(r.expectedDistDir).toBe(expected.distDir);
}

/** Expectation for the fixture's declared POOL skill. */
function poolExpectation(fx: ReferenceFixture): BuildableExpectation {
  return { name: POOL_SKILL, distributionKind: 'pool', distDir: fx.poolDistDir(POOL_SKILL) };
}

/** Expectation for the fixture's declared PLUGIN-LOCAL skill. */
function pluginLocalExpectation(fx: ReferenceFixture): BuildableExpectation {
  return { name: PLUGIN_SKILL, distributionKind: PLUGIN_LOCAL, distDir: fx.pluginDistDir(PLUGIN_SKILL) };
}

/** Shared assertion for "plain, config-blind `source` at `dir`" (no declaredSkill link). */
function expectPlainSource(
  r: Awaited<ReturnType<typeof resolveSkillReference>>,
  dir: string,
): void {
  expect(r.kind).toBe('source');
  if (r.kind !== 'source') throw new Error(UNREACHABLE);
  expect(r.source).toEqual({ path: dir });
  expect(r.declaredSkill).toBeUndefined();
}

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
    expectBuildableSkill(r, pluginLocalExpectation(fx));
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

  // A definite path AT a declared skill's SOURCE dir must resolve the
  // SAME way the bare-name form does — buildable — so a real run BUILDS it (files:
  // injection included) instead of tree-copying raw source. Matches the companion
  // contract #159 already gives `resolveCompanionSpec`'s `findDeclaredSkillForSourceDir`
  // call; this is the subject side of the same fix.
  it('definite path AT a declared pool skill\'s SOURCE dir → buildable (was source), files: honored', async () => {
    const fx = setupReferenceFixture({
      pool: [POOL_SKILL],
      skillFiles: { [POOL_SKILL]: [{ source: 'extra.txt', dest: 'extra.txt' }] },
      sourceFiles: { 'extra.txt': 'extra fixture content\n' },
    });
    resetSkillDiscoveryCache();
    const sourceDir = dirname(fx.poolSkillMd(POOL_SKILL));
    const r = await resolveSkillReference(sourceDir, fx.root);
    expectBuildableSkill(r, poolExpectation(fx));
    if (r.kind !== 'buildable') throw new Error(UNREACHABLE);
    expect(r.packagingConfig.files).toEqual([{ source: 'extra.txt', dest: 'extra.txt' }]);
  });

  it('definite path AT a declared plugin-local skill\'s SOURCE dir → buildable, plugin dist dir', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_SKILL] });
    resetSkillDiscoveryCache();
    const sourceDir = safePath.join(fx.root, 'plugins', 'fixture-plug', 'skills', PLUGIN_SKILL);
    const r = await resolveSkillReference(sourceDir, fx.root);
    expectBuildableSkill(r, pluginLocalExpectation(fx));
  });

  it('definite path at a SOURCE dir matching no declared skill → still source (undeclared local dir)', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const undeclaredDir = safePath.join(fx.root, UNDECLARED_DIR);
    const r = await resolveSkillReference(undeclaredDir, fx.root);
    expectPlainSource(r, undeclaredDir);
  });

  // The `path:` prefix only disambiguates a path from a bare name — it is not a
  // build directive (`--no-build` is). Spelling the same directory two ways must
  // therefore reach the same rung: at a declared skill's source dir, `buildable`.
  it('path:<dir> AT a declared skill\'s SOURCE dir → buildable, exactly like the unprefixed path', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const sourceDir = dirname(fx.poolSkillMd(POOL_SKILL));
    const r = await resolveSkillReference(`path:${sourceDir}`, fx.root);
    expectBuildableSkill(r, poolExpectation(fx));
  });

  it('path:<dir> at an UNdeclared dir → source, with the prefix stripped from the path', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const undeclaredDir = safePath.join(fx.root, UNDECLARED_DIR);
    const r = await resolveSkillReference(`path:${undeclaredDir}`, fx.root);
    expectPlainSource(r, undeclaredDir);
  });

  // Negative control: the re-route is scoped to `path:` alone. The other source
  // specs are not paths into the project tree, so they are never matched against
  // declared skills — even when their value happens to spell one.
  it('npm:/url:/workspace:/vendored are unaffected — passed through verbatim', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const sourceDir = dirname(fx.poolSkillMd(POOL_SKILL));

    expect(await resolveSkillReference(`workspace:${sourceDir}`, fx.root)).toEqual({
      kind: 'source', source: { workspace: sourceDir },
    });
    expect(await resolveSkillReference(`npm:${sourceDir}`, fx.root)).toEqual({
      kind: 'source', source: { npm: sourceDir },
    });
    expect(await resolveSkillReference(`url:${sourceDir}`, fx.root)).toEqual({
      kind: 'source', source: { url: sourceDir },
    });
    expect(await resolveSkillReference('vendored', fx.root)).toEqual({
      kind: 'source', source: { vendored: true },
    });
  });
});

// Issue #158: a `--with`/`--with-optional` companion given as `path:<source-dir>`
// has no bare-name grammar to hit the `buildable` rung, so findDeclaredSkillForSourceDir
// is the forward (source-dir) counterpart of findDeclaredSkillForPath's reverse
// (dist-dir) lookup — letting a companion get the same build treatment as the subject.
describe('findDeclaredSkillForSourceDir', () => {
  it('a path AT a declared pool skill\'s SOURCE dir → buildable, matching the bare-name resolution', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const sourceDir = dirname(fx.poolSkillMd(POOL_SKILL));
    const r = await findDeclaredSkillForSourceDir(sourceDir, fx.root);
    expect(r?.kind).toBe(BUILDABLE);
    expect(r?.name).toBe(POOL_SKILL);
    expect(r?.sourcePath).toBe(fx.poolSkillMd(POOL_SKILL));
    expect(r?.expectedDistDir).toBe(fx.poolDistDir(POOL_SKILL));
  });

  it('a path AT a declared plugin-local skill\'s SOURCE dir → buildable, plugin dist dir', async () => {
    const fx = setupReferenceFixture({ pluginLocal: [PLUGIN_SKILL] });
    resetSkillDiscoveryCache();
    const sourceDir = safePath.join(fx.root, 'plugins', 'fixture-plug', 'skills', PLUGIN_SKILL);
    const r = await findDeclaredSkillForSourceDir(sourceDir, fx.root);
    expect(r?.kind).toBe(BUILDABLE);
    expect(r?.distribution.kind).toBe(PLUGIN_LOCAL);
    expect(r?.expectedDistDir).toBe(fx.pluginDistDir(PLUGIN_SKILL));
  });

  it('a relative path resolved against the given base dir also matches', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const r = await findDeclaredSkillForSourceDir(safePath.join('skills', POOL_SKILL), fx.root);
    expect(r?.name).toBe(POOL_SKILL);
  });

  it('a path NOT matching any declared skill\'s source dir → undefined (outside config, left alone)', async () => {
    const fx = setupReferenceFixture({ pool: [POOL_SKILL] });
    resetSkillDiscoveryCache();
    const r = await findDeclaredSkillForSourceDir(safePath.join(fx.root, UNDECLARED_DIR), fx.root);
    expect(r).toBeUndefined();
  });

  it('a path with no governing config → undefined', async () => {
    const r = await findDeclaredSkillForSourceDir('definitely-not-a-vat-project', '/tmp');
    expect(r).toBeUndefined();
  });
});
