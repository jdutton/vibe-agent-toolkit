#!/usr/bin/env tsx
/**
 * npm registry guard: what the registry says about this repository's packages
 * that `npm publish` does not check.
 *
 * - Before any publish (`pre-publish-check --release-readiness` calls
 *   {@link checkBeforePublish}): a package on npm that is no longer a workspace
 *   package must be deprecated (an error), and on a prerelease, a published
 *   package whose `latest` is a prerelease or a package never published is
 *   reported as a warning. npm gives a package's FIRST publish `latest` even
 *   under `--tag next`, and refuses to remove `latest`, so such a package keeps
 *   a prerelease `latest` until the next stable publish moves it.
 * - After a stable publish (this file's CLI, a late step of `publish.yml`):
 *   every published package's `latest` must be the version just released.
 *
 * Deprecate and dist-tag writes need the owner's npm one-time password, so the
 * guard never runs them: it reports, prints the exact command, and fails.
 *
 * Every registry read goes through one injectable {@link RegistryGet}, so the
 * decisions are unit-tested offline.
 *
 * Usage:
 *   tsx packages/dev-tools/src/npm-registry-guard.ts --after-stable-publish VERSION [--root DIR] [--registry URL]
 *     [--attempts N] [--wait-ms MS]   (defaults: 10 reads, 30 s apart, for npm's processing lag)
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

/** The message `npm deprecate` is given for a package removed from the repository. */
const REMOVED_PACKAGE_MESSAGE =
  'Removed from vibe-agent-toolkit and no longer maintained. See https://github.com/jdutton/vibe-agent-toolkit/blob/main/CHANGELOG.md';

/** After a stable publish: how often to read the registry, and how long to wait between reads. */
const AFTER_PUBLISH_ATTEMPTS = 10;
const AFTER_PUBLISH_WAIT_MS = 30_000;

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
  /** The command the owner runs to fix it (needs their npm one-time password). */
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

async function readPackument(get: RegistryGet, name: string): Promise<Packument | undefined> {
  const body = await get(packumentPath(name));
  if (body === undefined) return undefined;
  const parsed = PackumentSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`The registry document for ${name} is not a packument: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Deprecated means every version is: `npm deprecate <name> <message>` marks them all. */
function isWhollyDeprecated(packument: Packument): boolean {
  const versions = Object.values(packument.versions);
  return versions.length > 0 && versions.every((v) => (v.deprecated ?? '') !== '');
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
        fix: `npm deprecate ${name} "${REMOVED_PACKAGE_MESSAGE}"`,
      },
    ];
  });
}

/** Every packument of `names`, in order; `undefined` where the registry has none. */
function readPackuments(get: RegistryGet, names: readonly string[]): Promise<(Packument | undefined)[]> {
  return Promise.all(names.map((name) => readPackument(get, name)));
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
          message: `${name} has never been published: npm gives a first publish latest even under --tag next, so it will have latest = ${version} until the next stable publish`,
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

/** Which of `names` do not (yet) have `latest` = `version`, and what each has instead. */
async function latestMismatches(
  get: RegistryGet,
  version: string,
  names: readonly string[],
): Promise<Map<string, string | undefined>> {
  const packuments = await readPackuments(get, names);
  const mismatches = new Map<string, string | undefined>();
  for (const [i, name] of names.entries()) {
    const latest = packuments[i]?.['dist-tags']['latest'];
    if (latest !== version) mismatches.set(name, latest);
  }
  return mismatches;
}

/**
 * Re-read the `pending` packages until none mismatches or `attemptsLeft` runs
 * out, `sleep` between reads. Recursive so each wait is one awaited step.
 */
async function pollLatest(
  options: { version: string; get: RegistryGet; sleep: () => Promise<void> },
  pending: readonly string[],
  attemptsLeft: number,
): Promise<Map<string, string | undefined>> {
  const mismatches = await latestMismatches(options.get, options.version, pending);
  if (mismatches.size === 0 || attemptsLeft <= 1) return mismatches;
  await options.sleep();
  return pollLatest(options, [...mismatches.keys()], attemptsLeft - 1);
}

/**
 * After a stable publish, every published package's `latest` must be `version`.
 * npm processes a publish asynchronously, so a mismatch is re-read up to
 * `attempts` times, `sleep` apart, before it is reported.
 */
export async function checkLatestAfterStablePublish(options: {
  version: string;
  publishedPackages: readonly string[];
  get: RegistryGet;
  attempts: number;
  sleep: () => Promise<void>;
}): Promise<RegistryFinding[]> {
  const { version } = options;
  if (semver.prerelease(version) !== null) {
    throw new Error(`${version} is a prerelease: only a stable publish moves latest`);
  }
  const mismatches = await pollLatest(options, options.publishedPackages, options.attempts);
  return [...mismatches].map(([name, latest]): RegistryFinding => ({
    severity: 'error',
    packageName: name,
    message:
      latest === undefined
        ? `${name} is not on the registry after the publish`
        : `${name} has latest = ${latest}, not the ${version} just published`,
    fix: `npm dist-tag add ${name}@${version} latest`,
  }));
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
    console.log('  Run (each needs your npm one-time password; add --otp=<code>):');
    for (const fix of fixes) console.log(`    ${fix}`);
  }
}

/** The real {@link RegistryGet}: `fetch` against `registry`, abbreviated packuments. */
export function registryGet(registry: string = NPM_REGISTRY): RegistryGet {
  let base = registry;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return async (path) => {
    const response = await fetch(`${base}${path}`, {
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

interface CliArgs {
  version: string;
  root: string;
  registry: string;
  attempts: number;
  waitMs: number;
}

const USAGE =
  'Usage: npm-registry-guard.ts --after-stable-publish VERSION [--root DIR] [--registry URL] [--attempts N] [--wait-ms MS]';

function parseCount(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} takes a whole number, not ${value}`);
  return n;
}

/** Apply one `flag value` pair to `args`; throws on an unknown flag. */
function applyFlag(args: Partial<CliArgs>, flag: string, value: string): void {
  switch (flag) {
    case '--after-stable-publish': {
      args.version = value;
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
    case '--attempts': {
      args.attempts = Math.max(1, parseCount(flag, value));
      break;
    }
    case '--wait-ms': {
      args.waitMs = parseCount(flag, value);
      break;
    }
    default: {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = String(argv[i]);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    applyFlag(args, flag, value);
  }
  if (args.version === undefined) throw new Error('--after-stable-publish VERSION is required');
  return {
    version: args.version,
    root: args.root ?? process.cwd(),
    registry: args.registry ?? NPM_REGISTRY,
    attempts: args.attempts ?? AFTER_PUBLISH_ATTEMPTS,
    waitMs: args.waitMs ?? AFTER_PUBLISH_WAIT_MS,
  };
}

async function afterStablePublish(args: CliArgs): Promise<number> {
  const published = guardWorkspacePackages(args.root).filter((p) => !p.isPrivate).map((p) => p.name);
  log(`Checking that latest is ${args.version} for ${published.length} published packages...`, 'blue');
  const findings = await checkLatestAfterStablePublish({
    version: args.version,
    publishedPackages: published,
    get: registryGet(args.registry),
    attempts: args.attempts,
    sleep: () => new Promise((resolve) => setTimeout(resolve, args.waitMs)),
  });
  printFindings(findings);
  if (findings.length === 0) log(`✓ latest is ${args.version} for every published package`, 'green');
  return findingsExitCode(findings);
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
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
