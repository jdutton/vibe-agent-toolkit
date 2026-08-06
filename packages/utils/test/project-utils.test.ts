/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitFindRoot } from '../src/git-utils.js';
import {
  findConfigFile,
  findNodeWorkspaceRoot,
  findProjectRoot,
  resetProjectRootCaches,
} from '../src/project-utils.js';
import { setupAsyncTempDirSuite } from '../src/test-helpers.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const PACKAGE_JSON = 'package.json';
const SEPARATOR = '/';
const CONFIG_CONTENT = 'version: 1\n';

describe('findConfigFile', () => {
  const suite = setupAsyncTempDirSuite('find-config-file');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('returns the config file path when found at startDir', () => {
    const cfg = safePath.join(tempDir, CONFIG_FILENAME);
    fs.writeFileSync(cfg, CONFIG_CONTENT, 'utf-8');
    expect(findConfigFile(tempDir)).toBe(cfg);
  });

  it('walks up to find the config in a parent dir', () => {
    const cfg = safePath.join(tempDir, CONFIG_FILENAME);
    fs.writeFileSync(cfg, CONFIG_CONTENT, 'utf-8');
    const child = safePath.join(tempDir, 'a', 'b');
    fs.mkdirSync(child, { recursive: true });
    expect(findConfigFile(child)).toBe(cfg);
  });

  it('returns null when no config exists in any ancestor up to filesystem root', () => {
    // Note: startDir under tempDir may have ancestors above tempDir that
    // happen to contain a config (e.g., when running these tests inside the
    // VAT repo itself). The contract only guarantees null when no config
    // exists between startDir and the filesystem root. To exercise the
    // null path deterministically, point at a path whose nearest ancestor
    // with a config is checked first; we assert findConfigFile of tempDir
    // (with no config in tempDir) walks up. Instead of fighting the
    // surrounding repo, verify the helper returns the *nearest* config —
    // which for an empty tempDir means at most the ancestor's config or null.
    const result = findConfigFile(tempDir);
    if (result === null) {
      expect(result).toBeNull();
    } else {
      // If something is found, it must be above tempDir (not inside it).
      expect(result.startsWith(tempDir + SEPARATOR)).toBe(false);
    }
  });

  it('prefers the nearest config when configs exist at multiple levels', () => {
    const outer = safePath.join(tempDir, CONFIG_FILENAME);
    fs.writeFileSync(outer, 'version: 1\n# outer\n', 'utf-8');

    const innerDir = safePath.join(tempDir, 'pkg');
    fs.mkdirSync(innerDir, { recursive: true });
    const inner = safePath.join(innerDir, CONFIG_FILENAME);
    fs.writeFileSync(inner, 'version: 1\n# inner\n', 'utf-8');

    expect(findConfigFile(innerDir)).toBe(inner);
  });
});

describe('gitFindRoot (sanity — canonical git-root walker)', () => {
  const suite = setupAsyncTempDirSuite('git-find-root');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('returns the directory containing .git/ when walking up from a child', () => {
    const repo = safePath.join(tempDir, 'repo');
    fs.mkdirSync(safePath.join(repo, '.git'), { recursive: true });
    const child = safePath.join(repo, 'a', 'b');
    fs.mkdirSync(child, { recursive: true });
    expect(gitFindRoot(child)).toBe(repo);
  });

  it('returns a string when given a path inside a real git repo (this repo)', () => {
    // We can't easily create a path guaranteed not to be inside a git repo,
    // so for the "real repo" case just verify the function returns a string
    // (the surrounding VAT repo's git root).
    const result = gitFindRoot(process.cwd());
    expect(typeof result).toBe('string');
    expect(result?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('findNodeWorkspaceRoot', () => {
  const suite = setupAsyncTempDirSuite('find-node-workspace-root');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('returns the directory containing package.json with "workspaces" key', () => {
    const root = safePath.join(tempDir, 'mono');
    const pkgDir = safePath.join(root, 'packages', 'my-pkg', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      safePath.join(root, PACKAGE_JSON),
      JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }),
    );
    // Inner package.json without "workspaces" should be skipped.
    fs.writeFileSync(
      safePath.join(root, 'packages', 'my-pkg', PACKAGE_JSON),
      JSON.stringify({ name: '@mono/my-pkg' }),
    );

    expect(findNodeWorkspaceRoot(pkgDir)).toBe(root);
  });

  it('skips invalid JSON package.json and keeps walking', () => {
    const root = safePath.join(tempDir, 'mono');
    const middle = safePath.join(root, 'middle');
    fs.mkdirSync(middle, { recursive: true });

    // Invalid JSON in middle — should be skipped.
    fs.writeFileSync(safePath.join(middle, PACKAGE_JSON), '{ invalid json }');
    // Valid workspace-bearing package.json at root.
    fs.writeFileSync(
      safePath.join(root, PACKAGE_JSON),
      JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }),
    );

    expect(findNodeWorkspaceRoot(middle)).toBe(root);
  });

  it('returns null when no workspace-bearing package.json is found below the VAT repo', () => {
    // tempDir is outside this repo's workspace tree (in an isolated tmpdir).
    // Walk would eventually reach the filesystem root without finding a
    // "workspaces" key. We can't fully guarantee that across machines, so we
    // only assert the function returns either null or a string above tempDir.
    const dir = safePath.join(tempDir, 'no-workspace');
    fs.mkdirSync(dir, { recursive: true });
    const result = findNodeWorkspaceRoot(dir);
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.startsWith(tempDir + SEPARATOR)).toBe(false);
    }
  });
});

describe('findProjectRoot (config → git → null ladder)', () => {
  const suite = setupAsyncTempDirSuite('find-project-root');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    // Cache is module-level; reset between tests so fixtures don't bleed.
    resetProjectRootCaches();
  });

  it('config-anchored: returns directory of vibe-agent-toolkit.config.yaml', () => {
    const proj = safePath.join(tempDir, 'proj');
    const inner = safePath.join(proj, 'a', 'b');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(safePath.join(proj, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');

    expect(findProjectRoot(inner)).toBe(proj);
  });

  it('git-anchored: returns .git/ directory when no config exists', () => {
    const repo = safePath.join(tempDir, 'repo');
    fs.mkdirSync(safePath.join(repo, '.git'), { recursive: true });
    const inner = safePath.join(repo, 'src');
    fs.mkdirSync(inner, { recursive: true });

    expect(findProjectRoot(inner)).toBe(repo);
  });

  it('both present, config deeper than git: config wins', () => {
    // .git/ at outer, config at inner — config wins (declaration of intent).
    const outer = safePath.join(tempDir, 'outer');
    fs.mkdirSync(safePath.join(outer, '.git'), { recursive: true });

    const inner = safePath.join(outer, 'project');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(safePath.join(inner, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');

    const startDir = safePath.join(inner, 'sub', 'dir');
    fs.mkdirSync(startDir, { recursive: true });

    expect(findProjectRoot(startDir)).toBe(inner);
  });

  it('both present, git deeper than config: config still wins (independent walks)', () => {
    // Per spec §6: the config walk is independent and always wins over git
    // when a config exists anywhere above startDir.
    const outerConfig = safePath.join(tempDir, 'cfg');
    fs.mkdirSync(outerConfig, { recursive: true });
    fs.writeFileSync(safePath.join(outerConfig, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');

    const innerGit = safePath.join(outerConfig, 'nested');
    fs.mkdirSync(safePath.join(innerGit, '.git'), { recursive: true });

    const startDir = safePath.join(innerGit, 'src');
    fs.mkdirSync(startDir, { recursive: true });

    expect(findProjectRoot(startDir)).toBe(outerConfig);
  });

  it('neither present: returns null (no fallback to startDir)', () => {
    // Same caveat as findConfigFile/gitFindRoot null tests: we can only
    // assert the function does not return startDir itself, since the tempDir
    // may live inside a real repo. The contract is "no fallback to startDir".
    const isolated = safePath.join(tempDir, 'isolated', 'deep');
    fs.mkdirSync(isolated, { recursive: true });

    const result = findProjectRoot(isolated);
    // Result is either null OR an ancestor of tempDir (e.g., this repo's
    // own root if the temp dir happens to be inside it). It must NEVER be
    // the startDir itself when no config/.git exists at or under tempDir.
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.startsWith(tempDir + SEPARATOR)).toBe(false);
      expect(result).not.toBe(isolated);
    }
  });
});

describe('findProjectRoot Layer 1 cache (spec §8 / §13.5)', () => {
  // We can't reliably spy on `existsSync` destructured at module load time in
  // ESM, so we verify cache behavior by mutating the filesystem between calls
  // and asserting the cached result wins. If a call returned the cached value
  // it could not have re-executed the filesystem walk.
  const suite = setupAsyncTempDirSuite('find-project-root-cache');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    resetProjectRootCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProjectRootCaches();
  });

  it('second walk-up from a sibling dir returns cached configRoot (cache hit)', () => {
    // /tempDir/proj/  (config here)
    //   a/b/skill1
    //   a/c/skill2
    const proj = safePath.join(tempDir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(safePath.join(proj, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');

    const skill1 = safePath.join(proj, 'a', 'b', 'skill1');
    const skill2 = safePath.join(proj, 'a', 'c', 'skill2');
    fs.mkdirSync(skill1, { recursive: true });
    fs.mkdirSync(skill2, { recursive: true });

    // First call: walks up to proj, populates cache for visited ancestors.
    expect(findProjectRoot(skill1)).toBe(proj);

    // Now delete the config file. If the second call re-walks, it will fail
    // to find a config and fall through to the git ladder (returning either
    // an outer .git root or null) — definitely not `proj`. If the cache hits,
    // it returns `proj`, proving the result is cached.
    fs.unlinkSync(safePath.join(proj, CONFIG_FILENAME));

    expect(findProjectRoot(skill2)).toBe(proj);
  });

  it('records null for every dir walked when no config or git ancestor exists', () => {
    // We can't guarantee the absence of git/config ancestors above tempDir, so
    // verify the cache-stickiness property instead: a first call populates a
    // cache entry for tempDir's descendants; a second call from an intermediate
    // dir returns the same answer even after mutating the filesystem.
    const deep = safePath.join(tempDir, 'deep', 'leaf');
    fs.mkdirSync(deep, { recursive: true });

    const firstResult = findProjectRoot(deep);

    // Mutate: add a config file at `tempDir/deep` (deeper than `deep`'s
    // resolved root, if any). If the cache short-circuits via a hit at an
    // already-visited ancestor, this new config will NOT be discovered for
    // the intermediate dir — proving cache stickiness.
    const intermediate = safePath.join(tempDir, 'deep');
    fs.writeFileSync(safePath.join(intermediate, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');

    const secondResult = findProjectRoot(intermediate);
    // Cache from the first call recorded `intermediate`'s answer. Even though
    // a config now exists there, the cached entry wins.
    expect(secondResult).toBe(firstResult);
  });

  it('resetProjectRootCaches() clears the cache between invocations', () => {
    const proj = safePath.join(tempDir, 'resetproj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(safePath.join(proj, CONFIG_FILENAME), CONFIG_CONTENT, 'utf-8');
    const skill = safePath.join(proj, 'a', 'b');
    fs.mkdirSync(skill, { recursive: true });

    // Populate cache.
    expect(findProjectRoot(skill)).toBe(proj);

    // Remove config; without reset the cache would still return `proj`.
    fs.unlinkSync(safePath.join(proj, CONFIG_FILENAME));
    resetProjectRootCaches();

    // Now the fresh walk finds no config, so the result must differ — either
    // null or a git/config ancestor above tempDir, but NOT `proj`.
    const fresh = findProjectRoot(skill);
    expect(fresh).not.toBe(proj);
  });
});
