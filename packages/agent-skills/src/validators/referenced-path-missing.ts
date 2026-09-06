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
 * 1. **Literal paths only.** A glob or a placeholder (`docs/**\/*.md`,
 *    `docs/product/<component>/prd.md`) is not a claim that a file exists.
 * 2. **First segment must be a bundled subdirectory.** This is the rule that
 *    earns the precision — a 17x reduction — and it is the only *semantic* one.
 *    The lexer deliberately refuses this judgement: it emits `docs/product/prd.md`
 *    and `dist/bin/arc-cli.mjs` as equal candidates because whether a token refers
 *    to the skill's own bundle or to the USER'S repository is a lens's property,
 *    not a lexical one. Until `edges`/`edge_resolutions` have producers, this
 *    four-line prefix test IS that lens, and its measured precision is recorded
 *    above so a future lens can be held to it.
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
 * double-report the same defect with a weaker severity, so only bare tokens the
 * markdown AST did not claim are considered.
 */

import { existsSync, readdirSync } from 'node:fs';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

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

/** How many missing paths the message spells out before summarising. */
const MAX_LISTED = 4;

/**
 * Whether `token` is a literal path rooted at a bundled subdirectory.
 *
 * Exported for tests: these two predicates are the whole precision argument, and
 * pinning them directly is cheaper than reconstructing a corpus to observe them.
 */
export function isBundledSubdirPath(token: string): boolean {
  if (NON_LITERAL.test(token)) return false;
  const slash = token.indexOf('/');
  return slash > 0 && BUNDLED_SUBDIRS.has(token.slice(0, slash));
}

/**
 * Every bare-token path candidate in the document at `filePath` that is rooted at
 * a bundled subdirectory.
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
    if (ref.syntacticForm !== 'bare-token') continue;
    if (!ref.hasExtension || ref.slashCount === 0) continue;
    if (!isBundledSubdirPath(ref.raw)) continue;
    out.add(ref.raw);
  }
  return [...out];
}

/** Whether `rel` exists anywhere under `root` (bounded walk). */
function existsUnder(root: string, rel: string, budget = 5000): boolean {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < budget) {
    visited++;
    const dir = stack.pop();
    if (dir === undefined) break;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths derived from a caller-supplied output dir
    if (existsSync(safePath.join(dir, rel))) return true;
    let entries;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        stack.push(safePath.join(dir, entry.name));
      }
    }
  }
  return false;
}

/**
 * @param docFiles Absolute paths of packaged markdown documents to scan
 *   (SKILL.md and any bundled reference files).
 * @param skillDir Absolute path to the packaged skill output — the base every
 *   candidate resolves against, and the base issue locations are relative to.
 * @param siblingSearchRoot Absolute path to the widest tree a reference may
 *   legitimately resolve in (the plugin root). Defaults to `skillDir`, which makes
 *   the check skill-local and measurably noisier (3.8% vs 1.9% on a 52-skill
 *   corpus of 52 built skills); callers that know the plugin root should pass it.
 */
export async function detectMissingReferencedPaths(
  docFiles: readonly string[],
  skillDir: string,
  siblingSearchRoot: string = skillDir,
): Promise<ValidationIssue[]> {
  const registryEntry = CODE_REGISTRY.PACKAGED_REFERENCED_PATH_MISSING;
  const issues: ValidationIssue[] = [];

  for (const docFile of docFiles) {
    const candidates = await bundledPathCandidates(docFile);
    const missing = candidates.filter(rel =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- packaged output path
      !existsSync(safePath.join(skillDir, rel)) && !existsUnder(siblingSearchRoot, rel),
    );
    if (missing.length === 0) continue;

    const listed = missing.slice(0, MAX_LISTED).join(', ');
    const suffix = missing.length > MAX_LISTED ? ` (and ${missing.length - MAX_LISTED} more)` : '';
    issues.push({
      severity: registryEntry.defaultSeverity,
      code: 'PACKAGED_REFERENCED_PATH_MISSING',
      message: `References a bundled path that is not in the package: ${listed}${suffix}`,
      location: safePath.relative(skillDir, docFile),
      fix: registryEntry.fix,
      reference: registryEntry.reference,
    });
  }

  return issues;
}
