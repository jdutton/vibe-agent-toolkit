import { describe, expect, it } from 'vitest';

import { CLAUDE_MD_TAG, classifyPath, RULES_FILE_TAG } from '../src/projection/agentic-tags.js';
import { rulesHolder } from '../src/projection/claude-context-walk.js';
import { CLAUDE_CODE } from '../src/projection/harness/claude-code.js';
import { harnessById, harnessForDialect, HARNESS_PROFILES } from '../src/projection/harness/profile.js';

describe('the Claude Code harness profile', () => {
  it('is the one profile, reachable by id and by its config dialect', () => {
    expect(Object.keys(HARNESS_PROFILES)).toEqual(['claude-code']);
    expect(harnessById('claude-code')).toBe(CLAUDE_CODE);
    expect(harnessForDialect('claude-import')).toBe(CLAUDE_CODE);
  });

  it('carries the loader constants transcribed from the binary', () => {
    expect(CLAUDE_CODE.maxImportDepth).toBe(4);
    // eslint-disable-next-line local/no-registry-count-pin -- a transcribed vendor byte cliff (`g3`), not a registry count; the literal IS the assertion, not a stand-in for one that would drift with legitimate growth
    expect(CLAUDE_CODE.sizeCliffBytes).toBe(4_194_304);
    expect(CLAUDE_CODE.isTextPath('a/b.ts')).toBe(true);
    expect(CLAUDE_CODE.isTextPath('a/b.pierce')).toBe(false);
    expect(CLAUDE_CODE.isTextPath('a/Makefile')).toBe(true); // no extension is read
  });

  it('names the memory files the launch and read walks open without an import', () => {
    for (const path of [
      'CLAUDE.md', 'acme/CLAUDE.md', '.claude/CLAUDE.md', 'acme/CLAUDE.local.md',
      '.claude/rules/x.md', 'acme/.claude/rules/deep/y.md',
      // The reach is a case-insensitive SUPERSET on the directory/basename side —
      // a case-insensitive filesystem folds these onto the exact-case spellings
      // above, and this predicate must not miss them.
      'acme/claude.md', '.Claude/Rules/x.md',
    ]) {
      expect(CLAUDE_CODE.isEntryPoint(path)).toBe(true);
    }
    for (const path of ['README.md', 'acme/claude.md.bak', '.claude/rules/x.MD', '.claude/rules/x.txt', 'widgets/.claude/settings.json']) {
      expect(CLAUDE_CODE.isEntryPoint(path)).toBe(false);
    }
  });

  it('reaches every path a reader classifies as a memory file (reach ⊇ readers)', () => {
    // The lazy harness pass derives facts only for `isEntryPoint` seeds; the
    // launch walk and the query read `claude-md` / `rules-file` tags and the
    // walk groups rules by `rulesHolder`. A tagged path the reach misses has
    // no facts row, so a reader would throw HarnessFactsAbsentError on it (or,
    // worse, a narrowed reach would silently shrink the answer). Swept over the
    // cartesian product so no one spelling stands in for the class.
    const prefixes = ['', 'acme/', 'acme/widgets/', 'acme/widgets/deep/er/still/'];
    const dirs = ['', '.claude/', '.Claude/', '.CLAUDE/'];
    const rulesDirs = ['.claude/rules/', '.claude/Rules/', '.CLAUDE/RULES/', '.claude/rules/nested/', '.claude/rules/a/b/c/'];
    const basenames = ['CLAUDE.md', 'claude.md', 'Claude.MD', 'CLAUDE.local.md', 'claude.LOCAL.md'];
    const ruleNames = ['x.md', 'Rule.md', 'UPPER.md', 'x.MD', 'x.txt'];
    const candidates = [
      ...prefixes.flatMap((prefix) => dirs.flatMap((dir) => basenames.map((name) => `${prefix}${dir}${name}`))),
      ...prefixes.flatMap((prefix) => rulesDirs.flatMap((dir) => ruleNames.map((name) => `${prefix}${dir}${name}`))),
    ];

    const tagged = { [CLAUDE_MD_TAG]: 0, [RULES_FILE_TAG]: 0, walkRules: 0 };
    for (const path of candidates) {
      const basename = path.slice(path.lastIndexOf('/') + 1);
      const tags = new Set(classifyPath(path, basename.toLowerCase(), new Set()).map((row) => row.tag));
      const isClaudeMd = tags.has(CLAUDE_MD_TAG);
      const isRule = tags.has(RULES_FILE_TAG);
      if (isClaudeMd) tagged[CLAUDE_MD_TAG] += 1;
      if (isRule) tagged[RULES_FILE_TAG] += 1;
      // The walk's own holder lookup, over the rules it keeps (tagged ones).
      if (isRule && rulesHolder(path) !== null) tagged.walkRules += 1;
      if (isClaudeMd || isRule) expect(CLAUDE_CODE.isEntryPoint(path), path).toBe(true);
    }
    // Fixture power: the sweep really exercised every reader's acceptance.
    expect(tagged[CLAUDE_MD_TAG]).toBeGreaterThan(0);
    expect(tagged[RULES_FILE_TAG]).toBeGreaterThan(tagged.walkRules);
    expect(tagged.walkRules).toBeGreaterThan(0);
  });

  it('calls a target with a directory component path-shaped, and a lone name bare', () => {
    expect(CLAUDE_CODE.importShape('docs/missing.md')).toBe('path');
    expect(CLAUDE_CODE.importShape('./x.md')).toBe('path');
    expect(CLAUDE_CODE.importShape('~/x.md')).toBe('path');
    expect(CLAUDE_CODE.importShape('doogie.howser.md')).toBe('bare');
    expect(CLAUDE_CODE.importShape('jeff')).toBe('bare');
  });

  it('renders the launch header with the per-kind suffix and the read header with none', () => {
    expect(CLAUDE_CODE.renderHeader('/w/CLAUDE.md', 'Project', 'launch'))
      .toBe('Contents of /w/CLAUDE.md (project instructions, checked into the codebase):\n');
    expect(CLAUDE_CODE.renderHeader('/w/CLAUDE.local.md', 'Local', 'launch'))
      .toBe("Contents of /w/CLAUDE.local.md (user's private project instructions, not checked in):\n");
    expect(CLAUDE_CODE.renderHeader('/w/a/CLAUDE.md', 'Project', 'read')).toBe('Contents of /w/a/CLAUDE.md:\n');
    expect(CLAUDE_CODE.launchPreamble).toBe(
      'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n',
    );
  });

  it('reads content through the one extractor', () => {
    const facts = CLAUDE_CODE.factsOf('---\npaths: src/**\n---\nSee @docs/a.md\n');
    expect(facts.paths).toEqual(['src/**']);
    expect(facts.imports.map((entry) => entry.target)).toEqual(['docs/a.md']);
  });
});
