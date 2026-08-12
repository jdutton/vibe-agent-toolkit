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
 * The rule is PROJECT-WIDE, not per-skill: a file that ANY skill declares as its eval
 * suite is test input, and never ships in ANY skill's bundle. Skill A's docs are free
 * to cite skill B's suite as a worked example — that citation is a reference, not a
 * reason to package B's answer key inside A. The invariant "the executor's filesystem
 * contains no answer key" therefore covers every declared suite in the project, not
 * only the subject's own.
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
 * A probe for "does this skill carry the conventional suite at
 * `<skill-root>/evals/evals.json`?", answering each directory from the filesystem
 * at most once.
 *
 * The one filesystem touch in this module, and the reason the default convention can
 * be honored without guessing from a directory name. Everything else here is pure
 * path math over a config.
 *
 * Deduplicated because {@link resolveTestInputDirs} asks the question once for the
 * subject and once per entry in `projectSkills` — and a package that keeps its
 * skills in ONE directory (VAT's own `vat-development-agents` keeps thirteen there)
 * makes every one of those the same question about the same path. Measured on
 * `vat audit .`: 14 probes over 2 distinct paths.
 *
 * The memo is created per call and dies with it. It deliberately is NOT module-level:
 * this module's answer is a snapshot of the filesystem, and a cache outliving the call
 * would keep answering for a tree that has since changed — in a long-lived process,
 * and across every later test in the same worker.
 */
function conventionalSuiteProbe(): (skillDir: string) => boolean {
  const answers = new Map<string, boolean>();
  return (skillDir: string): boolean => {
    const suitePath = safePath.resolve(skillDir, DEFAULT_EVALS_SUBPATH);
    const cached = answers.get(suitePath);
    if (cached !== undefined) return cached;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillDir is VAT's own resolved skill directory
    const found = existsSync(suitePath);
    answers.set(suitePath, found);
    return found;
  };
}

/** True when `candidate` is inside (or equal to) `dir`. Both are absolute. */
function isInside(candidate: string, dir: string): boolean {
  const c = safePath.resolve(candidate);
  const d = safePath.resolve(dir);
  return c === d || c.startsWith(`${d}/`);
}

/**
 * Absolute directories holding ONE skill's declared test input.
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
function declaredTestInputDirs(
  config: Pick<SkillPackagingConfig, 'test'>,
  skillDir: string,
  hasConventionalSuite: (skillDir: string) => boolean,
): string[] {
  if (config.test === undefined && !hasConventionalSuite(skillDir)) return [];
  const subpath = config.test?.evals ?? DEFAULT_EVALS_SUBPATH;
  const parent = dirname(subpath);
  // A suite at the skill root has no containing directory of its own — treating the
  // skill dir as test input would exclude the entire skill from its own bundle.
  if (parent === '.' || parent === '') return [];
  return [safePath.resolve(skillDir, parent)];
}

/** One skill's eval-suite declaration, as the PROJECT config states it. */
export interface DeclaredEvalSuite {
  /** Absolute path to that skill's root directory (the dir holding its SKILL.md). */
  skillDir: string;
  /** That skill's effective packaging config — only `test.evals` is read. */
  config: Pick<SkillPackagingConfig, 'test'>;
}

/**
 * Absolute directories holding declared test input, from the point of view of the
 * skill being packaged: its OWN suite, plus EVERY other suite the project declares.
 *
 * The cross-skill half is not defensive breadth — it is the same rule applied to the
 * same kind of file. A doc citing another skill's eval suite as a worked example is an
 * entirely reasonable doc, and the link walker follows those citations. Keyed only to
 * the subject, this function called another skill's answer key "ordinary content", so
 * the walker bundled it — with no exclusion and no `PACKAGED_TEST_INPUT` receipt,
 * because nothing under the subject's config named that path.
 *
 * Observed ACTIVE on a 90-skill adopter (2026-07-30, `vat skills build`): a built
 * bundle contained a file byte-identical to a DIFFERENT skill's real eval suite,
 * carried under that bundle's own subtree. The answer key shipped. A basename
 * collision between two such suites does not save anyone — a FILENAME_COLLISION is
 * REPORTED, not thrown, and the copy still happens.
 *
 * Nothing else in the pipeline sees it. `LINK_TO_SKILL_DEFINITION` covers only another
 * skill's SKILL.md. And the two mechanisms in THIS module that exist to catch a
 * shipped suite — the `PACKAGED_TEST_INPUT` receipt and the `checkPackagedTestInput`
 * backstop — are both fed the dirs this function returns, so while those dirs were the
 * subject's alone, both were structurally blind to another skill's suite. That is why
 * the fix has to be a project-level INPUT here rather than another check downstream.
 *
 * `projectSkills` may include the skill being packaged; dirs are deduplicated, and the
 * subject's own come first. It is REQUIRED, with no default: a defaulted parameter made
 * every pre-existing caller silently keep the per-skill behaviour, so the rule above
 * was written down and shipped as a no-op. A lane that genuinely cannot enumerate the
 * project's skills passes `[]` at the call site, where the narrowing is visible and has
 * to be justified in a comment — it can no longer happen by omission.
 *
 * SCOPE OF THE CROSS-SKILL HALF — another skill's suite dir travels to this build only
 * when it lies INSIDE that skill's own directory. A `test.evals` pointing at a SHARED
 * directory already strips that whole directory from the declaring skill's bundle
 * (issue #166); honouring it project-wide would turn one skill's over-broad
 * declaration into a project-wide strip of a directory no single skill owns. The
 * declaring skill's own build is unchanged — the `config`/`skillDir` pair above is
 * still taken at face value — so this narrows nothing that worked before.
 */
export function resolveTestInputDirs(
  config: Pick<SkillPackagingConfig, 'test'>,
  skillDir: string,
  projectSkills: readonly DeclaredEvalSuite[],
): string[] {
  const hasConventionalSuite = conventionalSuiteProbe();
  const dirs = new Set(declaredTestInputDirs(config, skillDir, hasConventionalSuite));
  for (const skill of projectSkills) {
    for (const dir of declaredTestInputDirs(skill.config, skill.skillDir, hasConventionalSuite)) {
      if (isInside(dir, skill.skillDir)) dirs.add(dir);
    }
  }
  return [...dirs];
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
 * The `files:` entries that will ACTUALLY be packaged for a skill:
 * {@link resolveTestInputDirs} + the `kept` half of
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
 *
 * `projectSkills` is forwarded to {@link resolveTestInputDirs}, so a `files:` entry
 * pointing at ANOTHER skill's declared suite is dropped here too. Required for the
 * same reason it is required there — see that function's note on the no-op default.
 */
export function packagedFileEntries(
  config: Pick<SkillPackagingConfig, 'files' | 'test'>,
  skillDir: string,
  projectRoot: string,
  projectSkills: readonly DeclaredEvalSuite[],
): SkillFileEntry[] {
  return partitionTestInputFileEntries(
    config.files ?? [],
    projectRoot,
    resolveTestInputDirs(config, skillDir, projectSkills),
  ).kept;
}

/** A `PACKAGED_TEST_INPUT` receipt per dropped `files:` entry — a warning, not a failure. */
export function testInputFileEntryIssues(dropped: readonly SkillFileEntry[]): ValidationIssue[] {
  return dropped.map((entry) =>
    materializeIssue('PACKAGED_TEST_INPUT', {
      location: toForwardSlash(entry.dest),
      message:
        `files: entry "${toForwardSlash(entry.source)} -> ${toForwardSlash(entry.dest)}" points into ` +
        `declared test input (some skill's test.evals) and was NOT packaged — test input, ` +
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
          `Link "${ref.linkHref ?? location}" points into declared test input (some skill's ` +
          `test.evals — its own or another skill's). The target is NOT packaged — test input, ` +
          `including the expected_output answer key, never ships to consumers — so the link is ` +
          `removed from the packaged output.`,
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
