/**
 * Attributing a V8 CPU profile's time to named cost buckets, per time window.
 * Pure: the profile is handed in parsed, so every rule is unit-testable.
 *
 * - **A sample lasts until the next one.** Sample `i` is at `startTime` plus the
 *   first `i + 1` time deltas, and lasts until sample `i + 1` (the last until
 *   `endTime`), so a window's buckets add up to the sampled part of its span.
 * - **The first rule with a frame on the stack decides.** Rules are in priority
 *   order and each is tried against the sample's whole stack, so a narrower rule
 *   goes first: a deep-freeze inside the reader rebuild is the freeze's, and an
 *   `lstatSync` under the chain walk is the chain walk's, not a generic stat's.
 * - **Nothing is dropped.** A sample no rule matches is `other`, and its leaf
 *   frame is counted, so a bucket the rules miss shows up as a named leaf rather
 *   than as a smaller total.
 * - **Windows are in the profile's clock.** A caller that holds wall-clock
 *   instants (the perf probe's banners, in epoch milliseconds) aligns them first;
 *   see {@link bannerWindows}.
 */

import { z } from 'zod';

import type { PerfProcessDump } from './types.js';

/** Microseconds in a millisecond. */
const US_PER_MS = 1000;

/** The bucket a sample no rule matches goes to. */
export const OTHER_BUCKET = 'other';

/**
 * V8's pseudo-frame for a sample taken while the thread waited. It has no
 * stack, so its time is listed by the bucket of the sample before it
 * (`after <bucket>`): a heuristic, since a wait may begin up to one sampling
 * interval after that sample, but the only clue a CPU profile holds about what
 * an `await` was waiting for.
 */
const IDLE_FRAME = '(idle)';

/**
 * The parts of a `.cpuprofile` this reads. V8 owns the format and writes more
 * (`hitCount`, `positionTicks`, `scriptId`), so every object passes those
 * through rather than refusing a profile a newer Node writes.
 */
export const CpuProfileSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number().int(),
      callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number().int() }).passthrough(),
      children: z.array(z.number().int()).optional(),
    }).passthrough(),
  ),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number().int()),
  timeDeltas: z.array(z.number()),
}).passthrough();

export type CpuProfile = z.infer<typeof CpuProfileSchema>;

/** What a rule's url pattern must do: a `RegExp` is one. */
export interface UrlPattern {
  test(url: string): boolean;
}

/** One rule: a frame whose function name and url both match (an absent pattern matches anything) is the bucket's. */
export interface BucketRule {
  readonly bucket: string;
  readonly functionName?: RegExp;
  readonly url?: UrlPattern;
}

/** A span of the profile's clock, in microseconds, `start` inclusive and `end` exclusive. */
export interface ProfileWindow {
  readonly name: string;
  readonly startUs: number;
  readonly endUs: number;
}

/** What one window's samples were spent on. */
export interface WindowAttribution {
  readonly name: string;
  /** The window's span, milliseconds. */
  readonly spanMs: number;
  /** Milliseconds per bucket, every bucket a sample landed in. */
  readonly buckets: Readonly<Record<string, number>>;
  /**
   * Per bucket, milliseconds per frame that names where in vat the time went
   * (see {@link frameSignature}), so a bucket's content can be checked and the
   * rules missing from {@link OTHER_BUCKET} found.
   */
  readonly frames: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** A node with its parent, for walking a stack upwards. */
interface StackNode {
  readonly frame: CpuProfile['nodes'][number]['callFrame'];
  readonly parent: number | null;
}

/**
 * Index every node by id, with its parent.
 *
 * @param profile - The profile
 * @returns The nodes, keyed by id
 */
function stackIndex(profile: CpuProfile): Map<number, StackNode> {
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  return new Map(profile.nodes.map((node) => [node.id, { frame: node.callFrame, parent: parents.get(node.id) ?? null }]));
}

/**
 * Whether a rule matches a frame.
 *
 * @param rule - The rule
 * @param frame - The frame
 * @returns True when every pattern the rule has matches
 */
function matches(rule: BucketRule, frame: StackNode['frame']): boolean {
  return (rule.functionName?.test(frame.functionName) ?? true) && (rule.url?.test(frame.url) ?? true);
}

/**
 * The frames of the stack ending at `leaf`, leaf first.
 *
 * @param nodes - The profile's nodes
 * @param leaf - The sampled node's id
 * @returns Every frame up to the root
 */
function stackOf(nodes: ReadonlyMap<number, StackNode>, leaf: number): StackNode['frame'][] {
  const frames: StackNode['frame'][] = [];
  let node = nodes.get(leaf);
  while (node !== undefined) {
    frames.push(node.frame);
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  return frames;
}

/**
 * The bucket of the stack ending at `leaf`: the first rule, in order, that matches any of its frames.
 *
 * @param nodes - The profile's nodes
 * @param leaf - The sampled node's id
 * @param rules - The rules, in priority order
 * @returns The bucket, or `null` when no rule matches
 */
function bucketOf(nodes: ReadonlyMap<number, StackNode>, leaf: number, rules: readonly BucketRule[]): string | null {
  const frames = stackOf(nodes, leaf);
  return rules.find((rule) => frames.some((frame) => matches(rule, frame)))?.bucket ?? null;
}

/** A frame in one of vat's own packages, emitted or installed: `.../<package>/dist/...`. */
const VAT_FRAME = /[/\\](?:packages|@vibe-agent-toolkit)[/\\]([\w-]+[/\\]dist[/\\].*)$/u;

/**
 * Where in vat a sample's time went: its innermost frame in one of vat's
 * packages (`name <package>/dist/<file>:line`), or its leaf when none is vat's.
 *
 * @param nodes - The profile's nodes
 * @param leaf - The sampled node's id
 * @returns The signature
 */
function frameSignature(nodes: ReadonlyMap<number, StackNode>, leaf: number): string {
  const frames = stackOf(nodes, leaf);
  const vat = frames.find((frame) => VAT_FRAME.test(frame.url));
  const frame = vat ?? frames[0];
  if (frame === undefined) return '?';
  const where = VAT_FRAME.exec(frame.url)?.[1] ?? frame.url;
  return `${frame.functionName === '' ? '(anonymous)' : frame.functionName} ${where}:${String(frame.lineNumber + 1)}`;
}

/**
 * Each sample's instant and duration, in the profile's clock.
 *
 * @param profile - The profile
 * @returns One entry per sample, in order
 */
export function sampleTimes(profile: CpuProfile): { readonly node: number; readonly atUs: number; readonly durationUs: number }[] {
  const instants: number[] = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) {
    at += delta;
    instants.push(at);
  }
  return profile.samples.map((node, index) => {
    const atUs = instants[index] ?? profile.endTime;
    const next = instants[index + 1] ?? profile.endTime;
    return { node, atUs, durationUs: Math.max(0, next - atUs) };
  });
}

/** Add `amount` to `key` of a tally. */
function add(tally: Record<string, number>, key: string, amount: number): void {
  tally[key] = (tally[key] ?? 0) + amount;
}

/**
 * Attribute a profile's samples to buckets, per window.
 *
 * @param profile - The profile
 * @param windows - The spans to attribute, in the profile's clock; a sample in none is not counted
 * @param rules - The bucket rules, in priority order
 * @returns One attribution per window, in the order given, in milliseconds
 */
export function attributeProfile(
  profile: CpuProfile,
  windows: readonly ProfileWindow[],
  rules: readonly BucketRule[],
): WindowAttribution[] {
  const nodes = stackIndex(profile);
  const tallies = windows.map(() => ({ buckets: {} as Record<string, number>, frames: {} as Record<string, Record<string, number>> }));
  let previous = '(none)';
  for (const sample of sampleTimes(profile)) {
    const bucket = bucketOf(nodes, sample.node, rules) ?? OTHER_BUCKET;
    const idle = nodes.get(sample.node)?.frame.functionName === IDLE_FRAME;
    // An idle sample has no stack; what ran just before it is the best a profile says about what it awaited.
    const signature = idle ? `after ${previous}` : frameSignature(nodes, sample.node);
    if (!idle) previous = bucket;
    const index = windows.findIndex((window) => sample.atUs >= window.startUs && sample.atUs < window.endUs);
    if (index === -1) continue; // in no window: not counted, as the contract says
    const tally = tallies[index];
    if (tally === undefined) continue;
    const ms = sample.durationUs / US_PER_MS;
    add(tally.buckets, bucket, ms);
    tally.frames[bucket] ??= {};
    add(tally.frames[bucket], signature, ms);
  }
  return windows.map((window, index) => ({
    name: window.name,
    spanMs: (window.endUs - window.startUs) / US_PER_MS,
    buckets: tallies[index]?.buckets ?? {},
    frames: tallies[index]?.frames ?? {},
  }));
}

/**
 * The windows a process's `Surface:` banners mark, in its profile's clock.
 *
 * The probe stamps banners in epoch milliseconds and the profile counts in V8's
 * monotonic microseconds; the two are aligned at the process's end, which both
 * record (the probe's exit listener runs first, and the profile ends as the
 * process does). Before the first banner is `(startup)`; each banner runs to
 * the next, the last to the profile's end. A process with no banners is one
 * `(process)` window.
 *
 * @param record - The process's probe record
 * @param profile - Its main thread's profile
 * @returns The windows, and how far the two clocks disagree about the process's start (ms)
 */
export function bannerWindows(
  record: PerfProcessDump,
  profile: CpuProfile,
): { readonly windows: ProfileWindow[]; readonly startSkewMs: number } {
  const offsetUs = profile.endTime - record.endMs * US_PER_MS;
  const toProfile = (ms: number): number => ms * US_PER_MS + offsetUs;
  const startSkewMs = (profile.startTime - toProfile(record.startMs)) / US_PER_MS;
  if (record.banners.length === 0) {
    return { windows: [{ name: '(process)', startUs: profile.startTime, endUs: profile.endTime }], startSkewMs };
  }
  const starts = record.banners.map((banner) => toProfile(banner.atMs));
  const windows: ProfileWindow[] = [{ name: '(startup)', startUs: profile.startTime, endUs: starts[0] ?? profile.endTime }];
  for (const [index, banner] of record.banners.entries()) {
    windows.push({ name: banner.name, startUs: starts[index] ?? profile.endTime, endUs: starts[index + 1] ?? profile.endTime });
  }
  return { windows, startSkewMs };
}
