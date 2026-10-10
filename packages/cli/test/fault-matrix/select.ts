/**
 * Which calls of a verb's fs trace the fault matrix fails, and with which errno.
 *
 * Pure: a trace of what an UNINJECTED run did goes in, a list of rules for the
 * harness comes out. A covering sample keeps each matrix file inside its
 * integration budget; `full` is the whole product, for local runs.
 */

import path from 'node:path';

import { relativeEscapesRoot, safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';
import type { FaultRule, FsCall, FsOpFamily, InjectedErrno } from '@vibe-agent-toolkit/utils/testing';

/** Where a call acts, which decides which refusal a failure of it is owed. */
export type Side = 'source' | 'destination' | 'environment';

export interface Roots {
  home: string;
  tmp: string;
  project: string;
  /** The trees the verb reads and must never change. */
  sources: readonly string[];
}

/** One injection: the rule the harness takes, the side it lands on, and the trace call it was derived from. */
export interface InjectionPoint {
  readonly rule: FaultRule;
  readonly side: Side;
  readonly call: FsCall;
}

/** Names the code makes random: staged copies, skills scratch, cache temp dirs, probes. */
const RANDOM_SUFFIX = /(\.vat-staged-|\.vat-skills-|\.tmp-|\.vat-symlink-probe-)\w+/g;
/** A `mkdtemp` directory directly under the temp dir: `<prefix>-<6 random chars>`. */
const MKDTEMP_SEGMENT = /^(.+-)[A-Za-z0-9]{6}$/;

/** Whether `ancestor` holds `entry` (or is it). */
const isAncestor = (ancestor: string, entry: string): boolean => within(ancestor, entry);

/** How many directories `entry` lies below `ancestor` (which holds it). */
function levelsBelow(ancestor: string, entry: string): number {
  let levels = 0;
  for (let at = entry; at !== ancestor && path.dirname(at) !== at; at = path.dirname(at)) levels += 1;
  return levels;
}

/**
 * A call's path with everything that differs between two runs removed: the case's roots
 * become placeholders and random name suffixes become `<random>`. A rule built from this
 * key still matches in the injected run, whose staging names and root are its own.
 */
export function normaliseCallPath(path: string, roots: Roots): string {
  const named: [string, string][] = [
    ...roots.sources.map((source, index): [string, string] => [source, `<source${index}>`]),
    [roots.tmp, '<tmp>'], [roots.home, '<home>'], [roots.project, '<project>'],
  ];
  let key = path;
  for (const [root, placeholder] of named.toSorted((a, b) => b[0].length - a[0].length)) {
    if (within(root, path)) {
      key = `${placeholder}${path.slice(root.length)}`;
      break;
    }
  }
  // A directory ABOVE a root (the case's mkdtemp root, which a walk up from TMPDIR stats) is named from
  // the root it holds, in a fixed order, so its key is the same in every run.
  const holds = key === path ? named.find(([root]) => root !== path && isAncestor(path, root)) : undefined;
  if (holds !== undefined) key = `${holds[1]}${'/..'.repeat(levelsBelow(path, holds[0]))}`;
  if (key.startsWith('<tmp>/')) {
    const [, first = '', ...rest] = toForwardSlashAnyPlatform(key).split('/');
    key = ['<tmp>', first.replace(MKDTEMP_SEGMENT, '$1<random>'), ...rest].join('/');
  }
  return key.replaceAll(RANDOM_SUFFIX, '$1<random>');
}

/** The most injections one matrix file may carry (C10). A longer list is split into another file. */
export const MAX_INJECTIONS_PER_FILE = 40;

/**
 * How many injections a case's files should carry on AVERAGE. The slices are cut by a hash of each
 * injection's id (it must be: see `shardOf`), so a file's count scatters about the mean like a
 * count of random draws (Poisson) — and the matrix has some five hundred files, so the tail is met:
 * measured, a case at a mean of 26 had a file of 41, and one at 23 a file of 37. At a mean of 20 a
 * file past the limit of 40 is a 1-in-40,000 draw, which leaves the limit for what it is there to
 * catch: a host whose trace is longer than the one the table was sized on.
 */
const MEAN_INJECTIONS_PER_FILE = 20;

/** How many matrix files a case selecting `total` injections needs, with that headroom. */
export function shardFilesFor(total: number): number {
  return Math.ceil(total / MEAN_INJECTIONS_PER_FILE);
}

/** The host a matrix file ran on, and what its case selected there: what an overflow has to say to be acted on. */
interface ShardSelection {
  /** The file, e.g. `plugin/install/local/fresh (file 2 of 9)`. */
  readonly label: string;
  /** The host: platform and Node version. A trace is the host's — a case-keeping filesystem, a Node that traces inside `rm`. */
  readonly host: string;
  /** Every injection the case selected on this host, all its files together. */
  readonly total: number;
  /** How many files the shard table gives the case. */
  readonly files: number;
}

/**
 * Fail a matrix file whose slice grew past the shard limit — saying on which host, by how much, and
 * how many files the case needs there, so the table is sized from the host with the longest trace.
 */
export function assertWithinShardLimit(count: number, selection: ShardSelection): void {
  if (count <= MAX_INJECTIONS_PER_FILE) return;
  const { label, host, total, files } = selection;
  const sized = shardFilesFor(total);
  // No fewer files than its total asks for: this slice is over by the hash's scatter alone, and one more file moves it.
  const advice = sized > files
    ? `give it ${sized} in its shard table and add the matrix files`
    : `its total asks for only ${sized}, so this slice is over by the scatter of the hash alone; give it ${files + 1} in its shard table and add the matrix file`;
  throw new Error(
    `${label} on ${host}: ${count} injections, ${count - MAX_INJECTIONS_PER_FILE} over the shard limit of ${MAX_INJECTIONS_PER_FILE}. `
    + `The case selects ${total} on this host across ${files} file(s); ${advice}.`,
  );
}

const within = (root: string, path: string): boolean => !relativeEscapesRoot(safePath.relative(root, path));

/** Whether the harness's `dest` of this call is where the operation lands (a symlink's is only its target text). */
const landsOnDest = (call: FsCall): boolean =>
  call.dest !== undefined && call.op !== 'symlink' && ['write', 'rename', 'create'].includes(call.family);

/** The side a call acts on: a two-path write, rename or link lands on its destination, not its source. */
function sideOfCall(call: FsCall, roots: Roots): Side {
  return sideOfPath(landsOnDest(call) && call.dest !== undefined ? call.dest : call.path, roots);
}

/**
 * Classify a path. Sources win (a source may live under the case root), then the
 * temp dir (environment: the host's scratch space), then home and project
 * (destination); anything else is environment.
 */
export function sideOfPath(path: string, roots: Roots): Side {
  if (roots.sources.some((source) => within(source, path))) return 'source';
  if (within(roots.tmp, path)) return 'environment';
  if (within(roots.home, path) || within(roots.project, path)) return 'destination';
  return 'environment';
}

/** The errnos that mean something for each family of operation (the owner's list). */
export const ERRNOS_FOR_FAMILY: Readonly<Record<FsOpFamily, readonly InjectedErrno[]>> = {
  read: ['EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE'],
  list: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EMFILE'],
  meta: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'],
  create: ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOTDIR'],
  write: ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY'],
  rename: ['EPERM', 'EBUSY', 'EACCES', 'EXDEV', 'ENOSPC'],
  remove: ['EPERM', 'EACCES', 'EBUSY', 'EROFS'],
};

/**
 * The rule that hits exactly `call`: pinned to its op, family and NORMALISED path, with `nth` the call's
 * ordinal among the trace calls the harness would count for that rule (it matches a call by
 * its path OR its destination).
 */
function ruleFor(call: FsCall, errno: InjectedErrno, trace: readonly FsCall[], roots: Roots, target: Roots): FaultRule {
  const key = normaliseCallPath(call.path, roots);
  const matches = (other: FsCall): boolean => normaliseCallPath(other.path, roots) === key
    || (other.dest !== undefined && normaliseCallPath(other.dest, roots) === key);
  const counted = trace.filter((other) => other.op === call.op && other.family === call.family && matches(other));
  return {
    family: call.family,
    op: call.op,
    path: (path) => normaliseCallPath(path, target) === key,
    nth: counted.indexOf(call) + 1,
    errno,
  };
}

/** The path a call acts on: a two-path write, rename or link lands on its destination. */
const landingPath = (call: FsCall): string => (landsOnDest(call) && call.dest !== undefined ? call.dest : call.path);

/**
 * Every call of a bucket as a SITE: its op, the normalised path it lands on, and which time this is
 * that the op acts on that path (a removal retried once the owner has rwx, a rename back, is a step
 * of its own). A site names one call and no other, so the selection never chooses among calls:
 *
 * - appending a call adds a site and moves none (a first/last-per-bucket choice let a new last call
 *   evict every site it outranked — T12's realpath, T15's marker mkdir);
 * - the order of calls on DIFFERENT paths moves nothing. Siblings a verb walks concurrently (Node's
 *   rm, a parallel copy) reach the trace in completion order, which differs between runs; a site that
 *   collapsed siblings into their directory took whichever came first, so the injection moved between runs.
 *
 * The ordinal counts only earlier calls on the same op and path, which is exactly how the injector
 * counts `nth`, so it cannot move either.
 */
function sitesOf(bucket: readonly FsCall[], roots: Roots): Array<{ site: string; call: FsCall }> {
  const seen = new Map<string, number>();
  return bucket.map((call) => {
    const where = `${call.op} ${normaliseCallPath(landingPath(call), roots)}`;
    const ordinal = (seen.get(where) ?? 0) + 1;
    seen.set(where, ordinal);
    return { site: `${where} #${ordinal}`, call };
  });
}

/** A stable index for `key` (FNV-1a): which errno a site gets never depends on the other sites. */
function fnv(key: string): number {
  let hash = 0x81_1c_9d_c5;
  for (const char of key) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  return hash;
}

/**
 * The errnos each site of a bucket is injected with: the bucket's first site gets every errno of
 * the family (the full sweep), every later site one, chosen by a hash of the site alone — so no
 * site's errnos depend on how many sites follow it.
 */
function errnosOfSite(index: number, site: string, errnos: readonly InjectedErrno[]): readonly InjectedErrno[] {
  if (index === 0) return errnos;
  const errno = errnos[fnv(site) % errnos.length];
  return errno === undefined ? [] : [errno];
}

/**
 * The ops that are their own site within a family: path resolution (`realpath`, which the harness
 * reaches through `.native` too) runs around nearly every other meta call, and sharing their bucket
 * would take its first and last candidates from the stat, lstat, chmod and close calls a verb makes.
 */
const OWN_SITE_OPS: ReadonlySet<string> = new Set(['realpath']);

function bucketsOf(trace: readonly FsCall[], roots: Roots): Map<string, { side: Side; calls: FsCall[] }> {
  const buckets = new Map<string, { side: Side; calls: FsCall[] }>();
  for (const call of trace) {
    const side = sideOfCall(call, roots);
    const key = OWN_SITE_OPS.has(call.op) ? `${call.family}/${side}/${call.op}` : `${call.family}/${side}`;
    const bucket = buckets.get(key) ?? { side, calls: [] };
    bucket.calls.push(call);
    buckets.set(key, bucket);
  }
  return buckets;
}

/**
 * Choose the injections for one verb run.
 *
 * `covering`: bucket the trace by (family, side), an own-site op (`realpath`) apart. In each bucket,
 * every SITE (op × normalised landing path × how many times the op has acted on that path — one call
 * each) is injected: the bucket's first site with every errno of the family, each later site with one
 * errno its own hash picks; plus a full disk on the first data write of the second file written under
 * tmp. No choice depends on a later call, or on the order of calls on different paths, so a call
 * appended to the trace (a new step in the verb) adds injections but never evicts one, and a
 * concurrent walk's completion order moves none.
 * `full`: every call times every errno of its family.
 *
 * @param trace - The calls an uninjected run made
 * @param roots - Where the traced (golden) case's trees are, to tell the sides apart
 * @param mode - `covering` sample or the `full` product
 * @param target - The roots of the case the rules will be installed in, when they differ from `roots`:
 *   the rules match paths by their normalised form, so the injected run's own root and random names still hit
 */
export function selectInjectionPoints(trace: readonly FsCall[], roots: Roots, mode: 'covering' | 'full', target: Roots = roots): InjectionPoint[] {
  const points: InjectionPoint[] = [];
  for (const { side, calls } of bucketsOf(trace, roots).values()) {
    const family = calls[0]?.family;
    if (family === undefined) continue;
    const errnos = ERRNOS_FOR_FAMILY[family];
    if (mode === 'full') {
      for (const call of calls) for (const errno of errnos) points.push({ rule: ruleFor(call, errno, trace, roots, target), side, call });
      continue;
    }
    for (const [index, { site, call }] of sitesOf(calls, roots).entries()) {
      for (const errno of errnosOfSite(index, site, errnos)) points.push({ rule: ruleFor(call, errno, trace, roots, target), side, call });
    }
    points.push(...fullDiskMidWrite(points, calls, side, { trace, roots, target }));
  }
  return points;
}

/** A full disk on the middle data write under tmp, unless the round-robin already dealt it there. */
function fullDiskMidWrite(points: readonly InjectionPoint[], calls: readonly FsCall[], side: Side, at: { trace: readonly FsCall[]; roots: Roots; target: Roots }): InjectionPoint[] {
  const midWrite = middleDataWriteUnderTmp(calls, at.roots);
  if (midWrite === undefined) return [];
  const fullDisk = ruleFor(midWrite, 'ENOSPC', at.trace, at.roots, at.target);
  const dealt = points.some((point) => point.call === midWrite && point.rule.errno === fullDisk.errno);
  return dealt ? [] : [{ rule: fullDisk, side, call: midWrite }];
}

/**
 * The first data `write` of the second file written under tmp, for a full disk mid-extraction (tar
 * or adm-zip writing an archive into staging, one file already landed): a site's first call can be
 * an `open`, never a byte written. Chosen from the calls before it only, so it is append-stable.
 */
function middleDataWriteUnderTmp(calls: readonly FsCall[], roots: Roots): FsCall | undefined {
  const writes = calls.filter((call) => (call.op === 'write' || call.op === 'writev') && within(roots.tmp, call.path));
  const firstFile = writes[0]?.path;
  return writes.find((call) => call.path !== firstFile);
}

/**
 * Which of `files` shard files runs the injection `id`: a hash of the id alone (FNV-1a), so every
 * process slices one selection the same way whatever order its trace listed the points in.
 */
export function shardOf(id: string, files: number): number {
  return fnv(id) % files;
}
