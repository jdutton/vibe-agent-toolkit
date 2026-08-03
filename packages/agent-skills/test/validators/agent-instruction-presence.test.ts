/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { detectPackagedAgentInstructionFiles } from '../../src/validators/agent-instruction-presence.js';
import { runGit } from '../skill-source/test-helpers.js';
import { setupTempDir } from '../test-helpers.js';

const NOTES_CLAUDE = 'notes/CLAUDE.md';

describe('detectPackagedAgentInstructionFiles', () => {
  const { getTempDir } = setupTempDir('vat-agent-instruction-presence-');

  /** Write `files` (relative paths) into a fresh tree and scan it. */
  const scan = (files: string[], declaredDests: string[] = []) => {
    const root = getTempDir();
    for (const rel of files) {
      const full = safePath.join(root, rel);
      mkdirSyncReal(dirname(full), { recursive: true });
      writeFileSync(full, '# content\n');
    }
    return detectPackagedAgentInstructionFiles(root, root, declaredDests);
  };

  it('reports every agent-instruction basename found in the tree', () => {
    const issues = scan([
      'CLAUDE.md',
      'nested/AGENTS.md',
      'nested/deep/GEMINI.md',
      'CLAUDE.local.md',
    ]);

    expect(issues).toHaveLength(4);
    for (const issue of issues) {
      expect(issue.code).toBe('PACKAGED_AGENT_INSTRUCTION_FILE');
      expect(issue.severity).toBe('warning');
    }
    expect(issues.map(i => i.location).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'CLAUDE.local.md',
      'CLAUDE.md',
      'nested/AGENTS.md',
      'nested/deep/GEMINI.md',
    ]);
  });

  // The backstop must not be evadable by spelling. On APFS/NTFS a `Claude.md`
  // is resolved by the same lookup Claude Code performs for `CLAUDE.md`, so a
  // case-sensitive detector reports a clean tree while the harm ships.
  // Each spelling lives in its own directory — two spellings of one name in one
  // directory are the SAME file on a case-insensitive filesystem.
  it('reports mis-cased agent-instruction files too', () => {
    const issues = scan([
      'a/Claude.md',
      'b/claude.md',
      'c/agents.md',
      'd/Agents.md',
      'e/CLAUDE.MD',
      'f/Gemini.md',
    ]);

    expect(issues).toHaveLength(6);
    expect(issues.every((i) => i.code === 'PACKAGED_AGENT_INSTRUCTION_FILE')).toBe(true);
  });

  it('reports nothing for a clean tree', () => {
    expect(scan(['SKILL.md', 'resources/guide.md', 'README.md'])).toEqual([]);
  });

  it('does not match a doc that merely starts with an agent-instruction name', () => {
    // `CLAUDE-setup.md` is ordinary content; only exact basenames are guidance.
    expect(scan(['CLAUDE-setup.md', 'docs/AGENTS-overview.md'])).toEqual([]);
  });

  it('anchors locations to the supplied root, not the scanned directory', () => {
    // The plugin lane scans <marketplace>/plugins/<name> but anchors issues at
    // the run root, so the reported path must be reachable by the reader.
    const root = getTempDir();
    const pluginDir = safePath.join(root, 'plugins', 'demo');
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, 'CLAUDE.md'), '# guidance\n');

    const issues = detectPackagedAgentInstructionFiles(pluginDir, root, []);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('plugins/demo/CLAUDE.md');
  });

  it('returns an empty list for a directory that does not exist', () => {
    const missing = safePath.join(getTempDir(), 'not-there');
    expect(detectPackagedAgentInstructionFiles(missing, missing, [])).toEqual([]);
  });

  // §8.2 precedence: an EXPLICIT `files:` entry naming a dest is an unambiguous
  // instruction to ship that file. Reporting it — with a remedy that says "remove
  // the file" — tells the author their own sanctioned config is the defect.
  it('does not report a dest an explicit files: entry declared', () => {
    expect(scan([NOTES_CLAUDE, 'SKILL.md'], [NOTES_CLAUDE])).toEqual([]);
  });

  it('still reports an agent-instruction file no declaration covers', () => {
    // Same tree, same declaration — the bundle-root CLAUDE.md is not the declared
    // dest, so the suppression must not spill onto it.
    const issues = scan(['CLAUDE.md', NOTES_CLAUDE], [NOTES_CLAUDE]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('CLAUDE.md');
  });

  // A declaration is EXACT membership, never a prefix test: the caller passes
  // explicit dests only, and a directory-shaped entry must not launder its whole
  // subtree. (Mirrors `refusesAgentInstructionFile` in walk-link-graph.ts.)
  it('does not treat a declared dest as a prefix exemption for its subtree', () => {
    const issues = scan(['notes/deep/CLAUDE.md'], ['notes']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe('notes/deep/CLAUDE.md');
  });

  it('normalizes declared dests so a ./-spelled entry still exempts', () => {
    expect(scan([NOTES_CLAUDE], [`./${NOTES_CLAUDE}`])).toEqual([]);
  });

  /**
   * The ONE case every other test in this file is structurally blind to.
   *
   * `setupTempDir` is a bare `mkdtemp` — no repository — so the crawler's git lane
   * never engages and `respectGitignore` cannot change any answer. Every scan above
   * would agree with a detector that respected gitignore, and the subject of this
   * detector is BUILT output: a bundle under a gitignored `dist/`, where the crawl's
   * default (`git ls-files`, tracked files only) returns nothing at all and the scan
   * passes by scanning zero files.
   *
   * A real repo is what makes the difference observable: `git init` alone is enough
   * for `git ls-files` to return an empty set for an untracked tree, and the
   * `.gitignore` makes the fixture the actual shape the comment describes. Until
   * this case existed the guard lived in another package's integration test, one
   * fixture re-scope away from evaporating.
   */
  it('scans a built bundle sitting under a gitignored dist/ inside a real repo', () => {
    const root = getTempDir();
    runGit(['init', '--initial-branch=main'], root);
    writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n');
    const bundleDir = safePath.join(root, 'dist', 'skills', 'demo');
    mkdirSyncReal(bundleDir, { recursive: true });
    writeFileSync(safePath.join(bundleDir, 'CLAUDE.md'), '# guidance\n');
    writeFileSync(safePath.join(bundleDir, 'SKILL.md'), '# skill\n');

    const issues = detectPackagedAgentInstructionFiles(bundleDir, root, []);

    expect(issues.map(i => i.location)).toEqual(['dist/skills/demo/CLAUDE.md']);
  });
});
