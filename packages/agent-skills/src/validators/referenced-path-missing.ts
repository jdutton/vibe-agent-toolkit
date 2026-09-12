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
 * Both rules ship, and the shipped rule pair is the bottom row: **3.8% on the
 * 52-skill adopter marketplace and 10.4% on the 632-skill installed corpus**.
 * ⚠️ QUOTE BOTH, ALWAYS. The headline here used to quote 3.8% alone — the lower
 * of two numbers measured on the SAME shipped rule — which reads as a single
 * measured misfire rate rather than as the flattering end of a 2.7x spread.
 * Neither corpus is privileged: the marketplace is BUILT output (what this check
 * actually runs on) and the install corpus is bigger and more varied, so a
 * reader deciding whether to enable this needs the range, not the better half.
 *
 * 1. **Literal paths only.** A glob or a placeholder (`docs/**\/*.md`,
 *    `docs/product/<component>/prd.md`) is not a claim that a file exists.
 * 2. **First segment must be a bundled subdirectory.** This is the rule that
 *    earns the precision — 17x on the marketplace corpus, 5x on the install
 *    corpus (65.4%→3.8% and 52.1%→10.4%) — and it is the only *semantic* one.
 *    The lexer deliberately refuses this judgement: it emits `docs/product/prd.md`
 *    and `dist/bin/arc-cli.mjs` as equal candidates because whether a token refers
 *    to the skill's own bundle or to the USER'S repository is a lens's property,
 *    not a lexical one. Until `edges`/`edge_resolutions` have producers, this
 *    prefix test IS that lens, and its measured precision is recorded above so a
 *    future lens can be held to it.
 *
 * A third rule — a plugin-wide **sibling search root**, measured at 1.9%
 * (marketplace) and 8.9% (install corpus) — was built and then DELETED, because
 * nothing could call it. The rejected
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
 * ## A path VAT'S OWN PACKAGER moved is not a missing path
 *
 * Routing relocates a bundled file, so an authored `resources/setup.sh` ships as
 * `scripts/setup.sh` under `claude-code` and as `references/setup.sh` under
 * `claude-web`. Markdown links are rewritten to follow it; bare tokens in fences
 * and code spans — this check's only input — are not. A candidate is therefore
 * only missing if it is absent under BOTH its authored spelling and its routed
 * one.
 *
 * ⛔ Routing is a function of the TARGET, not of the extension alone, so this
 * check takes the target as a required argument and asks
 * `getResourceSubdirForFile` — the same function the packager asks. It used to
 * ask the extension-only half and answer for `claude-code` whatever it was
 * packaging, which false-positived the entire `claude-web` target. See
 * {@link routedSpelling}.
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

import {
  CLAUDE_WEB_REFERENCES_SUBDIR,
  getResourceSubdirForFile,
  type PackagingTarget,
  TARGET_SUBDIR_CATEGORIES,
} from '../content-type-routing.js';

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
 *
 * ⚠️ It is also the SHIPPED rule, and that is load-bearing rather than tidiness.
 * `bundledPathCandidates` used to re-derive the same two steps inline — a
 * `bundleRelativeSegments` call followed by its own `BUNDLED_SUBDIRS.has(…)` —
 * so every assertion in this module's `isBundledSubdirPath` describe block
 * pinned a COPY of the rule. Lower-casing the lookup in the production line left
 * all eight of them green. This lane has already shipped that exact defect once
 * (a filter whose only caller was a unit test ran at double its documented
 * misfire rate), so there is ONE definition and production calls it.
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
    // `bundleRelativeSegments` runs here for the NORMALIZATION it does
    // (`./scripts/x.mjs` and `scripts\x.mjs` collapse onto one spelling, so one
    // allow glob waives all of them). The bundled-subdir JUDGEMENT is
    // `isBundledSubdirPath`'s and is CALLED, never re-derived — see that
    // function for why re-deriving it made its whole test block vacuous.
    const segments = bundleRelativeSegments(ref.raw);
    if (segments === null || !isBundledSubdirPath(ref.raw)) continue;
    out.add(segments.join('/'));
  }
  return [...out];
}

/**
 * Existence-only probe for one bundle-relative path.
 *
 * `rel` IS document content — the least trusted input in this module — so it is
 * constrained before it gets here rather than trusted: it reached this line only
 * by passing `bundleRelativeSegments`, which admits a relative path with no
 * empty, `.` or `..` segment and refuses every glob and placeholder character,
 * and by being rooted at one of the five known bundled subdirectory names.
 * `skillDir` is the caller's own directory. Nothing is read, nothing is written,
 * and a `true` merely suppresses a warning.
 *
 * {@link routedSpelling}'s output is derived from the same constrained value —
 * a basename of it, under a name from the routing table — so it inherits the
 * argument rather than needing its own.
 */
function bundleHas(skillDir: string, rel: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
  return existsSync(safePath.join(skillDir, rel));
}

/**
 * Where the packager would actually put a file with this basename, FOR THIS
 * TARGET.
 *
 * 🚨 **VAT's own packaging manufactures this finding, and this is the guard.**
 * Content-type routing relocates an auto-discovered bundled file, discarding the
 * subdirectory its author chose: under `claude-code` by EXTENSION, so source
 * `resources/setup.sh` ships as `scripts/setup.sh`, `scripts/config.json` as
 * `templates/config.json`, `assets/runtime.wasm` as `resources/runtime.wasm`;
 * under `claude-web` by flattening every resource into `references/`. The
 * packager rewrites markdown LINKS to the routed destination, so those stay
 * correct — but a bare token in a code fence or code span is deliberately NOT
 * rewritten, and bare tokens are precisely what {@link bundledPathCandidates}
 * reads. So a skill that says ``bash resources/setup.sh`` in a fenced block, and
 * links `resources/setup.sh` in prose, gets one rewritten reference that
 * resolves and one unrewritten one that reports a file which DID ship.
 *
 * That misfire is unfixable by the author: the registered remedy ("Ship the
 * file, correct the path…") names no action that resolves it, because writing
 * the packaged spelling into the source breaks the source repo, where the file
 * really is under the authored subdirectory.
 *
 * 🚩 The guard used to call `getTargetSubdir` — the EXTENSION half — while the
 * packager routed through `getResourceSubdirForFile(file, target)`. Two routing
 * answers for one question, and the half this file happened to hold was the
 * `claude-code` one, so the whole `claude-web` target false-positived: the same
 * fixture was clean under `--target claude-code` and raised
 * `PACKAGED_REFERENCED_PATH_MISSING` under `--target claude-web`, on a file that
 * did ship. Reachable from the shipped `vat skills package --target claude-web`.
 * `target` is a REQUIRED parameter all the way up to `packageSkill` for that
 * reason: a default here would let the next caller re-acquire the wrong answer
 * by saying nothing.
 *
 * So a candidate is only missing if it is absent under BOTH its authored
 * spelling and its routed one. The suppression is deliberately narrow — a
 * basename-for-basename relocation, which is exactly the shape routing produces
 * — and it costs one extra `existsSync` on a path that already failed one.
 */
function routedSpelling(rel: string, target: PackagingTarget): string {
  const basename = rel.slice(rel.lastIndexOf('/') + 1);
  return `${getResourceSubdirForFile(basename, target)}/${basename}`;
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
 *   real coverage to it. The measured fire rates that ship are the skill-local
 *   **3.8% (marketplace) / 10.4% (install corpus)**; the 1.9% / 8.9% pair
 *   describes a check VAT does not run. If a plugin-aware lens is ever built, it
 *   can grow its own resolution rule with its own measurement; a dead parameter
 *   is not a head start.
 */
export async function detectMissingReferencedPaths(
  docFiles: readonly string[],
  skillDir: string,
  target: PackagingTarget,
): Promise<ValidationIssue[]> {
  const registryEntry = CODE_REGISTRY.PACKAGED_REFERENCED_PATH_MISSING;
  const issues: ValidationIssue[] = [];

  for (const docFile of docFiles) {
    const candidates = await bundledPathCandidates(docFile);
    const missing = candidates.filter(
      rel => !bundleHas(skillDir, rel) && !bundleHas(skillDir, routedSpelling(rel, target)),
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
