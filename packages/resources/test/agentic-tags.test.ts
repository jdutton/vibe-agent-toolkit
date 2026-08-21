/**
 * The load-bearing cases here are the ones that would still pass if the
 * classifier were wrong.
 *
 * A vocabulary test that only feeds it `CLAUDE.md` and expects `claude-md`
 * passes for a classifier that matches on substrings, one that ignores the
 * directory entirely, and one that charges rules files as always-loaded. So
 * every convention with a *directory* requirement is pinned twice — once where
 * it matches, and once where the same basename sits somewhere else — and the
 * loading classes are asserted against the measurement that corrected them.
 */

import { describe, expect, it } from 'vitest';

import { classifyPath, LOADING_TAG } from '../src/projection/agentic-tags.js';

/** Basenames that appear in both the positive and the negative table. */
const SETTINGS_JSON = 'settings.json';
const PLUGIN_JSON = 'plugin.json';

/**
 * The tag names produced for a path, without the loading row.
 *
 * @param path - Root-relative path
 * @param basenameLower - Lowercased final segment
 * @returns Convention tag names
 */
function tagsOf(path: string, basenameLower: string): string[] {
  return classifyPath(path, basenameLower)
    .filter((t) => t.tag !== LOADING_TAG)
    .map((t) => t.tag);
}

/**
 * The loading class assigned to a path, if any.
 *
 * @param path - Root-relative path
 * @param basenameLower - Lowercased final segment
 * @returns The loading value, or undefined when nothing matched
 */
function loadingOf(path: string, basenameLower: string): string | undefined {
  return classifyPath(path, basenameLower).find((t) => t.tag === LOADING_TAG)?.value ?? undefined;
}

describe('classifyPath — the built-in vocabulary', () => {
  it.for([
    ['CLAUDE.md', 'claude.md', 'claude-md'],
    ['docs/CLAUDE.md', 'claude.md', 'claude-md'],
    ['AGENTS.md', 'agents.md', 'agents-md'],
    ['skills/thing/SKILL.md', 'skill.md', 'skill-md'],
    ['.claude/rules/x.md', 'x.md', 'rules-file'],
    ['.claude/agents/reviewer.md', 'reviewer.md', 'subagent'],
    ['.claude/commands/ship.md', 'ship.md', 'command'],
    [`.claude/${SETTINGS_JSON}`, SETTINGS_JSON, 'settings'],
    ['.claude/settings.local.json', 'settings.local.json', 'settings'],
    ['.mcp.json', '.mcp.json', 'mcp-config'],
    [`.claude-plugin/${PLUGIN_JSON}`, PLUGIN_JSON, 'plugin-manifest'],
    ['.claude-plugin/marketplace.json', 'marketplace.json', 'marketplace-manifest'],
    ['README.md', 'readme.md', 'readme'],
    ['.changeset/proud-pans-shake.md', 'proud-pans-shake.md', 'changeset'],
  ] as const)('tags %s as %s', ([path, basename, expected]) => {
    expect(tagsOf(path, basename)).toContain(expected);
  });

  /**
   * The half that catches a substring matcher. Each of these carries a basename
   * or a directory fragment the real convention uses, in a location where it is
   * NOT that convention — so a classifier that skipped the directory check
   * would pass every case above and fail every case here.
   */
  it.for([
    ['vendor/rules/x.md', 'x.md', 'rules-file'],
    ['docs/agents/notes.md', 'notes.md', 'subagent'],
    [PLUGIN_JSON, PLUGIN_JSON, 'plugin-manifest'],
    ['config/marketplace.json', 'marketplace.json', 'marketplace-manifest'],
    [SETTINGS_JSON, SETTINGS_JSON, 'settings'],
    ['docs/changeset/notes.md', 'notes.md', 'changeset'],
  ] as const)('does NOT tag %s as %s', ([path, basename, forbidden]) => {
    expect(tagsOf(path, basename)).not.toContain(forbidden);
  });

  it('matches case-insensitively, because skill.md and SKILL.md are one file on macOS and Windows', () => {
    expect(tagsOf('a/skill.md', 'skill.md')).toContain('skill-md');
    expect(tagsOf('a/Claude.MD', 'claude.md')).toContain('claude-md');
  });

  it('tags a nested command, which is a real Claude Code shape', () => {
    expect(tagsOf('.claude/commands/git/commit.md', 'commit.md')).toContain('command');
  });

  it('returns nothing for a path carrying no convention', () => {
    expect(classifyPath('src/index.ts', 'index.ts')).toEqual([]);
  });

  it('does not tag a non-markdown file sitting in a markdown convention directory', () => {
    expect(tagsOf('.claude/rules/helper.ts', 'helper.ts')).toEqual([]);
  });
});

describe('classifyPath — loading classes', () => {
  it.for([
    ['CLAUDE.md', 'claude.md', 'always'],
    ['AGENTS.md', 'agents.md', 'always'],
    ['a/SKILL.md', 'skill.md', 'selected'],
    ['.claude/agents/r.md', 'r.md', 'selected'],
    ['.claude/commands/c.md', 'c.md', 'selected'],
    ['README.md', 'readme.md', 'referenced'],
    ['.mcp.json', '.mcp.json', 'referenced'],
  ] as const)('charges %s as %s', ([path, basename, expected]) => {
    expect(loadingOf(path, basename)).toBe(expected);
  });

  /**
   * The correction that measurement forced. An earlier draft called rules files
   * always-loaded; all 53 in the only corpus with them at scale carry a
   * `paths:` glob and load conditionally. Charging them as `always` overstated
   * that corpus by 29,715 tokens — a 3x error on the metric the budget check
   * exists to report — so this asserts the corrected class explicitly rather
   * than leaving it to the table above.
   */
  it('charges a rules file as selected, NOT always', () => {
    expect(loadingOf('.claude/rules/schema.md', 'schema.md')).toBe('selected');
    expect(loadingOf('.claude/rules/schema.md', 'schema.md')).not.toBe('always');
  });

  it('assigns no loading class when no convention matched', () => {
    expect(loadingOf('src/index.ts', 'index.ts')).toBeUndefined();
  });

  /**
   * A file can match more than one convention, and the budget check reads the
   * loading class alone. Taking the last match rather than the most expensive
   * one would under-report exactly the always-loaded files the check exists to
   * find, so the strongest class has to win.
   */
  it('takes the most expensive class when a path matches several conventions', () => {
    // A CLAUDE.md inside a commands directory is both `command` (selected) and
    // `claude-md` (always). It is still charged every turn.
    const tags = tagsOf('.claude/commands/CLAUDE.md', 'claude.md');
    expect(tags).toContain('claude-md');
    expect(tags).toContain('command');
    expect(loadingOf('.claude/commands/CLAUDE.md', 'claude.md')).toBe('always');
  });
});
