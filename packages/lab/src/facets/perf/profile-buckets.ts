/**
 * The cost buckets a `vat validate` in-process phase is attributed to, as data.
 *
 * Each rule names a bucket by the frames that put a sample in it: vat's own
 * modules by their emitted file (`<package>/dist/<path>.js`, so a build from the
 * monorepo and one installed from npm match alike) and, where one module holds
 * more than one bucket, by function. Order is priority (see
 * `profile-attribution.ts`): the first rule with a frame anywhere on a sample's
 * stack takes it, so a narrow bucket comes before the broad one that encloses
 * it. A function or file renamed in vat lands its samples in `other`, named by
 * leaf, rather than in a wrong bucket; a rule is corrected here when that shows.
 *
 * One bucket is a catch-all by design: `blob read and decode` takes every sample
 * in projection-sqlite's `store`, `values` and `run-database` modules (and in
 * resources' stored-admission and blob-facts) that no earlier rule claimed. The
 * store's shared decode serves both tiers, so the extent read is claimed first
 * by its entry points, and store open and write by function name; what is left
 * there is counted as the blob read. That is a heuristic: store work no rule
 * names (statement preparation, a new entry point) lands in the blob read, not
 * in `other`, and shows up only as a frame in that bucket's list.
 */

import { toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';

import type { BucketRule, UrlPattern } from './profile-attribution.js';

/** A frame's url with every separator a forward slash, whichever OS wrote the profile. */
function slashed(url: string): string {
  return toForwardSlashAnyPlatform(url);
}

/**
 * A pattern over named vat modules, carrying the names it matches: a module
 * path, never a regex, so a test can check every one names a source file.
 */
export interface VatModulePattern extends UrlPattern {
  /** The package directory under `packages/`. */
  readonly pkg: string;
  /** Each module's path below the package's `src/` (and `dist/`), no extension. */
  readonly modules: readonly string[];
}

/** A frame in one of vat's emitted modules: `<package>/dist/<module>.js`, `modules` a `|`-separated list of literal paths. */
function vatModule(pkg: string, modules: string): VatModulePattern {
  const marker = `/${pkg}/dist/`;
  const names = modules.split('|');
  const files = new Set(names.map((name) => `${name}.js`));
  return {
    pkg,
    modules: names,
    test: (url) => {
      const path = slashed(url);
      const at = path.lastIndexOf(marker);
      return at >= 0 && files.has(path.slice(at + marker.length));
    },
  };
}

/** A frame in a third-party package, wherever the install put it. */
function dependency(pkg: string): UrlPattern {
  const marker = `/node_modules/${pkg}/`;
  return { test: (url) => slashed(url).includes(marker) };
}

const PROJECTION_STORE = vatModule('projection-sqlite', 'store');
const PROBES_AND_STATS = 'probes and stats';
const EXTENT_READ = 'extent read';

/** Every rule, in priority order. */
export const VALIDATE_PHASE_BUCKETS: readonly BucketRule[] = [
  // V8's own pseudo-frames: waiting (I/O, a child process, a timer), the collector, and V8 itself.
  { bucket: 'idle', functionName: /^\(idle\)$/u },
  { bucket: 'gc', functionName: /^\(garbage collector\)$/u },
  { bucket: 'program', functionName: /^\(program\)$/u },

  // Narrow first: each of these runs inside one of the broad buckets below.
  { bucket: 'deep-freeze and copies', url: vatModule('utils', 'deep-freeze') },
  { bucket: 'deep-freeze and copies', functionName: /^structuredClone$/u },
  { bucket: 'chain-walk lstats', url: vatModule('utils', 'link-following') },
  // A synchronous spawn blocks the thread, so the sampler sees its whole wait in the spawn frame.
  { bucket: 'git spawns', functionName: /^(?:spawnSync|execFileSync|execSync|spawn)$/u, url: /^node:child_process$/u },
  {
    bucket: 'git output handling',
    url: vatModule('utils', 'git|git-run|git-snapshot|git-tracker|git-tree-key|git-utils|git-root-cache|git-changed-files|git-index-links|spawn-hardened|safe-exec'),
  },
  {
    bucket: 'store open',
    functionName: /^(?:openSqliteFactStore|openStoreAt|configure|enableWal|createSchema|prepareStoreTables|adoptLegacyBlobKeys)$/u,
    url: PROJECTION_STORE,
  },
  {
    bucket: 'store write',
    functionName: /^(?:writeBlobRows|writeExtentRows|writeBlobFacts|writeExtent|insertBundle|clearSpaceFor\w*|evict\w*)$/u,
    url: PROJECTION_STORE,
  },
  { bucket: EXTENT_READ, url: vatModule('resources', String.raw`projection/store-hydration`) },
  { bucket: EXTENT_READ, functionName: /^(?:readExtent|readExtentRows)$/u, url: PROJECTION_STORE },
  { bucket: EXTENT_READ, functionName: /^(?:readStoredMembership|readStoredExtent)$/u, url: vatModule('resources', String.raw`projection/merge`) },
  { bucket: 'blob read and decode', url: vatModule('projection-sqlite', 'store|values|run-database') },
  { bucket: 'blob read and decode', url: vatModule('resources', String.raw`projection/stored-admission|projection/blob-facts`) },
  { bucket: 'reader rebuild', url: vatModule('resources', String.raw`projection/blob-resource-facts|projection/blob-references|projection/blob-sections`) },
  { bucket: PROBES_AND_STATS, url: vatModule('utils', 'text-file|special-file') },
  { bucket: PROBES_AND_STATS, functionName: /^stat$/u, url: vatModule('resources', 'resource-registry') },
  {
    bucket: PROBES_AND_STATS,
    functionName: /^(?:statSync|lstatSync|fstatSync|openSync|closeSync|realpathSync|stat|lstat|fstat|open|close|realpath)$/u,
    url: /^node:(?:internal\/)?fs(?:\/promises)?$/u,
  },
  { bucket: 'config load', url: vatModule('cli', String.raw`utils/config-loader`) },
  { bucket: 'config load', url: vatModule('resources', 'config-parser') },
  {
    bucket: 'link judgement',
    url: vatModule('resources', 'link-validator|link-classify|frontmatter-link-validator|external-link-validator|external-link-cache|unresolved-references'),
  },
  { bucket: 'frontmatter schema validation', url: dependency('ajv') },
  { bucket: 'skills detectors', url: /[/\\]agent-skills[/\\]dist[/\\]validators[/\\]/u },
  { bucket: 'check lenses', url: vatModule('resources', String.raw`projection/edge-lens|projection/sql-checks|projection/builtin-checks|projection/contributors/closure-extent`) },
  { bucket: 'population bookkeeping', url: vatModule('resources', String.raw`projection/run-population|projection/resource-population|projection/content-cache|resource-registry`) },
  { bucket: 'report', url: vatModule('cli', String.raw`utils/output|utils/issue-rendering|utils/document-writer|utils/verdict-helpers`) },
  { bucket: 'report', url: vatModule('utils', 'yaml|yaml/surgical-yaml') },
  { bucket: 'module load', url: /^node:internal\/modules\//u },
];
