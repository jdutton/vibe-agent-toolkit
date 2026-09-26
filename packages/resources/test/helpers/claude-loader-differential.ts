/**
 * The engine of a randomized DIFFERENTIAL test of `vat claude context`'s
 * public answer — `whatLoadsAt` folded through `account` — against a
 * reference port of Claude Code's own loader (`claude-loader-reference.ts`).
 * Two tiers sweep disjoint seed ranges through it:
 * `projection-claude-loader-differential.test.ts` (unit, in-memory projection)
 * and the integration tier — `integration/claude-loader-differential.integration.test.ts`
 * (in memory) and `integration/claude-loader-differential-on-disk.integration.test.ts`
 * (real trees on disk through `buildClaudeContextPopulation`).
 *
 * ## What is compared
 *
 * Each case is a random tree — `CLAUDE.md`, `.claude/CLAUDE.md`,
 * `CLAUDE.local.md`, `AGENTS.md` and rules with and without `paths:` at several
 * directory levels, documents they `@`-import in varied markdown contexts, and
 * files over the size cliff — and a handful of query FILES. A query of `f` is
 * a session started in `f`'s directory that reads `f`, so for each one:
 *
 * - **launch** — the paths VAT charges `always` equal the reference's launch
 *   set for that directory;
 * - **on demand** — the paths VAT charges `on-demand` equal what the reference
 *   injects when `f` is read;
 * - **token basis** — for a path both charge, VAT's tokens equal the shipped
 *   estimator over the text the harness INJECTS (frontmatter and comment blocks
 *   removed, trimmed), not over the file;
 * - **imports** — for every file the harness would read, the targets VAT's
 *   `harness_blob_imports` rows resolve to (in order, first occurrence of each,
 *   outside-the-tree targets dropped) equal the reference's `Ayn` over it. The
 *   load sets alone could agree while the import sets differ — an import to a
 *   file some other route loads anyway is invisible to them.
 *
 * Order is not compared: VAT's answer is path-sorted by contract.
 * External-include approval is taken as GRANTED, the over-report direction a
 * budget answer may take: the tree cannot say whether a user approved it.
 *
 * ## Feature groups
 *
 * Every construct the generator can plant belongs to one named group, and a
 * sweep names the groups it plants — every group is settled, so a sweep leaves
 * one out only for cost (the 4 MiB `oversize` files). A construct VAT answers
 * differently is a failing sweep, never a group parked beside it.
 *
 * A failure prints the seed and a greedily SHRUNK case. Re-run one seed with
 * `LOADER_DIFFERENTIAL_SEED=<n>`, widen with `LOADER_DIFFERENTIAL_CASES=<n>`.
 */

import { estimateTokens } from '../../src/link-classify.js';
import { account, type AccountedRow } from '../../src/projection/claude-context-accounting.js';
import { whatLoadsAt } from '../../src/projection/claude-context-query.js';
import { CLAUDE_CODE } from '../../src/projection/harness/claude-code.js';
import { harnessFactsIndex } from '../../src/projection/harness/facts-index.js';
import type { Projection } from '../../src/projection/projection.js';
import { resolveReferencePath } from '../../src/projection/reference-resolution.js';

import {
  filesOnRead,
  launchFiles,
  LOADER_SIZE_CLIFF,
  memoryImports,
  type LoadedMemoryFile,
  type LoaderTree,
} from './claude-loader-reference.js';

/** A construct family the generator can plant. */
export type LoaderFeature =
  /** `@path` in prose, lists, headings, quotes, fences and code spans — where both lexers agree on the token. */
  | 'plain-imports'
  /** `(@x)`, `@x.`, `@x,`, `**@x**`, `_@x_`, `[@x](y)`, `<div>@x</div>`, `\@x`, `@my\ file.md` — only Claude Code's `marked` walk reads these right. */
  | 'marked-only-imports'
  /** Frontmatter, comment blocks, and files that inject nothing — the injected text differs from the file. */
  | 'injected-content'
  /** Path-scoped rules below the root, whose globs the harness matches relative to their own directory only. */
  | 'cross-directory-globs'
  /** `.claude/CLAUDE.md` and unscoped nested rules in every ancestor. */
  | 'ancestor-files'
  /** Imported documents whose own `paths:` decide when they load. */
  | 'scoped-imports'
  /** Files over the 4 MiB cliff. */
  | 'oversize'
  /** `r.MD`, `AGENTS.md`, non-text import targets. */
  | 'names';

/** Every group: VAT is held to the reference on all of them. */
export const SETTLED_FEATURES: readonly LoaderFeature[] = [
  'plain-imports',
  'marked-only-imports',
  'injected-content',
  'ancestor-files',
  'cross-directory-globs',
  'scoped-imports',
  'oversize',
  'names',
];

/** One generated scenario: the tree, and the files a session reads. */
export interface LoaderCase {
  readonly seed: number;
  readonly files: Readonly<Record<string, string>>;
  readonly queries: readonly string[];
}

// ── The generator ─────────────────────────────────────────────────────────

/** mulberry32 — a tiny seeded PRNG, so every case is reproducible from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function choose<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('choose from an empty list');
  return item;
}

/** The directories instruction files are planted in. */
const LEVELS = ['', 'pkg', 'pkg/sub'];

/** Documents an instruction file may import, and files a session may read. */
const DOCUMENTS = ['docs/guide.md', 'docs/api.md', 'pkg/notes.md', 'pkg/sub/deep.md', 'README.md', 'shared.txt', 'pkg/src/app.ts', 'src/index.ts'];

/** Import targets only the `names` group plants: not text, or nothing at all. */
const ODD_TARGETS = ['logo.png', 'docs/spec.pdf', 'docs/missing.md', 'docs'];

/** Globs a path-scoped file may declare. */
const GLOBS = ['src/**', '**/*.ts', 'docs/**', '*.md', 'app.ts', 'sub/**', '**/*.md'];

/** The path from `fromDir` to `target`, as an author would write it. */
function relativeRef(fromDir: string, target: string): string {
  // eslint-disable-next-line local/no-hardcoded-path-split -- tree paths are root-relative and forward-slashed by construction
  const from = fromDir === '' ? [] : fromDir.split('/');
  // eslint-disable-next-line local/no-hardcoded-path-split -- tree paths are root-relative and forward-slashed by construction
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const ups = from.length - shared;
  const rest = to.slice(shared).join('/');
  return ups === 0 ? rest : `${'../'.repeat(ups)}${rest}`;
}

type Context = (ref: string) => string;

/** Contexts both lexers read the same way. */
const PLAIN_CONTEXTS: readonly Context[] = [
  (ref) => `@${ref}`,
  (ref) => `See @${ref} for the details`,
  (ref) => `- @${ref}`,
  (ref) => `# Imports @${ref}`,
  (ref) => `> @${ref}`,
  (ref) => `@${ref}#section`,
  (ref) => `\`@${ref}\``,
  (ref) => `\`\`\`\n@${ref}\n\`\`\``,
];

/** Contexts only a `marked` walk reads right. */
const MARKED_ONLY_CONTEXTS: readonly Context[] = [
  (ref) => `(@${ref})`,
  (ref) => `Read @${ref}.`,
  (ref) => `@${ref}, then`,
  (ref) => `**@${ref}**`,
  (ref) => `_@${ref}_`,
  (ref) => `[@${ref}](https://example.com)`,
  (ref) => `<div>@${ref}</div>`,
  (ref) => String.raw`\@${ref}`,
  (ref) => `<!-- @${ref} -->`,
];

/** What an instruction or document file carries, drawn from the active groups. */
function bodyFor(random: () => number, path: string, targets: readonly string[], features: ReadonlySet<LoaderFeature>): string {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const contexts = [
    ...(features.has('plain-imports') ? PLAIN_CONTEXTS : []),
    ...(features.has('marked-only-imports') ? MARKED_ONLY_CONTEXTS : []),
  ];
  const lines = [`Notes for ${path}.`];
  const imports = contexts.length === 0 ? 0 : Math.floor(random() * 3);
  for (let index = 0; index < imports; index += 1) {
    const target = choose(random, targets);
    if (target === path) continue;
    const ref = relativeRef(dir, target);
    lines.push('', choose(random, contexts)(random() < 0.2 ? `./${ref}` : ref));
  }
  if (features.has('injected-content') && random() < 0.3) lines.push('', '<!-- maintainer note: do not load -->');
  return `${lines.join('\n')}\n`;
}

/** A frontmatter block, when the file is path-scoped. */
function frontmatterFor(random: () => number, scoped: boolean, features: ReadonlySet<LoaderFeature>): string {
  if (scoped) {
    const count = 1 + Math.floor(random() * 2);
    const globs = Array.from({ length: count }, () => `  - "${choose(random, GLOBS)}"`);
    return `---\npaths:\n${globs.join('\n')}\n---\n`;
  }
  return features.has('injected-content') && random() < 0.2 ? '---\ndescription: unscoped\n---\n' : '';
}

/** The instruction-file slots one level may hold. */
function slotsAt(level: string, features: ReadonlySet<LoaderFeature>): string[] {
  const at = (name: string): string => (level === '' ? name : `${level}/${name}`);
  const slots = [at('CLAUDE.md'), at('CLAUDE.local.md'), at('.claude/rules/style.md')];
  if (features.has('ancestor-files')) slots.push(at('.claude/CLAUDE.md'), at('.claude/rules/deep/more.md'));
  if (features.has('names')) slots.push(at('AGENTS.md'), at('.claude/rules/LOUD.MD'));
  return slots;
}

/** Whether a slot is path-scoped: rules may be; imported documents may be under `scoped-imports`. */
function scopedSlot(random: () => number, path: string, features: ReadonlySet<LoaderFeature>): boolean {
  // eslint-disable-next-line local/no-path-startswith -- generated paths are root-relative and forward-slashed by construction
  if (path.startsWith('.claude/rules/')) return random() < 0.4;
  if (path.includes('.claude/rules/')) return features.has('cross-directory-globs') && random() < 0.4;
  return features.has('scoped-imports') && DOCUMENTS.includes(path) && random() < 0.3;
}

/**
 * One scenario from its seed, planting only the named groups.
 *
 * @param seed - The case's seed
 * @param features - The construct groups this sweep plants
 * @returns The case
 */
export function generatedLoaderCase(seed: number, features: ReadonlySet<LoaderFeature>): LoaderCase {
  const random = seeded(seed);
  const slots = LEVELS.flatMap((level) => slotsAt(level, features)).filter(() => random() < 0.45);
  const documents = DOCUMENTS.filter(() => random() < 0.6);
  const targets = [...slots, ...documents, ...(features.has('names') ? ODD_TARGETS : [])];
  const files: Record<string, string> = {};
  for (const path of [...slots, ...documents]) {
    files[path] = frontmatterFor(random, scopedSlot(random, path, features), features) + bodyFor(random, path, targets, features);
  }
  if (features.has('names') && random() < 0.3) files['logo.png'] = 'PNG';
  if (features.has('injected-content') && documents.length > 0 && random() < 0.3) {
    // A file that injects NOTHING: the harness drops it and never follows its imports.
    files[choose(random, documents)] = choose(random, ['<!-- a maintainer note -->\n', '---\ndescription: empty\n---\n', '\n\n']);
  }
  if (features.has('oversize') && slots.length > 0 && random() < 0.08) {
    const victim = choose(random, slots);
    files[victim] = `${files[victim] ?? ''}${'x'.repeat(LOADER_SIZE_CLIFF)}\n`;
  }
  const readable = Object.keys(files).filter((path) => (files[path]?.length ?? 0) <= LOADER_SIZE_CLIFF);
  const queries = [...new Set(Array.from({ length: 3 }, () => choose(random, readable.length > 0 ? readable : ['README.md'])))];
  if (readable.length === 0) files['README.md'] = 'Hello.\n';
  return { seed, files, queries };
}

// ── The comparison ────────────────────────────────────────────────────────

/** Rows VAT charges — every size-cliff state that still counts toward a total. */
function charged(rows: readonly AccountedRow[], loadClass: 'always' | 'on-demand'): Map<string, AccountedRow> {
  return new Map(rows
    .filter((row) => row.loadClass === loadClass && (row.sizeCliff === 'loaded' || row.sizeCliff === 'unmeasured'))
    .map((row) => [row.path, row]));
}

function setDivergences(label: string, vat: ReadonlyMap<string, AccountedRow>, reference: readonly LoadedMemoryFile[]): string[] {
  const expected = new Set(reference.map((entry) => entry.path));
  return [
    ...[...expected].filter((path) => !vat.has(path)).map((path) => `${label}: reference loads ${path}, VAT does not charge it`),
    ...[...vat.keys()].filter((path) => !expected.has(path)).map((path) => `${label}: VAT charges ${path}, reference does not load it`),
  ];
}

function tokenDivergences(vat: ReadonlyMap<string, AccountedRow>, reference: readonly LoadedMemoryFile[]): string[] {
  return reference.flatMap((entry) => {
    const row = vat.get(entry.path);
    const injected = estimateTokens(entry.injected);
    return row === undefined || row.tokens === injected
      ? []
      : [`tokens: ${entry.path} charged ${String(row.tokens)}, injected text is ${injected}`];
  });
}

/** Every way VAT's answer for one query differs from the reference. */
function queryDivergences(projection: Projection, tree: LoaderTree, query: string): string[] {
  const answer = whatLoadsAt(projection, query);
  if (answer.kind !== 'answer') return [`query ${query}: VAT answered unknown`];
  const cwd = query.includes('/') ? query.slice(0, query.lastIndexOf('/')) : '';
  const launch = launchFiles(tree, cwd, { externalIncludesApproved: true });
  const onRead = filesOnRead(tree, cwd, query, new Set(launch.map((entry) => entry.path)));
  const { rows } = account(answer);
  const always = charged(rows, 'always');
  const onDemand = charged(rows, 'on-demand');
  return [
    ...setDivergences('launch', always, launch),
    ...setDivergences('on read', onDemand, onRead),
    ...tokenDivergences(always, launch),
    ...tokenDivergences(onDemand, onRead),
  ].map((line) => `query ${query}: ${line}`);
}

/**
 * The in-tree targets VAT's import extraction for one file resolves to, in
 * ordinal order, first occurrence of each — the shape `Ayn`'s `Set` has.
 *
 * A file the harness reaches is read off its `harness_blob_imports` rows — the
 * table the walk reads. A file it does not reach has no rows by design (the
 * facts are derived lazily, for the reached set only), so its extraction is
 * asked of the SAME extractor directly: the reference's import set is an
 * oracle for the extractor over every file, and narrowing it to the reached
 * ones would quietly shrink what this sweep proves. Whether VAT reaches what
 * the reference loads is the query comparison's question, and a reached blob
 * with no rows throws there.
 */
function vatImports(projection: Projection, tree: LoaderTree, path: string): string[] {
  const root = projection.roots[0]?.path ?? '';
  const contentKey = projection.resourceRealizations.find((row) => row.path === path)?.contentKey;
  const targets = importRowsOf(projection, tree, path, contentKey)
    .map((row) => resolveReferencePath('claude-import', row.target, path, root))
    .flatMap((resolution) => (resolution.kind === 'inside-root' ? [resolution.path] : []));
  return [...new Set(targets)];
}

/** One file's import rows, in ordinal order: stored when derived, extracted when not, none without content. */
function importRowsOf(
  projection: Projection,
  tree: LoaderTree,
  path: string,
  contentKey: string | null | undefined,
): readonly { readonly target: string }[] {
  if (contentKey === null || contentKey === undefined) return [];
  if (!projection.blobs.some((row) => row.contentKey === contentKey)) return [];
  const facts = harnessFactsIndex(projection, CLAUDE_CODE.id);
  if (facts.factsOf(contentKey) !== undefined) return facts.requireImports(contentKey, path);
  return CLAUDE_CODE.factsOf(tree.get(path) ?? '').imports;
}

/** Every file whose import set VAT reads differently from the harness. */
function importDivergences(projection: Projection, tree: LoaderTree): string[] {
  return [...tree.keys()].flatMap((path) => {
    const reference = memoryImports(tree, path);
    if (reference === null) return [];
    const expected = reference.filter((target): target is string => target !== null);
    const actual = vatImports(projection, tree, path);
    return JSON.stringify(expected) === JSON.stringify(actual)
      ? []
      : [`imports: ${path} imports ${JSON.stringify(expected)}, VAT reads ${JSON.stringify(actual)}`];
  });
}

/** Builds VAT's projection for a `{path: content}` tree — in memory, or on disk. */
export type ProjectionFor = (files: Readonly<Record<string, string>>) => Promise<Projection>;

/**
 * Every divergence for one case.
 *
 * @param testCase - The case
 * @param projectionFor - How VAT's projection is built for it
 * @returns One line per divergence; empty when VAT agrees
 */
export async function loaderDivergences(testCase: LoaderCase, projectionFor: ProjectionFor): Promise<string[]> {
  const projection = await projectionFor(testCase.files);
  const tree: LoaderTree = new Map(Object.entries(testCase.files));
  return [
    ...importDivergences(projection, tree),
    ...testCase.queries.flatMap((query) => queryDivergences(projection, tree, query)),
  ];
}

/** Drop one query, keeping at least one. */
function withoutQuery(current: LoaderCase, index: number): LoaderCase | undefined {
  if (current.queries.length < 2 || index >= current.queries.length) return undefined;
  return { ...current, queries: current.queries.filter((_, other) => other !== index) };
}

/** Drop one file that is not queried. */
function withoutFile(current: LoaderCase, index: number): LoaderCase | undefined {
  const droppable = Object.keys(current.files).filter((path) => !current.queries.includes(path));
  const path = droppable[index];
  if (path === undefined) return undefined;
  return { ...current, files: Object.fromEntries(Object.entries(current.files).filter(([other]) => other !== path)) };
}

/** Drop one line of one file, counting lines across the files in key order. */
function withoutLine(current: LoaderCase, index: number): LoaderCase | undefined {
  let remaining = index;
  for (const [path, content] of Object.entries(current.files)) {
    const lines = content.split('\n');
    if (remaining < lines.length) {
      return { ...current, files: { ...current.files, [path]: lines.filter((_, other) => other !== remaining).join('\n') } };
    }
    remaining -= lines.length;
  }
  return undefined;
}

/**
 * How many diverging seeds one sweep shrinks, and how many candidate cases one
 * shrink may try. Every try re-populates a projection, so a broken module
 * failing every seed would otherwise spend minutes shrinking cases that all say
 * the same thing; past either bound a case is reported as far as it got.
 */
const SHRUNK_FAILURES = 3;
const SHRINK_TRIES = 600;

/**
 * Greedily drop queries, then files, then lines while the case still diverges.
 * Each phase walks its candidates once and does not restart after a success —
 * the dropped item's successor takes its index — so a phase is linear.
 */
async function shrink(testCase: LoaderCase, projectionFor: ProjectionFor): Promise<LoaderCase> {
  let current = testCase;
  let tries = 0;
  for (const drop of [withoutQuery, withoutFile, withoutLine]) {
    for (let index = 0; tries < SHRINK_TRIES; tries += 1) {
      const candidate = drop(current, index);
      if (candidate === undefined) break;
      if ((await loaderDivergences(candidate, projectionFor)).length > 0) current = candidate;
      else index += 1;
    }
  }
  return current;
}

/**
 * The seeds one sweep runs: one pinned seed, or `count` seeds from `first`.
 *
 * @param first - The first seed of this tier's range
 * @param count - How many seeds this tier sweeps by default
 * @returns The seeds, honouring `LOADER_DIFFERENTIAL_SEED` / `LOADER_DIFFERENTIAL_CASES`
 */
export function loaderSweepSeeds(first: number, count: number): number[] {
  const pinned = process.env['LOADER_DIFFERENTIAL_SEED'];
  if (pinned !== undefined) return [Number(pinned)];
  const cases = Number(process.env['LOADER_DIFFERENTIAL_CASES'] ?? String(count));
  return Array.from({ length: cases }, (_, index) => first + index);
}

/**
 * Every seed whose case diverges, each with its shrunk case and divergences.
 *
 * @param seeds - The seeds to generate and compare
 * @param features - The construct groups to plant
 * @param projectionFor - How VAT's projection is built
 * @returns One report per diverging seed; empty when VAT agrees everywhere
 */
export async function loaderDifferentialFailures(
  seeds: readonly number[],
  features: ReadonlySet<LoaderFeature>,
  projectionFor: ProjectionFor,
): Promise<string[]> {
  const failures: string[] = [];
  for (const seed of seeds) {
    const testCase = generatedLoaderCase(seed, features);
    if ((await loaderDivergences(testCase, projectionFor)).length === 0) continue;
    const minimal = failures.length < SHRUNK_FAILURES ? await shrink(testCase, projectionFor) : testCase;
    const shape = JSON.stringify({ files: minimal.files, queries: minimal.queries });
    failures.push(`seed ${seed}: ${shape}\n  ${(await loaderDivergences(minimal, projectionFor)).join('\n  ')}`);
  }
  return failures;
}
