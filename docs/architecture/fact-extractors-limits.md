# Fact Extractors — Parse Limits

The measured record behind `DEFAULT_PARSE_LIMITS` (`packages/resources/src/parse-limits.ts`), the
limits every parse-pool job runs under ([Fact Extractors](./fact-extractors.md) I8). The register
rows these numbers serve are in the [hazard register](./fact-extractors-hazard-register.md). Change
a value here and in the code together, and only from a new lab record.

## The headroom rule

1. **A limit the lab observes per document** is the largest value seen on any recorded corpus, times
   ten, rounded up to a power of two in its unit. Ten covers a corpus not yet measured that is an
   order of magnitude past the largest one that was; the power of two keeps the value readable.
2. **A limit the lab cannot yet observe per job** keeps a bound justified another way, written
   below, until the lab can see it. That gap is itself a finding, recorded below.
3. **No absolute time ceiling gates CI** ([Settled decisions](./fact-extractors.md#settled-decisions):
   CI gates on work counters, time is compared relatively). A limit is a kill switch for a
   pathological file, never a performance budget.

## The values

| Limit | Value | Observed maximum | How it was set |
|---|---|---|---|
| `inputBytes` | 8 MiB | 666,449 bytes (one adopter document); 352,261 in VAT's own tree | Rule 1: 6.7 MB, up to 8 MiB. |
| `outputRows` | 16,384 | 896 rows in one document; p99 203, p50 9 | Rule 1: 8,960, up to 16,384. Rows are counted over every top-level array of a document's facts. |
| `outputBytes` | 4 MiB | 233,802 bytes in one parse-cache entry; p99 57,556, p50 3,358 | Rule 1: 2.3 MB, up to 4 MiB. Measured on the stored entry, which is never smaller than the facts the worker checks. |
| `timeMs` | 10,000 ms | Not observable per document: the `parse` facet reports per-pass sums. Mean 13.7 ms per document over 2,680 documents under load. | Rule 2: about 700 times the loaded mean. The limit includes a cold worker's first parser load. A 1,000-level nested list, the slowest realistic shape found, takes 10.6 s. |
| `heapMb` | 1,024 MiB | Not observable per worker: the `memory` facet reports process peak RSS. The whole process, every worker included, peaked at 1.17 GiB on the adopter's cold run. | Rule 2: no single job can need more than the whole process held, less the main thread's share. |
| `stackMb` | 4 MiB | Not observable. | Rule 2: before this limit existed every corpus parsed on the main thread under Node's default stack of about 1 MiB, so 4 MiB is four times a stack every recorded corpus fit in. |

The output and input values come from the stored parse-cache entries of a cold `vat-lab parse run`
over the adopter monorepo, kept with `--arms-dir`, and from the sizes of the markdown and HTML files
in both trees.

## The record

All runs on one darwin/arm64 host with 10 CPUs, Node 26.7.0, at VAT `692ac3e4` plus this change.
**No quiet capture was possible:** the 1-minute load average stayed between 12 and 34 for every run,
and the lab flagged each one `CONTAMINATED`. Treat the absolute numbers as loaded-machine numbers.
The quiet arm is still owed.

### The bounded pool against the in-process parse, on a small corpus

20 markdown documents (510,554 bytes), cold cache, `perf ab`, minimum across pairs:

| A/B | Command | A min | B min | B − A | Pairs |
|---|---|---|---|---|---|
| rc.13 in-process (`VAT_PARSE_POOL=0`) vs rc.13 pool from the first miss (`VAT_PARSE_POOL_MIN_MISSES=1`) | `resources scan` | 793.7 ms | 800.7 ms | +7.0 ms (+0.9%) | 4, disagreed |
| main (in-process below the threshold) vs this change | `resources scan` | 800.7 ms | 938.8 ms | +138.1 ms (+17%) | 5, disagreed |
| main vs this change | `resources query` | 731.7 ms | 1,196.6 ms | +464.9 ms | 5, disagreed |
| main vs this change with `VAT_PARSE_POOL_MIN_MISSES=1` | `resources scan` | 1,355.1 ms | 1,566.1 ms | +211.0 ms (+16%) | 5, disagreed |
| main vs this change with `VAT_PARSE_POOL_MIN_MISSES=1` | `resources query` | 1,517.3 ms | 1,496.8 ms | −20.5 ms | 5, disagreed |

Every A/B but the first ran at load 18 to 29, and in every one the pairs disagreed, so the lab calls
none of them a result. The `parse` facet shows the mechanism. In-process, the 20 parses take 458.5 ms
on the main thread. Through the pool at width 1, the same parses take 632.7 ms of worker time and the
main thread waits 835.6 ms for the round trips: about 200 ms more, which is the worker's start, its
parser load and the message hops.

**Decision:** the pool stays on for every parse. The cost on a small cold corpus is between nothing
measurable and about 17% of wall time, against a 10% threshold, so it is recorded as an accepted
`Cost:` row in the register instead of keeping an unbounded route (I8). A warm run parses nothing and
starts no worker, so a served run does not pay it.

### VAT's own tree

A clean clone at `692ac3e4`, 330 markdown and HTML files, 3 runs each:

| Command | Served (warm store) | Derived (cold) |
|---|---|---|
| `resources check` | 1,665 ms median (1,534–1,860) | 12,395 ms median (11,961–13,640) |
| `resources query` | 1,601 ms median (1,358–1,850) | 10,650 ms median (8,941–11,720) |

Store hit rate: every warm repetition reported `population: store`, which the lab requires of a warm
run, so 3 of 3 were served from the store.

### The adopter monorepo, and its whole-tree check

2,359 markdown and HTML files on disk; the check parses 2,680 documents (53.4 MB), because the
crawl follows links out of the tree's own listing.

| `resources check` | Wall |
|---|---|
| Served (warm store, 3 runs) | 1,730 ms median (1,632–2,254) |
| Derived (cold, 2 runs) | 22,075 ms median (21,968–22,182) |

**Why a whole-tree check takes about a minute.** It is the derived path, and almost all of that is the
markdown parse:

- The cold check spends 32.5 s of parse time, summed across worker threads, on 2,680 documents. That
  is 12.1 ms per document on average.
- 90.9% of the markdown time is `remark-parse` (29.5 s), the tokenizer and tree build. Fact
  extraction from the tree is 1.2 s, and lexical references are 0.45 s.
- The parent thread spends 2.4 s writing parse-cache entries and 0.46 s reading them.
- The run took 41.7 s of process wall time across its two processes and 64.2 s of CPU. With the pool
  narrowed or the machine busy, wall time approaches that CPU figure, which is where "about a
  minute" comes from.
- Served from the store, the same check takes 1.7 s. Of that, the `crawl` facet sees 116 ms: 81 ms
  reading the projection store and 35 ms initializing git. The rest is process start-up and the SQL
  answer, and no facet can attribute it yet (see the gaps below).

Peak RSS of the cold run was 1.17 GiB, worker threads included.

## What the lab could not see

These gaps are findings, not omissions to fill by hand:

- **No per-phase timing inside `resources check` or `resources query`.** `perf` reports wall time
  per command, `crawl` the crawl, and `parse` the parse. Statement planning, hydration and the
  answer have no facet.
- **No per-document maximum.** The `parse` facet reports sums and means per pass, so `timeMs` cannot
  be derived by rule 1.
- **No per-worker heap.** The `memory` facet reports process peak RSS, so `heapMb` cannot be derived
  by rule 1.
- **No one-file-edit arm.** No facet edits one file between repetitions, so the cost of a one-file
  edit per file kind is not recorded.
