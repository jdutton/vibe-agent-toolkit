/**
 * The runtime schema pieces every measurement facet shares.
 *
 * A facet owns its own body schema — that is the contract in
 * [Facets](../../docs/facets.md), and it is why the envelope reader deliberately
 * does not validate bodies. But `perf` and `io` are not arbitrary: they measure
 * the same commands, the same way, under the same cache modes, on the same
 * machine, and they say so with the same fields. Those fields are the harness's
 * contract showing through, not a coincidence between two facets.
 *
 * Declaring them once here means the two can only agree. Two hand-written copies
 * would be free to drift — one facet tightening `cache` to a third mode, or
 * spelling `failure` differently — and a reader holding a `perf` report beside an
 * `io` report would be comparing fields that merely look alike.
 *
 * What does NOT belong here: anything a single facet measures. `medianMs` is
 * `perf`'s, `loaderCalls` is `io`'s, and pulling either up would make this the
 * union of every facet rather than their genuinely shared core.
 */

import { z } from 'zod';

/**
 * Machine-load readings as they appear in a report body.
 *
 * Mirrors {@link LoadReadings}. Every number is nullable and `available` is an
 * explicit flag because Windows' `os.loadavg()` returns `[0, 0, 0]`
 * unconditionally — "no data" wearing the costume of a perfectly idle machine.
 * A schema that required numbers here would force a capture to invent one.
 */
export const LoadReadingsSchema = z
  .object({
    before: z.number().nullable(),
    after: z.number().nullable(),
    cpus: z.number().int().positive(),
    available: z.boolean(),
    contaminated: z.boolean(),
  })
  .strict();

/**
 * The fields every measured-command row carries, whatever is being measured.
 *
 * Spread into a facet's own row schema, which then adds its measurements and
 * calls `.strict()` itself — the strictness belongs to the finished object, not
 * to this fragment.
 *
 * `runs` means the same thing in every facet that uses this: **how many times
 * the command actually ran**. A facet that discards some of those repeats (as
 * `io` discards a warm-up) reports how many it compared in a field of its own,
 * rather than quietly redefining this one.
 */
export const measuredCommandShape = {
  /** Stable artifact name, appearing in the report and any diff. */
  name: z.string().min(1),
  /** Arguments as actually run, so the report records what produced the number. */
  args: z.array(z.string()),
  cache: z.union([z.literal('warm'), z.literal('cold')]),
  runs: z.number().int().nonnegative(),
  /** True when the row produced no usable measurement; it is kept so the report says so. */
  failed: z.boolean(),
  failure: z.string().nullable(),
} as const;
