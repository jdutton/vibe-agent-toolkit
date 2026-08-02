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
 *
 *    Both halves of that sentence are statements about somebody else's product,
 *    and clause 1 outranking clause 2 rests on them. No test in this repo can
 *    contradict either — they can only be re-read:
 *
 * @vendor-claim reviewed=2026-08-02 verify=Install a marketplace with /plugin marketplace add and confirm ~/.claude/plugins/marketplaces/<name> is a git working copy; confirm dataverse still ships templates/CLAUDE.md
 *
 * 2. **Not git-visible source** — the `SKILL.md` is gitignored, or it lies
 *    outside any git repository. A built `dist/` bundle is gitignored; an
 *    unpacked tarball is outside a repo; a working tree's skill is neither.
 *
 * Neither clause consults the project's config, and neither is CONDITIONAL on it:
 * `vat audit` asks this question in its config-aware lane exactly as it does in
 * its wild one. The config-declaration test was not merely replaced inside this
 * module — it also had to stop gating whether this module is reached, or it
 * survives at the caller in its purest form, where it can only suppress.
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
 *
 * ## When git cannot be consulted
 *
 * Clause 2 is only as good as git's willingness to answer, and `gitLsFiles`
 * returns the same `null` for a missing binary, a corrupt `.git` and an
 * unreadable one. That `null` used to arrive here as "not ignored" — i.e. source,
 * i.e. silence — so the detector switched itself off and the run still reported
 * `status: success` with nothing to indicate why. This module therefore has a
 * third answer, `'indeterminate'`, and reports it (see
 * {@link distributedTreeFindings}) rather than guessing in either direction.
 */

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { detectPackagedAgentInstructionFiles, materializeIssue } from '@vibe-agent-toolkit/agent-skills';
import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import {
  gitFindRoot,
  GitTracker,
  issueLocation,
  normalizePath,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

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

/**
 * Cache of (canonical SKILL.md path → verdict).
 *
 * The walk asks the same question about the same skill twice: once to decide
 * whether this skill's crawl OWNS the subtree below it (see
 * {@link crawlOwnsSubtree}) and once when the crawl runs. Both answers derive
 * from filesystem and git state, which is fixed for the duration of one audit —
 * so it is memoized rather than re-derived, and cleared alongside the tracker it
 * is derived from, which is what every reset path already calls.
 */
const provenanceCache: Map<string, SkillTreeProvenance> = new Map();

/** Clear the per-root tracker cache (see `resetAuditCaches`). */
export function resetGitTrackerCache(): void {
  gitTrackerCache.clear();
  provenanceCache.clear();
}

/**
 * Where a scanned skill tree came from, as far as the filesystem can testify.
 *
 * `'repo-source'` — a working tree somebody is authoring in.
 * `'distributed'` — an artifact somebody published: a built bundle, an installed
 * skill or plugin, an unpacked third-party tarball.
 * `'indeterminate'` — the question could not be asked, because git could not be
 * consulted. A THIRD state, not a default: the two-valued version of this type
 * forced every git failure into `'repo-source'` (see
 * {@link classifyScannedSkillTree}), which is the answer that stays silent.
 */
export type SkillTreeProvenance = 'repo-source' | 'distributed' | 'indeterminate';

/**
 * The silent verdict, spelled once.
 *
 * Three call sites now test for it — the two clauses that return it and
 * {@link crawlOwnsSubtree}, which is defined as "not this" — and a verdict
 * literal that drifts in one of them fails open.
 */
const REPO_SOURCE: SkillTreeProvenance = 'repo-source';

/**
 * One canonical, forward-slashed spelling of a path — symlinks resolved, and on a
 * case-insensitive filesystem (macOS, NTFS) the case as it is stored on disk.
 *
 * Every comparison in this module goes through it, and both sides of every
 * comparison do, because two unrelated defects follow from comparing paths as the
 * caller happened to spell them:
 *
 * - `~/.claude` is very often a SYMLINK into a dotfiles checkout. Auditing that
 *   checkout by its real path missed the install-root clause entirely: the same
 *   physical files, two verdicts, decided by which spelling was typed.
 * - `GitTracker`'s active set is keyed by exact string while the `existsSync`
 *   qualifier beside it is case-INsensitive, so `<repo>/Skills/demo/SKILL.md`
 *   read as "absent from the set and present on disk" ⇒ ignored ⇒ distributed:
 *   a false finding against tracked source, reachable by tab-completion.
 *
 * Canonicalising the SKILL.md before deriving the git root is what keeps the
 * second fix honest — the tracker's own keys are built from the root it is given,
 * so a canonical lookup against a non-canonical root would miss every time.
 */
function canonicalPath(filePath: string): string {
  return toForwardSlash(normalizePath(safePath.resolve(filePath)));
}

/**
 * True when `absolutePath` is `root` or lies beneath it.
 *
 * Both sides are put through {@link toForwardSlash} first: a Windows caller can
 * hand us a backslash path, and a prefix test across mixed separators reports a
 * sibling directory as "outside" — the exact shape that would quietly turn this
 * whole clause off on one platform.
 *
 * Exported because `audit.ts` asks the same containment question of the same
 * kind of path when deciding which crawl owns a subtree; a second spelling of a
 * prefix test is how the separator bug gets reintroduced on one side only.
 */
export function isWithin(root: string, absolutePath: string): boolean {
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
function isUnderClaudeInstallRoot(canonicalAbsolutePath: string): boolean {
  const { pluginsDir, skillsDir, marketplacesDir } = getClaudeUserPaths();
  // marketplacesDir is nested under pluginsDir; listed anyway so the set reads as
  // the three install destinations rather than as an accident of layout.
  return [pluginsDir, skillsDir, marketplacesDir].some((dir) =>
    isWithin(canonicalPath(dir), canonicalAbsolutePath),
  );
}

/**
 * Classify the tree holding `skillMdPath`. See this module's header for the
 * reasoning behind each clause and the order they are applied in.
 */
export async function classifyScannedSkillTree(skillMdPath: string): Promise<SkillTreeProvenance> {
  const absolute = canonicalPath(skillMdPath);
  const memoized = provenanceCache.get(absolute);
  if (memoized !== undefined) {
    return memoized;
  }
  const verdict = await classifyUncached(absolute);
  provenanceCache.set(absolute, verdict);
  return verdict;
}

/** {@link classifyScannedSkillTree}'s clauses, on an already-canonical path. */
async function classifyUncached(absolute: string): Promise<SkillTreeProvenance> {
  if (isUnderClaudeInstallRoot(absolute)) {
    return 'distributed';
  }

  const gitRoot = gitFindRoot(safePath.resolve(absolute, '..'));
  if (gitRoot === null) {
    return 'distributed';
  }

  const tracker = await getOrCreateGitTracker(gitRoot);
  // Fail CLOSED. `isIgnoredByActiveSet` cannot distinguish "git says this file is
  // tracked" from "git was never asked", and both come back `false` ⇒
  // `'repo-source'` ⇒ silence. So the detector used to switch itself off — with a
  // green status and no diagnostic — whenever `git` was missing from `PATH` or the
  // repository's `.git` was corrupt or unreadable. Ask whether git answered before
  // reading anything into its answer.
  if (!tracker.isUsable()) {
    return 'indeterminate';
  }
  return tracker.isIgnoredByActiveSet(absolute) ? 'distributed' : REPO_SOURCE;
}

/**
 * Will a crawl rooted at this SKILL.md's directory actually report the WHOLE
 * subtree beneath it — nested skills included?
 *
 * The question the directory walk needs before it descends, and it is not the
 * same as "is there a SKILL.md here". {@link distributedTreeFindings} matches at
 * any depth, so a distributed (or unclassifiable) skill's crawl covers every
 * descendant and they must stand down or one file is counted once per ancestor.
 * A `repo-source` skill's crawl does not run at all, so standing its descendants
 * down would convert a double count into silence — and provenance is NOT
 * monotone down a tree: a gitignored bundle can sit inside a tracked source
 * skill, and a scan rooted above `<claudeDir>/skills` reaches an install root
 * from outside one.
 */
export async function crawlOwnsSubtree(skillMdPath: string): Promise<boolean> {
  return (await classifyScannedSkillTree(skillMdPath)) !== REPO_SOURCE;
}

/**
 * The agent-instruction files present in a skill's own directory, when that
 * directory is a distributed tree. Empty otherwise — including when the caller
 * says a plugin lane already owns this subtree.
 *
 * `[]` declared dests, from BOTH callers, including the config-aware one that does
 * hold a `files:` block. The parameter takes skill-OUTPUT-relative dests, and the
 * tree crawled here is not an output tree — it is wherever the SKILL.md lives, so
 * a `dest` and a path relative to this root are two different coordinate systems.
 * Feeding dests in would exempt by accidental basename agreement and mislabel it
 * as intent. `vat verify` is the lane that maps a built bundle back to the config
 * that produced it, with both sides in output coordinates, and it applies the
 * explicit-`files:` exemption there — which is what
 * `PACKAGED_AGENT_INSTRUCTION_FILE`'s own remediation already tells readers.
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
  const provenance = await classifyScannedSkillTree(skillPath);
  if (provenance === REPO_SOURCE) return [];

  const treeRoot = safePath.resolve(skillPath, '..');
  const present = detectPackagedAgentInstructionFiles(treeRoot, locationRoot, []);
  if (provenance === 'distributed') return present;

  // Provenance is unknown. Report the unknown, not the files: calling them
  // packaged would assert that they travelled to a consumer, which is exactly the
  // fact that could not be established. And say nothing at all when the tree holds
  // none — with nothing to classify, no answer was lost, and a healthy git would
  // have been silent here too. That keeps the notice proportional to the actual
  // ambiguity instead of warning once per skill across a git-less container.
  if (present.length === 0) return [];
  const location = issueLocation(treeRoot, locationRoot);
  return [
    materializeIssue('TREE_PROVENANCE_INDETERMINATE', {
      location,
      detail: `${location} (${present.length} agent-instruction file(s) found, unclassified)`,
    }),
  ];
}
