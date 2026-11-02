/**
 * The report envelope — the header every facet writes and every comparator
 * reads.
 *
 * A facet (skill lint, resource integrity, performance, I/O accounting, compat
 * prediction) decides what goes in `body`. The envelope decides everything
 * needed to know whether two bodies may be held next to each other: the
 * coordinate they were measured at, and which facet the body belongs to.
 *
 * **Refusal, not coercion.** A report from another header shape, a different
 * facet, or another body shape is *refused* rather than best-efforted into
 * comparison. A comparator that silently tolerates a schema change reports
 * differences that are artifacts of the change rather than of the subject, and
 * those are the most expensive kind of wrong answer this package can give.
 *
 * ## ⚠️ There are no version fields here, and adding one back is a defect
 *
 * This header used to carry a `formatVersion` and a `facetVersion`, and neither
 * ever decided anything the schemas do not decide already. {@link readEnvelope}
 * validates against {@link ReportEnvelopeSchema}, which is strict all the way
 * down through {@link CoordinateSchema} — so the very report the format bump was
 * cut for (one predating `instrument.dirty`) is refused for the honest reason,
 * that a required field is missing, without an integer in the loop. The body
 * half is the same: `harness/facet-compare.ts` validates BOTH sides against the
 * facet's own strict schema before a number is subtracted.
 *
 * The integers were strictly worse than the schemas at the one job they had,
 * because nothing fails when a human forgets to bump one. The crawl seam shipped
 * two meaning changes ahead of its bump and one of them published a confident
 * false delta in the interval.
 *
 * What no schema can see is a field whose MEANING moved while its name and type
 * stayed put — and no integer could see that either, it could only be told.
 * The remedies are to invalidate explicitly (delete the stored reports) or to
 * make the build DECLARE the thing that moved, as `CrawlTimingDump.charges`
 * does. Not to reintroduce a number nobody is obliged to move.
 */

import { spawnSync } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';

import { z } from 'zod';

import { type ArmEnvironment, buildArmEnv } from '../harness/arm-env.js';
import { describeIssues, recaptureRefusal } from '../harness/dumps.js';
import { type RecordedExit, RecordedExitSchema } from '../harness/exit-record.js';

import { type Coordinate, CoordinateSchema } from './coordinate.js';

/** Where a report's children ran: see {@link ReportEnvelope.host}. */
export interface ReportHost {
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  /** The `NODE_OPTIONS` the arm hands every measured child, before a facet's own preload; `''` for none. */
  readonly nodeOptions: string;
  /**
   * V8's heap limit in bytes, as a measured child's Node sees it under {@link nodeOptions}. Its
   * default is derived from the machine's memory, so two hosts alike in every field above can
   * still run out of heap at different peaks.
   */
  readonly heapSizeLimit: number;
  /** The machine's memory in bytes (`os.totalmem()`). Recorded, never compared: the heap limit is what it decides. */
  readonly totalMem: number;
  /**
   * `os.availableParallelism()`. Compared: vat sizes its parse pool from it (`min(4, n - 1)`
   * threads), and each thread holds its own heap, so two hosts alike in every field above can
   * still run a different number of parse workers.
   */
  readonly availableParallelism: number;
}

/**
 * The heap limit a measured child gets: read from a child of this Node under the arm's environment,
 * since `--max-old-space-size` in `NODE_OPTIONS` (or its absence) decides it.
 *
 * @throws {Error} when the child reports no limit — a host field the comparison cannot trust
 */
function childHeapSizeLimit(env: NodeJS.ProcessEnv): number {
  const read = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))"], { env, encoding: 'utf8' });
  const limit = Number(read.stdout);
  if (read.status !== 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`currentHost: could not read V8's heap limit from a child under NODE_OPTIONS '${env['NODE_OPTIONS'] ?? ''}' (exit ${String(read.status)}): ${read.stderr}`);
  }
  return limit;
}

/**
 * @param env - The capture's arm environment
 * @returns The host this process is, as a report records it
 */
export function currentHost(env: ArmEnvironment): ReportHost {
  const armEnv = buildArmEnv(process.env, env);
  const nodeOptions = (armEnv['NODE_OPTIONS'] ?? '').trim();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeOptions,
    heapSizeLimit: childHeapSizeLimit(armEnv),
    totalMem: totalmem(),
    availableParallelism: availableParallelism(),
  };
}

/** A measurement of one facet at one coordinate. */
export interface ReportEnvelope<TBody = unknown> {
  /** Which facet produced this — `io`, `perf`, `skill-lint`, and so on. */
  readonly facet: string;
  /** Where this was measured. See {@link Coordinate}. */
  readonly coordinate: Coordinate;
  /**
   * When the capture ran, ISO-8601.
   *
   * Recorded for provenance and **never compared**: it moves on every run, so
   * comparing it would report a difference between two identical measurements.
   */
  readonly capturedAt: string;
  /**
   * Inherited environment names the measured VAT children ran WITHOUT — the
   * developer state (`VAT_*`, git config, temp and Claude directories) the arm
   * cleared. Recorded for provenance and never compared.
   */
  readonly removedEnv: readonly string[];
  /**
   * Inherited npm network setting names (`registry`, proxies, CA — see
   * `arm-env.ts`) the measured VAT children KEPT: names only, never values, so
   * two developers' runs can be told apart. Recorded for provenance and never compared.
   */
  readonly npmNetworkEnv: readonly string[];
  /**
   * Every measured command's exit commitment and the code its repetitions
   * shared — empty for a facet that judges no commitment (`verdict` records
   * each row's own exit in its body). Recorded for provenance and never compared.
   */
  readonly exits: readonly RecordedExit[];
  /**
   * The lab's platform, architecture and Node build, and the `NODE_OPTIONS` its measured
   * children inherited. A `tree:`/`dist:` child, and every `memory` child, runs on this
   * Node; another facet's `npx:` child runs on the `node` on `PATH`. `memory`, whose peak
   * is the runtime's as much as vat's, refuses a pair that differs ({@link refuseDifferentHosts}).
   */
  readonly host: ReportHost;
  /** The facet's payload. */
  readonly body: TBody;
}

/**
 * Runtime schema for {@link ReportEnvelope}.
 *
 * **Strict, and load-bearing for it.** This is the whole of "may this report be
 * read?" — see this module's header. A header carrying a field this build does
 * not model (a `formatVersion` from a build that had one, say) is refused here,
 * and so is one missing a field this build requires.
 */
export const ReportEnvelopeSchema = z
  .object({
    facet: z.string().min(1),
    coordinate: CoordinateSchema,
    capturedAt: z.string().min(1),
    removedEnv: z.array(z.string()),
    npmNetworkEnv: z.array(z.string()),
    exits: z.array(RecordedExitSchema),
    host: z
      .object({
        platform: z.string().min(1),
        arch: z.string().min(1),
        node: z.string().min(1),
        nodeOptions: z.string(),
        heapSizeLimit: z.number().int().positive(),
        totalMem: z.number().int().positive(),
        availableParallelism: z.number().int().positive(),
      })
      .strict(),
    body: z.unknown(),
  })
  .strict();

/** Why a stored report could not be read or compared. */
export interface EnvelopeRefusal {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A report that parsed cleanly. */
export interface EnvelopeAccepted<TBody> {
  readonly ok: true;
  readonly envelope: ReportEnvelope<TBody>;
}

/** The outcome of reading a stored report. */
export type EnvelopeResult<TBody> = EnvelopeAccepted<TBody> | EnvelopeRefusal;

/**
 * Read an unknown value as a report envelope.
 *
 * The body is *not* validated here — only the header. Each facet owns its body
 * schema and validates it after checking that `facet` is the one it understands.
 *
 * @param value - Parsed JSON or YAML from a stored report
 * @returns The envelope, or a refusal naming what was wrong
 */
export function readEnvelope(value: unknown): EnvelopeResult<unknown> {
  const parsed = ReportEnvelopeSchema.safeParse(value);
  if (parsed.success) return { ok: true, envelope: parsed.data as ReportEnvelope<unknown> };
  // A header naming a facet and a coordinate is a lab report whose shape moved;
  // anything else is not a report at all, and blaming an older lab would lie.
  const facet = labReportFacet(value);
  return {
    ok: false,
    refusal:
      facet === null
        ? `REFUSED: not a report envelope — ${describeIssues(parsed.error)}`
        : recaptureRefusal(`this ${facet} report`, parsed.error),
  };
}

/**
 * @param value - Parsed JSON from a stored report
 * @returns The facet a lab report's header names, or `null` when `value` is not one
 */
function labReportFacet(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('coordinate' in value) || !('facet' in value)) return null;
  return typeof value.facet === 'string' && value.facet !== '' ? value.facet : null;
}

/**
 * Are these two reports measurements of the same facet?
 *
 * One of three gates a comparison must clear, and the only one the header alone
 * can answer. The coordinate gate is `decideComparison`; the body-shape gate is
 * `readBody` in `harness/facet-compare.ts`.
 *
 * ⚠️ **This deliberately does not compare the two bodies' shapes to each other.**
 * It used to, via a `facetVersion` integer, and that was the weaker of the two
 * checks available: two reports captured before a schema move agree with each
 * other perfectly while every row in them means what the older build meant.
 * Validating each side against THIS build's strict schema — which is what
 * `readBody` does — refuses that pair, and refuses it without anyone having
 * remembered to bump anything.
 *
 * @param a - The baseline report
 * @param b - The report being compared against it
 * @returns `null` when the two name one facet, or a refusal explaining why not
 */
export function refuseDifferentFacets(
  a: ReportEnvelope<unknown>,
  b: ReportEnvelope<unknown>,
): string | null {
  if (a.facet !== b.facet) {
    return `REFUSED: these reports measure different facets ('${a.facet}' and '${b.facet}'). There is no delta between two different measurements.`;
  }
  return null;
}

/** Each host field, as a refusal names it. */
const HOST_FIELDS: readonly (readonly [keyof ReportHost, string])[] = [
  ['platform', 'platform'],
  ['arch', 'architecture'],
  ['node', 'Node version'],
  ['nodeOptions', 'NODE_OPTIONS'],
  ['heapSizeLimit', 'V8 heap limit'],
  ['availableParallelism', 'available parallelism'],
];

/**
 * Were these two reports measured on one host — see {@link ReportEnvelope.host}?
 *
 * @param a - The baseline report
 * @param b - The report being compared against it
 * @returns `null` when they were, or a refusal naming both sides
 */
export function refuseDifferentHosts(a: ReportEnvelope<unknown>, b: ReportEnvelope<unknown>): string | null {
  const field = HOST_FIELDS.find(([key]) => a.host[key] !== b.host[key]);
  if (field === undefined) return null;
  const [key, what] = field;
  return `REFUSED: these reports were measured on a different ${what} ('${a.host[key]}' and '${b.host[key]}'), and the ${a.facet} numbers are the runtime's as much as vat's. Re-capture both on one host.`;
}
