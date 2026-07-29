/**
 * test-input.ts — a skill's DECLARED test input, and the rule that it never ships.
 *
 * `skills.config.<name>.test.evals` names a skill's eval suite. That suite holds the
 * `expected_output` / `expectations` answer key for the tasks the skill is graded on,
 * so shipping it does two distinct kinds of harm:
 *
 *   1. **Distribution.** Plugin consumers download test input they have no use for —
 *      and, in the case of a published marketplace tree, the answer key to the
 *      author's own eval suite.
 *   2. **Signal.** `vat skill test` stages the built artifact. Anything the built
 *      artifact carries is reachable by the executor under test; an executor that
 *      can read its own answer key grades as a PASS while demonstrating nothing.
 *      (The harness defends this independently — see skill-test/eval-suite-isolation.ts
 *      — because "we stopped shipping it" and "the executor can't read it" must not
 *      be the same guarantee.)
 *
 * This module is the ONE definition of where a skill's test input lives, shared by
 * every packaging lane, so no lane can answer the question differently.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import type { SkillPackagingConfig } from '@vibe-agent-toolkit/resources';
import { isGlob, issueLocation, safePath, staticGlobBase, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { type SkillFileEntry } from './files-config.js';
import { DEFAULT_EVALS_SUBPATH } from './skill-test/eval-suite-isolation.js';
import { materializeIssue } from './validators/rule-engine/index.js';

/**
 * Does this skill carry the conventional suite at `<skill-root>/evals/evals.json`?
 *
 * The one filesystem touch in this module, and the reason the default convention can
 * be honored without guessing from a directory name. Everything else here is pure
 * path math over a config.
 */
function hasConventionalSuite(skillDir: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillDir is VAT's own resolved skill directory
  return existsSync(safePath.resolve(skillDir, DEFAULT_EVALS_SUBPATH));
}

/**
 * Absolute directories holding a skill's declared test input.
 *
 * The unit is the DIRECTORY containing the suite file (it also holds the suite's
 * `fixtures/`), except when the suite sits at the skill root — where the "directory"
 * would be the skill itself, so nothing is treated as test input and packaging is
 * unaffected. A suite path that points OUTSIDE the skill dir is still returned: it is
 * still test input, and a link into it should still be excluded from the bundle.
 *
 * With no `test:` block, the CONVENTION applies: the harness has always defaulted to
 * `<skill-root>/evals/evals.json`, reading, stripping and grading that suite whether
 * or not a `test:` block exists. This lane used to return `[]` there, so the two
 * disagreed about the same skill — and in the dangerous direction: the harness
 * protected the signal while the packager PUBLISHED the answer key. The default is
 * now a declaration in both lanes.
 *
 * The inference stays deliberately narrow. It is keyed on the suite FILE existing,
 * never on a directory's name, and it names exactly `<skill-root>/evals` — a
 * `docs/evals/` elsewhere in the tree is ordinary content and still ships, as does a
 * root `evals/` holding no `evals.json`. Guessing from the name alone would silently
 * drop an author's unrelated directory out of their own bundle.
 */
export function resolveTestInputDirs(
  config: Pick<SkillPackagingConfig, 'test'>,
  skillDir: string,
): string[] {
  if (config.test === undefined && !hasConventionalSuite(skillDir)) return [];
  const subpath = config.test?.evals ?? DEFAULT_EVALS_SUBPATH;
  const parent = dirname(subpath);
  // A suite at the skill root has no containing directory of its own — treating the
  // skill dir as test input would exclude the entire skill from its own bundle.
  if (parent === '.' || parent === '') return [];
  return [safePath.resolve(skillDir, parent)];
}

/**
 * The test-input dirs VAT actually excludes links for: those inside the project
 * root. A dir outside it yields no exclude rule — the walker already refuses to
 * bundle outside-project targets, and a `../` pattern would not match its relative
 * paths anyway.
 *
 * Shared by {@link testInputExcludeRules} and {@link testInputLinkIssues} so the
 * receipt covers exactly the exclusions VAT caused. Claiming credit for a drop the
 * walker made for its own reason double-reports one link under two codes with
 * contradictory advice ("no action needed" beside "move the target inside the
 * project").
 */
function projectRelativeTestInputDirs(
  testInputDirs: readonly string[],
  projectRoot: string,
): string[] {
  const inside: string[] = [];
  for (const dir of testInputDirs) {
    const rel = toForwardSlash(safePath.relative(projectRoot, dir));
    if (rel === '' || rel.startsWith('../')) continue;
    inside.push(dir);
  }
  return inside;
}

/**
 * Exclude rules that drop any link into declared test input from the bundle.
 *
 * Patterns are project-root-relative with forward slashes, matching
 * `walkLinkGraph`'s convention.
 */
export function testInputExcludeRules(
  testInputDirs: readonly string[],
  projectRoot: string,
): Array<{ patterns: string[] }> {
  const patterns: string[] = [];
  for (const dir of projectRelativeTestInputDirs(testInputDirs, projectRoot)) {
    const rel = toForwardSlash(safePath.relative(projectRoot, dir));
    patterns.push(rel, `${rel}/**`);
  }
  return patterns.length === 0 ? [] : [{ patterns }];
}

/** True when `candidate` is inside (or equal to) `dir`. Both are absolute. */
function isInside(candidate: string, dir: string): boolean {
  const c = safePath.resolve(candidate);
  const d = safePath.resolve(dir);
  return c === d || c.startsWith(`${d}/`);
}

/**
 * Split `files:` entries into those that may be packaged and those that point into
 * declared test input and therefore must not be.
 *
 * Declaring a path under `test.evals` IS the instruction: it says "this is test
 * input," and VAT's policy is that test input never ships. So a `files:` entry
 * pointing into it is dropped automatically — an adopter never has to edit config,
 * add a waiver, or fix a build to get the correct artifact. The dropped entries are
 * reported (see {@link testInputFileEntryIssues}) so a `files:` entry that silently
 * did nothing can't be mistaken for one that worked.
 *
 * Matching is at the DECLARATION, not after expansion, so a glob whose static base
 * sits inside test input is caught without running it.
 */
export function partitionTestInputFileEntries(
  filesConfig: readonly SkillFileEntry[],
  projectRoot: string,
  testInputDirs: readonly string[],
): { kept: SkillFileEntry[]; dropped: SkillFileEntry[] } {
  if (testInputDirs.length === 0) return { kept: [...filesConfig], dropped: [] };
  const kept: SkillFileEntry[] = [];
  const dropped: SkillFileEntry[] = [];
  for (const entry of filesConfig) {
    const effective = isGlob(entry.source) ? staticGlobBase(entry.source) : entry.source;
    const absSource = safePath.resolve(safePath.join(projectRoot, effective));
    if (testInputDirs.some((dir) => isInside(absSource, dir))) dropped.push(entry);
    else kept.push(entry);
  }
  return { kept, dropped };
}

/**
 * The `files:` entries that will ACTUALLY be packaged for a skill, derived from the
 * skill's own config: {@link resolveTestInputDirs} + the `kept` half of
 * {@link partitionTestInputFileEntries}.
 *
 * Every lane that models "which `dest` paths will exist after the build" must build
 * that model from THIS list, not from the raw `files:` array. The packager already
 * does (it drops the test-input entries before walking), so a lane that used the raw
 * array would predict a `dest` the build never writes — and then report a *link* to
 * that dest as a harmless deferred artifact while the build reports a broken link
 * and fails. Same input, opposite verdicts, in two commands that are supposed to
 * agree. The packager is the authority on what ships; this is how the read-only
 * lanes borrow its answer instead of guessing.
 */
export function packagedFileEntries(
  config: Pick<SkillPackagingConfig, 'files' | 'test'>,
  skillDir: string,
  projectRoot: string,
): SkillFileEntry[] {
  return partitionTestInputFileEntries(
    config.files ?? [],
    projectRoot,
    resolveTestInputDirs(config, skillDir),
  ).kept;
}

/** A `PACKAGED_TEST_INPUT` receipt per dropped `files:` entry — a warning, not a failure. */
export function testInputFileEntryIssues(dropped: readonly SkillFileEntry[]): ValidationIssue[] {
  return dropped.map((entry) =>
    materializeIssue('PACKAGED_TEST_INPUT', {
      location: toForwardSlash(entry.dest),
      message:
        `files: entry "${toForwardSlash(entry.source)} -> ${toForwardSlash(entry.dest)}" points into ` +
        `this skill's declared test input (test.evals) and was NOT packaged — test input, ` +
        `including the expected_output answer key, never ships to consumers.`,
    }),
  );
}

/** The shape of a walker exclusion this module needs: where it pointed, and from what link. */
export interface ExcludedLinkRef {
  /** Absolute path of the excluded link target. */
  path: string;
  /** The href as authored in the markdown, when known. */
  linkHref?: string | undefined;
}

/**
 * A `PACKAGED_TEST_INPUT` receipt per LINK that was dropped for pointing into
 * declared test input.
 *
 * The link route needs its own receipt for the same reason the `files:` route does:
 * VAT silently removes the link from the shipped SKILL.md, and a link that silently
 * did nothing must not be mistaken for one that worked. Without this the drop is
 * invisible in every lane — the generic walker exclusion channel deliberately emits
 * nothing for a pattern match, because ordinary pattern excludes are author-declared
 * intent, and this exclusion is not: the author declared an EVAL SUITE, not a
 * link-stripping rule.
 *
 * `locationRoot`-relative locations, so the same link reports identically from the
 * packager and from the read-only validator. `projectRoot` is a separate concern:
 * it scopes WHICH declared test-input dirs are in play, not how a location reads.
 *
 * Scoped to the same dirs {@link testInputExcludeRules} generates a rule for, so
 * this reports only drops VAT caused. A test-input dir outside the project root
 * gets no rule, and its links are dropped by the walker's own outside-project
 * check — which already reports `LINK_OUTSIDE_PROJECT`.
 */
export function testInputLinkIssues(
  excluded: readonly ExcludedLinkRef[],
  testInputDirs: readonly string[],
  projectRoot: string,
  locationRoot: string = projectRoot,
): ValidationIssue[] {
  const excludedDirs = projectRelativeTestInputDirs(testInputDirs, projectRoot);
  if (excludedDirs.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const ref of excluded) {
    if (!excludedDirs.some((dir) => isInside(ref.path, dir))) continue;
    const location = issueLocation(ref.path, locationRoot);
    if (seen.has(location)) continue;
    seen.add(location);
    issues.push(
      materializeIssue('PACKAGED_TEST_INPUT', {
        location,
        message:
          `Link "${ref.linkHref ?? location}" points into this skill's declared test input ` +
          `(test.evals). The target is NOT packaged — test input, including the expected_output ` +
          `answer key, never ships to consumers — so the link is removed from the packaged output.`,
      }),
    );
  }
  return issues;
}

export interface CheckPackagedTestInputInput {
  /** Source → destination map for everything the packager copies by path. */
  pathMap: ReadonlyMap<string, string>;
  /** Absolute skill output dir — issue locations are reported relative to it. */
  outputPath: string;
  /** Absolute declared test-input dirs, from {@link resolveTestInputDirs}. */
  testInputDirs: readonly string[];
}

/**
 * The BACKSTOP: emit `PACKAGED_TEST_INPUT` if declared test input reached the output
 * anyway.
 *
 * Both known routes are already closed before this runs — links by
 * {@link testInputExcludeRules}, `files:` entries by
 * {@link partitionTestInputFileEntries} — so in normal operation this is silent.
 * It exists so the invariant is *observable* rather than merely intended: if a
 * future change bypasses an exclusion, the shipped artifact says so instead of
 * quietly carrying an answer key again.
 */
export function checkPackagedTestInput(input: CheckPackagedTestInputInput): ValidationIssue[] {
  if (input.testInputDirs.length === 0) return [];
  const locations = new Set<string>();
  for (const [source, dest] of input.pathMap) {
    if (input.testInputDirs.some((dir) => isInside(source, dir))) {
      locations.add(toForwardSlash(safePath.relative(input.outputPath, dest)));
    }
  }
  return [...locations].map((location) =>
    materializeIssue('PACKAGED_TEST_INPUT', { location, detail: location }),
  );
}
