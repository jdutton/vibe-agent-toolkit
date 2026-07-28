/**
 * Unit tests for staging.ts — the harness staging flow.
 *
 * `stageHarness` takes a dependency-injected `resolve` so the full staging flow
 * (incl. the module-private `stageOneItem` and `readExistingManifest`) is
 * exercised with a FAKE resolve that returns a prepared temp dir — no network,
 * no process spawning. Real fs is used throughout.
 *
 * Mode/uid assertions are platform-guarded the same way production is
 * (`process.platform !== 'win32'`).
 */

/* eslint-disable security/detect-non-literal-fs-filename -- tests use controlled temp directories */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type {
  ResolveSkillSourceContext,
  ResolvedSkillSource,
  SkillSource,
  StageItem,
} from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import {
  computeDirContentHash,
  descriptorToSource,
  stageHarness,
} from '../../src/skill-test/staging.js';
import { setupTempDir } from '../test-helpers.js';

const currentUid = process.getuid?.() ?? 0;
const MANIFEST_FILE = 'staged.manifest.json';
const SKILL_FILE = 'SKILL.md';
const SUBJECT_NAME = 'foo';
const CLAUDE_PLUGIN_DIR = '.claude-plugin';
const PLUGIN_JSON = 'plugin.json';
const REL_SKILL_PATH = 'skills/foo';
const FAKE_IDENTITY = 'fake-identity';

type StageHarnessResolve = (
  source: SkillSource,
  ctx: ResolveSkillSourceContext,
) => Promise<ResolvedSkillSource>;

/** A no-op resolution context — staging never reads these in the flat/plugin paths. */
const CTX: ResolveSkillSourceContext = {
  repoRoot: '/unused',
  // The OS temp dir, NOT a placeholder: every fixture below lives under it, and the
  // fake resolver hands back the fixture path as its "staged" dir. Eval-suite
  // isolation refuses to delete from anything outside the staging root (a guard
  // against a future resolver handing back the user's real source tree), so this has
  // to describe where the fake actually stages. See eval-suite-isolation.ts.
  stagingRoot: normalizedTmpdir(),
  fetchCacheDir: '/unused',
};

/**
 * Eval-suite isolation inputs required by every `stageHarness` call. `writeSourceSkill`
 * fixtures DO carry `evals/evals.json`, so these calls genuinely exercise the strip:
 * the subject's suite is relocated into the hold dir and every staged tree loses it.
 */
const EVAL_HOLD_DIR = safePath.join(normalizedTmpdir(), `vat-staging-hold-${randomBytes(6).toString('hex')}`);
const EVAL_ISOLATION = { evalsSubpath: 'evals/evals.json', evalSuiteHoldDir: EVAL_HOLD_DIR };

afterAll(() => {
  rmSync(EVAL_HOLD_DIR, { recursive: true, force: true });
});

/** Create a fresh 0700 harness root under the OS tmp dir (assertSafeHarnessRoot passes). */
function makeHarnessRoot(): string {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const dir = safePath.join(normalizedTmpdir(), `vat-staging-test-${suffix}`);
  mkdirSyncReal(dir, { mode: 0o700 });
  return dir;
}

/** A fake `resolve` that returns the given staged dir + identity, ignoring its source. */
function fakeResolve(stagedDir: string, identity: string): StageHarnessResolve {
  return async () => ({ stagedDir, identity });
}

/** Write a minimal source skill dir (SKILL.md + evals/evals.json) and return its path. */
function writeSourceSkill(base: string): string {
  const dir = safePath.join(base, 'src-skill');
  mkdirSyncReal(safePath.join(dir, 'evals'), { recursive: true });
  writeFileSync(safePath.join(dir, SKILL_FILE), `---\nname: foo\n---\nsubject body\n`);
  writeFileSync(safePath.join(dir, 'evals', 'evals.json'), '{"cases":[]}\n');
  return dir;
}

/** Build a dir tree from a {relPath: bytes} map and return its absolute path. */
function buildTree(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = safePath.join(root, rel);
    mkdirSyncReal(safePath.join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/**
 * Build a real plugin dir (with `.claude-plugin/plugin.json`) and return its root.
 * `parent`/`manifestName` let callers create two plugins that share the SAME
 * directory basename (`my-plugin`) under different parents, with distinct manifest
 * contents — the setup for the basename-collision regression test.
 */
function writePluginRoot(base: string, parent = '.', manifestName = 'my-plugin'): string {
  const root = safePath.join(base, parent, 'my-plugin');
  mkdirSyncReal(safePath.join(root, CLAUDE_PLUGIN_DIR), { recursive: true });
  writeFileSync(
    safePath.join(root, CLAUDE_PLUGIN_DIR, PLUGIN_JSON),
    JSON.stringify({ name: manifestName }) + '\n',
  );
  return root;
}

/** Run a single flat stage for SUBJECT_NAME against a shared harness root. */
async function stageFlat(
  harnessRoot: string,
  sourceDir: string,
  identity = FAKE_IDENTITY,
): Promise<ResolvedHarness> {
  const items: StageItem[] = [{ name: SUBJECT_NAME, source: { path: sourceDir }, role: 'subject' }];
  return stageHarness({ harnessRoot, items, resolve: fakeResolve(sourceDir, identity), ctx: CTX, currentUid, ...EVAL_ISOLATION });
}

type ResolvedHarness = Awaited<ReturnType<typeof stageHarness>>;

describe('computeDirContentHash', () => {
  const { getTempDir } = setupTempDir('vat-staging-hash-');

  it('is stable across repeated calls on the same tree', () => {
    const dir = buildTree(safePath.join(getTempDir(), 'tree'), { 'a.txt': 'alpha', 'sub/b.txt': 'beta' });
    expect(computeDirContentHash(dir)).toBe(computeDirContentHash(dir));
  });

  it("changes when a file's bytes change", () => {
    const before = buildTree(safePath.join(getTempDir(), 'v1'), { 'a.txt': 'alpha' });
    const hashBefore = computeDirContentHash(before);
    writeFileSync(safePath.join(before, 'a.txt'), 'ALPHA');
    expect(computeDirContentHash(before)).not.toBe(hashBefore);
  });

  it('is order-independent: identical content yields identical hash', () => {
    const first = buildTree(safePath.join(getTempDir(), 'first'), {
      'a.txt': 'alpha',
      'sub/b.txt': 'beta',
      'c.txt': 'gamma',
    });
    // Same content created in a different insertion order → same hash.
    const reordered = buildTree(safePath.join(getTempDir(), 'second'), {
      'c.txt': 'gamma',
      'a.txt': 'alpha',
      'sub/b.txt': 'beta',
    });
    expect(computeDirContentHash(first)).toBe(computeDirContentHash(reordered));
  });
});

describe('descriptorToSource', () => {
  it('returns the descriptor unchanged', () => {
    const d: SkillSourceDescriptor = { path: '/some/skill' };
    expect(descriptorToSource(d)).toBe(d);
  });
});

describe('stageHarness — flat (standalone) path', () => {
  const { getTempDir } = setupTempDir('vat-staging-flat-');

  it('copies the source into a fresh staged dest and writes the manifest', async () => {
    const sourceDir = writeSourceSkill(getTempDir());
    const harnessRoot = makeHarnessRoot();

    const result = await stageFlat(harnessRoot, sourceDir);

    const stagedDir = result.subjectStagedDir as string;
    // subjectStagedDir is the staged COPY, not the source.
    expect(result.subjectStagedDir).not.toBeNull();
    expect(toForwardSlash(stagedDir)).not.toBe(toForwardSlash(sourceDir));
    expect(toForwardSlash(stagedDir)).toBe(toForwardSlash(result.pluginDirs[0] as string));
    expect(result.subjectPluginRoot).toBeNull();
    expect(result.pluginDirs).toHaveLength(1);

    // The staged dest actually contains the copied SKILL.md.
    expect(existsSync(safePath.join(stagedDir, SKILL_FILE))).toBe(true);

    // Manifest written under harnessRoot with a fingerprint + one entry.
    expect(existsSync(safePath.join(harnessRoot, MANIFEST_FILE))).toBe(true);
    expect(result.manifest.fingerprint.length).toBeGreaterThan(0);
    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.entries[0]?.name).toBe(SUBJECT_NAME);
    expect(result.manifest.entries[0]?.identity).toBe(FAKE_IDENTITY);
  });
});

describe('stageHarness — plugin-layout path', () => {
  const { getTempDir } = setupTempDir('vat-staging-plugin-');

  it('recreates the plugin-root layout and nests the skill under relPathUnderPlugin', async () => {
    const tmp = getTempDir();
    const pluginRoot = writePluginRoot(tmp);
    const sourceDir = writeSourceSkill(tmp);
    const harnessRoot = makeHarnessRoot();
    const items: StageItem[] = [
      {
        name: SUBJECT_NAME,
        source: { path: sourceDir },
        role: 'subject',
        pluginLayout: { pluginRoot, relPathUnderPlugin: REL_SKILL_PATH },
      },
    ];

    const result = await stageHarness({
      harnessRoot,
      items,
      resolve: fakeResolve(sourceDir, 'plugin-identity'),
      ctx: CTX,
      currentUid,
      ...EVAL_ISOLATION,
    });

    expect(result.subjectPluginRoot).not.toBeNull();
    const stagedPluginRoot = result.subjectPluginRoot as string;

    // The staged plugin root holds `.claude-plugin/`.
    expect(existsSync(safePath.join(stagedPluginRoot, CLAUDE_PLUGIN_DIR, PLUGIN_JSON))).toBe(true);

    // The skill is copied under the nested slot, and subjectStagedDir points there.
    const nested = safePath.join(stagedPluginRoot, 'skills', 'foo');
    expect(toForwardSlash(result.subjectStagedDir as string)).toBe(toForwardSlash(nested));
    expect(existsSync(safePath.join(nested, SKILL_FILE))).toBe(true);

    // The pushed plugin dir is the plugin root (not the nested skill dir).
    expect(toForwardSlash(result.pluginDirs[0] as string)).toBe(toForwardSlash(stagedPluginRoot));
  });
});

describe('stageHarness — plugin basename collision', () => {
  const { getTempDir } = setupTempDir('vat-staging-collision-');

  it('stages two plugins sharing a dir basename into DISTINCT roots (no cross-wiring)', async () => {
    const tmp = getTempDir();
    // Two DIFFERENT plugins that share the basename `my-plugin` (…/a/my-plugin and
    // …/b/my-plugin) with distinct manifests. Keyed on basename alone they would
    // collide onto one staged root; keyed on the full path they must stay separate.
    const pluginA = writePluginRoot(tmp, 'a', 'plugin-a');
    const pluginB = writePluginRoot(tmp, 'b', 'plugin-b');
    const skillA = writeSourceSkill(safePath.join(tmp, 'a'));
    const skillB = writeSourceSkill(safePath.join(tmp, 'b'));
    const harnessRoot = makeHarnessRoot();

    const items: StageItem[] = [
      {
        name: 'foo-a',
        source: { path: skillA },
        role: 'subject',
        pluginLayout: { pluginRoot: pluginA, relPathUnderPlugin: REL_SKILL_PATH },
      },
      {
        name: 'foo-b',
        source: { path: skillB },
        pluginLayout: { pluginRoot: pluginB, relPathUnderPlugin: REL_SKILL_PATH },
      },
    ];

    const resolve: StageHarnessResolve = async (source) => {
      const p = 'path' in source ? source.path : '';
      if (p === skillA) return { stagedDir: skillA, identity: 'id-a' };
      if (p === skillB) return { stagedDir: skillB, identity: 'id-b' };
      throw new Error(`unexpected source: ${p}`);
    };

    const result = await stageHarness({ harnessRoot, items, resolve, ctx: CTX, currentUid, ...EVAL_ISOLATION });

    // Two distinct staged plugin roots — no collision.
    const [rootA, rootB] = result.pluginDirs;
    expect(toForwardSlash(rootA as string)).not.toBe(toForwardSlash(rootB as string));
    expect(result.pluginDirs).toHaveLength(2);

    // Each staged manifest carries ITS OWN plugin name — proving neither item's
    // `.claude-plugin/` clobbered the other's onto a shared root.
    const nameOf = (root: string): string =>
      JSON.parse(readFileSync(safePath.join(root, CLAUDE_PLUGIN_DIR, PLUGIN_JSON), 'utf8')).name;
    expect(nameOf(rootA as string)).toBe('plugin-a');
    expect(nameOf(rootB as string)).toBe('plugin-b');
  });
});

/**
 * A `resolve` that succeeds ONLY for `okSource` (returning `okStagedDir` under
 * `okIdentity`) and throws `cannot resolve: <path>` for anything else — the
 * shared stub for the optional-vs-required resolve-failure tests below.
 */
function resolveOnlyKnown(okSource: string, okStagedDir: string, okIdentity: string): StageHarnessResolve {
  return async (source) => {
    const p = 'path' in source ? source.path : '';
    if (p === okSource) return { stagedDir: okStagedDir, identity: okIdentity };
    throw new Error(`cannot resolve: ${p}`);
  };
}

/**
 * Build a subject + one `companion` staging setup whose `resolve` succeeds only
 * for the subject — so the companion's source (`UNRESOLVABLE_SOURCE`) always
 * throws. Shared by the optional-skip vs required-propagate tests below.
 */
function stagingWithFailingCompanion(
  getTempDir: () => string,
  companion: StageItem,
): { harnessRoot: string; items: StageItem[]; resolve: StageHarnessResolve } {
  const sourceDir = writeSourceSkill(getTempDir());
  const items: StageItem[] = [
    { name: SUBJECT_NAME, source: { path: sourceDir }, role: 'subject' },
    companion,
  ];
  return { harnessRoot: makeHarnessRoot(), items, resolve: resolveOnlyKnown(sourceDir, sourceDir, FAKE_IDENTITY) };
}

describe('stageHarness — optional item resolve failure (skip-with-warning)', () => {
  const { getTempDir } = setupTempDir('vat-staging-optional-');
  const UNRESOLVABLE_SOURCE = '/does/not/matter';

  it('skips an optional item whose resolve throws: name in skippedOptional, absent from pluginDirs, staging completes', async () => {
    const { harnessRoot, items, resolve } = stagingWithFailingCompanion(getTempDir, {
      name: 'flaky-optional',
      source: { path: UNRESOLVABLE_SOURCE },
      optional: true,
    });

    const result = await stageHarness({ harnessRoot, items, resolve, ctx: CTX, currentUid, ...EVAL_ISOLATION });

    expect(result.skippedOptional).toEqual(['flaky-optional']);
    expect(result.pluginDirs).toHaveLength(1);
    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.entries[0]?.name).toBe(SUBJECT_NAME);
    expect(result.subjectStagedDir).not.toBeNull();
  });

  it('propagates a resolve throw for a REQUIRED (non-optional) item', async () => {
    const { harnessRoot, items, resolve } = stagingWithFailingCompanion(getTempDir, {
      name: 'required-companion',
      source: { path: UNRESOLVABLE_SOURCE },
    });

    await expect(stageHarness({ harnessRoot, items, resolve, ctx: CTX, currentUid, ...EVAL_ISOLATION })).rejects.toThrow(
      'cannot resolve',
    );
  });

  it('stages a RESOLVABLE optional companion: present in pluginDirs + entries, nothing skipped', async () => {
    const subjectDir = writeSourceSkill(getTempDir());
    const optionalDir = writeSourceSkill(safePath.join(getTempDir(), 'opt'));
    const items: StageItem[] = [
      { name: SUBJECT_NAME, source: { path: subjectDir }, role: 'subject' },
      { name: 'good-optional', source: { path: optionalDir }, optional: true },
    ];
    const resolve: StageHarnessResolve = async (source) => {
      const p = 'path' in source ? source.path : '';
      if (p === subjectDir) return { stagedDir: subjectDir, identity: FAKE_IDENTITY };
      if (p === optionalDir) return { stagedDir: optionalDir, identity: 'opt-identity' };
      throw new Error(`cannot resolve: ${p}`);
    };

    const result = await stageHarness({ harnessRoot: makeHarnessRoot(), items, resolve, ctx: CTX, currentUid, ...EVAL_ISOLATION });

    expect(result.skippedOptional).toEqual([]);
    expect(result.pluginDirs).toHaveLength(2);
    expect(result.manifest.entries.map((e) => e.name)).toEqual([SUBJECT_NAME, 'good-optional']);
  });
});

describe('stageHarness — manifest re-stage behavior (readExistingManifest)', () => {
  const { getTempDir } = setupTempDir('vat-staging-manifest-');

  it('succeeds on a second run after the first wrote a manifest', async () => {
    const sourceDir = writeSourceSkill(getTempDir());
    const harnessRoot = makeHarnessRoot();

    await stageFlat(harnessRoot, sourceDir);
    // Second run reads the existing manifest then fully re-stages — must not throw.
    const second = await stageFlat(harnessRoot, sourceDir);
    expect(second.manifest.entries).toHaveLength(1);
    expect(existsSync(safePath.join(harnessRoot, MANIFEST_FILE))).toBe(true);
  });

  it('treats a corrupt manifest as null and re-stages without throwing', async () => {
    const sourceDir = writeSourceSkill(getTempDir());
    const harnessRoot = makeHarnessRoot();

    await stageFlat(harnessRoot, sourceDir);
    // Corrupt the manifest to invalid JSON → readExistingManifest returns null.
    writeFileSync(safePath.join(harnessRoot, MANIFEST_FILE), '{ not json');

    const result = await stageFlat(harnessRoot, sourceDir);
    expect(result.manifest.entries).toHaveLength(1);
    // The corrupt file is overwritten with a valid manifest.
    const reparsed = JSON.parse(readFileSync(safePath.join(harnessRoot, MANIFEST_FILE), 'utf8'));
    expect(reparsed.entries).toHaveLength(1);
  });
});
