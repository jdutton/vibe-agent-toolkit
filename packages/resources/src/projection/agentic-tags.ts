/**
 * The agentic-convention vocabulary: which harness convention a path *is*, and
 * what that costs an agent in context.
 *
 * ## The organising axis is where selection logic lives
 *
 * Frontmatter exists where selection logic exists. An always-loaded file is
 * pure prose, because nothing chooses it — it is simply present. A
 * conditionally-loaded file carries a typed header the harness indexes without
 * reading the body, because something must decide whether to load it. So every
 * convention carries a {@link TagLoading} class, and that class — not the file
 * kind — is what a context-budget check reads:
 *
 * | loading | files | context cost |
 * |---|---|---|
 * | `always` | `CLAUDE.md`, `AGENTS.md` | charged **every turn**, unconditionally |
 * | `selected` | `SKILL.md`, subagents, commands, `.claude/rules/*` | index entry always; body only when chosen |
 * | `referenced` | anything merely linked | nothing until traversed |
 *
 * ⚠️ **`.claude/rules/*` are `selected`, not `always`** — this was corrected by
 * measurement, not taste. In the only corpus with rules files at scale all 53
 * carry a `paths:` frontmatter glob and load only when a session touches a
 * matching file; that repo's own budget gate excludes them from its chain sum
 * for exactly this reason. Charging them as always-loaded overstated that
 * corpus by 29,715 tokens — a 3x error on the very metric the check reports.
 *
 * ## Case-insensitivity is a construction property, not a courtesy
 *
 * Every match here is against a lowercased basename. VAT compares
 * `=== 'SKILL.md'` case-sensitively at ten sites across four packages, with
 * exactly one handling both cases. On macOS and Windows `skill.md` is the same
 * file, so nine of those ten paths classify it as generic markdown. Matching on
 * the lowercased form is why `resource_realizations.basenameLower` is a column
 * rather than a function call at each site.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/** What a convention costs an agent's context, and when. */
export type TagLoading = 'always' | 'referenced' | 'selected';

/** The tag whose value carries a resource's {@link TagLoading} class. */
export const LOADING_TAG = 'loading';

/**
 * One classification of a path.
 *
 * `value` is null for a boolean-presence tag — the tag's own name is the whole
 * fact. Only {@link LOADING_TAG} carries a value today.
 */
export interface AgenticTag {
  readonly tag: string;
  readonly value: string | null;
}

/** A convention recognised by the shape of its path. */
interface Convention {
  readonly tag: string;
  readonly loading: TagLoading;
  /** Answers "is this path this convention?" given its lowercased basename and root-relative path. */
  readonly matches: (basenameLower: string, pathLower: string) => boolean;
}

/**
 * Whether a path sits directly inside `<anything>/<dir>/`, or at `<dir>/` from
 * the root.
 *
 * Direct containment rather than "contains the segment", because
 * `.claude/commands/git/commit.md` and `.claude/agents/README.md` are different
 * questions from `docs/.claude/rules/x.md`, and a substring test conflates all
 * three. Nested command directories are a real Claude Code shape, so `command`
 * deliberately uses {@link underDirectory} instead.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param dir - Directory path the file must sit directly inside, e.g. `.claude/rules`
 * @returns True when the path's parent directory is exactly `dir`
 */
function directlyInside(pathLower: string, dir: string): boolean {
  const cut = pathLower.lastIndexOf('/');
  if (cut === -1) return false;
  return pathLower.slice(0, cut) === dir || pathLower.slice(0, cut).endsWith(`/${dir}`);
}

/**
 * Whether a path sits anywhere beneath `<anything>/<dir>/`.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param dir - Ancestor directory path, e.g. `.claude/commands`
 * @returns True when `dir` is an ancestor directory of the path
 */
function underDirectory(pathLower: string, dir: string): boolean {
  // eslint-disable-next-line local/no-path-startswith -- classifyPath() runs toForwardSlash() before any matcher sees the path, so there are no mixed separators to trip over here
  return pathLower.startsWith(`${dir}/`) || pathLower.includes(`/${dir}/`);
}

/**
 * The built-in vocabulary, in match order.
 *
 * A path may carry several tags — `.claude/agents/foo.md` is a `subagent`, and
 * nothing stops a config-declared tag also matching it — so this list is
 * evaluated in full rather than stopping at the first hit. Order therefore
 * affects only the order of the returned rows, which the projection sorts
 * anyway.
 */
const CONVENTIONS: readonly Convention[] = [
  // Always-loaded: pure prose, no frontmatter, charged every turn.
  { tag: 'claude-md', loading: 'always', matches: (b) => b === 'claude.md' },
  { tag: 'agents-md', loading: 'always', matches: (b) => b === 'agents.md' },

  // Selected: indexed by a header or a glob, body loaded on demand.
  { tag: 'skill-md', loading: 'selected', matches: (b) => b === 'skill.md' },
  {
    tag: 'rules-file',
    loading: 'selected',
    matches: (b, p) => b.endsWith('.md') && directlyInside(p, '.claude/rules'),
  },
  {
    tag: 'subagent',
    loading: 'selected',
    matches: (b, p) => b.endsWith('.md') && directlyInside(p, '.claude/agents'),
  },
  {
    // Nested on purpose: `.claude/commands/git/commit.md` is a real shape, and
    // it is a command.
    tag: 'command',
    loading: 'selected',
    matches: (b, p) => b.endsWith('.md') && underDirectory(p, '.claude/commands'),
  },

  // Referenced: configuration and manifests. An agent pays for these only if
  // something walks to them.
  {
    tag: 'settings',
    loading: 'referenced',
    matches: (b, p) =>
      (b === 'settings.json' || b === 'settings.local.json') && directlyInside(p, '.claude'),
  },
  { tag: 'mcp-config', loading: 'referenced', matches: (b) => b === '.mcp.json' },
  {
    tag: 'plugin-manifest',
    loading: 'referenced',
    matches: (b, p) => b === 'plugin.json' && directlyInside(p, '.claude-plugin'),
  },
  {
    tag: 'marketplace-manifest',
    loading: 'referenced',
    matches: (b, p) => b === 'marketplace.json' && directlyInside(p, '.claude-plugin'),
  },
  { tag: 'readme', loading: 'referenced', matches: (b) => b === 'readme.md' },
  {
    tag: 'changeset',
    loading: 'referenced',
    matches: (b, p) => b.endsWith('.md') && b !== 'readme.md' && directlyInside(p, '.changeset'),
  },
];

/**
 * Classify one realization by its path.
 *
 * Derives only what a path can answer. Tags that describe filesystem *state* —
 * `gitignored`, `symlink`, `dangling-symlink` — are not here on purpose: they
 * come from `resource_realizations` columns that `lstat` and the ignore oracle
 * already populated, and re-deriving them from a name would be inventing an
 * answer the projection already holds.
 *
 * @param path - Root-relative, forward-slash separated path
 * @param basenameLower - The realization's `basenameLower` column
 * @returns Convention tags plus one {@link LOADING_TAG} row when any matched,
 *   or an empty array for a path carrying no recognised convention
 *
 * @example
 * ```typescript
 * classifyPath('docs/CLAUDE.md', 'claude.md');
 * // [{ tag: 'claude-md', value: null }, { tag: 'loading', value: 'always' }]
 * ```
 */
export function classifyPath(path: string, basenameLower: string): readonly AgenticTag[] {
  // Normalised here, once, so every matcher below can compare separators
  // literally. A Windows-shaped path reaching a matcher would silently classify
  // nothing — the quiet failure this single call exists to make impossible.
  const pathLower = toForwardSlash(path).toLowerCase();
  const tags: AgenticTag[] = [];
  let loading: TagLoading | undefined;

  for (const convention of CONVENTIONS) {
    if (!convention.matches(basenameLower, pathLower)) continue;
    tags.push({ tag: convention.tag, value: null });
    // Strongest class wins: a file that is always-loaded under any of its
    // classifications is always-loaded, full stop. A budget check that took
    // the last match would under-report exactly the files it exists to find.
    if (loading === undefined || rank(convention.loading) > rank(loading)) {
      loading = convention.loading;
    }
  }

  if (loading !== undefined) tags.push({ tag: LOADING_TAG, value: loading });
  return tags;
}

/**
 * Order the loading classes by context cost, cheapest first.
 *
 * @param loading - The class to rank
 * @returns A comparable rank, higher meaning more expensive
 */
function rank(loading: TagLoading): number {
  if (loading === 'always') return 2;
  if (loading === 'selected') return 1;
  return 0;
}
