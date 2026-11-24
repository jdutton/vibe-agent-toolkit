#!/usr/bin/env tsx
/**
 * npm registry guard: what the registry says about this repository's packages
 * that `npm publish` does not check. The one reader of the npm registry in the
 * release tooling.
 *
 * - Before any publish (`pre-publish-check --release-readiness` calls
 *   {@link checkBeforePublish}): a package on npm that is no longer a workspace
 *   package must be deprecated (an error), and on a prerelease, a published
 *   package whose `latest` is a prerelease or a package not on npm is reported
 *   as a warning. npm gives a package's FIRST publish `latest` even under
 *   `--tag next`, and refuses to remove `latest`, so such a package keeps a
 *   prerelease `latest` until the next stable publish moves it.
 * - After a stable publish (this file's CLI, its own job in `publish.yml`):
 *   every published package's `latest` must be the version just released.
 * - `determine-publish-tags` decides whether to move `next` through
 *   {@link decideUpdateNext}, which retries a registry error, then fails closed.
 *
 * The guard never writes to npm (an owner ruling): it reports, prints the exact
 * `npm deprecate` / `npm dist-tag` command, and fails. Run from a maintainer's
 * machine, both commands need the owner's one-time password.
 *
 * Every registry read goes through one injectable {@link RegistryGet}, so the
 * decisions are unit-tested offline.
 *
 * Usage:
 *   tsx packages/dev-tools/src/npm-registry-guard.ts --after-stable-publish VERSION [--root DIR] [--registry URL]
 *     [--interval-ms MS] [--max-reads N] [--stall-reads N]
 *   Defaults: a read every 30 s, ending when no package is left, when the set
 *   left has not shrunk for 14 reads (7 min), or after 30 reads (15 min).
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import semver from 'semver';
import { z } from 'zod';

import { isEntrypoint, log } from './common.js';
import { readWorkspaceGraph } from './workspace-graph.js';

/** The registry every publish goes to. */
export const NPM_REGISTRY = 'https://registry.npmjs.org';
/** The npm scope every scoped package of this repository publishes under. */
export const NPM_SCOPE = '@vibe-agent-toolkit';
/** The one unscoped package; no scope listing names it, so it is checked by name. */
export const UMBRELLA_PACKAGE_NAME = 'vibe-agent-toolkit';
/**
 * The registry's listing of every package in the scope. `npm search` is not
 * used: its index lags and drops packages. This endpoint is what
 * `npm access list packages` reads, and it answers without credentials.
 */
export const SCOPE_LISTING_PATH = `/-/org/${NPM_SCOPE.slice(1)}/package`;

/**
 * Removed packages that have a successor, for the deprecation message the guard
 * suggests. A removed package not named here gets a message that claims no
 * replacement either way.
 */
const REMOVED_PACKAGE_REPLACEMENTS: Readonly<Record<string, string>> = {
  [`${NPM_SCOPE}/agent-schema`]: `${NPM_SCOPE}/schema`,
  [`${NPM_SCOPE}/runtime-claude-skills`]: `${NPM_SCOPE}/agent-skills`,
};

/** After a stable publish: the defaults of {@link LatestPoll}. */
const AFTER_PUBLISH_INTERVAL_MS = 30_000;
const AFTER_PUBLISH_MAX_READS = 30;
// The stall rule, not the cap, ends a poll that makes no progress, so it alone
// must outlast the CDN's max-age=300 plus processing lag: 14 x 30 s = 7 min.
const AFTER_PUBLISH_STALL_READS = 14;

/**
 * GET a registry path (`/` + name, or {@link SCOPE_LISTING_PATH}). Resolves the
 * parsed JSON body, or `undefined` for a 404. Rejects on anything else: a guard
 * that read an outage as "not there" would pass.
 */
export type RegistryGet = (path: string) => Promise<unknown>;

export interface RegistryFinding {
  readonly severity: 'warning' | 'error';
  readonly packageName: string;
  readonly message: string;
  /** The command that fixes it, when one does. */
  readonly fix?: string;
}

/** A workspace package as the guard needs it. */
export interface GuardWorkspacePackage {
  readonly name: string;
  readonly isPrivate: boolean;
}

// `.passthrough()`: npm owns the packument and every version's manifest; the
// guard reads two fields and must not refuse the many it does not model.
const PackumentSchema = z
  .object({
    'dist-tags': z.record(z.string()),
    versions: z.record(z.object({ deprecated: z.string().optional() }).passthrough()),
  })
  .passthrough();
type Packument = z.infer<typeof PackumentSchema>;

const ScopeListingSchema = z.record(z.string());

/** The registry path of a package's document; a scoped name's `/` is escaped as npm escapes it. */
export function packumentPath(name: string): string {
  return `/${name.replace('/', '%2f')}`;
}

/**
 * npm's record of package `name` whose every version was unpublished: a 200
 * carrying `time.unpublished`, or this package's `name` and a `modified` string
 * with no `versions` (or none left). It is a package npm does not have, exactly
 * like a 404. Anything else without versions (`{}`, `{"error": ...}` from a
 * proxy) is not npm's answer and falls through to the packument parse, which
 * refuses it: read as "not there" it would pass the guard.
 */
function isUnpublishedRecord(body: unknown, name: string): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  const time = record['time'];
  if (typeof time === 'object' && time !== null && 'unpublished' in time) return true;
  if (record['name'] !== name || typeof record['modified'] !== 'string') return false;
  const versions = record['versions'];
  if (versions === undefined) return true;
  return typeof versions === 'object' && versions !== null && Object.keys(versions).length === 0;
}

/** A package's packument, or `undefined` when npm does not have the package (404 or unpublished). */
async function readPackument(get: RegistryGet, name: string): Promise<Packument | undefined> {
  const body = await get(packumentPath(name));
  if (body === undefined || isUnpublishedRecord(body, name)) return undefined;
  const parsed = PackumentSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`The registry document for ${name} is not a packument: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Every packument of `names`, in order; `undefined` where npm has none. */
function readPackuments(get: RegistryGet, names: readonly string[]): Promise<(Packument | undefined)[]> {
  return Promise.all(names.map((name) => readPackument(get, name)));
}

/** A package's dist-tag, or `undefined` when npm has no such package or tag. Rejects on a registry error. */
export async function readDistTag(get: RegistryGet, name: string, tag: string): Promise<string | undefined> {
  return (await readPackument(get, name))?.['dist-tags'][tag];
}

/** How a one-off registry read is retried before it fails closed. */
export interface ReadRetry {
  readonly tries: number;
  readonly waitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** `read()`, re-run up to `retry.tries` times, `retry.waitMs` apart, while it rejects. */
async function withRetry<T>(read: () => Promise<T>, retry: ReadRetry): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (retry.tries <= 1) throw error;
    await retry.sleep(retry.waitMs);
    return withRetry(read, { ...retry, tries: retry.tries - 1 });
  }
}

/**
 * Whether a stable `version` should also move `next`: when npm has no `next`
 * for `packageName`, or `version` is newer than it. A registry error is retried,
 * then rejects: an outage is never "no next tag".
 */
export async function decideUpdateNext(options: {
  version: string;
  packageName: string;
  get: RegistryGet;
  retry: ReadRetry;
}): Promise<{ updateNext: boolean; currentNext: string | undefined }> {
  const { version, packageName, get, retry } = options;
  const currentNext = await withRetry(() => readDistTag(get, packageName, 'next'), retry);
  return { updateNext: currentNext === undefined || semver.gt(version, currentNext), currentNext };
}

/** Deprecated means every version is: `npm deprecate <name> <message>` marks them all. */
function isWhollyDeprecated(packument: Packument): boolean {
  const versions = Object.values(packument.versions);
  return versions.length > 0 && versions.every((v) => (v.deprecated ?? '') !== '');
}

function deprecationMessage(name: string): string {
  const replacement = REMOVED_PACKAGE_REPLACEMENTS[name];
  const advice = replacement === undefined ? 'and is no longer maintained' : `; use ${replacement} instead`;
  return `Removed from vibe-agent-toolkit ${advice}. See https://github.com/jdutton/vibe-agent-toolkit/blob/main/CHANGELOG.md`;
}

async function removedPackageFindings(
  get: RegistryGet,
  workspaceNames: ReadonlySet<string>,
): Promise<RegistryFinding[]> {
  const listingBody = await get(SCOPE_LISTING_PATH);
  const listing = ScopeListingSchema.safeParse(listingBody);
  if (listingBody === undefined || !listing.success) {
    throw new Error(`The registry's ${NPM_SCOPE} scope listing (${SCOPE_LISTING_PATH}) could not be read`);
  }
  const candidates = [...new Set([...Object.keys(listing.data), UMBRELLA_PACKAGE_NAME])]
    .filter((name) => !workspaceNames.has(name))
    .sort((a, b) => a.localeCompare(b));

  const packuments = await readPackuments(get, candidates);
  return candidates.flatMap((name, i): RegistryFinding[] => {
    const packument = packuments[i];
    if (packument === undefined || isWhollyDeprecated(packument)) return [];
    return [
      {
        severity: 'error',
        packageName: name,
        message: `${name} is on npm but is no longer a workspace package, and is not deprecated`,
        fix: `npm deprecate ${name} "${deprecationMessage(name)}"`,
      },
    ];
  });
}

async function prereleaseLatestFindings(
  get: RegistryGet,
  version: string,
  published: readonly string[],
): Promise<RegistryFinding[]> {
  const packuments = await readPackuments(get, published);
  return published.flatMap((name, i): RegistryFinding[] => {
    const packument = packuments[i];
    if (packument === undefined) {
      return [
        {
          severity: 'warning',
          packageName: name,
          message: `${name} is not on npm (never published, or every version unpublished): npm gives a first publish latest even under --tag next, so it will have latest = ${version} until the next stable publish`,
        },
      ];
    }
    const latest = packument['dist-tags']['latest'];
    if (latest === undefined || semver.prerelease(latest) === null) return [];
    return [
      {
        severity: 'warning',
        packageName: name,
        message: `${name} has latest = ${latest}, a prerelease; the next stable publish moves it`,
      },
    ];
  });
}

/**
 * The checks that run before a publish, RC or stable: removed packages must be
 * deprecated (error); on a prerelease, a prerelease or absent `latest` is a warning.
 */
export async function checkBeforePublish(options: {
  version: string;
  workspacePackages: readonly GuardWorkspacePackage[];
  get: RegistryGet;
}): Promise<RegistryFinding[]> {
  const { version, workspacePackages, get } = options;
  const removed = await removedPackageFindings(get, new Set(workspacePackages.map((p) => p.name)));
  if (semver.prerelease(version) === null) return removed;
  const published = workspacePackages.filter((p) => !p.isPrivate).map((p) => p.name);
  return [...(await prereleaseLatestFindings(get, version, published)), ...removed];
}

/** How the after-publish check re-reads the registry while npm processes the publish. */
export interface LatestPoll {
  /** Wait between reads. */
  readonly intervalMs: number;
  /** Reads at most, however the set left is moving. */
  readonly maxReads: number;
  /** Reads in a row without the set left shrinking that end the poll. */
  readonly stallReads: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** One package's state on one read, other than "latest is the release". */
type LatestState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'behind'; readonly latest: string | undefined }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The packages of `names` whose `latest` is not (yet) `version`, with what each shows instead. */
async function latestStates(
  get: RegistryGet,
  version: string,
  names: readonly string[],
): Promise<Map<string, LatestState>> {
  const reads = await Promise.allSettled(names.map((name) => readPackument(get, name)));
  const states = new Map<string, LatestState>();
  for (const [i, name] of names.entries()) {
    const read = reads[i];
    if (read?.status !== 'fulfilled') {
      states.set(name, { kind: 'unreadable', reason: read === undefined ? 'no read' : String(read.reason) });
      continue;
    }
    const packument = read.value;
    if (packument?.versions[version] === undefined) {
      states.set(name, { kind: 'absent' });
    } else if (packument['dist-tags']['latest'] !== version) {
      states.set(name, { kind: 'behind', latest: packument['dist-tags']['latest'] });
    }
  }
  return states;
}

interface PollProgress {
  readonly left: Map<string, LatestState>;
  readonly reads: number;
  readonly fewest: number;
  readonly stalled: number;
}

/**
 * Re-read the packages left until none is, the set left has not shrunk for
 * `stallReads` reads, or `maxReads` reads are spent. A registry error is a
 * package left for that read, never an immediate failure.
 */
async function pollLatest(
  get: RegistryGet,
  version: string,
  poll: LatestPoll,
  progress: PollProgress,
): Promise<Map<string, LatestState>> {
  const left = await latestStates(get, version, [...progress.left.keys()]);
  const reads = progress.reads + 1;
  const shrank = left.size < progress.fewest;
  const stalled = shrank ? 0 : progress.stalled + 1;
  if (left.size === 0 || reads >= poll.maxReads || stalled >= poll.stallReads) return left;
  await poll.sleep(poll.intervalMs);
  return pollLatest(get, version, poll, { left, reads, fewest: Math.min(left.size, progress.fewest), stalled });
}

/** The finding for a package whose `latest` is not the release, or `undefined` for one npm could not be read for. */
function latestFinding(name: string, version: string, state: LatestState): RegistryFinding | undefined {
  if (state.kind === 'unreadable') return undefined;
  if (state.kind === 'behind') {
    const now = state.latest === undefined ? 'has no latest tag' : `has latest = ${state.latest}`;
    return {
      severity: 'error',
      packageName: name,
      message: `${name} ${now}, not the ${version} just published`,
      fix: `npm dist-tag add ${name}@${version} latest`,
    };
  }
  // Never a bare `npm publish` from the package directory: that ships its
  // `workspace:*` specifiers unresolved, and a published version can never be reused.
  return {
    severity: 'error',
    packageName: name,
    message: `${name}@${version} is not on npm: the publish may not have landed, or npm may still be processing it. Re-check with npm view ${name}@${version}; if it is missing, follow the manual fallback in docs/publishing.md (build, resolve-workspace-deps, then publish)`,
  };
}

/** What the after-publish check found: findings to fix, and packages npm could not be read for. */
export interface LatestReport {
  readonly findings: RegistryFinding[];
  /** `<name>: <reason>` for each package still unreadable when the poll ended. */
  readonly unreadable: string[];
}

/**
 * After a stable publish, every published package's `latest` must be `version`.
 * npm processes a publish asynchronously, so the registry is polled (see
 * {@link LatestPoll}) before anything is reported. A package still unreadable
 * at the end is reported apart from the findings: an outage is not a verdict.
 */
export async function checkLatestAfterStablePublish(options: {
  version: string;
  publishedPackages: readonly string[];
  get: RegistryGet;
  poll: LatestPoll;
}): Promise<LatestReport> {
  const { version, get, poll } = options;
  if (semver.prerelease(version) !== null) {
    throw new Error(`${version} is a prerelease: only a stable publish moves latest`);
  }
  const start = new Map<string, LatestState>(
    options.publishedPackages.map((name) => [name, { kind: 'absent' }]),
  );
  const left = await pollLatest(get, version, poll, {
    left: start,
    reads: 0,
    fewest: Number.POSITIVE_INFINITY,
    stalled: 0,
  });
  const unreadable = [...left].flatMap(([name, state]) =>
    state.kind === 'unreadable' ? [`${name}: ${state.reason}`] : [],
  );
  const findings = [...left].flatMap(([name, state]) => latestFinding(name, version, state) ?? []);
  return { findings, unreadable };
}

/** FINDINGS when any finding is an error; a warning never fails. */
export function findingsExitCode(findings: readonly RegistryFinding[]): number {
  return findings.some((f) => f.severity === 'error') ? ExitCode.FINDINGS : ExitCode.OK;
}

/** Print findings, then every fix command in one block the owner can paste. */
export function printFindings(findings: readonly RegistryFinding[]): void {
  for (const finding of findings) {
    log(`${finding.severity === 'error' ? '✗' : '⚠'} ${finding.message}`, finding.severity === 'error' ? 'red' : 'yellow');
  }
  const fixes = findings.flatMap((f) => (f.fix === undefined ? [] : [f.fix]));
  if (fixes.length > 0) {
    console.log('  The guard never writes to npm. Run (from a maintainer machine, add --otp=<code>):');
    for (const fix of fixes) console.log(`    ${fix}`);
  }
}

/**
 * The real {@link RegistryGet}: `fetch` against `registry`, abbreviated
 * packuments. Every read carries a unique query parameter: npm's CDN caches a
 * package document for `max-age=300` and keys on the full URL, so a read right
 * after a publish would otherwise see the document from before it.
 */
export function registryGet(registry: string): RegistryGet {
  let base = registry;
  while (base.endsWith('/')) base = base.slice(0, -1);
  let reads = 0;
  return async (path) => {
    reads++;
    const url = new URL(`${base}${path}`);
    url.searchParams.set('vat-read', `${Date.now().toString(36)}-${reads.toString(36)}`);
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`GET ${base}${path} answered ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as unknown;
  };
}

/** Every workspace package's manifest name and whether it is private. */
export function guardWorkspacePackages(repoRoot: string): GuardWorkspacePackage[] {
  return readWorkspaceGraph(repoRoot).packages.map((p) => ({ name: p.name, isPrivate: p.isPrivate }));
}

export interface GuardArgs {
  readonly version: string;
  readonly root: string;
  readonly registry: string;
  readonly intervalMs: number;
  readonly maxReads: number;
  readonly stallReads: number;
}

const USAGE =
  'Usage: npm-registry-guard.ts --after-stable-publish VERSION [--root DIR] [--registry URL] [--interval-ms MS] [--max-reads N] [--stall-reads N]';

function parseCount(flag: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} takes a whole number of at least ${min}, not ${value}`);
  return n;
}

function parseStableVersion(value: string): string {
  if (semver.valid(value) === null) throw new Error(`--after-stable-publish: ${value} is not a version`);
  if (semver.prerelease(value) !== null) {
    throw new Error(`--after-stable-publish: ${value} is a prerelease; only a stable publish moves latest`);
  }
  return value;
}

/** Apply one `flag value` pair to `args`; throws on an unknown flag or a bad value. */
function applyFlag(args: { -readonly [K in keyof GuardArgs]?: GuardArgs[K] }, flag: string, value: string): void {
  switch (flag) {
    case '--after-stable-publish': {
      args.version = parseStableVersion(value);
      break;
    }
    case '--root': {
      args.root = safePath.resolve(value);
      break;
    }
    case '--registry': {
      args.registry = value;
      break;
    }
    case '--interval-ms': {
      args.intervalMs = parseCount(flag, value, 0);
      break;
    }
    case '--max-reads': {
      args.maxReads = parseCount(flag, value, 1);
      break;
    }
    case '--stall-reads': {
      args.stallReads = parseCount(flag, value, 1);
      break;
    }
    default: {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
}

/** The CLI's arguments; `cwd` is the default root. Throws on anything it cannot use. */
export function parseGuardArgs(argv: readonly string[], cwd: string): GuardArgs {
  const args: { -readonly [K in keyof GuardArgs]?: GuardArgs[K] } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = String(argv[i]);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    applyFlag(args, flag, value);
  }
  if (args.version === undefined) throw new Error('--after-stable-publish VERSION is required');
  return {
    version: args.version,
    root: args.root ?? cwd,
    registry: args.registry ?? NPM_REGISTRY,
    intervalMs: args.intervalMs ?? AFTER_PUBLISH_INTERVAL_MS,
    maxReads: args.maxReads ?? AFTER_PUBLISH_MAX_READS,
    stallReads: args.stallReads ?? AFTER_PUBLISH_STALL_READS,
  };
}

async function afterStablePublish(args: GuardArgs): Promise<number> {
  const published = guardWorkspacePackages(args.root).filter((p) => !p.isPrivate).map((p) => p.name);
  log(`Checking that latest is ${args.version} for ${published.length} published packages...`, 'blue');
  const { findings, unreadable } = await checkLatestAfterStablePublish({
    version: args.version,
    publishedPackages: published,
    get: registryGet(args.registry),
    poll: {
      intervalMs: args.intervalMs,
      maxReads: args.maxReads,
      stallReads: args.stallReads,
      sleep: sleepMs,
    },
  });
  printFindings(findings);
  if (unreadable.length > 0) {
    log(`✗ The registry could not be read for: ${unreadable.join('; ')}`, 'red');
    return ExitCode.ERROR;
  }
  if (findings.length === 0) log(`✓ latest is ${args.version} for every published package`, 'green');
  return findingsExitCode(findings);
}

/** The real wait. */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  let args: GuardArgs;
  try {
    args = parseGuardArgs(process.argv.slice(2), process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return ExitCode.ERROR;
  }
  try {
    return await afterStablePublish(args);
  } catch (error) {
    log(`✗ ${error instanceof Error ? error.message : String(error)}`, 'red');
    return ExitCode.ERROR;
  }
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = await main();
}
