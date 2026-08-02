/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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

  // 57 of 94 installed plugins ship a plugin-root README.md and it is their front
  // page — the skill-bundle navigation exclusions must NEVER reach this lane. If a
  // later "simplification" merges the two lists, this test is what fails.
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
});
