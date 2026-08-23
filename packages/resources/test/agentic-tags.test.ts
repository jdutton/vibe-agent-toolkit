/**
 * Fixtures authored to FAIL, because this repository's corpus cannot.
 *
 * The predecessor of this suite was mutation-tested and killed 1 of 10 mutants.
 * Every positive fixture was root-anchored, so the arm handling the monorepo
 * shape `packages/cli/.claude/rules/x.md` had zero coverage; deleting
 * `toForwardSlash`, deleting `.toLowerCase()`, and collapsing containment to a
 * substring test all left the suite green.
 *
 * The corpus cannot supply the missing cases: VAT has **0** `.claude/agents`,
 * **0** `.claude/commands`, **0** `.changeset`, and 7-of-7 rules files are
 * direct children carrying `paths:`. A census over it therefore agrees with a
 * classifier that is wrong in five distinct ways. So each of the five defects
 * gets a fixture below that is red against the old behaviour, and the negatives
 * are chosen to be the *nearest miss* rather than an obviously different shape.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  classifyPath,
  LOADING_TAG,
  pluginRootsFrom,
  strongestLoading,
} from '../src/projection/agentic-tags.js';

/** Basenames that appear in both the positive and the negative table. */
const SETTINGS_JSON = 'settings.json';
const SETTINGS_LOCAL_JSON = 'settings.local.json';
const PLUGIN_JSON = 'plugin.json';
const MCP_JSON = '.mcp.json';
const README_MD = 'readme.md';
/** Tag names asserted from more than one table below. */
const RULES_FILE = 'rules-file';
const SUBAGENT = 'subagent';
const COMMAND = 'command';
const SETTINGS = 'settings';
const PLUGIN_MANIFEST = 'plugin-manifest';
const MARKETPLACE_JSON = 'marketplace.json';
const MCP_CONFIG = 'mcp-config';
/** Paths repeated across the positive, negative and normalisation tables. */
const ROOT_RULE = '.claude/rules/x.md';
const REVIEWER_MD = 'reviewer.md';

/** A tree with no plugin in it — the shape every `.claude/` case is asked under. */
const NO_PLUGINS = pluginRootsFrom([]);

/**
 * A tree holding two plugins, one at the corpus root and two nested.
 *
 * Nesting is deliberate: the plugin-anchored matcher has to try *every*
 * occurrence of the component-directory segment, and a single root-level plugin
 * would pass even if it only ever tried the first.
 */
const PLUGIN_TREE = pluginRootsFrom([
  '.claude-plugin/plugin.json',
  'plugins/reviewer/.claude-plugin/plugin.json',
  'vendor/nested/deep-plugin/.claude-plugin/plugin.json',
  // 🪤 A root whose own path contains the component-directory segment. The only
  // shape that distinguishes "try every occurrence" from "try the first": here
  // the first `/agents/` yields the non-root candidate `tools`, and only the
  // second yields the real one.
  'tools/agents/reviewer/.claude-plugin/plugin.json',
]);

/**
 * The tag names produced for a path, without the loading row.
 *
 * @param path - Root-relative path
 * @param basenameLower - Lowercased final segment
 * @param roots - Plugin roots to classify against
 * @returns Convention tag names
 */
function tagsOf(path: string, basenameLower: string, roots = NO_PLUGINS): string[] {
  return classifyPath(path, basenameLower, roots)
    .filter((t) => t.tag !== LOADING_TAG)
    .map((t) => t.tag);
}

/**
 * The loading class assigned to a path, if any.
 *
 * @param path - Root-relative path
 * @param basenameLower - Lowercased final segment
 * @param roots - Plugin roots to classify against
 * @returns The loading value, or undefined when nothing answered
 */
function loadingOf(path: string, basenameLower: string, roots = NO_PLUGINS): string | undefined {
  return classifyPath(path, basenameLower, roots).find((t) => t.tag === LOADING_TAG)?.value ?? undefined;
}

describe('classifyPath — the built-in vocabulary', () => {
  it.for([
    ['CLAUDE.md', 'claude.md', 'claude-md'],
    ['docs/CLAUDE.md', 'claude.md', 'claude-md'],
    ['CLAUDE.local.md', 'claude.local.md', 'claude-md'],
    ['AGENTS.md', 'agents.md', 'agents-md'],
    ['skills/thing/SKILL.md', 'skill.md', 'skill-md'],
    [ROOT_RULE, 'x.md', RULES_FILE],
    ['.claude/agents/reviewer.md', REVIEWER_MD, SUBAGENT],
    ['.claude/commands/ship.md', 'ship.md', COMMAND],
    [`.claude/${SETTINGS_JSON}`, SETTINGS_JSON, SETTINGS],
    [`.claude/${SETTINGS_LOCAL_JSON}`, SETTINGS_LOCAL_JSON, SETTINGS],
    ['.claude.json', '.claude.json', SETTINGS],
    [MCP_JSON, MCP_JSON, MCP_CONFIG],
    ['README.md', README_MD, 'readme'],
    [`.claude-plugin/${PLUGIN_JSON}`, PLUGIN_JSON, PLUGIN_MANIFEST],
    [`.claude-plugin/${MARKETPLACE_JSON}`, MARKETPLACE_JSON, 'marketplace-manifest'],
    ['README.md', README_MD, 'readme'],
  ])('tags %s as %s', ([path, basename, expected]) => {
    expect(tagsOf(path as string, basename as string)).toContain(expected);
  });

  it.for([
    // The same basename, one directory away from the convention.
    ['docs/rules/x.md', 'x.md'],
    ['docs/agents/reviewer.md', REVIEWER_MD],
    ['docs/commands/ship.md', 'ship.md'],
    [`config/${SETTINGS_JSON}`, SETTINGS_JSON],
    [`packages/cli/${PLUGIN_JSON}`, PLUGIN_JSON],
    [`packages/cli/${MARKETPLACE_JSON}`, MARKETPLACE_JSON],
    // Not markdown, so not a component even in the right directory.
    ['.claude/agents/helper.ts', 'helper.ts'],
    ['.claude/rules/schema.json', 'schema.json'],
    // 🪤 The convention path as a SUBSTRING of a directory that is not it. A
    // containment test written as `pathLower.includes('.claude/rules')` passes
    // every other fixture in this file and swallows these.
    ['.claude/rules-archive/x.md', 'x.md'],
    ['packages/cli/.claude/commands-draft/ship.md', 'ship.md'],
    ['.claude/agentsold/a.md', 'a.md'],
    // 🪤 SLASH-FREE paths — the arm of `directlyInside` no other fixture
    // reaches. Every anchored fixture above has a parent segment to compare, so
    // the `lastIndexOf('/') === -1` early return is only ever taken here; flip
    // it to `true` and a root-level `settings.json`, `plugin.json` or
    // `marketplace.json` becomes harness configuration it is not.
    [SETTINGS_JSON, SETTINGS_JSON],
    [SETTINGS_LOCAL_JSON, SETTINGS_LOCAL_JSON],
    [PLUGIN_JSON, PLUGIN_JSON],
    [MARKETPLACE_JSON, MARKETPLACE_JSON],
    // 🪤 The nearest miss for `skill.md`, which this suite's own stated
    // principle demands and did not have. `'myskill.md'.endsWith('skill.md')`
    // is true, so an `===` relaxed to a suffix test tags both of these
    // `skill-md`/`selected` — a file the harness never indexes, charged.
    ['skills/thing/myskill.md', 'myskill.md'],
    ['docs/not-skill.md', 'not-skill.md'],
  ])('leaves %s unclassified', ([path, basename]) => {
    expect(classifyPath(path as string, basename as string, NO_PLUGINS)).toEqual([]);
  });
});

describe('classifyPath — component directories are recursive, and not root-anchored', () => {
  // Anthropic documents all three `.claude/` component directories as recursive.
  // The predecessor used direct-containment for rules and subagents, so every
  // path in the first block classified as `[]`.
  it.for([
    ['.claude/rules/frontend/style.md', 'style.md', RULES_FILE],
    ['.claude/rules/a/b/c/deep.md', 'deep.md', RULES_FILE],
    ['.claude/agents/review/security.md', 'security.md', SUBAGENT],
    ['.claude/commands/git/commit.md', 'commit.md', COMMAND],
  ])('classifies nested %s as %s', ([path, basename, expected]) => {
    expect(tagsOf(path as string, basename as string)).toContain(expected);
  });

  // The monorepo shape. Every positive fixture in the predecessor was
  // root-anchored, so the arm that handles a non-root prefix had no coverage at
  // all and could be deleted with the suite still green.
  it.for([
    ['packages/cli/.claude/rules/x.md', 'x.md', RULES_FILE],
    ['apps/web/.claude/agents/a.md', 'a.md', SUBAGENT],
    ['apps/web/.claude/agents/team/a.md', 'a.md', SUBAGENT],
    ['sub/deep/.claude/commands/ship.md', 'ship.md', COMMAND],
    [`sub/.claude/${SETTINGS_JSON}`, SETTINGS_JSON, SETTINGS],
    [`sub/.claude-plugin/${PLUGIN_JSON}`, PLUGIN_JSON, PLUGIN_MANIFEST],
  ])('classifies non-root-anchored %s as %s', ([path, basename, expected]) => {
    expect(tagsOf(path as string, basename as string)).toContain(expected);
  });

  it('keeps .claude-plugin manifests flat, unlike the component directories', () => {
    // A manifest is looked for at one place; a nested one is not a plugin.
    expect(classifyPath(`.claude-plugin/nested/${PLUGIN_JSON}`, PLUGIN_JSON, NO_PLUGINS)).toEqual([]);
  });
});

describe('classifyPath — plugin-root components', () => {
  // The defect that made `subagent` and `command` fire ZERO times across 2,168
  // files: a plugin's components sit at `<plugin>/agents/`, never under
  // `.claude/`. Six real subagent definitions in this repo classified as `[]`.
  it.for([
    ['agents/reviewer.md', REVIEWER_MD, SUBAGENT],
    ['commands/ship.md', 'ship.md', COMMAND],
    ['plugins/reviewer/agents/security.md', 'security.md', SUBAGENT],
    ['plugins/reviewer/agents/team/lead.md', 'lead.md', SUBAGENT],
    ['plugins/reviewer/commands/audit.md', 'audit.md', COMMAND],
    ['vendor/nested/deep-plugin/agents/x.md', 'x.md', SUBAGENT],
    ['vendor/nested/deep-plugin/commands/y.md', 'y.md', COMMAND],
    // The second-occurrence case — see PLUGIN_TREE.
    ['tools/agents/reviewer/agents/x.md', 'x.md', SUBAGENT],
  ])('classifies %s as %s when a plugin root contains it', ([path, basename, expected]) => {
    expect(tagsOf(path as string, basename as string, PLUGIN_TREE)).toContain(expected);
  });

  // 🪤 The false positive a bare "directory named commands" rule produces. This
  // monorepo has 60+ files under `packages/cli/src/commands/`, and the markdown
  // one is the case a `.md`-only guard still lets through.
  it.for([
    ['packages/cli/src/commands/build.md', 'build.md'],
    ['docs/agents/overview.md', 'overview.md'],
    ['plugins/not-a-plugin/agents/x.md', 'x.md'],
    ['vendor/nested/agents/x.md', 'x.md'],
  ])('refuses %s, which no plugin root contains', ([path, basename]) => {
    expect(classifyPath(path as string, basename as string, PLUGIN_TREE)).toEqual([]);
  });

  it('anchors .mcp.json to a project or plugin root', () => {
    expect(tagsOf(MCP_JSON, MCP_JSON, PLUGIN_TREE)).toContain(MCP_CONFIG);
    expect(tagsOf(`plugins/reviewer/${MCP_JSON}`, MCP_JSON, PLUGIN_TREE)).toContain(MCP_CONFIG);
    // Matching the basename anywhere counts a fixture's or a dependency's
    // config as context the agent pays for, which it is not.
    expect(classifyPath(`test/fixtures/${MCP_JSON}`, MCP_JSON, PLUGIN_TREE)).toEqual([]);
  });
});

describe('pluginRootsFrom', () => {
  it('locates roots by the manifest that defines them', () => {
    expect([...PLUGIN_TREE].sort(compareCodeUnits)).toEqual([
      '',
      'plugins/reviewer',
      'tools/agents/reviewer',
      'vendor/nested/deep-plugin',
    ]);
  });

  it.for([
    ['plugin.json', 'a bare manifest outside .claude-plugin'],
    [`.claude-plugin/${MARKETPLACE_JSON}`, 'a marketplace manifest'],
    ['docs/.claude-plugin/plugin.json.bak', 'a backup beside the manifest'],
  ])('does not treat %s as a plugin root (%s)', ([path]) => {
    expect(pluginRootsFrom([path as string]).size).toBe(0);
  });

  it('normalises separators and case, like the classifier does', () => {
    expect([...pluginRootsFrom([String.raw`Plugins\Mine\.claude-plugin\plugin.json`])]).toEqual(['plugins/mine']);
  });
});

describe('classifyPath — normalisation', () => {
  // Deleting toForwardSlash() left the predecessor's suite green: no fixture
  // carried a Windows separator, and every matcher compares '/' literally.
  it('classifies a Windows-shaped path', () => {
    expect(tagsOf(String.raw`packages\cli\.claude\rules\x.md`, 'x.md')).toContain(RULES_FILE);
    expect(tagsOf(String.raw`apps\web\.claude\agents\a.md`, 'a.md')).toContain(SUBAGENT);
  });

  // Deleting .toLowerCase() also left it green. On macOS and Windows these are
  // the same directory as the lowercase spelling.
  it('classifies an upper-cased directory', () => {
    expect(tagsOf('.CLAUDE/RULES/x.md', 'x.md')).toContain(RULES_FILE);
    expect(tagsOf('Packages/CLI/.Claude/Agents/A.md', 'a.md')).toContain(SUBAGENT);
  });
});

describe('loading classes', () => {
  it.for([
    ['CLAUDE.md', 'claude.md', 'always'],
    ['CLAUDE.local.md', 'claude.local.md', 'always'],
    ['skills/x/SKILL.md', 'skill.md', 'selected'],
    ['.claude/agents/a.md', 'a.md', 'selected'],
    ['.claude/commands/c.md', 'c.md', 'selected'],
  ])('charges %s as %s', ([path, basename, expected]) => {
    expect(loadingOf(path as string, basename as string)).toBe(expected);
  });

  // ⛔ The two corrections. A missing loading row is a positive statement — "a
  // path cannot answer this" — and the predecessor hardcoded both.
  it('does not charge a rules file, because `paths:` frontmatter decides', () => {
    expect(tagsOf(ROOT_RULE, 'x.md')).toEqual([RULES_FILE]);
    expect(loadingOf(ROOT_RULE, 'x.md')).toBeUndefined();
  });

  // ⛔ The client parses these; their bytes never reach a context window, so
  // "when is this body charged" has no answer. Calling them `referenced` put
  // them in the same bucket as a README, whose bytes a walk really does charge.
  it.for([
    [`.claude/${SETTINGS_JSON}`, SETTINGS_JSON, SETTINGS],
    [MCP_JSON, MCP_JSON, MCP_CONFIG],
    ['README.md', README_MD, 'readme'],
    [`.claude-plugin/${PLUGIN_JSON}`, PLUGIN_JSON, PLUGIN_MANIFEST],
    [`.claude-plugin/${MARKETPLACE_JSON}`, MARKETPLACE_JSON, 'marketplace-manifest'],
  ])('locates %s without charging it', ([path, basename, tag]) => {
    expect(tagsOf(path as string, basename as string)).toEqual([tag]);
    expect(loadingOf(path as string, basename as string)).toBeUndefined();
  });

  it('does not charge AGENTS.md, because the import graph decides', () => {
    expect(tagsOf('AGENTS.md', 'agents.md')).toEqual(['agents-md']);
    expect(loadingOf('AGENTS.md', 'agents.md')).toBeUndefined();
  });

  // ⛔ The FULL row array, not a projection of it. Both helpers above are
  // blind to a `{ tag: 'loading', value: null }` row: `tagsOf` filters
  // LOADING_TAG out entirely, and `loadingOf` coalesces `null ?? undefined`, so
  // "a loading row that says nothing" and "no loading row" read identically
  // through either. That is a real state the classifier can reach — drop the
  // `convention.loading !== null` guard and every `rules-file`, `agents-md`,
  // `readme` and manifest carries one — and the only thing keeping it out of
  // `resource_tags` today is the contributor's own `tag.value !== null` test,
  // one module away. Pin it where it is produced.
  it.for([
    [ROOT_RULE, 'x.md', RULES_FILE],
    ['AGENTS.md', 'agents.md', 'agents-md'],
    ['README.md', README_MD, 'readme'],
    [`.claude-plugin/${PLUGIN_JSON}`, PLUGIN_JSON, PLUGIN_MANIFEST],
  ])('emits NO loading row at all for %s — the whole row array is just its tag', ([path, basename, tag]) => {
    expect(classifyPath(path as string, basename as string, NO_PLUGINS)).toEqual([
      { tag, value: null },
    ]);
  });

  it('emits exactly one loading row, carrying its value, for a charged path', () => {
    expect(classifyPath('CLAUDE.md', 'claude.md', NO_PLUGINS)).toEqual([
      { tag: 'claude-md', value: null },
      { tag: LOADING_TAG, value: 'always' },
    ]);
    expect(classifyPath('.claude/commands/ship.md', 'ship.md', NO_PLUGINS)).toEqual([
      { tag: COMMAND, value: null },
      { tag: LOADING_TAG, value: 'selected' },
    ]);
  });

  it('still charges a file whose other convention answers', () => {
    // `.claude/agents/README.md` is both — the readme row must not erase the
    // subagent's class, nor the other way round.
    const tags = tagsOf('.claude/agents/README.md', README_MD);
    expect(tags).toContain(SUBAGENT);
    expect(tags).toContain('readme');
    expect(loadingOf('.claude/agents/README.md', README_MD)).toBe('selected');
  });
});

describe('strongestLoading', () => {
  // Tested directly: today's vocabulary lists its classes strongest-first, so
  // through classifyPath() "strongest wins" and "first match wins" agree on
  // every path that exists, and a rank-everything-equally mutant survives the
  // entire path-level suite above.
  it.for([
    [['selected', 'always'], 'always'],
    [['always', 'selected'], 'always'],
    [['selected'], 'selected'],
    [['always'], 'always'],
  ] as const)('reduces %j to %s', ([classes, expected]) => {
    expect(strongestLoading([...classes])).toBe(expected);
  });

  it('answers undefined when nothing could be charged', () => {
    expect(strongestLoading([])).toBeUndefined();
  });
});

describe('conventions deliberately absent', () => {
  // `.changeset/*.md` is the npm Changesets release tool. No agent harness
  // reads it, this repo has no `.changeset/`, and 0 of 2,168 files matched — a
  // built-in that fires nowhere and models nothing the vocabulary is about.
  it.for([
    ['.changeset/proud-pans-shake.md', 'proud-pans-shake.md'],
    ['.changeset/config.json', 'config.json'],
    ['GEMINI.md', 'gemini.md'],
  ])('does not classify %s', ([path, basename]) => {
    expect(classifyPath(path as string, basename as string, NO_PLUGINS)).toEqual([]);
  });

  it('leaves filesystem state to the columns that measured it', () => {
    // `gitignored`, `symlink` and `dangling-symlink` come from lstat and the
    // ignore oracle, never from a name.
    const tags = classifyPath('node_modules/pkg/README.md', README_MD, NO_PLUGINS).map((t) => t.tag);
    expect(tags).not.toContain('gitignored');
    expect(tags).not.toContain('symlink');
  });
});
