/**
 * Importer for `corpus/seed.yaml` — generates entries from upstream marketplaces.
 *
 * Fetches `.claude-plugin/marketplace.json` from
 * `anthropics/claude-plugins-official` and `anthropics/knowledge-work-plugins`,
 * maps each plugin to a PluginEntry, and rewrites `corpus/seed.yaml`.
 *
 * Mapping rules and design are documented in
 * `~/code/vat-issue-99-slice-1b-plan.md` (slice 1b of issue #99).
 *
 * Usage:
 *   bun run import-marketplace
 *
 * Exit codes:
 *   0 - success (seed.yaml written)
 *   1 - failure (network, schema mismatch, name collision, unknown source shape)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT (controlled, not user input)

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { PROJECT_ROOT, log } from './common.js';

// ---------------------------------------------------------------------------
// Catalog config — both upstream catalogs use `main` as their default branch.
// ---------------------------------------------------------------------------

interface Catalog {
  /** GitHub owner */
  owner: string;
  /** GitHub repo name */
  name: string;
  /** Full clone URL */
  cloneUrl: string;
  /** Default branch (used as `<ref>` for string-shape entries that live in this catalog) */
  ref: string;
  /** Prefix applied to all names from this catalog (collision-avoidance) */
  namePrefix: string;
}

export const CATALOG_OFFICIAL: Catalog = {
  owner: 'anthropics',
  name: 'claude-plugins-official',
  cloneUrl: 'https://github.com/anthropics/claude-plugins-official.git',
  ref: 'main',
  namePrefix: '',
};

export const CATALOG_KNOWLEDGE_WORK: Catalog = {
  owner: 'anthropics',
  name: 'knowledge-work-plugins',
  cloneUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
  ref: 'main',
  namePrefix: 'knowledge-work-',
};

// ---------------------------------------------------------------------------
// Upstream manifest schema — Postel's law: passthrough for external data.
// We only read `name`, `source`, and (optionally) `author`. Everything else
// the upstream carries (description, category, homepage, etc.) is silently
// discarded.
// ---------------------------------------------------------------------------

const SourceObjectSchema = z
  .object({
    source: z.string(),
  })
  .passthrough();

const UpstreamEntrySchema = z
  .object({
    name: z.string().min(1),
    source: z.union([z.string(), SourceObjectSchema]),
    author: z
      .object({ name: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ManifestSchema = z
  .object({
    plugins: z.array(UpstreamEntrySchema),
  })
  .passthrough();

export type UpstreamEntry = z.infer<typeof UpstreamEntrySchema>;

// ---------------------------------------------------------------------------
// Output entry shape — kept in sync with `PluginEntrySchema` in
// `packages/cli/src/commands/corpus/seed.ts`. We hand-write entries rather
// than importing the schema (avoids dev-tools → cli reverse dependency).
// The committed seed is validated by `loadSeedFile()` at downstream load time.
// ---------------------------------------------------------------------------

interface PluginEntry {
  source: string;
  name: string;
  bucket: 'official';
  confidence: 'first-party' | 'curated';
  maturity: 'production';
}

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const FIRST_PARTY: PluginEntry['confidence'] = 'first-party';
const CURATED: PluginEntry['confidence'] = 'curated';

// Hand-curated entries that pre-date the import — VAT-owned plugins that
// don't live in either upstream catalog. Re-emitted verbatim on every run.
const PRESERVED_ENTRIES: PluginEntry[] = [
  {
    source:
      'https://github.com/jdutton/vibe-agent-toolkit.git#claude-marketplace:plugins/vibe-agent-toolkit',
    name: 'vibe-agent-toolkit',
    bucket: 'official',
    confidence: FIRST_PARTY,
    maturity: 'production',
  },
  {
    source: 'https://github.com/jdutton/vibe-validate.git#claude-marketplace',
    name: 'vibe-validate',
    bucket: 'official',
    confidence: FIRST_PARTY,
    maturity: 'production',
  },
];

// ---------------------------------------------------------------------------
// Fetch helpers — both use `gh api` via safeExecSync so this script inherits
// the same auth setup as ad-hoc `gh` commands.
// ---------------------------------------------------------------------------

function ghFetch(args: string[]): string {
  const out = safeExecSync('gh', args, { encoding: 'utf8' });
  return typeof out === 'string' ? out : out.toString('utf8');
}

function fetchManifest(catalog: Catalog): z.infer<typeof ManifestSchema> {
  const raw = ghFetch([
    'api',
    `repos/${catalog.owner}/${catalog.name}/contents/.claude-plugin/marketplace.json`,
    '-H',
    'Accept: application/vnd.github.raw',
  ]);
  return ManifestSchema.parse(JSON.parse(raw));
}

function fetchCatalogSha(catalog: Catalog): string {
  const raw = ghFetch([
    'api',
    `repos/${catalog.owner}/${catalog.name}/commits/${catalog.ref}`,
    '--jq',
    '.sha',
  ]);
  return raw.trim().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Mapping primitives — exported so unit tests can exercise each rule directly.
// ---------------------------------------------------------------------------

/** Replace anything outside the schema's name regex with `-`. */
export function mungeName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]+/g, '-');
}

/** Compose the canonical `<git-url>.git#<ref>:<subpath>` source URL. */
export function composeSourceUrl(entry: UpstreamEntry, catalog: Catalog): string {
  const src = entry.source;

  // String shape — entry lives inside the catalog repo.
  if (typeof src === 'string') {
    const stripped = src.replace(/^\.\//, '');
    return `${catalog.cloneUrl}#${catalog.ref}:${stripped}`;
  }

  // Object shape — discriminated by `source.source`. `git-subdir` and `url`
  // both carry an optional `path` and an optional `ref`; omit either when
  // absent and let the audit clone fall back to the repo's default branch.
  const disc = src.source;
  if (disc === 'git-subdir' || disc === 'url') {
    const url = readString(src, 'url', entry.name);
    const ref = (src as Record<string, unknown>)['ref'];
    const path = (src as Record<string, unknown>)['path'];
    const refStr = typeof ref === 'string' ? ref : '';
    const pathStr = typeof path === 'string' ? path : '';
    if (refStr === '' && pathStr === '') return url;
    return `${url}#${refStr}:${pathStr}`;
  }
  if (disc === 'github') {
    const repo = readString(src, 'repo', entry.name);
    return `https://github.com/${repo}.git`;
  }
  throw new Error(
    `Entry "${entry.name}": unknown source discriminator "${disc}". ` +
      `Update import-marketplace.ts to handle this shape.`,
  );
}

function readString(obj: Record<string, unknown>, key: string, ownerName: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(
      `Entry "${ownerName}": expected string at source.${key}, got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

/**
 * Derive `confidence` from the upstream `source` URL.
 *
 * - String shape → `first-party` (both catalogs are anthropics-owned), unless
 *   the path starts with `./partner-built/` (knowledge-work convention for
 *   vendor-contributed plugins).
 * - Object shape → `first-party` iff the resolved GitHub owner is `anthropics`,
 *   else `curated`.
 *
 * The `author` field on upstream entries is NOT consulted (40% of entries
 * lack it, and the field is inconsistent across catalogs).
 */
export function deriveConfidence(entry: UpstreamEntry): PluginEntry['confidence'] {
  const src = entry.source;

  if (typeof src === 'string') {
    return src.startsWith('./partner-built/') ? CURATED : FIRST_PARTY;
  }

  const disc = src.source;
  let url: string | undefined;
  if (disc === 'github') {
    const repo = (src as Record<string, unknown>)['repo'];
    if (typeof repo === 'string') {
      url = `https://github.com/${repo}.git`;
    }
  } else {
    const u = (src as Record<string, unknown>)['url'];
    if (typeof u === 'string') {
      url = u;
    }
  }

  if (url === undefined) {
    return CURATED;
  }
  const ownerMatch = /^https:\/\/github\.com\/([^/]+)\//.exec(url);
  return ownerMatch?.[1] === 'anthropics' ? FIRST_PARTY : CURATED;
}

export function mapEntry(entry: UpstreamEntry, catalog: Catalog): PluginEntry {
  const name = mungeName(`${catalog.namePrefix}${entry.name}`);
  if (!NAME_REGEX.test(name)) {
    throw new Error(
      `Entry "${entry.name}" → "${name}" still fails name regex after munging`,
    );
  }
  return {
    source: composeSourceUrl(entry, catalog),
    name,
    bucket: 'official',
    confidence: deriveConfidence(entry),
    maturity: 'production',
  };
}

// ---------------------------------------------------------------------------
// Deduplication & uniqueness checks
//
// `loadSeedFile()` treats `source` as the unique key (it throws on dupes).
// But the upstream catalogs intentionally list the same plugin under multiple
// presentation-name aliases (e.g. `data`, `data-engineering`, and
// `astronomer-data-agents` all resolve to the same `github.com/astronomer/agents`
// repo). For the seed — which represents *unique audit targets* — we
// deduplicate by source URL and keep the alphabetical-first name.
// ---------------------------------------------------------------------------

interface CombineResult {
  /** Final entry list in seed.yaml order: preserved, then official, then knowledge-work. */
  final: PluginEntry[];
  /** Count of official entries that survived dedup. */
  officialKept: number;
  /** Count of knowledge-work entries that survived dedup. */
  kwKept: number;
  /** Names that were dropped because their source URL had already been claimed. */
  droppedNames: string[];
}

/**
 * Merge preserved + official + knowledge-work entries, dropping duplicates by
 * source URL. Preserved entries always win; within imports, the first
 * occurrence wins (callers pass alphabetically-sorted arrays, so the
 * alphabetical-first name in each duplicate cluster lands in the seed).
 */
export function combineAndDedupe(
  official: PluginEntry[],
  kw: PluginEntry[],
): CombineResult {
  const seen = new Set<string>();
  const final: PluginEntry[] = [];
  const droppedNames: string[] = [];

  for (const e of PRESERVED_ENTRIES) {
    seen.add(e.source);
    final.push(e);
  }

  let officialKept = 0;
  for (const e of official) {
    if (seen.has(e.source)) {
      droppedNames.push(e.name);
      continue;
    }
    seen.add(e.source);
    final.push(e);
    officialKept++;
  }

  let kwKept = 0;
  for (const e of kw) {
    if (seen.has(e.source)) {
      droppedNames.push(e.name);
      continue;
    }
    seen.add(e.source);
    final.push(e);
    kwKept++;
  }

  return { final, officialKept, kwKept, droppedNames };
}

function assertUniqueNames(entries: PluginEntry[]): void {
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) {
      throw new Error(`Duplicate name after mapping: ${e.name}`);
    }
    names.add(e.name);
  }
}

// ---------------------------------------------------------------------------
// YAML output — written by hand (rather than via `yaml.stringify`) to keep
// the file format byte-identical across runs with no upstream changes.
// ---------------------------------------------------------------------------

interface ImportCounts {
  official: number;
  knowledgeWork: number;
}

function buildHeader(officialSha: string, kwSha: string, counts: ImportCounts): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `# Tracked plugins for \`vat corpus scan\`.`,
    `# Source is the unique key. Each entry can carry an optional \`validation:\``,
    `# block with the same shape as \`skills.defaults.validation\` in`,
    `# vibe-agent-toolkit.config.yaml — used to silence findings on this`,
    `# plugin when we've decided the rule is wrong (or not yet right enough).`,
    `#`,
    `# Last imported from upstream marketplaces on ${date} by`,
    `# packages/dev-tools/src/import-marketplace.ts`,
    `#`,
    `# Sources:`,
    `#   anthropics/claude-plugins-official @ ${officialSha} — ${counts.official} entries`,
    `#   anthropics/knowledge-work-plugins  @ ${kwSha} — ${counts.knowledgeWork} entries`,
    `#`,
    `# Hand-curated entries (preserved on re-import): ${PRESERVED_ENTRIES.length} at top.`,
    `# Re-import: bun run import-marketplace`,
    ``,
    ``,
  ].join('\n');
}

function stringifyEntries(entries: PluginEntry[]): string {
  return entries
    .map(
      e =>
        `  - source: ${e.source}\n` +
        `    name: ${e.name}\n` +
        `    bucket: ${e.bucket}\n` +
        `    confidence: ${e.confidence}\n` +
        `    maturity: ${e.maturity}\n`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(): void {
  log('Fetching upstream manifests via gh CLI…', 'cyan');

  const official = fetchManifest(CATALOG_OFFICIAL);
  const kw = fetchManifest(CATALOG_KNOWLEDGE_WORK);
  const officialSha = fetchCatalogSha(CATALOG_OFFICIAL);
  const kwSha = fetchCatalogSha(CATALOG_KNOWLEDGE_WORK);

  log(
    `  claude-plugins-official @ ${officialSha}: ${official.plugins.length} upstream entries`,
    'reset',
  );
  log(
    `  knowledge-work-plugins  @ ${kwSha}: ${kw.plugins.length} upstream entries`,
    'reset',
  );

  // Sort by name within each catalog so the diff is stable when upstream
  // re-orders entries (which they do frequently).
  const officialEntries = official.plugins
    .map(e => mapEntry(e, CATALOG_OFFICIAL))
    .sort((a, b) => a.name.localeCompare(b.name));
  const kwEntries = kw.plugins
    .map(e => mapEntry(e, CATALOG_KNOWLEDGE_WORK))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { final, officialKept, kwKept, droppedNames } = combineAndDedupe(
    officialEntries,
    kwEntries,
  );
  assertUniqueNames(final);

  const mungedCount =
    countMunged(official.plugins, '') +
    countMunged(kw.plugins, CATALOG_KNOWLEDGE_WORK.namePrefix);

  log('', 'reset');
  log('Mapping summary:', 'cyan');
  log(`  Preserved entries:                ${PRESERVED_ENTRIES.length}`, 'reset');
  log(`  Imported (official, raw):         ${officialEntries.length}`, 'reset');
  log(`  Imported (knowledge-work, raw):   ${kwEntries.length}`, 'reset');
  log(
    `  Duplicate-source aliases dropped: ${droppedNames.length}`,
    droppedNames.length > 0 ? 'yellow' : 'reset',
  );
  if (droppedNames.length > 0) {
    log(`    [${droppedNames.join(', ')}]`, 'yellow');
  }
  log(`  Official kept:                    ${officialKept}`, 'reset');
  log(`  Knowledge-work kept:              ${kwKept}`, 'reset');
  log(`  Total in seed.yaml:               ${final.length}`, 'green');
  log(
    `  Names that required munging: ${mungedCount}`,
    mungedCount > 0 ? 'yellow' : 'reset',
  );

  const output =
    buildHeader(officialSha, kwSha, {
      official: officialKept,
      knowledgeWork: kwKept,
    }) +
    `plugins:\n` +
    stringifyEntries(final);

  const seedPath = safePath.join(PROJECT_ROOT, 'corpus', 'seed.yaml');
  writeFileSync(seedPath, output, 'utf8');
  log('', 'reset');
  log(`✓ Wrote ${seedPath}`, 'green');
}

function countMunged(entries: UpstreamEntry[], prefix: string): number {
  let count = 0;
  for (const e of entries) {
    const raw = `${prefix}${e.name}`;
    if (mungeName(raw) !== raw) {
      count++;
    }
  }
  return count;
}

// Only run when invoked directly (e.g. `bun run import-marketplace`). When
// imported by unit tests, this top-level branch is skipped so importing the
// module doesn't fetch from gh or rewrite seed.yaml.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    run();
  } catch (err) {
    log(`✗ ${(err as Error).message}`, 'red');
    process.exit(1);
  }
}
