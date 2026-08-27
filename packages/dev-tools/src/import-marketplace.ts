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
 *   bun run import-marketplace [--allow-shrink]
 *
 * Flags:
 *   --allow-shrink  Bypass the safety checks that refuse to overwrite the seed
 *                   when (a) an upstream catalog returned 0 plugins or (b) the
 *                   new entry count drops >20% vs. the existing seed. Use only
 *                   when an upstream catalog is *genuinely* empty or shrinking.
 *
 * Exit codes:
 *   0 - success (seed.yaml written)
 *   1 - failure (network, schema mismatch, name collision, unknown source
 *       shape, empty catalog without --allow-shrink, catastrophic shrinkage
 *       without --allow-shrink)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT (controlled, not user input)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { CommandExecutionError, safeExecSync } from '@vibe-agent-toolkit/utils/process';
import * as yaml from 'yaml';
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
// Output entry shape — the canonical `PluginEntrySchema` from
// `packages/cli/src/commands/corpus/seed.ts`, hand-mirrored to avoid a
// dev-tools → cli reverse dependency. The committed seed is validated by
// `loadSeedFile()` at downstream load time.
//
// The full union shape is carried through the importer's pipeline so that
// preserved entries (which can be any valid `PluginEntry`) round-trip
// without `as`-casts that would lie about their narrow type at the
// public-shaming gate. `mapEntry` still emits the narrow `official` /
// `first-party|curated` / `production` literals for freshly-mapped upstream
// entries.
// ---------------------------------------------------------------------------

interface PluginEntry {
  source: string;
  name: string;
  bucket: 'official' | 'community';
  confidence: 'first-party' | 'curated' | 'listed';
  maturity: 'production' | 'experimental' | 'example';
}

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const FIRST_PARTY: PluginEntry['confidence'] = 'first-party';
const CURATED: PluginEntry['confidence'] = 'curated';

// Minimal schema for parsing the existing seed.yaml back in. Wider than the
// `PluginEntry` we emit (the canonical schema allows `community` bucket,
// `experimental` maturity, `listed` confidence, and a nested validation block)
// because the file on disk may have richer entries that we still need to
// preserve untouched. Stays in sync with `PluginEntrySchema` in
// `packages/cli/src/commands/corpus/seed.ts`.
const ExistingPluginEntrySchema = z
  .object({
    source: z.string().min(1),
    name: z.string().min(1),
    bucket: z.enum(['official', 'community']),
    confidence: z.enum(['first-party', 'curated', 'listed']),
    maturity: z.enum(['production', 'experimental', 'example']),
    validation: z.unknown().optional(),
  })
  .strict();

const ExistingSeedSchema = z
  .object({
    plugins: z.array(ExistingPluginEntrySchema),
  })
  .strict();

type ExistingPluginEntry = z.infer<typeof ExistingPluginEntrySchema>;

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
  const catalogId = `${catalog.owner}/${catalog.name}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from ${catalogId} marketplace.json: ${(err as Error).message}. ` +
        `First 200 chars of body: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  try {
    return ManifestSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(
        `Manifest from ${catalogId} failed schema validation:\n${issues}`,
      );
    }
    throw err;
  }
}

function fetchCatalogSha(catalog: Catalog): string {
  const raw = ghFetch([
    'api',
    `repos/${catalog.owner}/${catalog.name}/commits/${catalog.ref}`,
    '--jq',
    '.sha',
  ]).trim();
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    // `gh` deprecation/update notices and `--jq` misses both come back as a
    // 200 with a stdout body that isn't a SHA — without this guard, a garbage
    // or blank value would land in the header provenance and look real.
    throw new Error(
      `Unexpected response from gh api for ${catalog.owner}/${catalog.name} HEAD SHA: ` +
        `expected 40-char hex, got ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  return raw.slice(0, 7);
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
// Preservation — read existing seed.yaml, hold back any entry whose `source`
// isn't going to be re-produced by the importer.
//
// "Preserved" is defined structurally, not by a hardcoded allowlist: anything
// the importer wouldn't generate this run is treated as hand-curated and
// re-emitted verbatim. This covers the 2 VAT-owned entries today and any
// future hand-added entries without needing to update this file.
// ---------------------------------------------------------------------------

/**
 * Read and structurally validate the existing `corpus/seed.yaml`. Throws if
 * the file is missing or malformed — re-import is not a bootstrap operation.
 */
export function loadExistingSeed(path: string): ExistingPluginEntry[] {
  if (!existsSync(path)) {
    throw new Error(
      `Existing seed file not found: ${path}. Re-import requires an existing seed.yaml ` +
        `(this script preserves entries that don't come from upstream).`,
    );
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = ExistingSeedSchema.parse(yaml.parse(raw));
  return parsed.plugins;
}

/**
 * Pick entries from the existing seed whose `source` is NOT one the importer
 * is about to produce. These are hand-curated and re-emitted verbatim.
 *
 * Throws on a preserved entry that carries a `validation:` block — the
 * verbatim stringify path doesn't currently serialize nested validation
 * blocks, so a silent drop here would be a real bug. Slice 1b has no such
 * entries; a later slice that introduces validation overrides needs to
 * extend `stringifyEntries` first.
 */
export function partitionPreserved(
  existing: ExistingPluginEntry[],
  importedSources: Set<string>,
): PluginEntry[] {
  const preserved: PluginEntry[] = [];
  for (const e of existing) {
    if (importedSources.has(e.source)) continue;
    if (e.validation !== undefined) {
      throw new Error(
        `Preserved entry "${e.name}" carries a validation block; stringifyEntries doesn't ` +
          `serialize validation blocks yet. Either remove the block or extend the importer.`,
      );
    }
    preserved.push({
      source: e.source,
      name: e.name,
      bucket: e.bucket,
      confidence: e.confidence,
      maturity: e.maturity,
    });
  }
  return preserved;
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
  preserved: PluginEntry[],
  official: PluginEntry[],
  kw: PluginEntry[],
): CombineResult {
  const seen = new Set<string>();
  const final: PluginEntry[] = [];
  const droppedNames: string[] = [];

  for (const e of preserved) {
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
// Shrinkage guards — protect against silently committing a collapsed seed.
//
// Both upstream catalogs are eventually-consistent GitHub repos served via
// `gh api`; a mid-deploy push, an empty `plugins: []` blob, or a transient
// 200-with-bad-body could all reduce a catalog to zero or near-zero entries
// without raising an exception. `writeFileSync` overwrites `seed.yaml`
// unconditionally, so a passing run could quietly turn 238 entries into ~32.
// These guards refuse to write under those conditions; `--allow-shrink`
// bypasses them for the rare case where shrinkage is real.
// ---------------------------------------------------------------------------

/** Drop ratio above which `assertNoCatastrophicShrinkage` refuses. */
const MAX_SHRINK_RATIO = 0.2;

/**
 * Refuse to write if a catalog returned 0 plugins (the most likely cause of
 * a silently-collapsed seed). `--allow-shrink` bypasses for the rare case
 * where an upstream catalog is genuinely empty.
 */
export function assertCatalogNonEmpty(
  catalog: Catalog,
  pluginCount: number,
  allowShrink: boolean,
): void {
  if (pluginCount > 0 || allowShrink) return;
  throw new Error(
    `Catalog ${catalog.owner}/${catalog.name} returned 0 plugins. ` +
      `Refusing to overwrite seed.yaml with a likely-empty catalog. ` +
      `Re-run when the catalog is populated, or pass --allow-shrink to override.`,
  );
}

/**
 * Refuse to overwrite the existing seed if the new entry count would drop by
 * more than `MAX_SHRINK_RATIO` (default 20%). `--allow-shrink` bypasses.
 *
 * Bootstrap case: an existing count of 0 is treated as "no prior seed to
 * shrink from" and always allowed.
 */
export function assertNoCatastrophicShrinkage(
  existingCount: number,
  newCount: number,
  allowShrink: boolean,
): void {
  if (allowShrink || existingCount === 0) return;
  const dropRatio = (existingCount - newCount) / existingCount;
  if (dropRatio > MAX_SHRINK_RATIO) {
    const dropPct = (dropRatio * 100).toFixed(1);
    throw new Error(
      `Refusing to shrink seed.yaml by ${dropPct}% (${existingCount} → ${newCount} entries; ` +
        `threshold ${(MAX_SHRINK_RATIO * 100).toFixed(0)}%). Likely a transient upstream issue. ` +
        `Investigate before re-running with --allow-shrink to override.`,
    );
  }
}

export function parseRunArgs(argv: readonly string[]): { allowShrink: boolean } {
  return { allowShrink: argv.includes('--allow-shrink') };
}

// ---------------------------------------------------------------------------
// YAML output — written by hand (rather than via `yaml.stringify`) so the
// entry block stays diff-clean run-to-run unless upstream actually moved.
// Note: the header's date stamp and catalog HEAD SHAs *do* shift across days
// or upstream pushes; a future `--check` drift mode would have to ignore
// those header lines.
// ---------------------------------------------------------------------------

interface ImportCounts {
  preserved: number;
  official: number;
  knowledgeWork: number;
}

function buildHeader(officialSha: string, kwSha: string, counts: ImportCounts): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `# Tracked plugins for \`vat corpus scan\`. Source is the unique key.`,
    `#`,
    `# Last imported from upstream marketplaces on ${date} by`,
    `# packages/dev-tools/src/import-marketplace.ts.`,
    `#`,
    `# Each entry's \`source\` URL points at an upstream repo and (where the`,
    `# upstream specifies one) a fragment ref — typically the default branch,`,
    `# NOT a per-entry commit SHA. The catalog SHAs below are the audit`,
    `# provenance of *this importer run* (which catalog HEADs were read);`,
    `# entries themselves are not pinned and drift with upstream branches.`,
    `#`,
    `# Sources:`,
    `#   anthropics/claude-plugins-official @ ${officialSha} — ${counts.official} entries`,
    `#   anthropics/knowledge-work-plugins  @ ${kwSha} — ${counts.knowledgeWork} entries`,
    `#`,
    `# Hand-curated entries (preserved on re-import): ${counts.preserved} at top.`,
    `# An existing entry is preserved iff its \`source\` URL isn't one the importer`,
    `# would generate this run (i.e. it doesn't live in either upstream catalog).`,
    `# Re-import: bun run import-marketplace [--allow-shrink]`,
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
  const { allowShrink } = parseRunArgs(process.argv.slice(2));
  const seedPath = safePath.join(PROJECT_ROOT, 'corpus', 'seed.yaml');

  log('Reading existing seed.yaml for preserved entries…', 'cyan');
  const existing = loadExistingSeed(seedPath);

  log('Fetching upstream manifests via gh CLI…', 'cyan');
  const official = fetchManifest(CATALOG_OFFICIAL);
  const kw = fetchManifest(CATALOG_KNOWLEDGE_WORK);
  assertCatalogNonEmpty(CATALOG_OFFICIAL, official.plugins.length, allowShrink);
  assertCatalogNonEmpty(CATALOG_KNOWLEDGE_WORK, kw.plugins.length, allowShrink);
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

  const importedSources = new Set([
    ...officialEntries.map(e => e.source),
    ...kwEntries.map(e => e.source),
  ]);
  const preserved = partitionPreserved(existing, importedSources);

  const { final, officialKept, kwKept, droppedNames } = combineAndDedupe(
    preserved,
    officialEntries,
    kwEntries,
  );
  assertUniqueNames(final);

  const mungedCount =
    countMunged(official.plugins, '') +
    countMunged(kw.plugins, CATALOG_KNOWLEDGE_WORK.namePrefix);

  log('', 'reset');
  log('Mapping summary:', 'cyan');
  log(`  Preserved entries:                ${preserved.length}`, 'reset');
  if (preserved.length > 0) {
    log(`    [${preserved.map(e => e.name).join(', ')}]`, 'reset');
  }
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

  assertNoCatastrophicShrinkage(existing.length, final.length, allowShrink);

  const output =
    buildHeader(officialSha, kwSha, {
      preserved: preserved.length,
      official: officialKept,
      knowledgeWork: kwKept,
    }) +
    `plugins:\n` +
    stringifyEntries(final);

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
    // `CommandExecutionError.stderr` carries the real reason for `gh` failures
    // (HTTP 403 rate-limit, "not authenticated", etc.) — the bare `.message`
    // is usually just "Command failed".
    if (err instanceof CommandExecutionError) {
      const stderr =
        typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8');
      if (stderr.trim().length > 0) {
        log(stderr.trimEnd(), 'red');
      }
    }
    // Zod errors raised outside `fetchManifest` (e.g. from `loadExistingSeed`)
    // surface here; print issues so the user knows which field failed.
    if (err instanceof z.ZodError) {
      for (const issue of err.issues) {
        log(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`, 'red');
      }
    }
    process.exit(1);
  }
}
