/**
 * The engine of a randomized DIFFERENTIAL test of every answer
 * `claude-context-rules.ts` derives from a rule's `paths:` list, against a
 * brute-force reference. Two tiers sweep disjoint seed ranges through it:
 * `projection-claude-context-rules-differential.test.ts` (unit, small) and
 * `integration/claude-context-rules-differential.integration.test.ts` (wide).
 *
 * ## Why this exists
 *
 * Only *does the whole rule load file f* was ever proven against Claude Code.
 * Every DERIVED answer — a pattern's `matched`/`inert` status, its witness, a
 * negation's liveness, the nested-base reading, a directory's ∀/∃ admission,
 * the pattern a finding names — was hand-written, and four adversarial review
 * rounds each found a new divergence in one of them. This checks all of them at
 * once, on seeded random trees and rules, against a reference that shares no
 * code with the module under test.
 *
 * ## The reference
 *
 * Built from `node-ignore` directly, the way
 * `docs/external/claude-code-rules-paths-behaviour.md` says the harness does it:
 * expand braces, strip a trailing `/**`, drop empties, and ask
 * `ignore().add(globs).ignores(relPath)`. A NESTED rule (under
 * `<pkg>/.claude/rules/`) is read under two bases — the root, and `<pkg>` with
 * paths made RELATIVE to it (never by rewriting the glob, which is what VAT
 * does) — and loads a file loaded under either.
 *
 * - `loads(f)` = OR over bases.
 * - positive pattern `matched` ⟺ ∃ visible f: the pattern ALONE matches f
 *   under some base, and `loads(f)`.
 * - negation `matched` ⟺ ∃ visible f and a base b: the rule WITHOUT the
 *   negation loads f under b, and the rule does not load f under b. ⚠️ Per
 *   base, which is VAT's recorded `nested-rule-glob-base` decision: the vendor
 *   doc is silent on nested rules, so a negation that excludes a file under
 *   EITHER plausible base is not safe to delete.
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
  declaresPaths,
  evaluateRulePatterns,
  type RuleAdmission,
} from '../../src/projection/claude-context-rules.js';

import { pathScopedAdmissions, queryRealization } from './context-query-rows.js';

/** One generated scenario: a rule, its `paths:` list, and the tree beside it. */
export interface DifferentialCase {
  readonly seed: number;
  readonly rulePath: string;
  readonly paths: readonly string[];
  /** Realized files other than the rule itself. */
  readonly files: readonly string[];
}

/** The project directory every nested rule hangs below. */
const NESTED_PROJECT = 'pkg';

/** Directory names the tree generator draws from. */
const DIRS = ['src', 'docs', 'pkg', 'sub', 'dist', '.hidden'];

/** File names the tree generator draws from. */
const NAMES = ['gen.ts', 'a.md', 'b.ts', '.env', 'a', 'x.ts'];

/** Glob segments the rule generator draws from. */
const SEGMENTS = ['src', 'docs', 'pkg', 'sub', 'gen.ts', 'a.md', '.env', 'a', '*', '*', '**', '**', '*.ts', '{a,b}', '{src,docs}', '{gen.ts,a.md}'];

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
  };
}

// ── The reference ──────────────────────────────────────────────────────────

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

/** The path under one base, or null when the base does not contain it. */
function relativeTo(base: string, file: string): string | null {
  if (base === '') return file;
  return toForwardSlash(file).startsWith(`${base}/`) ? file.slice(base.length + 1) : null;
}

function ignoredUnder(globs: readonly string[], base: string, file: string): boolean {
  const relative = relativeTo(base, file);
  return relative !== null && globs.length > 0 && ignore().add([...globs]).ignores(relative);
}

interface Reference {
  readonly alwaysLoaded: boolean;
  readonly loads: (file: string) => boolean;
  readonly aloneMatches: (index: number, file: string) => boolean;
  readonly negationExcludes: (index: number, file: string) => boolean;
}

export function referenceOf(testCase: DifferentialCase): Reference {
  const perPattern = testCase.paths.map((pattern) => harnessGlobs(pattern));
  const survivors = perPattern.flat();
  const bases = toForwardSlash(testCase.rulePath).startsWith(`${NESTED_PROJECT}/`) ? ['', NESTED_PROJECT] : [''];
  const listLoads = (skip: number, base: string, file: string): boolean =>
    ignoredUnder(perPattern.filter((_, index) => index !== skip).flat(), base, file);
  return {
    alwaysLoaded: survivors.length === 0 || survivors.every((glob) => glob === '**'),
    loads: (file) => bases.some((base) => listLoads(-1, base, file)),
    aloneMatches: (index, file) => bases.some((base) => ignoredUnder(perPattern[index] ?? [], base, file)),
    negationExcludes: (index, file) =>
      bases.some((base) => listLoads(index, base, file) && !listLoads(-1, base, file)),
  };
}

// ── The comparison ─────────────────────────────────────────────────────────

function isUnder(dir: string, file: string): boolean {
  return dir === '' || toForwardSlash(file).startsWith(`${dir}/`);
}

function parentOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

function directoriesOf(files: readonly string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const file of files) {
    for (let dir = parentOf(file); dir !== ''; dir = parentOf(dir)) dirs.add(dir);
  }
  return [...dirs].sort((left, right) => left.localeCompare(right));
}

/** Does some declared pattern spelled `named` match `file` on its own? */
function namedMatches(paths: readonly string[], ref: Reference, named: string, file: string): boolean {
  return paths.some((pattern, index) => pattern === named && ref.aloneMatches(index, file));
}

function patternDivergences(testCase: DifferentialCase, ref: Reference, visible: readonly string[]): string[] {
  const found: string[] = [];
  const evaluations = evaluateRulePatterns({
    rulePath: testCase.rulePath,
    patterns: declaredPatterns({ paths: [...testCase.paths] }),
    files: visible,
    isIgnored: () => false,
  });
  for (const [index, evaluation] of evaluations.entries()) {
    const pattern = testCase.paths[index] ?? '';
    const negation = pattern.startsWith('!');
    const holds = (file: string): boolean => (negation
      ? ref.negationExcludes(index, file)
      : ref.aloneMatches(index, file) && ref.loads(file));
    const witness = visible.find((file) => holds(file));
    const tag = `pattern ${index} ${JSON.stringify(pattern)}`;
    if (evaluation.ordinal !== index) found.push(`${tag}: ordinal ${evaluation.ordinal}`);
    if (evaluation.status === 'gitignored') found.push(`${tag}: gitignored with nothing ignored`);
    if (evaluation.status === 'unevaluated') continue;
    if ((evaluation.status === 'matched') !== (witness !== undefined)) {
      const reference = witness === undefined ? 'inert' : 'matched via ' + witness;
      found.push(`${tag}: VAT ${evaluation.status}, reference ${reference}`);
    }
    if (evaluation.witnessPath !== null && !holds(evaluation.witnessPath)) {
      found.push(`${tag}: witness ${evaluation.witnessPath} does not satisfy the predicate`);
    }
  }
  return found;
}

function fileLaneDivergences(testCase: DifferentialCase, ref: Reference, visible: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of visible) {
    const admissions = pathScopedAdmissions(testCase.rulePath, testCase.paths, testCase.files, parentOf(file), file);
    const admission = admissions[0];
    if ((admission !== undefined) !== ref.loads(file)) {
      found.push(`file ${file}: VAT ${admission === undefined ? 'absent' : 'admits'}, reference ${ref.loads(file) ? 'loads' : 'does not load'}`);
    } else if (admission?.kind === 'glob-rule' && !namedMatches(testCase.paths, ref, admission.pattern, file)) {
      found.push(`file ${file}: names ${JSON.stringify(admission.pattern)}, which alone does not match it`);
    }
  }
  return found;
}

export function directoryVerdict(
  testCase: DifferentialCase,
  ref: Reference,
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
    const unnamed = under.find((file) => !namedMatches(testCase.paths, ref, admission.pattern, file));
    return unnamed === undefined ? undefined : `∀ names ${JSON.stringify(admission.pattern)}, which alone misses ${unnamed}`;
  }
  if (admission.kind !== 'glob-rule-may-fire') return `unexpected admission ${admission.kind}`;
  const { examplePath, pattern } = admission;
  if (!under.includes(examplePath) || !ref.loads(examplePath)) return `∃ witness ${examplePath} is not a loaded file here`;
  return namedMatches(testCase.paths, ref, pattern, examplePath)
    ? undefined
    : `∃ names ${JSON.stringify(pattern)}, which alone misses ${examplePath}`;
}

function directoryLaneDivergences(testCase: DifferentialCase, ref: Reference, visible: readonly string[]): string[] {
  const found: string[] = [];
  for (const dir of directoriesOf(visible)) {
    const admissions = pathScopedAdmissions(testCase.rulePath, testCase.paths, testCase.files, dir, null);
    const verdict = directoryVerdict(testCase, ref, visible.filter((file) => isUnder(dir, file)), admissions[0]);
    if (verdict !== undefined) found.push(`dir ${JSON.stringify(dir)}: ${verdict}`);
  }
  return found;
}

function divergences(testCase: DifferentialCase): string[] {
  const ref = referenceOf(testCase);
  const paths = { paths: [...testCase.paths] };
  if (declaresPaths(paths) === ref.alwaysLoaded) {
    return [`load class: VAT declaresPaths=${String(declaresPaths(paths))}, reference alwaysLoaded=${String(ref.alwaysLoaded)}`];
  }
  if (ref.alwaysLoaded) return [];
  const visible = corpusFiles([testCase.rulePath, ...testCase.files].map((file) => queryRealization(file)));
  return [
    ...patternDivergences(testCase, ref, visible),
    ...fileLaneDivergences(testCase, ref, visible),
    ...directoryLaneDivergences(testCase, ref, visible),
  ];
}

/** Greedily drop files, then patterns, while the case still diverges. */
function shrink(testCase: DifferentialCase): DifferentialCase {
  let current = testCase;
  for (let changed = true; changed;) {
    changed = false;
    const candidates: DifferentialCase[] = [
      ...current.files.map((_, drop) => ({ ...current, files: current.files.filter((__, index) => index !== drop) })),
      ...current.paths.length > 1
        ? current.paths.map((_, drop) => ({ ...current, paths: current.paths.filter((__, index) => index !== drop) }))
        : [],
    ];
    const smaller = candidates.find((candidate) => divergences(candidate).length > 0);
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
    const shape = JSON.stringify({ rulePath: minimal.rulePath, paths: minimal.paths, files: minimal.files });
    failures.push(`seed ${seed}: ${shape}\n  ${divergences(minimal).join('\n  ')}`);
  }
  return failures;
}

