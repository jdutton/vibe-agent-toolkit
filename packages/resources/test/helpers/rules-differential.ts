/**
 * The engine of a randomized DIFFERENTIAL test of every answer
 * `claude-context-rules.ts` derives from a rule's `paths:` list, against a
 * brute-force reference. Two tiers sweep disjoint seed ranges through it:
 * `projection-claude-context-rules-differential.test.ts` (unit, small) and
 * `integration/claude-context-rules-differential-{a,b}.integration.test.ts` (wide).
 *
 * ## Why this exists
 *
 * Only *does the whole rule load file f* was ever proven against Claude Code.
 * Every DERIVED answer — a pattern's `matched`/`inert`/`gitignored` status, its
 * witness, a negation's liveness, the nested rule's base, a directory's ∀/∃
 * admission, the pattern a finding names — was hand-written, and five
 * adversarial review rounds each found a new divergence in one of them. Pinning
 * the one instance found never closed the class, so this checks all of them at
 * once, on seeded random trees, rules AND `.gitignore` files, against a
 * reference that shares no code with the module under test.
 *
 * ## The rule reference
 *
 * Built from `node-ignore` directly, the way
 * `docs/external/claude-code-rules-paths-behaviour.md` says the harness does it:
 * expand braces, strip a trailing `/**`, drop empties, and ask
 * `ignore().add(globs).ignores(relPath)`. Every rule is read under ONE base:
 * the directory that holds its `.claude/rules` — the root for a root rule,
 * `<pkg>` for a NESTED rule under `<pkg>/.claude/rules/`, with paths made
 * RELATIVE to it (never by rewriting the glob). That is the binary's `y3`,
 * quoted in `docs/external/claude-code-memory-loader.md`:
 * `w=r==="Project"?LO(LO(n)):ye(),M=DO(e)?vge(w,e):e` — `n` is the rules
 * directory, so `w` is its grandparent, and a path outside `w` (`..`) never
 * loads. There is no second, root-relative reading.
 *
 * - `loads(f)` = the rule's list ignores f relative to its base.
 * - positive pattern `matched` ⟺ ∃ visible f: the pattern ALONE matches f,
 *   and `loads(f)`.
 * - negation `matched` ⟺ ∃ visible f: the rule WITHOUT the negation loads f,
 *   and the rule does not.
 * - the NAMED pattern for a loaded path is the LAST positive P such that the
 *   list with every OTHER positive removed (P plus every negation, declared
 *   order) still loads the path. Gitignore is last-match-wins, so that is the
 *   entry the author must edit to change the answer — a positive a later
 *   negation cancels is never it.
 *
 * ## The gitignore reference
 *
 * VAT never realizes a gitignored file, and the harness reads the filesystem,
 * so a glob that matches nothing VAT sees may still fire. Each case carries a
 * random root `.gitignore` and, for a nested rule, a `pkg/.gitignore`, and a
 * second `node-ignore` reference decides git's answer: an ignored directory
 * carries its whole subtree (no `!` re-includes beneath it), otherwise the last
 * matching line wins, a deeper file's lines after a shallower one's. VAT is
 * handed exactly what the production contributor hands it — `isIgnored` with
 * `GitTracker.isIgnoredByActiveSet` semantics (an EXISTING path is ignored iff
 * nothing visible is at or below it; an absent one is asked by pattern, as
 * `git check-ignore` does) and git's COLLAPSED `ls-files -o -i --directory`
 * listing — and judged:
 *
 * - never `inert` when an ignored file exists that the pattern would load
 *   (for a negation: would exclude), UNLESS that file lies strictly inside a
 *   collapsed ignored directory the pattern does not itself reach — the
 *   documented `gitignored-not-realized` blind spot, since nothing short of
 *   walking ignored territory can see it;
 * - never `gitignored` unless some path git ignores could be matched by the
 *   pattern ALONE — an existing ignored file or directory, or a plausible path
 *   spelled from the generator's own vocabulary.
 *
 * A failure prints the seed and a greedily SHRUNK case: re-run one seed with
 * `RULES_DIFFERENTIAL_SEED=<n>`, or widen the sweep with
 * `RULES_DIFFERENTIAL_CASES=<n>`.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import ignore from 'ignore';

import {
  corpusFiles,
  declaredPatterns,
  harnessPaths,
  evaluateRulePatterns,
  type RuleAdmission,
} from '../../src/projection/claude-context-rules.js';

import { pathScopedAdmissions, queryRealization } from './context-query-rows.js';

/** One `.gitignore` file: the directory it sits in (`''` = root) and its lines. */
export interface GitignoreFile {
  readonly dir: string;
  readonly lines: readonly string[];
}

/** One generated scenario: a rule, its `paths:` list, and the tree beside it. */
export interface DifferentialCase {
  readonly seed: number;
  readonly rulePath: string;
  readonly paths: readonly string[];
  /** Every file on disk other than the rule itself — visible and gitignored alike. */
  readonly files: readonly string[];
  /** The tree's `.gitignore` files, shallowest first. */
  readonly gitignores: readonly GitignoreFile[];
}

/** The project directory every nested rule hangs below. */
const NESTED_PROJECT = 'pkg';

/** Directory names the tree generator draws from. */
const DIRS = ['src', 'docs', 'pkg', 'sub', 'dist', '.hidden'];

/** File names the tree generator draws from. */
const NAMES = ['gen.ts', 'a.md', 'b.ts', '.env', 'a', 'x.ts', 'x.js', 'keep.md'];

/** Glob segments the rule generator draws from. */
const SEGMENTS = ['src', 'docs', 'pkg', 'sub', 'dist', 'gen.ts', 'a.md', '.env', 'a', '*', '*', '**', '**', '*.ts', '*.js', '{a,b}', '{src,docs}', '{gen.ts,a.md}'];

/** Lines a ROOT `.gitignore` draws from: anchored, unanchored, dir-only, re-included. */
const ROOT_IGNORE_LINES = ['dist/', '/dist/', 'dist', 'pkg/dist/', '/pkg/dist/', '*/dist/', 'dist/*', '!dist/keep.md', '*.js', 'sub/', '/sub', '.hidden/', 'gen.ts', 'docs/*.md', 'src/**/*.ts'];

/** Lines the nested project's own `.gitignore` draws from, relative to it. */
const NESTED_IGNORE_LINES = ['/dist', 'dist/', '*.js', '/sub/', 'a.md', '!keep.md'];

/** mulberry32 — a tiny seeded PRNG, so every case is reproducible from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function generatedFile(random: () => number): string {
  const depth = Math.floor(random() * 4);
  const dirs = Array.from({ length: depth }, () => pick(random, DIRS));
  return [...dirs, pick(random, NAMES)].join('/');
}

function generatedPattern(random: () => number): string {
  const length = 1 + Math.floor(random() ** 2 * 3);
  let pattern = Array.from({ length }, () => pick(random, SEGMENTS)).join('/');
  const lead = random();
  if (lead < 0.15) pattern = `/${pattern}`;
  else if (lead < 0.2) pattern = `./${pattern}`;
  const tail = random();
  if (tail < 0.15) pattern = `${pattern}/`;
  else if (tail < 0.35) pattern = `${pattern}/**`;
  return random() < 0.35 ? `!${pattern}` : pattern;
}

function generatedGitignores(random: () => number, nested: boolean): GitignoreFile[] {
  const files: GitignoreFile[] = [];
  if (random() < 0.5) {
    files.push({ dir: '', lines: Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, ROOT_IGNORE_LINES)) });
  }
  if (nested && random() < 0.4) {
    files.push({ dir: NESTED_PROJECT, lines: Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(random, NESTED_IGNORE_LINES)) });
  }
  return files;
}

function generatedCase(seed: number): DifferentialCase {
  const random = prng(seed);
  const nested = random() < 0.35;
  // Skewed small: most interactions need only a handful of files, and a small
  // tree is cheap, so more cases fit the unit budget. The tail still reaches 30.
  const fileCount = 1 + Math.floor(random() ** 2 * 30);
  const files = Array.from({ length: fileCount }, () => generatedFile(random))
    .map((file) => (nested && random() < 0.5 ? `${NESTED_PROJECT}/${file}` : file));
  const patternCount = 1 + Math.floor(random() * 5);
  return {
    seed,
    rulePath: nested ? `${NESTED_PROJECT}/.claude/rules/r.md` : '.claude/rules/r.md',
    paths: Array.from({ length: patternCount }, () => generatedPattern(random)),
    files: [...new Set(files)],
    gitignores: generatedGitignores(random, nested),
  };
}

// ── Path arithmetic ────────────────────────────────────────────────────────

/** The path under one base, or null when the base does not contain it (or IS it). */
function relativeTo(base: string, path: string): string | null {
  if (base === '') return path;
  if (!toForwardSlash(path).startsWith(`${base}/`)) return null;
  const relative = path.slice(base.length + 1);
  return relative === '' ? null : relative;
}

function isUnder(dir: string, file: string): boolean {
  return dir === '' || toForwardSlash(file).startsWith(`${dir}/`);
}

function parentOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

/** Every proper ancestor directory of `path`, shallowest first, root excluded. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) ancestors.unshift(dir);
  return ancestors;
}

function directoriesOf(files: readonly string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const file of files) {
    for (const dir of ancestorsOf(file)) dirs.add(dir);
  }
  return [...dirs].sort((left, right) => left.localeCompare(right));
}

// ── The rule reference ─────────────────────────────────────────────────────

/** Brace expansion by `split(",")` of the leftmost group — the harness's whole grammar. */
function expand(pattern: string): string[] {
  const open = pattern.indexOf('{');
  const close = open < 0 ? -1 : pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern.slice(open + 1, close).split(',')
    .flatMap((alternative) => expand(`${head}${alternative.trim()}${tail}`));
}

function harnessGlobs(pattern: string): string[] {
  return expand(pattern)
    .map((glob) => (glob.endsWith('/**') ? glob.slice(0, -3) : glob))
    .filter((glob) => glob.length > 0);
}

/** A negation glob read as the paths it can take out: `!x` → `x`, bare `!` → `**`. */
function positiveOf(glob: string): string {
  if (!glob.startsWith('!')) return glob;
  return glob.length === 1 ? '**' : glob.slice(1);
}

/**
 * One `node-ignore` instance per distinct list, compiled once. Pure speed:
 * the reference asks the same few lists about thousands of paths, and a
 * fresh instance per question put the wide sweep over its tier budget.
 */
const compiledLists = new Map<string, ReturnType<typeof ignore>>();

function compiledList(lines: readonly string[]): ReturnType<typeof ignore> {
  const key = lines.join('\n');
  let compiled = compiledLists.get(key);
  if (compiled === undefined) {
    compiled = ignore().add([...lines]);
    compiledLists.set(key, compiled);
  }
  return compiled;
}

function ignoredUnder(globs: readonly string[], base: string, path: string): boolean {
  const relative = relativeTo(base, path);
  return relative !== null && globs.length > 0 && compiledList(globs).ignores(relative);
}

interface Reference {
  readonly alwaysLoaded: boolean;
  readonly loads: (path: string) => boolean;
  readonly aloneMatches: (index: number, path: string) => boolean;
  /** Does the pattern — a negation read as its positive half — reach `path` alone? */
  readonly touches: (index: number, path: string) => boolean;
  readonly negationExcludes: (index: number, path: string) => boolean;
  /** The patterns the strict naming rule allows for a loaded `path`; empty when none is single. */
  readonly namesFor: (path: string) => string[];
}

/** `LO(LO(rulesDir))` — the directory holding the rule's `.claude/rules`, `''` for the root. */
function baseOf(testCase: DifferentialCase): string {
  return toForwardSlash(testCase.rulePath).startsWith(`${NESTED_PROJECT}/`) ? NESTED_PROJECT : '';
}

export function referenceOf(testCase: DifferentialCase): Reference {
  const perPattern = testCase.paths.map((pattern) => harnessGlobs(pattern));
  const survivors = perPattern.flat();
  const base = baseOf(testCase);
  const negation = (index: number): boolean => (testCase.paths[index] ?? '').startsWith('!');
  const listLoads = (skip: number, path: string): boolean =>
    ignoredUnder(perPattern.filter((_, index) => index !== skip).flat(), base, path);
  const lastLoader = (path: string): string | undefined => {
    for (let index = testCase.paths.length - 1; index >= 0; index -= 1) {
      if (negation(index)) continue;
      const kept = perPattern.filter((_, other) => other === index || negation(other)).flat();
      if (ignoredUnder(kept, base, path)) return testCase.paths[index];
    }
    return undefined;
  };
  return {
    alwaysLoaded: survivors.every((glob) => glob === '**'),
    loads: (path) => listLoads(-1, path),
    aloneMatches: (index, path) => ignoredUnder(perPattern[index] ?? [], base, path),
    touches: (index, path) => ignoredUnder((perPattern[index] ?? []).map(positiveOf), base, path),
    negationExcludes: (index, path) => listLoads(index, path) && !listLoads(-1, path),
    namesFor: (path) => {
      const name = listLoads(-1, path) ? lastLoader(path) : undefined;
      return name === undefined ? [] : [name];
    },
  };
}

// ── The gitignore reference, and the tree VAT is shown ─────────────────────

/** One `.gitignore` file's own verdict on a path: ignored, re-included, or silent. */
function fileVerdict(file: GitignoreFile, path: string, isDirectory: boolean): boolean | undefined {
  const relative = relativeTo(file.dir, path);
  if (relative === null || file.lines.length === 0) return undefined;
  const { ignored, unignored } = compiledList(file.lines).test(isDirectory ? `${relative}/` : relative);
  if (unignored) return false;
  return ignored ? true : undefined;
}

/**
 * Git's answer for one path by PATTERN alone — `git check-ignore` on a path
 * that may not exist. An ignored ancestor directory decides first (git never
 * descends into one); otherwise the deepest `.gitignore` with an opinion wins.
 */
function gitIgnores(gitignores: readonly GitignoreFile[], path: string, isDirectory: boolean): boolean {
  const leaf = (candidate: string, directory: boolean): boolean => {
    let verdict = false;
    for (const file of gitignores) verdict = fileVerdict(file, candidate, directory) ?? verdict;
    return verdict;
  };
  return ancestorsOf(path).some((dir) => leaf(dir, true)) || leaf(path, isDirectory);
}

/** The tree on disk, split the way git splits it, and the oracle VAT is handed. */
export interface Tree {
  readonly visible: readonly string[];
  readonly hidden: readonly string[];
  /** `GitTracker.isIgnoredByActiveSet` semantics over root-relative paths. */
  readonly isIgnored: (path: string) => boolean;
  /** git's collapsed `ls-files -o -i --exclude-standard --directory` listing. */
  readonly entries: readonly string[];
  /** The collapsed entry a hidden file lies in: itself, or an ancestor spelled `dir/`. */
  readonly entryOf: (hidden: string) => string;
}

export function treeOf(testCase: DifferentialCase): Tree {
  const hidden = testCase.files.filter((file) => gitIgnores(testCase.gitignores, file, false));
  const visible = [testCase.rulePath, ...testCase.files.filter((file) => !hidden.includes(file))];
  const visibleDirs = new Set(directoriesOf(visible));
  const allDirs = new Set(directoriesOf(testCase.files));
  const entryOf = (file: string): string => {
    const top = ancestorsOf(file).find((dir) => !visibleDirs.has(dir));
    return top === undefined ? file : `${top}/`;
  };
  return {
    visible,
    hidden,
    entries: [...new Set(hidden.map((file) => entryOf(file)))],
    entryOf,
    isIgnored: (asked) => {
      const path = asked.endsWith('/') ? asked.slice(0, -1) : asked;
      if (testCase.files.includes(path) || path === testCase.rulePath) return hidden.includes(path);
      if (allDirs.has(path)) return !visibleDirs.has(path);
      return gitIgnores(testCase.gitignores, path, false);
    },
  };
}

/** The vocabulary a plausible-but-absent path is spelled from. */
const PLAUSIBLE_SEGMENTS = [...new Set([...DIRS, ...NAMES])];

/** Every path of 1..`depth` vocabulary segments below `base`. */
function plausibleBelow(base: string, depth: number): string[] {
  let layer = [base];
  const found: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    layer = layer.flatMap((parent) => PLAUSIBLE_SEGMENTS.map((segment) => (parent === '' ? segment : `${parent}/${segment}`)));
    found.push(...layer);
  }
  return found;
}

/**
 * Could the pattern alone match SOME path git ignores? The allowance a
 * `gitignored` verdict needs: an existing ignored file or directory, or a
 * plausible absent path, spelled from the generator's vocabulary — never from
 * VAT's own probe names, so the check stays independent of the module.
 */
function matchesSomethingIgnored(testCase: DifferentialCase, ref: Reference, tree: Tree, index: number): boolean {
  const existingDirs = new Set(directoriesOf(testCase.files));
  const ignoredAs = (path: string, directory: boolean): boolean => (existingDirs.has(path) || testCase.files.includes(path)
    ? tree.isIgnored(path)
    : gitIgnores(testCase.gitignores, path, directory));
  const candidates = new Set([
    ...plausibleBelow('', 3),
    ...plausibleBelow(NESTED_PROJECT, 3),
    ...directoriesOf(tree.visible).filter((dir) => dir !== '').flatMap((dir) => plausibleBelow(dir, 2)),
    ...tree.hidden.flatMap((file) => [file, ...ancestorsOf(file)]),
  ]);
  for (const path of candidates) {
    if (ignoredAs(path, false) && ref.touches(index, path)) return true;
    if (ignoredAs(path, true) && ref.touches(index, `${path}/`)) return true;
  }
  return false;
}

// ── The comparison ─────────────────────────────────────────────────────────

/**
 * Is the NAMED pattern one the strict naming rule allows for a loaded `path`?
 *
 * @returns A divergence sentence, or undefined when the name is allowed
 */
export function namingVerdict(testCase: DifferentialCase, ref: Reference, named: string, path: string): string | undefined {
  const allowed = ref.namesFor(path);
  if (allowed.length > 0) {
    return allowed.includes(named) ? undefined : `names ${JSON.stringify(named)} at ${path}, last loader ${JSON.stringify(allowed)}`;
  }
  // No single positive loads it with the negations beside it: the loose rule.
  return namedAloneMatches(testCase, ref, named, path)
    ? undefined
    : `names ${JSON.stringify(named)}, which alone does not match ${path}`;
}

/** Does some declared pattern spelled `named` match `path` on its own? */
function namedAloneMatches(testCase: DifferentialCase, ref: Reference, named: string, path: string): boolean {
  return testCase.paths.some((pattern, index) => pattern === named && ref.aloneMatches(index, path));
}

/**
 * The reference's liveness predicate for one pattern: a positive loads the
 * file through the whole rule; a negation excludes it.
 */
function holdsFor(testCase: DifferentialCase, ref: Reference, index: number): (file: string) => boolean {
  return (testCase.paths[index] ?? '').startsWith('!')
    ? (file) => ref.negationExcludes(index, file)
    : (file) => ref.aloneMatches(index, file) && ref.loads(file);
}

/**
 * The gitignore half of one pattern's verdict.
 *
 * @returns A divergence sentence, or undefined when VAT's status is allowed
 */
export function territoryVerdict(
  testCase: DifferentialCase,
  ref: Reference,
  tree: Tree,
  index: number,
  status: string,
): string | undefined {
  const holds = holdsFor(testCase, ref, index);
  if (status === 'inert') {
    const seen = tree.hidden.find((file) => holds(file) && ref.touches(index, tree.entryOf(file)));
    if (seen === undefined) return undefined;
    const verb = (testCase.paths[index] ?? '').startsWith('!') ? 'excludes' : 'loads';
    return `inert, reference ${verb} gitignored ${seen}`;
  }
  if (status === 'gitignored' && !matchesSomethingIgnored(testCase, ref, tree, index)) {
    return 'gitignored, but no path git ignores could match it';
  }
  return undefined;
}

function evaluated(testCase: DifferentialCase, paths: readonly string[], tree: Tree, visible: readonly string[]): ReturnType<typeof evaluateRulePatterns> {
  return evaluateRulePatterns({
    rulePath: testCase.rulePath,
    patterns: declaredPatterns(harnessPaths({ paths: [...paths] })),
    files: visible,
    ignores: { isIgnored: tree.isIgnored, ignoredEntries: () => tree.entries },
  });
}

/**
 * The harness strips ONE trailing `/**`, so `P` and `P/**` are the same glob to
 * it and must get the same status. A verdict read off the declared spelling
 * breaks this — the reason `dist`, `dist/` and `dist/**` disagreed over an
 * unbuilt, gitignored `dist/` — and it needs no ignored file on disk to show.
 */
function spellingDivergences(
  testCase: DifferentialCase,
  tree: Tree,
  visible: readonly string[],
  statuses: readonly string[],
): string[] {
  const respelled = testCase.paths.map((pattern) => (pattern.endsWith('/**') ? pattern : `${pattern}/**`));
  return evaluated(testCase, respelled, tree, visible).flatMap((evaluation, index) => (
    evaluation.status === statuses[index]
      ? []
      : [`pattern ${index} ${JSON.stringify(testCase.paths[index])}: ${statuses[index] ?? ''}, but ${JSON.stringify(respelled[index])} is ${evaluation.status}`]));
}

function patternDivergences(testCase: DifferentialCase, ref: Reference, tree: Tree, visible: readonly string[]): string[] {
  const evaluations = evaluated(testCase, testCase.paths, tree, visible);
  const found = spellingDivergences(testCase, tree, visible, evaluations.map((evaluation) => evaluation.status));
  for (const [index, evaluation] of evaluations.entries()) {
    const pattern = testCase.paths[index] ?? '';
    const holds = holdsFor(testCase, ref, index);
    const witness = visible.find((file) => holds(file));
    const tag = `pattern ${index} ${JSON.stringify(pattern)}`;
    if (evaluation.ordinal !== index) found.push(`${tag}: ordinal ${evaluation.ordinal}`);
    if (evaluation.status === 'unevaluated') continue;
    if ((evaluation.status === 'matched') !== (witness !== undefined)) {
      const reference = witness === undefined ? 'no visible witness' : 'matched via ' + witness;
      found.push(`${tag}: VAT ${evaluation.status}, reference ${reference}`);
    }
    if (evaluation.witnessPath !== null && !holds(evaluation.witnessPath)) {
      found.push(`${tag}: witness ${evaluation.witnessPath} does not satisfy the predicate`);
    }
    const territory = territoryVerdict(testCase, ref, tree, index, evaluation.status);
    if (territory !== undefined) found.push(`${tag}: ${territory}`);
  }
  return found;
}

function fileLaneDivergences(testCase: DifferentialCase, ref: Reference, lanes: readonly string[], visible: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of visible) {
    const admissions = pathScopedAdmissions(testCase.rulePath, testCase.paths, lanes, parentOf(file), file);
    const admission = admissions[0];
    if ((admission !== undefined) !== ref.loads(file)) {
      found.push(`file ${file}: VAT ${admission === undefined ? 'absent' : 'admits'}, reference ${ref.loads(file) ? 'loads' : 'does not load'}`);
    } else if (admission?.kind === 'glob-rule') {
      const naming = namingVerdict(testCase, ref, admission.pattern, file);
      if (naming !== undefined) found.push(`file ${file}: ${naming}`);
    }
  }
  return found;
}

export function directoryVerdict(
  testCase: DifferentialCase,
  ref: Reference,
  dir: string,
  under: readonly string[],
  admission: RuleAdmission | undefined,
): string | undefined {
  const loaded = under.filter((file) => ref.loads(file));
  if (admission === undefined) {
    return loaded.length === 0 ? undefined : `absent, reference loads ${loaded[0] ?? ''}`;
  }
  if (admission.kind === 'glob-rule-covers-dir') {
    const unloaded = under.find((file) => !ref.loads(file));
    if (unloaded !== undefined) return `∀ via ${JSON.stringify(admission.pattern)}, reference does not load ${unloaded}`;
    const unnamed = under.find((file) => !namedAloneMatches(testCase, ref, admission.pattern, file));
    if (unnamed !== undefined) return `∀ names ${JSON.stringify(admission.pattern)}, which alone misses ${unnamed}`;
    // The base itself cannot be asked (its relative path is empty): no naming there.
    const naming = dir === baseOf(testCase) ? undefined : namingVerdict(testCase, ref, admission.pattern, `${dir}/`);
    return naming === undefined ? undefined : `∀ ${naming}`;
  }
  if (admission.kind !== 'glob-rule-may-fire') return `unexpected admission ${admission.kind}`;
  const { examplePath, pattern } = admission;
  if (!under.includes(examplePath) || !ref.loads(examplePath)) return `∃ witness ${examplePath} is not a loaded file here`;
  const naming = namingVerdict(testCase, ref, pattern, examplePath);
  return naming === undefined ? undefined : `∃ ${naming}`;
}

function directoryLaneDivergences(testCase: DifferentialCase, ref: Reference, lanes: readonly string[], visible: readonly string[]): string[] {
  const found: string[] = [];
  for (const dir of directoriesOf(visible)) {
    const admissions = pathScopedAdmissions(testCase.rulePath, testCase.paths, lanes, dir, null);
    const verdict = directoryVerdict(testCase, ref, dir, visible.filter((file) => isUnder(dir, file)), admissions[0]);
    if (verdict !== undefined) found.push(`dir ${JSON.stringify(dir)}: ${verdict}`);
  }
  return found;
}

function divergences(testCase: DifferentialCase): string[] {
  const ref = referenceOf(testCase);
  const paths = { paths: [...testCase.paths] };
  const scoped = harnessPaths(paths) !== null;
  if (scoped === ref.alwaysLoaded) {
    return [`load class: VAT scoped=${String(scoped)}, reference alwaysLoaded=${String(ref.alwaysLoaded)}`];
  }
  if (ref.alwaysLoaded) return [];
  const tree = treeOf(testCase);
  // The query lanes realize the rule themselves, so they are handed the rest.
  const lanes = tree.visible.filter((file) => file !== testCase.rulePath);
  const visible = corpusFiles(tree.visible.map((file) => queryRealization(file)));
  return [
    ...patternDivergences(testCase, ref, tree, visible),
    ...fileLaneDivergences(testCase, ref, lanes, visible),
    ...directoryLaneDivergences(testCase, ref, lanes, visible),
  ];
}

/** Every one-step-smaller case: one file, one pattern, or one ignore line fewer. */
function smallerCases(current: DifferentialCase): DifferentialCase[] {
  const without = <T>(items: readonly T[], drop: number): T[] => items.filter((_, index) => index !== drop);
  return [
    ...current.files.map((_, drop) => ({ ...current, files: without(current.files, drop) })),
    ...current.paths.length > 1
      ? current.paths.map((_, drop) => ({ ...current, paths: without(current.paths, drop) }))
      : [],
    ...current.gitignores.flatMap((file, which) => file.lines.map((_, drop) => ({
      ...current,
      gitignores: current.gitignores
        .map((other, index) => (index === which ? { ...other, lines: without(other.lines, drop) } : other))
        .filter((other) => other.lines.length > 0),
    }))),
  ];
}

/** Greedily drop files, patterns and ignore lines while the case still diverges. */
function shrink(testCase: DifferentialCase): DifferentialCase {
  let current = testCase;
  for (let changed = true; changed;) {
    changed = false;
    const smaller = smallerCases(current).find((candidate) => divergences(candidate).length > 0);
    if (smaller !== undefined) {
      current = smaller;
      changed = true;
    }
  }
  return current;
}

/**
 * The seeds one sweep runs: one pinned seed, or `count` seeds from `first`.
 *
 * @param first - The first seed of this tier's range
 * @param count - How many seeds this tier sweeps by default
 * @returns The seeds, honouring `RULES_DIFFERENTIAL_SEED` / `RULES_DIFFERENTIAL_CASES`
 */
export function sweepSeeds(first: number, count: number): number[] {
  const pinned = process.env['RULES_DIFFERENTIAL_SEED'];
  if (pinned !== undefined) return [Number(pinned)];
  const cases = Number(process.env['RULES_DIFFERENTIAL_CASES'] ?? String(count));
  return Array.from({ length: cases }, (_, index) => first + index);
}

/**
 * Every seed whose case diverges, each with its shrunk case and divergences.
 *
 * @param seeds - The seeds to generate and compare
 * @returns One report per diverging seed; empty when VAT agrees everywhere
 */
export function differentialFailures(seeds: readonly number[]): string[] {
  const failures: string[] = [];
  for (const seed of seeds) {
    const testCase = generatedCase(seed);
    if (divergences(testCase).length === 0) continue;
    const minimal = shrink(testCase);
    const shape = JSON.stringify({ rulePath: minimal.rulePath, paths: minimal.paths, files: minimal.files, gitignores: minimal.gitignores });
    failures.push(`seed ${seed}: ${shape}\n  ${divergences(minimal).join('\n  ')}`);
  }
  return failures;
}
