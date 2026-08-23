/**
 * The agentic-convention vocabulary: which harness convention a path *is*, and
 * what that costs an agent in context.
 *
 * ## The organising axis is where selection logic lives
 *
 * Frontmatter exists where selection logic exists. An always-loaded file is
 * pure prose, because nothing chooses it — it is simply present. A
 * conditionally-loaded file carries a typed header the harness indexes without
 * reading the body, because something must decide whether to load it. So a
 * convention may carry a {@link TagLoading} class, and that class — not the
 * file kind — is what a context-budget check reads:
 *
 * | loading | files | context cost |
 * |---|---|---|
 * | `always` | `CLAUDE.md`, `CLAUDE.local.md` | charged **every turn**, unconditionally |
 * | `selected` | `SKILL.md`, subagents, commands | index entry always; body only when chosen |
 *
 * **Two values, both with a real producer.** An earlier draft had a third,
 * `referenced`, for "nothing until traversed". It was dropped because it is true
 * of a README and equally true of every `.ts` file in the tree, so as a class it
 * partitioned nothing. The question worth asking — *is this reachable from
 * something already loaded* — is a property of the link closure, which a path
 * classifier cannot see and a closure contributor can. When one produces it, the
 * value comes back; `resource_tags.value` is a plain nullable string, so that
 * costs no schema change.
 *
 * ## ⛔ The class is about the MODEL's context, not about the client's inputs
 *
 * `settings.json`, `.mcp.json`, `plugin.json` and `marketplace.json` carry **no**
 * loading class, and the reason is not that they are cheap — it is that the
 * question does not apply. The **client** parses them; their bytes never enter a
 * context window under any traversal, so "when is this body charged" has no
 * answer. An earlier draft called them `referenced`, which put them in the same
 * bucket as a README, whose bytes a link walk really does charge in full.
 *
 * That conflation is not cosmetic — it breaks the first consumer in **both**
 * directions at once. A budget check summing `tokenEstimate` over `referenced`
 * files would count JSON the model can never read, while missing the cost those
 * files actually cause: an `.mcp.json` naming three servers might be 200 tokens
 * of its own and inject several thousand tokens of tool schemas into the system
 * prompt. The indirect cost is real and worth modelling one day; it is a
 * different quantity, needing a different estimator, and it is not `loading`.
 * Inventing a fourth class for it now would ship a value with no producer and no
 * consumer, which is how `deferred-source` and `entry-point` got into the
 * earlier draft.
 *
 * ## ⛔ Conventions that deliberately carry NO loading class
 *
 * A missing `loading` row is a positive statement — *"a path cannot answer
 * this"* — and is the correction that distinguishes this vocabulary from its
 * first draft. Each case is a **graph or frontmatter** property that a
 * classifier reading only a path would have to guess at:
 *
 * - **`rules-file`.** Anthropic documents that *"rules without a `paths` field
 *   are loaded unconditionally"* and rules with one load only when a session
 *   touches a matching file. The earlier draft hardcoded `selected` on the
 *   strength of one corpus where all 53 rules files carried `paths:` — but
 *   53/53 is a **base rate, not a rule**, and the same measurement showed that
 *   getting this wrong in the other direction overstated that corpus by 29,715
 *   tokens, a 3× error on the metric the check exists to report. Computing it
 *   needs `blobs.frontmatter`, which costs the blob stage; §7's budget check
 *   excludes rules files anyway, so nothing loses a consumer by waiting.
 * - **`agents-md`.** *"Claude Code reads `CLAUDE.md`, not `AGENTS.md`."* An
 *   `AGENTS.md` enters context only where a `CLAUDE.md` imports it (`@AGENTS.md`)
 *   or a symlink aliases it — which makes its loading class a property of the
 *   **import graph**, not of its basename. A repo with an unimported `AGENTS.md`
 *   would be over-reported by any per-basename answer.
 * - **`settings`, `mcp-config`, `plugin-manifest`, `marketplace-manifest`** — the
 *   client's inputs, never the model's. See the section above.
 *
 * ## Case-insensitivity is a construction property, not a courtesy
 *
 * Every match here is against a lowercased basename. VAT compares
 * `=== 'SKILL.md'` case-sensitively at ten sites across four packages, with
 * exactly one handling both cases. On macOS and Windows `skill.md` is the same
 * file, so nine of those ten paths classify it as generic markdown. Matching on
 * the lowercased form is why `resource_realizations.basenameLower` is a column
 * rather than a function call at each site.
 *
 * @vendor-claim reviewed=2026-08-21 verify=Re-read https://code.claude.com/docs/en/memory
 *   ("Organize rules with `.claude/rules/`" for recursive discovery and the
 *   paths-less loading rule; the "AGENTS.md" section for the AGENTS.md sentence;
 *   "Import additional files" for CLAUDE.local.md) and
 *   https://code.claude.com/docs/en/sub-agents ("Claude Code scans
 *   `.claude/agents/` and `~/.claude/agents/` recursively").
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/** What a convention costs an agent's context, and when. */
export type TagLoading = 'always' | 'selected';

/** The tag whose value carries a resource's {@link TagLoading} class. */
export const LOADING_TAG = 'loading';

/**
 * The tag a `CLAUDE.md` or `CLAUDE.local.md` carries.
 *
 * Exported so a consumer selecting these files NAMES the vocabulary this module
 * owns instead of re-spelling the basename test. A second spelling drifts the
 * first time either side changes, and the drift is silent: a consumer's private
 * glob keeps matching what it always matched while the classifier moves on.
 */
export const CLAUDE_MD_TAG = 'claude-md';

/** The tag a markdown file under a `.claude/rules/` directory carries — see {@link CLAUDE_MD_TAG}. */
export const RULES_FILE_TAG = 'rules-file';

/**
 * Directory a plugin's auto-discovered components live in, relative to its root.
 *
 * Mirrors `CONVENTIONAL_COMPONENT_DIRS` in
 * `claude-marketplace/src/projection/plugin-extent.ts`, which is the extent
 * side of the same fact. Only the two that this vocabulary has a tag for are
 * named here: `hooks/` and `skills/` are discovered by that contributor too,
 * but `skills/**\/SKILL.md` is already tagged by basename and there is no
 * `hook` tag in the modelled vocabulary.
 */
const PLUGIN_COMPONENT_DIRS = { agents: 'agents', commands: 'commands' } as const;

/** The manifest whose presence *makes* a directory a plugin root. */
const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

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

/**
 * Root-relative directories that are plugin roots, lowercased and
 * forward-slashed; the empty string denotes the corpus root itself.
 *
 * A set rather than a predicate because it is derived once per population from
 * the realization table and then consulted once per path.
 */
export type PluginRoots = ReadonlySet<string>;

/** A convention recognised by the shape of its path. */
interface Convention {
  readonly tag: string;
  /** Null where a path cannot answer the loading question — see the header. */
  readonly loading: TagLoading | null;
  /** Answers "is this path this convention?" given its lowercased basename and root-relative path. */
  readonly matches: (basenameLower: string, pathLower: string, pluginRoots: PluginRoots) => boolean;
}

/**
 * Whether a path sits directly inside `<anything>/<dir>/`, or at `<dir>/` from
 * the root.
 *
 * Kept only for conventions the vendor documents as **flat**: a
 * `.claude-plugin/` manifest is looked for at one place, so
 * `docs/.claude-plugin/plugin.json` is a plugin and
 * `docs/.claude-plugin/nested/plugin.json` is not.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param dir - Directory path the file must sit directly inside, e.g. `.claude`
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
 * The default for every `.claude/` component directory, because Anthropic
 * documents all three as recursive: rules (*"All `.md` files are discovered
 * recursively"*), subagents (*"scans `.claude/agents/` … recursively, so you can
 * organize definitions into subfolders"*), and commands. The earlier draft used
 * {@link directlyInside} for rules and subagents, which dropped
 * `.claude/rules/frontend/style.md` and `.claude/agents/review/security.md` on
 * the floor.
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
 * Whether a path is an auto-discovered component of some detected plugin.
 *
 * ## 🪤 Why this is anchored and `underDirectory` is not enough
 *
 * A plugin's components sit at `<plugin>/agents/`, *not* under `.claude/`, so
 * the only thing distinguishing `my-plugin/commands/ship.md` from
 * `packages/cli/src/commands/build.md` is whether a `.claude-plugin/plugin.json`
 * sits beside the component directory. A bare "directory named `commands`" rule
 * false-positives on every CLI in this monorepo — 60+ files in
 * `packages/cli/src/commands/` alone.
 *
 * Every occurrence of the segment is tried, not just the first: a plugin nested
 * inside another tree gives `vendor/my-plugin/agents/x.md`, where the winning
 * candidate is the second-to-last segment boundary, not the first.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param dir - Component directory name, e.g. `agents`
 * @param pluginRoots - Detected plugin roots, from {@link pluginRootsFrom}
 * @returns True when some ancestor of the path is a plugin root whose component
 *   directory contains it
 */
function underPluginComponentDir(pathLower: string, dir: string, pluginRoots: PluginRoots): boolean {
  // eslint-disable-next-line local/no-path-startswith -- see underDirectory: the path is already normalised
  if (pathLower.startsWith(`${dir}/`) && pluginRoots.has('')) return true;
  const needle = `/${dir}/`;
  for (let at = pathLower.indexOf(needle); at !== -1; at = pathLower.indexOf(needle, at + 1)) {
    if (pluginRoots.has(pathLower.slice(0, at))) return true;
  }
  return false;
}

/**
 * Whether a path is a component of `dir`, by either route.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param dir - Component directory name, e.g. `agents`
 * @param pluginRoots - Detected plugin roots
 * @returns True for a `.claude/<dir>/**` path or a `<pluginRoot>/<dir>/**` one
 */
function isComponent(pathLower: string, dir: string, pluginRoots: PluginRoots): boolean {
  return underDirectory(pathLower, `.claude/${dir}`) || underPluginComponentDir(pathLower, dir, pluginRoots);
}

/**
 * Whether a path sits at the top of the corpus root or of a detected plugin.
 *
 * The anchor all four in-repo authorities use for `.mcp.json` — `claude-paths.ts:124`,
 * `compatibility-analyzer.ts:172`, `extract-plugin.ts:486` and `tree-copy.ts:184`
 * each look for it at a project or plugin root rather than by basename anywhere.
 * Without the anchor, a fixture or a vendored dependency's `.mcp.json` counts as
 * configuration the agent pays for, which it is not.
 *
 * @param pathLower - Root-relative, forward-slash, lowercased path
 * @param pluginRoots - Detected plugin roots
 * @returns True when the file's parent directory is the corpus root or a plugin root
 */
function atProjectOrPluginRoot(pathLower: string, pluginRoots: PluginRoots): boolean {
  const cut = pathLower.lastIndexOf('/');
  return cut === -1 || pluginRoots.has(pathLower.slice(0, cut));
}

/**
 * The built-in vocabulary, in match order.
 *
 * A path may carry several tags — `.claude/agents/README.md` is both a
 * `subagent` and a `readme` — so this list is evaluated in full rather than
 * stopping at the first hit. Order therefore affects only the order of the
 * returned rows, which the projection sorts anyway.
 *
 * ## What is deliberately absent
 *
 * - **`changeset`.** `.changeset/*.md` belongs to the npm **Changesets**
 *   release tool. No agent harness reads it, so it has no loading class and no
 *   place in a context-cost vocabulary; a corpus that wants it declares it as a
 *   config `resources.tags` glob, which is exactly the mechanism extensible
 *   tagging exists to provide.
 * - **`deferred-source` / `deferred-dest` / `entry-point`.** The first two are
 *   the skill packager's vocabulary for content it routes at build time, and
 *   the third is the output of evaluating a lens. Neither is a function of a
 *   path, so a path classifier claiming to produce them would be inventing an
 *   answer.
 * - **`gitignored` / `symlink` / `dangling-symlink`.** Filesystem *state*, which
 *   `resource_realizations` already holds in typed columns that `lstat` and the
 *   ignore oracle populated. Re-deriving them from a name would contradict a
 *   measurement with a guess.
 * - **`GEMINI.md`.** Canonical in `AGENT_INSTRUCTION_FILE_PATTERNS` for the
 *   *packaging* question ("never bundle this"), which is a different question
 *   from "what does the harness charge for it". No modelled tag, and no vendor
 *   authority for a loading class, so nothing is asserted.
 */
const CONVENTIONS: readonly Convention[] = [
  // Always-loaded: pure prose, no frontmatter, charged every turn. Both spellings
  // are documented as loaded together — "CLAUDE.md and CLAUDE.local.md files in
  // the directory hierarchy above the working directory are loaded at launch".
  {
    tag: CLAUDE_MD_TAG,
    loading: 'always',
    matches: (b) => b === 'claude.md' || b === 'claude.local.md',
  },

  // Tagged, but NOT charged — its loading class is a property of the import
  // graph. See the header.
  { tag: 'agents-md', loading: null, matches: (b) => b === 'agents.md' },

  // Selected: indexed by a header, body loaded on demand.
  { tag: 'skill-md', loading: 'selected', matches: (b) => b === 'skill.md' },

  // Tagged, but NOT charged — `paths:` frontmatter decides, and this classifier
  // does not read frontmatter. See the header.
  {
    tag: RULES_FILE_TAG,
    loading: null,
    matches: (b, p) => b.endsWith('.md') && underDirectory(p, '.claude/rules'),
  },

  // Both component conventions reach their files by two routes: under
  // `.claude/`, and under a detected plugin root.
  {
    tag: 'subagent',
    loading: 'selected',
    matches: (b, p, roots) => b.endsWith('.md') && isComponent(p, PLUGIN_COMPONENT_DIRS.agents, roots),
  },
  {
    tag: 'command',
    loading: 'selected',
    matches: (b, p, roots) => b.endsWith('.md') && isComponent(p, PLUGIN_COMPONENT_DIRS.commands, roots),
  },

  // ⛔ HARNESS CONFIGURATION — located, never charged. These four carry no
  // loading class because the model never sees their bytes under any traversal:
  // the CLIENT parses them. See the header.
  {
    tag: 'settings',
    loading: null,
    matches: (b, p) =>
      ((b === 'settings.json' || b === 'settings.local.json') && directlyInside(p, '.claude')) ||
      b === '.claude.json',
  },
  {
    tag: 'mcp-config',
    loading: null,
    matches: (b, p, roots) => b === '.mcp.json' && atProjectOrPluginRoot(p, roots),
  },
  {
    tag: 'plugin-manifest',
    loading: null,
    matches: (b, p) => b === 'plugin.json' && directlyInside(p, '.claude-plugin'),
  },
  {
    tag: 'marketplace-manifest',
    loading: null,
    matches: (b, p) => b === 'marketplace.json' && directlyInside(p, '.claude-plugin'),
  },

  // Located, never charged — for a different reason from the manifests above.
  // "Costs nothing until something walks to it" is true of a README and equally
  // true of every other file in the tree, so as a CLASS it distinguishes
  // nothing. The real question — is anything reachable from an always-loaded
  // file — is a property of the link closure, which a path cannot see.
  { tag: 'readme', loading: null, matches: (b) => b === 'readme.md' },
];

/**
 * Locate every plugin root in a set of realized paths.
 *
 * A directory is a plugin root exactly when it holds `.claude-plugin/plugin.json`,
 * which is the same test `plugin-extent.ts` applies — so the two agree by
 * construction rather than by coincidence.
 *
 * @param paths - Root-relative paths, any separator, any case
 * @returns The plugin roots, lowercased and forward-slashed; `''` for the corpus root
 *
 * @example
 * ```typescript
 * pluginRootsFrom(['plugins/mine/.claude-plugin/plugin.json']);
 * // Set { 'plugins/mine' }
 * ```
 */
export function pluginRootsFrom(paths: Iterable<string>): PluginRoots {
  const roots = new Set<string>();
  for (const path of paths) {
    const lower = toForwardSlash(path).toLowerCase();
    if (lower === PLUGIN_MANIFEST_PATH) {
      roots.add('');
    } else if (lower.endsWith(`/${PLUGIN_MANIFEST_PATH}`)) {
      roots.add(lower.slice(0, lower.length - PLUGIN_MANIFEST_PATH.length - 1));
    }
  }
  return roots;
}

/**
 * Classify one realization by its path.
 *
 * @param path - Root-relative, forward-slash separated path
 * @param basenameLower - The realization's `basenameLower` column
 * @param pluginRoots - Plugin roots for the tree this path belongs to, from
 *   {@link pluginRootsFrom}. Required rather than defaulted: a defaulted empty
 *   set is the silent-under-report direction, and it is the exact defect that
 *   made `subagent` and `command` fire zero times across 2,168 files
 * @returns Convention tags, plus one {@link LOADING_TAG} row when a matched
 *   convention could answer that question, or an empty array for a path
 *   carrying no recognised convention
 *
 * @example
 * ```typescript
 * classifyPath('docs/CLAUDE.md', 'claude.md', new Set());
 * // [{ tag: 'claude-md', value: null }, { tag: 'loading', value: 'always' }]
 * ```
 */
export function classifyPath(
  path: string,
  basenameLower: string,
  pluginRoots: PluginRoots,
): readonly AgenticTag[] {
  // Normalised here, once, so every matcher below can compare separators
  // literally. A Windows-shaped path reaching a matcher would silently classify
  // nothing — the quiet failure this single call exists to make impossible.
  const pathLower = toForwardSlash(path).toLowerCase();
  const tags: AgenticTag[] = [];
  const matched: TagLoading[] = [];

  for (const convention of CONVENTIONS) {
    if (!convention.matches(basenameLower, pathLower, pluginRoots)) continue;
    tags.push({ tag: convention.tag, value: null });
    if (convention.loading !== null) matched.push(convention.loading);
  }

  const loading = strongestLoading(matched);
  if (loading !== undefined) tags.push({ tag: LOADING_TAG, value: loading });
  return tags;
}

/**
 * The most expensive class among a path's matched conventions.
 *
 * Strongest wins: a file that is always-loaded under any of its classifications
 * is always-loaded, full stop. A budget check that took the *last* match would
 * under-report exactly the files it exists to find.
 *
 * ## 🪤 Why this is exported rather than inlined
 *
 * Today's {@link CONVENTIONS} happens to list its classes strongest-first, so
 * "strongest wins" and "first match wins" agree on every path that exists —
 * which makes the rule **unobservable through `classifyPath`**, and a mutation
 * that ranks every class equally survives the whole path-level suite. The rule
 * is load-bearing the moment a weaker convention is inserted above a stronger
 * one, so it is tested where it can actually fail rather than through a caller
 * that cannot distinguish it.
 *
 * @param classes - Loading classes of the conventions a path matched
 * @returns The most expensive class, or undefined when no matched convention
 *   could answer the loading question
 */
export function strongestLoading(classes: readonly TagLoading[]): TagLoading | undefined {
  let strongest: TagLoading | undefined;
  for (const candidate of classes) {
    if (strongest === undefined || rank(candidate) > rank(strongest)) strongest = candidate;
  }
  return strongest;
}

/**
 * Order the loading classes by context cost, cheapest first.
 *
 * Deliberately a comparison rather than an identity test even at two members:
 * the caller's rule is "strongest wins", and writing that as `=== 'always'` at
 * the call site would have to be rewritten — not merely extended — the first
 * time a third class appears.
 *
 * @param loading - The class to rank
 * @returns A comparable rank, higher meaning more expensive
 */
function rank(loading: TagLoading): number {
  return loading === 'always' ? 1 : 0;
}
