/**
 * PACKAGED_REFERENCED_PATH_MISSING — the inverse of PACKAGED_UNREFERENCED_FILE.
 *
 * `PACKAGED_UNREFERENCED_FILE` asks "is every shipped file mentioned somewhere?"
 * and answers it by searching FROM a known filename INTO the text, which needs no
 * parsing and is why it can be an error. This module asks the opposite question —
 * "is every mentioned path actually shipped?" — which requires extracting path
 * tokens from prose and code, and is therefore a warning.
 *
 * ## Why it is worth having anyway
 *
 * It is the only check that can see a BUILD DROP: a reference that is correct in
 * the source repo and whose target did not survive into the packaged output. The
 * source looks right, so neither human review nor an agent reading the source can
 * catch it. Measured instance in a live adopter marketplace: a skill names
 * `references/<setup-guide>.md` four times, that file is present at the matching
 * path in the source repository, and it is absent from the published bundle.
 *
 * ## The three rules, and why each exists
 *
 * ## The two rules, and why each exists
 *
 * Fire rates measured over **684 skills across two corpora** (one of them a live
 * marketplace). ⚠️ The heading and the prose here used to say "three rules" over
 * "691 skills across three corpora" above a table listing two that sum to 684 —
 * and to add that "dropping any one of them makes the check unusable" thirteen
 * lines above the note that rule 3 has no production caller. Rule 3 IS dropped,
 * the check ships anyway, and both of those sentences are gone rather than
 * re-dated.
 *
 * | Rule | adopter A, 52 built skills | 632-skill install corpus |
 * |---|---|---|
 * | candidates only | 65.4% | 52.1% |
 * | + literal (rule 1) | 46.2% | 47.5% |
 * | + bundled-subdir prefix (rule 2) | **3.8%** | **10.4%** |
 *
 * Both rules ship, and the 3.8% row is what runs.
 *
 * 1. **Literal paths only.** A glob or a placeholder (`docs/**\/*.md`,
 *    `docs/product/<component>/prd.md`) is not a claim that a file exists.
 * 2. **First segment must be a bundled subdirectory.** This is the rule that
 *    earns the precision — a 17x reduction — and it is the only *semantic* one.
 *    The lexer deliberately refuses this judgement: it emits `docs/product/prd.md`
 *    and `dist/bin/arc-cli.mjs` as equal candidates because whether a token refers
 *    to the skill's own bundle or to the USER'S repository is a lens's property,
 *    not a lexical one. Until `edges`/`edge_resolutions` have producers, this
 *    prefix test IS that lens, and its measured precision is recorded above so a
 *    future lens can be held to it.
 *
 * A third rule — a plugin-wide **sibling search root**, measured at 1.9% and
 * 8.9% — was built and then DELETED, because nothing could call it. The rejected
 * wiring and why a dead seam is not a head start are on
 * {@link detectMissingReferencedPaths}. The sibling population is real: one
 * measured skill points at a sibling's `resources/*.md`, another at a plugin-root
 * `scripts/cli.py`, and both are false positives here. A plugin-aware lens that
 * wants them should measure its own rule.
 *
 * ## Why this runs at the BUILT phase only
 *
 * A `files:` config entry materializes `scripts/` at build time, so a VAT source
 * skill directory legitimately lacks the subdirectory its body references —
 * a measured skill ships no `scripts/` in source and gets `scripts/<cli>.mjs`
 * injected. Running this at source phase fired on it; running it at built phase
 * does not. Measured: 15.0% source vs 9.6% built for the same naive rule.
 *
 * ## Deliberately NOT handled here
 *
 * Markdown links. `LINK_BROKEN_FILE` / `PACKAGED_BROKEN_LINK` already cover a
 * link whose target is missing, at error severity. Emitting here as well would
 * double-report the same defect with a weaker severity.
 *
 * That exclusion is enforced UPSTREAM, in the lexer, and not by anything in this
 * module: `codeContextRangesFrom` puts `inline-link`, `reference-link`,
 * `link-definition` and `image` spans into `excluded`, and `emitToken` refuses to
 * emit any token falling inside one. So an inline link, a `[text][label]`
 * reference AND its `[label]: path` definition all produce zero candidates here —
 * verified by the `does not double-report` cases in this module's unit test,
 * which assert on `bundledPathCandidates` rather than on the issue list so that
 * silence is attributed to the exclusion rather than to a missing candidate.
 *
 * The `syntacticForm !== 'bare-token'` guard below is NOT that exclusion and must
 * not be read as it. What it does is drop `env-anchored` and `at-prefixed` tokens
 * — and it is load-bearing for exactly one shape that would otherwise slip
 * through the literal test: `scripts/$VAR/x.mjs`, whose first segment IS a
 * bundled subdirectory and which carries no glob character.
 */

import { existsSync } from 'node:fs';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { CLAUDE_WEB_REFERENCES_SUBDIR, TARGET_SUBDIR_CATEGORIES } from '../content-type-routing.js';

/**
 * Subdirectories a packaged skill may bundle resources into.
 *
 * Derived from the content-type routing categories rather than re-listed, for the
 * same reason `bundled-resource-link-detection.ts` derives its copy: a hardcoded
 * list drifts from the routing table, and a category missing from it makes this
 * detector structurally unable to fire on that subdirectory.
 */
const BUNDLED_SUBDIRS: ReadonlySet<string> = new Set<string>([
  ...TARGET_SUBDIR_CATEGORIES,
  CLAUDE_WEB_REFERENCES_SUBDIR,
]);

/** Glob and placeholder syntax — a token carrying any of it is not a literal path. */
const NON_LITERAL = /[*?<>{}[\]]/u;

/**
 * `token` as bundle-relative segments, or `null` if it is not a bundle-relative
 * literal path at all.
 *
 * Two spellings reach here and only one used to be recognized: `scripts/x.mjs`
 * and `./scripts/x.mjs` (the lexer admits a leading `./` unconditionally).
 * Reading the first segment off the RAW token gave `.` for the second, so it was
 * dropped — and a build drop referenced as `./scripts/setup.mjs` is the very case
 * this module exists for.
 *
 * ⚠️ The `toForwardSlash` call also normalizes `scripts\x.mjs`, and this comment
 * used to claim that as a third recognized spelling. It is UNREACHABLE from the
 * shipped lexer, which only emits a run containing one of `/ $ % @` — a
 * backslash-only path never becomes a candidate, so no Windows-authored token
 * arrives here in that form. The normalization stays because it costs nothing and
 * a mixed `scripts/sub\x.mjs` does arrive; the CLAIM does not. The module's unit
 * test is honest about this; the comment was not.
 *
 * `null` for anything that is not a relative path INSIDE the bundle: an absolute
 * path, an empty segment (`scripts//x`), a `.` segment, or — the one that
 * matters for what happens downstream — any `..`. A token carrying `..` is not a
 * claim about the bundle's contents, and it is the segment that would otherwise
 * turn verbatim markdown content into a traversal by the time it reaches
 * `existsSync`.
 */
function bundleRelativeSegments(token: string): string[] | null {
  if (NON_LITERAL.test(token)) return null;
  const segments = toForwardSlash(token).split('/');
  if (segments[0] === '.') segments.shift();
  if (segments.length < 2) return null;
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return segments;
}

/**
 * Whether `token` is a literal path rooted at a bundled subdirectory.
 *
 * Exported for tests: these two predicates are the whole precision argument, and
 * pinning them directly is cheaper than reconstructing a corpus to observe them.
 */
export function isBundledSubdirPath(token: string): boolean {
  const segments = bundleRelativeSegments(token);
  return segments !== null && BUNDLED_SUBDIRS.has(segments[0] ?? '');
}

/**
 * Every bare-token path candidate in the document at `filePath` that is rooted at
 * a bundled subdirectory, NORMALIZED to its bundle-relative spelling.
 *
 * Normalizing here rather than at each use is what makes `./scripts/x.mjs`,
 * `scripts\x.mjs` and `scripts/x.mjs` one finding with one `link` anchor, so a
 * single allow glob waives all three spellings of the same reference.
 *
 * Goes through `parseMarkdown` rather than reaching for the lexer directly, for
 * two reasons. It keeps ONE definition of "path-shaped token" in the codebase —
 * `isCandidate` in `reference-lexer.ts` already requires a slash and a file
 * extension, which is this check's admission rule too, so re-deriving it here
 * would be a second matcher to drift. And `parseMarkdown` is the package's lazy
 * wrapper: a value import of the lexer would pull the remark stack into the eager
 * module graph of every `@vibe-agent-toolkit/resources` consumer (~730ms on
 * Windows), which `module-load-budget.integration.test.ts` exists to prevent.
 */
export async function bundledPathCandidates(filePath: string): Promise<string[]> {
  const parsed = await parseMarkdown(filePath);
  const out = new Set<string>();
  for (const ref of parsed.lexicalReferences ?? []) {
    // NOT the markdown-link exclusion — see the module docstring. This drops
    // `env-anchored` and `at-prefixed` tokens, and the shape it actually saves
    // us from is `scripts/$VAR/x.mjs`, which passes the literal test.
    if (ref.syntacticForm !== 'bare-token') continue;
    // `hasExtension` is the lexer's own fact and stays. Its `slashCount` does
    // not: it counts FORWARD slashes only, and `bundleRelativeSegments` already
    // refuses anything that does not split into at least two segments.
    if (!ref.hasExtension) continue;
    const segments = bundleRelativeSegments(ref.raw);
    if (segments === null || !BUNDLED_SUBDIRS.has(segments[0] ?? '')) continue;
    out.add(segments.join('/'));
  }
  return [...out];
}

/**
 * Emit one `PACKAGED_REFERENCED_PATH_MISSING` per missing path.
 *
 * One issue PER MISSING PATH, not one per document — and each carries the missing
 * path as `link`.
 *
 * This is what makes a single misfire waivable without disabling the rule for the
 * file. `applyAllowFilter` matches an allow glob against `location` OR `link`, so
 * an adopter can silence exactly one illustrative path:
 *
 * ```yaml
 * validation:
 *   allow:
 *     PACKAGED_REFERENCED_PATH_MISSING:
 *       - paths: ["resources/gates.md"]
 *         reason: "Illustrative path in a skill that teaches link syntax."
 * ```
 *
 * …while a DIFFERENT missing path in that same document still fires. Waiving by
 * `location` (`**\/some-skill/SKILL.md`) remains available and is the coarser
 * choice — it suppresses future real findings in that file, which is precisely
 * what the per-path form avoids.
 *
 * The three anchors are three different things, the same split
 * `REFERENCE_TARGET_MISSING` documents: `location` is the file you open, `field`
 * is not used here, and `link` is the target that does not exist — emphatically
 * NOT the location, since naming a nonexistent path as "where to look" is advice
 * you cannot follow.
 *
 * ⚠️ ONE lane, not two. This code is emitted from `packageSkill` and nowhere
 * else, so `vat skills validate` — which calls `validateSkillForPackaging(…,
 * 'source')` and never `packageSkill` — cannot produce it. This note used to tell
 * adopters to give a single allow entry BOTH the authored and packaged spellings
 * "so a waiver survives both lanes", two bullets after the same file said "built
 * phase only". Following it earns an `ALLOW_UNUSED` for the spelling that can
 * never match. A `link` glob is still the better choice, for its own reason: the
 * missing path is skill-relative, so it does not depend on where the bundle sits.
 *
 * @param docFiles Absolute paths of packaged markdown documents to scan
 *   (SKILL.md and any bundled reference files).
 * @param skillDir Absolute path to the packaged skill output — the base every
 *   candidate resolves against, and the base issue locations are relative to.
 *
 *   🚨 **SKILL-LOCAL, and there is no wider root to pass.** This function used to
 *   take a `siblingSearchRoot` and a `searchBudget`, with a ~90-line breadth-first
 *   mount-point walk behind them and a caveat string for a truncated search. NO
 *   production caller ever passed either: the only caller is the packager, via
 *   `checkMissingReferencedPaths`, and it genuinely does not know the plugin root
 *   — it packages one skill into its own output directory before any plugin is
 *   assembled. `vat build`'s `validateShippedPluginSkillLinks` does walk a whole
 *   plugin tree, and wiring this there was considered and REJECTED: it runs only
 *   `checkBrokenPackagedLinks`, its documented stance is the opposite one (a skill
 *   is a self-contained portable unit, so an escape from its own directory is a
 *   defect rather than a resolution), and it would report every finding twice.
 *
 *   So the subsystem was deleted rather than kept as a seam. `complete` was always
 *   `true`, the truncated-search caveat could never ship, and the tests that
 *   covered the walk covered a path production does not take — while attributing
 *   real coverage to it. The measured fire rate that ships is the skill-local
 *   **3.8%**, and the 1.9% figure describes a check VAT does not run. If a
 *   plugin-aware lens is ever built, it can grow its own resolution rule with its
 *   own measurement; a dead parameter is not a head start.
 */
export async function detectMissingReferencedPaths(
  docFiles: readonly string[],
  skillDir: string,
): Promise<ValidationIssue[]> {
  const registryEntry = CODE_REGISTRY.PACKAGED_REFERENCED_PATH_MISSING;
  const issues: ValidationIssue[] = [];

  for (const docFile of docFiles) {
    const candidates = await bundledPathCandidates(docFile);
    const missing = candidates.filter(rel =>
      // `rel` IS document content — the least trusted input in this module — so
      // it is constrained before it gets here rather than trusted: it reached
      // this line only by passing `bundleRelativeSegments`, which admits a
      // relative path with no empty, `.` or `..` segment and refuses every glob
      // and placeholder character, and by being rooted at one of the five known
      // bundled subdirectory names. `skillDir` is the caller's own directory. The
      // probe is existence only — nothing is read, nothing is written — and a
      // `true` merely suppresses a warning.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      !existsSync(safePath.join(skillDir, rel)),
    );
    if (missing.length === 0) continue;

    const location = safePath.relative(skillDir, docFile);
    for (const rel of missing) {
      issues.push({
        severity: registryEntry.defaultSeverity,
        code: 'PACKAGED_REFERENCED_PATH_MISSING',
        message: `References "${rel}", which is not in the packaged output`,
        location,
        // The missing path, so an allow glob can waive THIS reference without
        // silencing the whole document. Never the location: a path that does not
        // exist is not somewhere a reader can look.
        link: rel,
        fix: registryEntry.fix,
        reference: registryEntry.reference,
      });
    }
  }

  return issues;
}
