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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type {
  ResolveSkillSourceContext,
  ResolvedSkillSource,
  SkillSource,
  StageItem,
} from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

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

type StageHarnessResolve = (
  source: SkillSource,
  ctx: ResolveSkillSourceContext,
) => Promise<ResolvedSkillSource>;

/** A no-op resolution context — staging never reads these in the flat/plugin paths. */
const CTX: ResolveSkillSourceContext = {
  repoRoot: '/unused',
  stagingRoot: '/unused',
  fetchCacheDir: '/unused',
};

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

/** Build a real plugin dir (with `.claude-plugin/plugin.json`) and return its root. */
function writePluginRoot(base: string): string {
  const root = safePath.join(base, 'my-plugin');
  mkdirSyncReal(safePath.join(root, CLAUDE_PLUGIN_DIR), { recursive: true });
  writeFileSync(
    safePath.join(root, CLAUDE_PLUGIN_DIR, 'plugin.json'),
    JSON.stringify({ name: 'my-plugin' }) + '\n',
  );
  return root;
}

/** Run a single flat stage for SUBJECT_NAME against a shared harness root. */
async function stageFlat(
  harnessRoot: string,
  sourceDir: string,
  identity = 'fake-identity',
): Promise<ResolvedHarness> {
  const items: StageItem[] = [{ name: SUBJECT_NAME, source: { path: sourceDir }, role: 'subject' }];
  return stageHarness({ harnessRoot, items, resolve: fakeResolve(sourceDir, identity), ctx: CTX, currentUid });
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
    expect(result.manifest.entries[0]?.identity).toBe('fake-identity');
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
        pluginLayout: { pluginRoot, relPathUnderPlugin: 'skills/foo' },
      },
    ];

    const result = await stageHarness({
      harnessRoot,
      items,
      resolve: fakeResolve(sourceDir, 'plugin-identity'),
      ctx: CTX,
      currentUid,
    });

    expect(result.subjectPluginRoot).not.toBeNull();
    const stagedPluginRoot = result.subjectPluginRoot as string;

    // The staged plugin root holds `.claude-plugin/`.
    expect(existsSync(safePath.join(stagedPluginRoot, CLAUDE_PLUGIN_DIR, 'plugin.json'))).toBe(true);

    // The skill is copied under the nested slot, and subjectStagedDir points there.
    const nested = safePath.join(stagedPluginRoot, 'skills', 'foo');
    expect(toForwardSlash(result.subjectStagedDir as string)).toBe(toForwardSlash(nested));
    expect(existsSync(safePath.join(nested, SKILL_FILE))).toBe(true);

    // The pushed plugin dir is the plugin root (not the nested skill dir).
    expect(toForwardSlash(result.pluginDirs[0] as string)).toBe(toForwardSlash(stagedPluginRoot));
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
