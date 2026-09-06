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
 * All three were derived by measuring fire rates over 691 skills across three
 * corpora (two of them live marketplaces). Dropping any one of them makes the
 * check unusable, and the numbers are the argument:
 *
 * | Rule | adopter A, 52 built skills | 632-skill install corpus |
 * |---|---|---|
 * | candidates only | 65.4% | 52.1% |
 * | + literal (this module) | 46.2% | 47.5% |
 * | + bundled-subdir prefix | **3.8%** | **10.4%** |
 * | + sibling search root | **1.9%** | 8.9% |
 *
 * ⚠️ **Rules 1 and 2 are what SHIPS. Rule 3 has no production caller**, so the
 * shipped check runs at the 3.8% row, not the 1.9% one. `checkMissingReferencedPaths`
 * is invoked from exactly one place — the packager, which knows its own output
 * directory and not the plugin it will be installed into — and it is not exported
 * from the package root, so no CLI lane can reach it either. The parameter and its
 * measurement are kept because the sibling population is real and the seam is the
 * only place a plugin-aware caller could attach; nothing here claims that caller
 * exists. See `detectMissingReferencedPaths`'s `siblingSearchRoot` note.
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
 * 3. **Sibling search root.** A skill may legitimately reference a file at the
 *    plugin root or in a sibling skill — one measured skill points at a sibling's
 *    `resources/*.md`, another at a plugin-root `scripts/cli.py`. Both are false
 *    positives under a skill-local existence test.
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

import { existsSync, readdirSync } from 'node:fs';

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
 * Three spellings name the same file and only one of them used to be recognized:
 * `scripts/x.mjs`, `./scripts/x.mjs` (the lexer admits a leading `./`
 * unconditionally) and `scripts\x.mjs` (a Windows-authored doc). Reading the
 * first segment off the RAW token gave `.` for the second and the whole path for
 * the third, so both were dropped — and a build drop referenced as
 * `./scripts/setup.mjs` is the very case this module exists for.
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

/** Directories a resolution walk never enters — see {@link resolutionBases}. */
const UNWALKED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * How many directories a sibling-search walk may visit before giving up.
 *
 * A bound, not a tuning knob: an adopter's plugin root can sit inside a checkout
 * with an arbitrarily deep tree beneath it, and this check is a warning that must
 * not cost more than the build it rides along with. Exhausting it is REPORTED
 * rather than swallowed — see {@link RESOLUTION_SEARCH_INCOMPLETE}.
 */
const SIBLING_SEARCH_BUDGET = 5000;

/** The outcome of scanning a search root for places a reference may resolve. */
export interface ResolutionBaseScan {
  /** Absolute directories a bundle-relative path may be resolved against. */
  bases: string[];
  /** False if the walk was truncated or a directory could not be read. */
  complete: boolean;
}

/**
 * Every directory under `siblingSearchRoot` a bundle-relative reference may
 * legitimately resolve against, always including `skillDir` itself.
 *
 * ## Why this is a list of MOUNT POINTS and not "anywhere under the root"
 *
 * The predecessor asked "does a file with this suffix path exist under any
 * directory in the tree?" That is a different question from "is the referenced
 * path present", and it answers `true` for cases that are plainly not the
 * reference: a skill naming `scripts/setup.mjs` whose `scripts/` the build
 * dropped went SILENT as soon as the bundle happened to ship a documentation
 * copy at `references/scripts/setup.mjs` — i.e. it went silent on exactly the
 * build-drop class the module exists to catch.
 *
 * A bundle-relative path can only be resolved against something a bundle is
 * mounted at. Those are the search root itself (the plugin root, which is where
 * a measured skill's `scripts/cli.py` lives) and every directory holding a
 * `SKILL.md` (a sibling skill's own root). Nothing else, and in particular not
 * an arbitrary intermediate directory.
 *
 * `node_modules` and `.git` are never entered. Both can hold a `SKILL.md` —
 * skills ship on npm, and a `.git` directory holds arbitrary worktree content —
 * and neither is a mount point for THIS reference; walking them also burns the
 * budget on trees that can never legitimately answer.
 *
 * Breadth-first, over entries sorted by code point, so which directories a
 * TRUNCATED walk reached is a property of the tree alone. The predecessor was
 * depth-first off a `pop()`ed stack in `readdir` order, which means that once the
 * budget bites, adding an unrelated directory elsewhere in the tree can change
 * which directories get visited — and therefore whether a finding fires.
 *
 * @param skillDir The packaged skill — always a base, and the only one when no
 *   wider root is supplied.
 * @param siblingSearchRoot The widest tree a reference may resolve in.
 * @param budget Maximum directories to visit. The default is the operational
 *   bound; tests pass a small one to exercise the truncated path deterministically.
 */
export function resolutionBases(
  skillDir: string,
  siblingSearchRoot: string,
  budget: number = SIBLING_SEARCH_BUDGET,
): ResolutionBaseScan {
  // The shipped call passes no wider root. There is then nothing to walk: a
  // skill's own directory is the only mount point a skill-local check has, and
  // `validateNoNestedSkillMd` has already refused a second SKILL.md inside it.
  if (safePath.resolve(siblingSearchRoot) === safePath.resolve(skillDir)) {
    return { bases: [skillDir], complete: true };
  }

  const bases = [skillDir];
  const queue = [siblingSearchRoot];
  let head = 0;
  let complete = true;

  while (head < queue.length) {
    if (head >= budget) {
      complete = false;
      break;
    }
    const dir = queue[head++];
    if (dir === undefined) break;
    if (dir !== skillDir && isMountPoint(dir, siblingSearchRoot)) bases.push(dir);

    const children = walkableChildren(dir);
    if (children === null) {
      // Unreadable (permissions, a race with a concurrent build). Recorded, not
      // swallowed: a `false` from an unread directory must not be reported as a
      // fact the walk established.
      complete = false;
      continue;
    }
    queue.push(...children);
  }

  return { bases, complete };
}

/** Whether a bundle-relative path may be resolved against `dir`. */
function isMountPoint(dir: string, siblingSearchRoot: string): boolean {
  if (dir === siblingSearchRoot) return true;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `dir` is the caller-supplied search root or a directory reached from it by readdir; no component comes from document content
  return existsSync(safePath.join(dir, 'SKILL.md'));
}

/**
 * `dir`'s walkable subdirectories in a stable order, or `null` if it could not
 * be read.
 *
 * `sort` takes an explicit code-point comparator rather than `localeCompare`:
 * the ordering only has to be the SAME everywhere, and `localeCompare` is
 * locale- and ICU-dependent, which is the one property a determinism guarantee
 * cannot be built on.
 */
function walkableChildren(dir: string): string[] | null {
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as isMountPoint
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter(entry => entry.isDirectory() && !UNWALKED_DIRS.has(entry.name))
    .map(entry => safePath.join(dir, entry.name))
    .sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/**
 * Appended to the message when the walk that failed to find the path did not
 * finish. Absence is then the walk's best answer, not something it established,
 * and an adopter chasing a file that IS present needs to read that here rather
 * than deduce it.
 */
const RESOLUTION_SEARCH_INCOMPLETE =
  ' — note that the search of the surrounding tree was incomplete ' +
  '(a directory could not be read, or the walk reached its budget), ' +
  'so the file may exist somewhere the search did not reach';

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
 * ⚠️ A waiver must survive both lanes. `vat skills validate` reports the authored
 * source path and `vat build` reports the packaged artifact path, so a `location`
 * glob written for one silently leaks in the other — give ONE entry both
 * spellings rather than two entries, or each is reported `ALLOW_UNUSED` in the
 * lane it does not match. A `link` glob is immune to that split: the missing path
 * is skill-relative and identical in both lanes, which is a second reason to
 * prefer it.
 *
 * @param docFiles Absolute paths of packaged markdown documents to scan
 *   (SKILL.md and any bundled reference files).
 * @param skillDir Absolute path to the packaged skill output — the base every
 *   candidate resolves against, and the base issue locations are relative to.
 * @param siblingSearchRoot Absolute path to the widest tree a reference may
 *   legitimately resolve in (the plugin root). Defaults to `skillDir`.
 *
 *   ⚠️ **No production caller passes anything else today**, so the shipped check
 *   is the skill-local one and its fire rate is the measured 3.8%, not 1.9%. The
 *   only caller is the packager, via `checkMissingReferencedPaths`, and it
 *   genuinely does not know the plugin root: it packages one skill into its own
 *   output directory before any plugin is assembled. `vat build`'s
 *   `validateShippedPluginSkillLinks` DOES walk a whole plugin tree, but it runs
 *   only `checkBrokenPackagedLinks`, and its documented stance is the opposite
 *   one — that a skill is a self-contained portable unit and an escape from its
 *   own directory is a defect, not a resolution. Wiring this parameter there
 *   would both contradict that stance and report every finding twice.
 *
 *   The parameter stays because the sibling population is real and measured, and
 *   this is the seam a plugin-aware lens would attach at. It is not a claim that
 *   such a lens exists.
 * @param searchBudget Maximum directories the sibling-search walk may visit.
 *   Only meaningful when `siblingSearchRoot` differs from `skillDir`; see
 *   {@link resolutionBases}.
 */
export async function detectMissingReferencedPaths(
  docFiles: readonly string[],
  skillDir: string,
  siblingSearchRoot: string = skillDir,
  searchBudget?: number,
): Promise<ValidationIssue[]> {
  const registryEntry = CODE_REGISTRY.PACKAGED_REFERENCED_PATH_MISSING;
  const issues: ValidationIssue[] = [];
  const { bases, complete } = resolutionBases(skillDir, siblingSearchRoot, searchBudget);
  const searchCaveat = complete ? '' : RESOLUTION_SEARCH_INCOMPLETE;

  for (const docFile of docFiles) {
    const candidates = await bundledPathCandidates(docFile);
    const missing = candidates.filter(rel => !bases.some(base =>
      // `rel` IS document content — the least trusted input in this module — so
      // it is constrained before it gets here rather than trusted: it reached
      // this line only by passing `bundleRelativeSegments`, which admits a
      // relative path with no empty, `.` or `..` segment and refuses every glob
      // and placeholder character, and by being rooted at one of the five known
      // bundled subdirectory names. `base` is the caller's own directory or one
      // reached from it by readdir. The probe is existence only — nothing is
      // read, nothing is written — and a `true` merely suppresses a warning.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      existsSync(safePath.join(base, rel)),
    ));
    if (missing.length === 0) continue;

    const location = safePath.relative(skillDir, docFile);
    for (const rel of missing) {
      issues.push({
        severity: registryEntry.defaultSeverity,
        code: 'PACKAGED_REFERENCED_PATH_MISSING',
        message: `References "${rel}", which is not in the packaged output${searchCaveat}`,
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
