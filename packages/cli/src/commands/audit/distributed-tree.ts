/**
 * "Is this tree repository SOURCE, or an artifact somebody published?"
 *
 * `vat audit` needs an answer before it can run the presence-side detectors —
 * `PACKAGED_AGENT_INSTRUCTION_FILE` above all — because the same `CLAUDE.md`
 * means opposite things on the two sides of that line. Sitting beside a source
 * `SKILL.md` in a working repo it is ordinary repo guidance that ships nowhere;
 * sitting in a built bundle or an installed plugin it demonstrably travelled to
 * a consumer.
 *
 * ## The discriminator this replaced, and why it was wrong
 *
 * The first answer was "does the project's `vibe-agent-toolkit.config.yaml`
 * declare this SKILL.md, matched by absolute path?" — no match meant the tree
 * had been handed to us. Two ordinary cases falsify that inference, and both
 * were observed on adopter fixtures:
 *
 * - **A repo that has not adopted VAT at all** has no config, so nothing is
 *   declared. `vat audit` on a fresh repo is the first command a new user runs,
 *   and it greeted them with a warning whose first remedy is "remove the file,
 *   or move it outside the directory that is packaged" — about guidance that
 *   ships nowhere.
 * - **An adopting repo whose `include` globs do not enumerate every skill
 *   directory in the tree** — drafts, vendored copies, test fixtures. Not being
 *   named by a glob is not evidence of publication.
 *
 * ## What replaced it
 *
 * Two observable facts about where the file actually LIVES, in this order:
 *
 * 1. **Inside a Claude install root** (`plugins/`, `skills/`, `marketplaces/`
 *    under `$CLAUDE_CONFIG_DIR` or `~/.claude`) — the directories whose entire
 *    purpose is holding artifacts an installer put there. This clause wins over
 *    the git test below, and it must: Claude Code installs a marketplace by
 *    `git clone`, so an installed tree's files are TRACKED SOURCE — of somebody
 *    else's repository. For a git-distributed plugin, tracked source *is* what
 *    ships, which is precisely how a scaffold template like Anthropic's
 *    `dataverse` `templates/CLAUDE.md` reaches every consumer. Judging that tree
 *    by tracked-ness would silence the dominant audited population.
 * 2. **Not git-visible source** — the `SKILL.md` is gitignored, or it lies
 *    outside any git repository. A built `dist/` bundle is gitignored; an
 *    unpacked tarball is outside a repo; a working tree's skill is neither.
 *
 * Untracked-but-not-ignored is deliberately SOURCE, not "distributed": that is
 * a skill the author has written and not yet committed, and treating authoring
 * in progress as a distribution artifact would make the first audit of a new
 * skill the loudest one. `GitTracker`'s active set (`git ls-files --cached
 * --others --exclude-standard`) answers exactly this three-way question in O(1),
 * which is why this module reuses it rather than adding a second git-status path.
 *
 * Deliberately NOT inferred from a `dist/` path substring or from a bundle's
 * frontmatter `name`: both assert a cause the code cannot observe, and adopter
 * output directories vary. Location under an install root is not that kind of
 * guess — it is the same directory constant the `--user` scan itself is defined
 * by, resolved from {@link getClaudeUserPaths}.
 *
 * ## Known limits, both deliberate
 *
 * - A skill the author writes IN PLACE under `~/.claude/skills/` and keeps in a
 *   dotfiles repo is reported, because it is indistinguishable by location from
 *   an installed one. The install root is what a consumer's Claude reads from;
 *   a skill living there is being consumed either way.
 * - A third-party skills repo audited by `vat audit <git-url>` is a clone, so
 *   its skills read as source and stay silent. That is consistent: auditing
 *   somebody's repo source is the same situation as auditing your own. A
 *   third-party *plugin* still reports, because the plugin lane crawls the whole
 *   plugin tree independently of this classifier.
 */

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { detectPackagedAgentInstructionFiles } from '@vibe-agent-toolkit/agent-skills';
import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { gitFindRoot, GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** Cache of (gitRoot → initialized GitTracker) to avoid re-spawning ls-files. */
const gitTrackerCache: Map<string, GitTracker> = new Map();

/**
 * Get (or build) the pre-populated tracker for one git root.
 *
 * Shared with `resolveScanContext` in audit.ts so a run pays for `git ls-files`
 * once per repository, whether the caller wants scan-time gitignore filtering or
 * the provenance answer below.
 */
export async function getOrCreateGitTracker(gitRoot: string): Promise<GitTracker> {
  const cached = gitTrackerCache.get(gitRoot);
  if (cached !== undefined) {
    return cached;
  }
  const tracker = new GitTracker(gitRoot);
  await tracker.initialize();
  gitTrackerCache.set(gitRoot, tracker);
  return tracker;
}

/** Clear the per-root tracker cache (see `resetAuditCaches`). */
export function resetGitTrackerCache(): void {
  gitTrackerCache.clear();
}

/**
 * Where a scanned skill tree came from, as far as the filesystem can testify.
 *
 * `'repo-source'` — a working tree somebody is authoring in.
 * `'distributed'` — an artifact somebody published: a built bundle, an installed
 * skill or plugin, an unpacked third-party tarball.
 */
export type SkillTreeProvenance = 'repo-source' | 'distributed';

/**
 * True when `absolutePath` is `root` or lies beneath it.
 *
 * Both sides are put through {@link toForwardSlash} first: a Windows caller can
 * hand us a backslash path, and a prefix test across mixed separators reports a
 * sibling directory as "outside" — the exact shape that would quietly turn this
 * whole clause off on one platform.
 */
function isWithin(root: string, absolutePath: string): boolean {
  const normalizedRoot = toForwardSlash(root);
  const normalizedPath = toForwardSlash(absolutePath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/**
 * Is this path inside one of the directories Claude installs packages INTO?
 *
 * Resolved per call, never memoized at module load: `CLAUDE_CONFIG_DIR` is an
 * environment variable the operator (and every test fixture) is entitled to
 * change between runs, and a cached answer would describe the wrong machine.
 */
function isUnderClaudeInstallRoot(absolutePath: string): boolean {
  const { pluginsDir, skillsDir, marketplacesDir } = getClaudeUserPaths();
  // marketplacesDir is nested under pluginsDir; listed anyway so the set reads as
  // the three install destinations rather than as an accident of layout.
  return [pluginsDir, skillsDir, marketplacesDir].some((dir) =>
    isWithin(safePath.resolve(dir), absolutePath),
  );
}

/**
 * Classify the tree holding `skillMdPath`. See this module's header for the
 * reasoning behind each clause and the order they are applied in.
 */
export async function classifyScannedSkillTree(skillMdPath: string): Promise<SkillTreeProvenance> {
  const absolute = safePath.resolve(skillMdPath);
  if (isUnderClaudeInstallRoot(absolute)) {
    return 'distributed';
  }

  const gitRoot = gitFindRoot(safePath.resolve(absolute, '..'));
  if (gitRoot === null) {
    return 'distributed';
  }

  const tracker = await getOrCreateGitTracker(gitRoot);
  return tracker.isIgnoredByActiveSet(absolute) ? 'distributed' : 'repo-source';
}

/**
 * The agent-instruction files present in a skill's own directory, when that
 * directory is a distributed tree. Empty otherwise — including when the caller
 * says a plugin lane already owns this subtree.
 *
 * `[]` declared dests: this lane resolves a skill by PATH, and a distributed
 * bundle's path is not its source skill's declared path, so there is no config
 * block to read intent from here. `vat verify` is the lane that maps a built
 * bundle back to the config that produced it, and it applies the explicit-`files:`
 * exemption there.
 *
 * @param crawlTree `false` when a plugin lane already crawled this subtree.
 *   REQUIRED and never defaulted, because the wrong answer is silent in both
 *   directions: a skill nested inside a plugin is already crawled by
 *   `validatePlugin` at any depth, so crawling again reports one file twice,
 *   while omitting it for a standalone bundle is the blindness this pass exists
 *   to end.
 */
export async function distributedTreeFindings(
  skillPath: string,
  locationRoot: string,
  crawlTree: boolean,
): Promise<ValidationIssue[]> {
  if (!crawlTree) return [];
  if ((await classifyScannedSkillTree(skillPath)) === 'repo-source') return [];
  return detectPackagedAgentInstructionFiles(safePath.resolve(skillPath, '..'), locationRoot, []);
}
