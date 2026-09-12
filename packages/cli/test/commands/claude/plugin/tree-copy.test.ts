/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import {
  createSymlink,
  mkdirSyncReal,
  safePath,
  symlinkCapability,
  withReaddirSyncRefused,
} from '@vibe-agent-toolkit/utils';
import { DirectoryListingRefusedError } from '@vibe-agent-toolkit/utils/crawl';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PluginSymlinkRefusedError,
  treeCopyPlugin,
  type TreeCopyResult,
} from '../../../../src/commands/claude/plugin/tree-copy.js';
import { createTempDirTracker } from '../../../system/test-common.js';

/**
 * Seed a plugin source and tree-copy it with the given `exclude:` patterns.
 *
 * Every exclude case needs the same two files — one the pattern is meant to
 * drop, one it must not touch — so the fixture lives here rather than being
 * restated per test. `seedScratch: false` is for the case that must have NO
 * `scratch/` at all: a pattern aimed at a directory that does not exist is the
 * only way to test the zero-match report.
 */
async function copyWithExclude(
  src: string,
  dest: string,
  exclude: string[],
  { seedScratch = true }: { seedScratch?: boolean } = {},
): Promise<TreeCopyResult> {
  if (seedScratch) {
    await mkdir(safePath.join(src, 'scratch'), { recursive: true });
    await writeFile(safePath.join(src, 'scratch', 'notes.md'), '# scratch');
  }
  await writeFile(safePath.join(src, 'keep.md'), '# keep');
  return treeCopyPlugin({ sourceDir: src, destDir: dest, exclude });
}

describe('treeCopyPlugin', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-');
  let src: string;
  let dest: string;

  beforeEach(() => {
    const root = createTempDir();
    src = safePath.join(root, 'plugins', 'p1');
    dest = safePath.join(root, 'out', 'p1');
    mkdirSyncReal(src, { recursive: true });
    mkdirSyncReal(dest, { recursive: true });
  });

  afterEach(() => cleanupTempDirs());

  it('copies commands/, hooks/, agents/, .mcp.json, scripts/ into dest', async () => {
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'hello.md'), '# hello');
    await mkdir(safePath.join(src, 'hooks'), { recursive: true });
    await writeFile(safePath.join(src, 'hooks', 'hooks.json'), '{"events":{}}');
    await mkdir(safePath.join(src, 'agents'), { recursive: true });
    await writeFile(safePath.join(src, 'agents', 'a1.md'), '# agent');
    await writeFile(safePath.join(src, '.mcp.json'), '{"mcpServers":{}}');
    await mkdir(safePath.join(src, 'scripts'), { recursive: true });
    await writeFile(safePath.join(src, 'scripts', 'tool.mjs'), 'export default 1;');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'commands', 'hello.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'agents', 'a1.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, '.mcp.json'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'scripts', 'tool.mjs'))).toBe(true);
  });

  it('tree-copies skills/ verbatim (no special handling)', async () => {
    await mkdir(safePath.join(src, 'skills', 's1'), { recursive: true });
    await writeFile(safePath.join(src, 'skills', 's1', 'SKILL.md'), '# skill');
    await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(existsSync(safePath.join(dest, 'skills', 's1', 'SKILL.md'))).toBe(true);
  });

  it('excludes skill dirs named in excludeSkillDirs (collision referee)', async () => {
    await mkdir(safePath.join(src, 'skills', 's1'), { recursive: true });
    await writeFile(safePath.join(src, 'skills', 's1', 'SKILL.md'), '# skill one');
    await mkdir(safePath.join(src, 'skills', 's2'), { recursive: true });
    await writeFile(safePath.join(src, 'skills', 's2', 'SKILL.md'), '# skill two');

    await treeCopyPlugin({ sourceDir: src, destDir: dest, excludeSkillDirs: ['s1'] });

    expect(existsSync(safePath.join(dest, 'skills', 's1'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'skills', 's2', 'SKILL.md'))).toBe(true);
  });

  it('excludes .claude-plugin/ subtree (plugin.json is merged separately)', async () => {
    await mkdir(safePath.join(src, '.claude-plugin'), { recursive: true });
    await writeFile(safePath.join(src, '.claude-plugin', 'plugin.json'), '{"foo":1}');
    await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(existsSync(safePath.join(dest, '.claude-plugin'))).toBe(false);
  });

  it('returns counts for commands, hooks, agents, mcp', async () => {
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'a.md'), '');
    await writeFile(safePath.join(src, 'commands', 'b.md'), '');
    await mkdir(safePath.join(src, 'hooks'), { recursive: true });
    await writeFile(safePath.join(src, 'hooks', 'hooks.json'), '{}');
    await mkdir(safePath.join(src, 'agents'), { recursive: true });
    await writeFile(safePath.join(src, 'agents', 'x.md'), '');
    await writeFile(safePath.join(src, '.mcp.json'), '{}');

    const result = await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(result.commandsCopied).toBe(2);
    expect(result.hooksCopied).toBe(1);
    expect(result.agentsCopied).toBe(1);
    expect(result.mcpCopied).toBe(1);
  });

  it('returns 0 counts when plugin dir is bare (no assets)', async () => {
    const result = await treeCopyPlugin({ sourceDir: src, destDir: dest });
    expect(result).toEqual({
      commandsCopied: 0,
      hooksCopied: 0,
      agentsCopied: 0,
      mcpCopied: 0,
      filesCopied: 0,
      unusedExcludePatterns: [],
      symlinksCopied: [],
    });
  });

  it('never copies agent-instruction files, at the root or at depth (tier 1)', async () => {
    await writeFile(safePath.join(src, 'CLAUDE.md'), '# repo guidance');
    await writeFile(safePath.join(src, 'AGENTS.md'), '# repo guidance');
    await mkdir(safePath.join(src, 'docs'), { recursive: true });
    await writeFile(safePath.join(src, 'docs', 'CLAUDE.md'), '# nested guidance');
    await writeFile(safePath.join(src, 'docs', 'GEMINI.md'), '# nested guidance');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'AGENTS.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'docs', 'CLAUDE.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'docs', 'GEMINI.md'))).toBe(false);
  });

  // Measured 2026-08-02: 50 of 86 installed plugins ship a plugin-root README.md
  // (57 of 94 when first measured — the population moves, the ~3-in-5 ratio holds),
  // and it is their front page — the skill-bundle navigation exclusions must NEVER
  // reach this lane. If a later "simplification" merges the two lists, this test is
  // what fails.
  it('DOES copy README/index navigation files — tier 2 is skill-bundle-only', async () => {
    await writeFile(safePath.join(src, 'README.md'), '# plugin front page');
    await writeFile(safePath.join(src, 'index.md'), '# index');
    await mkdir(safePath.join(src, 'docs'), { recursive: true });
    await writeFile(safePath.join(src, 'docs', 'overview.md'), '# overview');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'README.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'index.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'docs', 'overview.md'))).toBe(true);
  });

  // A case-insensitive filesystem (APFS, NTFS) resolves `Claude.md` for a
  // `CLAUDE.md` lookup, so Claude Code loads a mis-cased bundled file as live
  // instructions exactly as it would the canonical spelling. Enumerating one
  // spelling per name leaves the whole harm reachable.
  // NOTE: each spelling gets its own directory — on APFS two spellings of one
  // name in one directory are the SAME file.
  it('never copies agent-instruction files whatever their case (tier 1)', async () => {
    await writeFile(safePath.join(src, 'CLAUDE.md'), '# upper');
    await writeFile(safePath.join(src, 'Agents.md'), '# mixed at root');
    await mkdir(safePath.join(src, 'a'), { recursive: true });
    await writeFile(safePath.join(src, 'a', 'Claude.md'), '# mixed at depth');
    await mkdir(safePath.join(src, 'b'), { recursive: true });
    await writeFile(safePath.join(src, 'b', 'claude.md'), '# lower at depth');
    await mkdir(safePath.join(src, 'c'), { recursive: true });
    await writeFile(safePath.join(src, 'c', 'agents.md'), '# lower at depth');
    await mkdir(safePath.join(src, 'd'), { recursive: true });
    await writeFile(safePath.join(src, 'd', 'CLAUDE.MD'), '# shouted extension');
    await mkdir(safePath.join(src, 'e'), { recursive: true });
    await writeFile(safePath.join(src, 'e', 'Gemini.md'), '# mixed');
    await writeFile(safePath.join(src, 'keep.md'), '# keep');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'Agents.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'a', 'Claude.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'b', 'claude.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'c', 'agents.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'd', 'CLAUDE.MD'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'e', 'Gemini.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'keep.md'))).toBe(true);
  });

  it('DOES copy mis-cased navigation files — tier 2 is still skill-bundle-only', async () => {
    await writeFile(safePath.join(src, 'Readme.md'), '# plugin front page');
    await mkdir(safePath.join(src, 'docs'), { recursive: true });
    await writeFile(safePath.join(src, 'docs', 'Overview.md'), '# overview');

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'Readme.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'docs', 'Overview.md'))).toBe(true);
  });

  // `exclude:` must mean the same thing whether or not the plugin source sits in
  // a git repo. The git fast path only ever yields FILE paths, so a
  // directory-shaped pattern matched nothing there while the non-git walker
  // pruned the directory outright — same config, opposite result, and the git
  // case is the one that ships. See the sibling git-lane cases in
  // test/integration/tree-copy-gitignore.integration.test.ts.
  it.each([['scratch/**'], ['scratch'], ['scratch/']])(
    'honors caller-supplied exclude pattern %s',
    async (pattern) => {
      await copyWithExclude(src, dest, [pattern]);

      expect(existsSync(safePath.join(dest, 'scratch', 'notes.md'))).toBe(false);
      expect(existsSync(safePath.join(dest, 'keep.md'))).toBe(true);
    },
  );

  it('excludes a nested directory named without a trailing glob', async () => {
    await mkdir(safePath.join(src, 'docs', 'internal'), { recursive: true });
    await writeFile(safePath.join(src, 'docs', 'internal', 'notes.md'), '# internal');
    await writeFile(safePath.join(src, 'docs', 'public.md'), '# public');

    await treeCopyPlugin({ sourceDir: src, destDir: dest, exclude: ['docs/internal'] });

    expect(existsSync(safePath.join(dest, 'docs', 'internal', 'notes.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'docs', 'public.md'))).toBe(true);
  });

  // A typo'd or wrong-shaped exclude pattern used to be perfectly silent — the
  // knob no-oped and the junk shipped. Zero matches is the ONLY evidence the
  // author gets, so it must reach the CALLER as data: a `warn` string could only
  // ever become a log line, and this build's report published `warnings: 0`
  // beside it. The caller turns these into coded findings that reach issueCounts.
  it('returns an exclude pattern that matched nothing', async () => {
    const result = await copyWithExclude(src, dest, ['scratch/**'], { seedScratch: false });

    expect(result.unusedExcludePatterns).toEqual(['scratch/**']);
  });

  it('reports the dead patterns and not the live one, verbatim as authored', async () => {
    const result = await copyWithExclude(src, dest, ['scratch', 'no-such-dir/**', '*.nope']);

    expect(result.unusedExcludePatterns).toEqual(['no-such-dir/**', '*.nope']);
  });

  it('does not report an exclude pattern that matched', async () => {
    const result = await copyWithExclude(src, dest, ['scratch']);

    expect(result.unusedExcludePatterns).toEqual([]);
  });

  // Hit counting is per-pattern, not first-match-wins: a pattern SHADOWED by an
  // earlier one still genuinely matches the file, so accusing it of matching
  // nothing would send the author to delete a working line of config.
  it('does not report a pattern shadowed by another that also matches', async () => {
    const result = await copyWithExclude(src, dest, ['scratch', 'scratch/notes.md']);

    expect(result.unusedExcludePatterns).toEqual([]);
  });

  // The `warn` sink survives for the one message that really IS a log line: a
  // notice about an input VAT ignored, not a claim about what shipped.
  it('warns (but does not fail) when marketplace.json is present inside author .claude-plugin/', async () => {
    await mkdir(safePath.join(src, '.claude-plugin'), { recursive: true });
    await writeFile(safePath.join(src, '.claude-plugin', 'marketplace.json'), '{}');
    const warnings: string[] = [];
    await treeCopyPlugin({ sourceDir: src, destDir: dest, warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('marketplace.json'))).toBe(true);
  });

  // The zero-match channel must not leak into the `warn` sink as well — one
  // channel per finding, or the plugin build reports it twice.
  it('does not route the zero-match report through the warn sink', async () => {
    await writeFile(safePath.join(src, 'keep.md'), '# keep');
    const warnings: string[] = [];

    await treeCopyPlugin({
      sourceDir: src,
      destDir: dest,
      exclude: ['scratch/**'],
      warn: (m) => warnings.push(m),
    });

    expect(warnings).toEqual([]);
  });

  /**
   * A copy over a tree it cannot fully list must STOP, not ship a partial plugin:
   * every file under the refused directory is in the declared source and would
   * be silently absent from the published bundle. The crawler used to hand back
   * the shorter list and the build said "success". The refusal is a
   * `readdirSync` spy so it runs on every platform and as root; the fixture has
   * no repository, so the walk route (the one that lists directories) is taken.
   */
  it('refuses the copy by name when a source directory cannot be listed, before copying anything', async () => {
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'hello.md'), '# hello');
    const locked = safePath.join(src, 'hooks');
    await mkdir(locked, { recursive: true });
    await writeFile(safePath.join(locked, 'hooks.json'), '{"events":{}}');

    let thrown: unknown;
    try {
      await withReaddirSyncRefused(locked, 'EACCES', () => treeCopyPlugin({ sourceDir: src, destDir: dest }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    const message = (thrown as Error).message;
    expect(message).toContain("'hooks'");
    expect(message).toContain('EACCES');
    expect(message).toContain('exclude');
    // Adopter-facing: no absolute path, no library seam.
    expect(message).not.toContain(src);
    expect(message).not.toContain('onUnreadable');
    // Nothing shipped: the crawl decides before the first copy.
    expect(existsSync(safePath.join(dest, 'commands', 'hello.md'))).toBe(false);
  });
});

/**
 * Symlinks in a plugin source — ONE behaviour on both crawl routes.
 *
 * Measured before this: on the walk route (no `.git` above the source) every
 * symlink — file, directory, dangling, cycle — was silently dropped: `filesCopied:
 * 2`, no warning, no field. On the git route a file symlink pointing OUTSIDE the
 * source was copied BY CONTENT (the published bundle read an arbitrary path on
 * the build host), and a directory or dangling symlink threw a raw `ENOTSUP` /
 * `ENOENT` out of `copyFile` AFTER earlier files had landed — the half-written
 * bundle the listing refusal above exists to prevent.
 *
 * Now, on both routes: every symlink is `lstat`ed and resolved BEFORE the first
 * byte is copied. One that does not resolve, resolves outside the source, or
 * resolves to a directory is refused by name and nothing is copied. An in-tree
 * FILE symlink is copied by content and reported in `symlinksCopied`.
 *
 * Each case runs on both routes: the git route is the same source with a
 * repository initialised in it and the tree staged, which is what flips
 * `crawlDirectory` from the walker to `git ls-files`.
 */
describe.skipIf(!symlinkCapability())('treeCopyPlugin — symlinks, both crawl routes', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-symlink-');
  const OUTSIDE_BYTES = 'OUTSIDE-FILE';
  const HOOKS_BYTES = '{"events":{}}';

  interface SymlinkFixture {
    src: string;
    dest: string;
    /** A regular file OUTSIDE the plugin source, the target of escaping links. */
    outsideFile: string;
    /** Plant `hooks/<name>` → `target` (absolute, or relative to `hooks/`). */
    link: (name: string, target: string) => void;
  }

  /** Two regular files under `src`, plus an outside file to point at. */
  async function seedPlugin(): Promise<SymlinkFixture> {
    const cap = symlinkCapability();
    if (!cap) throw new Error('gated by describe.skipIf');
    const root = createTempDir();
    const src = safePath.join(root, 'plugins', 'p1');
    const dest = safePath.join(root, 'out', 'p1');
    const outsideFile = safePath.join(root, 'outside', 'secret.txt');
    await mkdir(safePath.join(src, 'commands'), { recursive: true });
    await mkdir(safePath.join(src, 'hooks'), { recursive: true });
    await mkdir(safePath.join(root, 'outside'), { recursive: true });
    await writeFile(safePath.join(src, 'commands', 'hello.md'), '# hello');
    await writeFile(safePath.join(src, 'hooks', 'hooks.json'), HOOKS_BYTES);
    await writeFile(outsideFile, OUTSIDE_BYTES);
    mkdirSyncReal(dest, { recursive: true });
    return {
      src,
      dest,
      outsideFile,
      link: (name, target) => createSymlink(cap, target, safePath.join(src, 'hooks', name)),
    };
  }

  /** Make `src` a repository with the whole tree staged, so the crawl takes `git ls-files`. */
  function gitRoute(src: string): void {
    runGitOrThrow(['init', '-q'], { cwd: src });
    runGitOrThrow(['add', '-A'], { cwd: src });
  }

  const routes: Array<['walk' | 'git', (src: string) => void]> = [
    ['walk', () => {}],
    ['git', gitRoute],
  ];

  async function copyExpectingRefusal(fx: SymlinkFixture): Promise<PluginSymlinkRefusedError> {
    let thrown: unknown;
    try {
      await treeCopyPlugin({ sourceDir: fx.src, destDir: fx.dest });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginSymlinkRefusedError);
    return thrown as PluginSymlinkRefusedError;
  }

  /** Refused means REFUSED: no file reached the destination, not even the regular ones. */
  function expectNothingCopied(fx: SymlinkFixture): void {
    expect(existsSync(safePath.join(fx.dest, 'commands', 'hello.md'))).toBe(false);
    expect(existsSync(safePath.join(fx.dest, 'hooks', 'hooks.json'))).toBe(false);
    expect(readdirSync(fx.dest)).toEqual([]);
  }

  afterEach(() => cleanupTempDirs());

  describe.each(routes)('%s route', (_route, prepare) => {
    it('refuses a file symlink that resolves OUTSIDE the source, by name, before copying anything', async () => {
      const fx = await seedPlugin();
      fx.link('abs-file-link', fx.outsideFile);
      prepare(fx.src);

      const error = await copyExpectingRefusal(fx);

      expect(error.message).toContain("'hooks/abs-file-link'");
      expect(error.message).toContain('outside');
      expect(error.message).toContain('exclude');
      // Adopter-facing: the bundle's own coordinates, not the build host's.
      expect(error.message).not.toContain(fx.src);
      expect(error.refused).toEqual([{ path: 'hooks/abs-file-link', reason: 'escapes-source' }]);
      expectNothingCopied(fx);
    });

    it('refuses a relative file symlink that climbs out of the source', async () => {
      const fx = await seedPlugin();
      fx.link('rel-file-link', '../../../outside/secret.txt');
      prepare(fx.src);

      const error = await copyExpectingRefusal(fx);

      expect(error.refused).toEqual([{ path: 'hooks/rel-file-link', reason: 'escapes-source' }]);
      expectNothingCopied(fx);
    });

    it('refuses a dangling symlink by name, before copying anything', async () => {
      const fx = await seedPlugin();
      fx.link('dangling', safePath.join(fx.src, '..', 'nowhere'));
      prepare(fx.src);

      const error = await copyExpectingRefusal(fx);

      expect(error.message).toContain("'hooks/dangling'");
      expect(error.refused).toEqual([{ path: 'hooks/dangling', reason: 'unresolvable' }]);
      expectNothingCopied(fx);
    });

    it('refuses an in-tree DIRECTORY symlink by name (a cycle included)', async () => {
      // Decision: refused, not recursed. Recursing by content would ship the
      // subtree twice under two names, and `hooks/cycle -> ..` would ship the
      // whole plugin inside itself.
      const fx = await seedPlugin();
      fx.link('dir-link', '../commands');
      fx.link('cycle', '..');
      prepare(fx.src);

      const error = await copyExpectingRefusal(fx);

      expect(error.refused).toEqual([
        { path: 'hooks/cycle', reason: 'directory' },
        { path: 'hooks/dir-link', reason: 'directory' },
      ]);
      expectNothingCopied(fx);
    });

    it('copies an in-tree FILE symlink by content and reports it', async () => {
      const fx = await seedPlugin();
      fx.link('alias.json', 'hooks.json');
      prepare(fx.src);

      const result = await treeCopyPlugin({ sourceDir: fx.src, destDir: fx.dest });

      const copied = safePath.join(fx.dest, 'hooks', 'alias.json');
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(readFileSync(copied, 'utf8')).toBe(HOOKS_BYTES);
      // Not dropped, and not dropped SILENTLY: counted with the files, and named.
      expect(result.filesCopied).toBe(3);
      expect(result.hooksCopied).toBe(2);
      expect(result.symlinksCopied).toEqual(['hooks/alias.json']);
    });

    it('refuses the whole copy when one link is bad even if another is fine — collect first, then copy', async () => {
      const fx = await seedPlugin();
      fx.link('alias.json', 'hooks.json');
      fx.link('dangling', safePath.join(fx.src, '..', 'nowhere'));
      prepare(fx.src);

      const error = await copyExpectingRefusal(fx);

      expect(error.refused.map((r) => r.path)).toEqual(['hooks/dangling']);
      expectNothingCopied(fx);
      expect(existsSync(safePath.join(fx.dest, 'hooks', 'alias.json'))).toBe(false);
    });

    it('does not refuse a symlink the caller excluded — the remedy the message names', async () => {
      const fx = await seedPlugin();
      fx.link('dangling', safePath.join(fx.src, '..', 'nowhere'));
      prepare(fx.src);

      const result = await treeCopyPlugin({ sourceDir: fx.src, destDir: fx.dest, exclude: ['hooks/dangling'] });

      expect(result.filesCopied).toBe(2);
      expect(result.symlinksCopied).toEqual([]);
      // The pattern did work, so it is not reported as dead.
      expect(result.unusedExcludePatterns).toEqual([]);
      expect(existsSync(safePath.join(fx.dest, 'hooks', 'dangling'))).toBe(false);
    });
  });
});
