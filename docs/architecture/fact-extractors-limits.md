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
| `inputBytes` | 8 MiB | 666,449 bytes (one adopter document); 352,261 in VAT's own tree | Rule 1: 6.7 MB, up to 8 MiB. Measured in one unit on every lane, the bytes the content came from: a file's raw bytes on disk (`fstat`, before a byte is read), carried with what the read decoded so no lane re-measures the text; a ZIP entry's declared size; content never read, its UTF-8 bytes (`inputBytesBreach`, `MeasuredContent`). |
| `outputRows` | 16,384 | 896 rows in one document, top-level arrays only; p99 203, p50 9 | **Rule 2.** The limit counts every array in a document's facts, nested ones included (a heading's `children` count like any other row, so one `#` over 20,000 `##` is 20,001 rows), and the frontmatter as the JSON the store writes for it — every array element and every mapping entry a row, each YAML alias at its target's full size, a `!!binary` one row per byte, and every `!!set` member and `!!omap` entry a row (the codec carries them, though `JSON.stringify` writes `{}`). The lab's maximum was counted over top-level arrays only, so rule 1 cannot be applied to it: 16,384 is rule 1 over that count (8,960, up to 16,384). Re-counted as the limit counts it, with the shipped `outputBreach`, over the 2,626 git-tracked markdown documents of the adopter the lab's `adopter-default` arm scans: maximum 1,287 rows (p99 280, p50 24), 12.7× under the limit — and one document's frontmatter alone is 770 rows, so a frontmatter mapping is NOT "a handful of rows", as this record said. That re-count is a one-off probe over the shipped functions, not a lab facet; the per-document count is a lab gap (below). |
| `outputBytes` | 4 MiB | 297,447 bytes in one document, counted as the limit counts it; p99 58,097, p50 3,810 | Rule 1: 2.97 MB, up to 4 MiB (14.1× the maximum). Counted as the worker checks it — the facts' JSON plus the frontmatter expanded (every alias at its target's full size, every `!!set` member and `!!omap` entry, a `!!binary` as its `Buffer` JSON) — with the shipped pool's own `outputBreach`, over the same 2,626 git-tracked markdown documents as the `outputRows` re-count (the probe also reproduces that row's 1,287 / 280 / 24 rows exactly). The largest is a 251,888-byte document. The value it replaces was measured on stored parse-cache entries (233,802 bytes; p99 57,556, p50 3,358), which is not what the worker checks: an entry holds the frontmatter's source text beside its encoding, and the encoding writes a shared anchor once. That re-count is a one-off probe over the shipped functions, not a lab facet; the per-document count is a lab gap (below). |
| `outputDepth` | 1,000 levels | Not observable per document. | Not a headroom value: the store's own ceiling. SQLite's JSON functions read at most 1,000 nested containers (`JSON_MAX_DEPTH`); measured on Node 26's `node:sqlite`, 1,000 read and 1,001 throw "malformed JSON" for the whole statement, so one deeper stored row breaks every `json_extract` over `blobs.frontmatter`. `resolveParseLimits` refuses a looser value. A cyclic anchor nests without end and breaches it. |
| `timeMs` | 30,000 ms | Not observable per document: the `parse` facet reports per-pass sums. Mean 10.3 ms per document over 2,680 documents at a clean load (the adopter arm of [the `vat-lab parse run` arms](#the-vat-lab-parse-run-arms)); 12.1 ms in the cold `resources check` run. | Rule 2: the slowest realistic shape found, a 1,000-level nested list, takes 9.3 s in a worker (the nested-list arm below, a one-document corpus, so its per-pass sum is that document's time); a cold worker's first parser load (about 0.7 s), and a reused thread's heap check before the job, are not charged to it: they run on their own `timeMs` clock, whose stop is the thread's and runs the document again, at most three times, so one document ends within about four `timeMs` (two minutes at the default), plus a check on each reused thread it was moved off, plus any time it waited in the queue (hazard register, the slow-start row). 30 s is that 9.3 s with headroom of three times for a loaded machine. A mean is no basis: one document can be a thousand times the mean, and the per-document maximum over a real corpus is still not observable (see the gaps below). |
| `heapMb` | 1,024 MiB | Not observable per worker: the `memory` facet reports process peak RSS. The whole process, every worker included, peaked at 1.17 GiB on the adopter's cold run. | Rule 2: no single job can need more than the whole process held, less the main thread's share. Under a process-wide `--max-old-space-size` lower than twice this, the pool applies `max(⌊ceiling / 2⌋, min(youngGen, ceiling − 32))` MiB, never above `heapMb` — half of V8's ceiling, floored at the worker's young generation while the ceiling leaves 32 MiB above it; 96 MiB under a 128 MiB flag on Node 26.7, whose young generation (192 or 96 MiB, by host) is at least the 96 the ceiling leaves (see [the heap under a small flag](#the-heap-under-a-small-flag)). A used heap past the bound is a breach only once an old-generation collection shows it held, or past a stop halfway to V8's ceiling (1,536 MiB at the defaults) with none (see [garbage is not a breach](#garbage-is-not-a-breach)). |
| `stackMb` | 4 MiB | Not observable. | Rule 2: before this limit existed every corpus parsed on the main thread under Node's default stack of about 1 MiB, so 4 MiB is four times a stack every recorded corpus fit in. |

The output and input values come from the stored parse-cache entries of a cold `vat-lab parse run`
over the adopter monorepo, kept with `--arms-dir`, and from the sizes of the markdown and HTML files
in both trees. That first run's exact invocation was not recorded; the arms below were re-run and
are the record.

## The `vat-lab parse run` arms

Run from the VAT repository root against the working tree at `06eb2589` plus the round-2 review
fixes (the lab names it `DIRTY`), darwin/arm64, 10 CPUs, Node 26.7.0. The lab judged the load clean
for every arm (1-minute load average 3.0 to 3.6). The two pathological arms are one-document
subjects, so the `parse` facet's per-pass sum is that document's own parse time.

```bash
node packages/lab/dist/bin/vat-lab.js parse run <subject> --instrument tree:. \
  --command resources-scan --runs <n> --cache cold --id <id> --out <dir>
```

| Arm (`--id`) | Subject | `--runs` | Parse time | What it shows |
|---|---|---|---|---|
| `adopter-monorepo` | the adopter monorepo | 1 | 27,469.7 ms summed over 2,680 documents (53,443,554 bytes), 10.3 ms mean; `remark-parse` 90.8% of markdown; 18,974 ms wall, 57,595 ms CPU | The per-document mean behind `timeMs`; reproducibility untested (one repeat). |
| `pathological-nested-list` | one document: a list nested 1,000 levels (1,009,900 bytes) | 3 | 9,302.9 ms in `remark-parse`; repeat totals 9,317.1, 9,157.5, 9,356.7 ms; worker job 9,364.1 ms | The slowest realistic shape `timeMs` covers. |
| `pathological-blockquote` | one document: 10,000 nested `>` (10,015 bytes) | 3 | 613.2 ms; repeat totals 649.4, 593.2, 613.2 ms | Under the default 4 MiB worker stack it parses; it overflows only a main thread's stack (about 1 MiB), which is why a breach fixture names a 1 MiB `stackMb`. |

The pathological subjects are generated, not checked in: the nested list is `"  ".repeat(i) + "- item " + i`
for `i` from 0 to 999 under a `# Nested` heading, and the blockquote is `# Quote` followed by
10,000 `>` and the word `deep`.

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
on the main thread. Through the pool at width 1, the same parses take 632.7 ms of worker time, and
the main thread waits 835.6 ms for the round trips, where the in-process parse took 458.5 ms. The
difference is the worker's start, its parser load and the message hops.

**Decision:** the pool stays on for every parse. The cost on a small cold corpus runs from about −1%
to +64% of wall time across the arms above; the worst arm is `resources query` cold-small, at
+464.9 ms (731.7 ms to 1,196.6 ms). It is recorded as an accepted `Cost:` row in the register, and
counted there by the `wire-roundtrip` tier row of the lab's `parse` facet, for three reasons: I8 forbids keeping an unbounded in-process route for small
runs; a warm run parses nothing and starts no worker, so a served run does not pay it; and the cost
is a fixed start-up cost per run, not a cost per file, so it shrinks as a share of a larger run.

**Per run, not per pool, only because shutdown parks the thread.** A command builds a pool per lane
and per single-file parse, and each pool used to start its own thread: a cold `vat build` of one
skill and one plugin started eleven, about 1.1 s of a run that takes 60 ms in-process (the
`top-level-build` fault-matrix case, cache off, on this host: 32 runs in 34.5 s against 1.99 s
before the pool). A pool's shutdown now parks each healthy idle thread, and the next pool of the same
shape adopts it (`parkedWorkers` in `parse-pool.ts`), so a run starts one thread per pool it holds
open AT ONCE — two for that build, and the same 32 runs take 2.2 s. Parking is off while parse timing
is recorded, so a timed run still closes, and reports, every thread; it is capped by the memory the
pool bound leaves (`parkedThreadRoom`), so a machine with none to spare parks nothing and pays a
start per pool again.

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

**How long a cold whole-tree check takes: 22 s cold here; 64 s of CPU, so up to about a minute on a
contended host (not measured).** It is the derived path, and almost all of that is the markdown
parse:

- The cold check spends 32.5 s of parse time, summed across worker threads, on 2,680 documents. That
  is 12.1 ms per document on average. This is the `resources check` run in the table above, not the
  `vat-lab parse run` adopter arm whose 10.3 ms mean the `timeMs` row quotes: two runs, at different loads.
- 90.9% of the markdown time is `remark-parse` (29.5 s), the tokenizer and tree build. Fact
  extraction from the tree is 1.2 s, and lexical references are 0.45 s.
- The parent thread spends 2.4 s writing parse-cache entries and 0.46 s reading them.
- The run took 41.7 s of process wall time across its two processes and 64.2 s of CPU. With the pool
  narrowed or the machine busy, wall time would approach that CPU figure, which is where "up to about
  a minute" comes from. No arm measured it (see the gaps below).
- Served from the store, the same check takes 1.7 s. Of that, the `crawl` facet sees 116 ms: 81 ms
  reading the projection store and 35 ms initializing git. The rest is process start-up and the SQL
  answer, and no facet can attribute it yet (see the gaps below).

Peak RSS of the cold run was 1.17 GiB, worker threads included.

## The heap under a small flag

One-off probes, not a lab facet (darwin/arm64, Node 26.7.0). The pool's sampler counts a worker's
whole used heap, young generation included, so its applied bound must sit above what an ordinary
parse holds in garbage alone.

- **An ordinary document.** A cold worker that loads the parser and parses a 34,469-byte document
  of 400 headed sections peaks at 54 to 68 MiB of used heap, sampled every 5 ms (20 runs at each
  of no flag, 512, 256, 128 and 64 MiB; ~18 MiB once the parser has loaded). Capping the young
  generation at 8 MiB still peaks at 37 to 43 MiB, so most of the excess is young-generation
  garbage. Under `--max-old-space-size=128` the pool applied 64 MiB (half the ceiling) and refused
  that document at `heapMb` in 2 runs of 20; with the bound floored at 96 MiB it is admitted in 30
  of 30. The floor is the young generation's size (192 or 96 MiB on Node 26.7, by host) held to 32 MiB under V8's
  ceiling, so under this flag it is 96 MiB. It holds only while V8's ceiling leaves 32 MiB above
  it (twice what a job allocates in one 50 ms sample interval at ~300 MiB/s), so under a 64 MiB
  flag the pool still applies 32 MiB and an ordinary document can be refused: such a flag is too
  small to parse with. A 200,000-link breach under the 128 MiB flag is stopped at 96 MiB with the
  child exiting cleanly, 15 of 15 (seeded three in a row in `parse-pool-limits.integration.test.ts`).
- **A semi-space or heap-size flag.** V8's ceiling for a worker is the old generation it can reach:
  the least of `heap_size_limit` less the young generation, `--max-old-space-size` (with none
  visible, the old generation the pool set the thread, `maxOldGenerationSizeMb`), and
  `--max-heap-size` less the young generation. The reading holds for flags visible in
  `NODE_OPTIONS` and `execArgv`; a flag set another way is not seen. Measured on Node 26.7 (`heap_size_limit`, MiB): no
  flags 2,240 (2,048 + 192) on one host and 2,144 (2,048 + 96) on another; old 512 with semi-space 128, 896; old 128 with semi-space 16, 176;
  semi-space 16 alone 2,096, 128 alone 2,432; `--max-heap-size=512`, 512; old 1,024 with heap size
  512, 1,027. The young generation is three times the semi-space flag rounded up to a power of two
  (flags of 3, 40 and 100 grew `heap_size_limit` by 12, 192 and 384) on Node 22, 24 and 26, while a
  worker's `resourceLimits` still reports the default (on Node 26.7 192 or 96 by host, and 48 on
  Node 22), so the pool reads a flagged semi-space from the flag. Nothing depends on which default
  a host has: every bound is computed from the one it reads. Under old 512 with semi-space 128 the applied bound is 384 MiB,
  and under old 128 with semi-space 16, 64 MiB; read from `resourceLimits` they were 256 and 48.
- **A 10,000-level nested blockquote** (10,015 bytes, the pathological arm above) needs its heap
  for real: in a raw worker with V8's full collection before it gives up, it runs out of memory
  under an old-generation ceiling of 420 MiB and completes under 460 MiB (peak used 414 MiB). The
  pool admits it with no flag and under `--max-old-space-size=1024`, and refuses it under CI's
  512 (applied 256 MiB) on every crawl and skill verb alike. The refusal is the halving, not a
  mis-applied bound: V8's 512 MiB ceiling would itself hold it. Not changed; the CI-flag verdict
  is recorded, not tuned.

## Garbage is not a breach

One-off probes, not a lab facet (darwin/arm64; the CLI under Node 24.21.0, the raw workers under
26.7.0). The used heap a sample reads counts garbage V8 has not collected, and V8 collects lazily
below a ceiling set at twice the bound. With no flag, the 10,000-level blockquote (live heap 420 to
460 MiB, above) parsed in a raw worker peaks at 595 to 643 MiB used, sawtoothing as V8 collects,
and allocates about 2.3 GiB in all. On a loaded host the collections stop: run cold through
`skills build` and `skills package` beside 8 busy loops (load average 15 to 45), its used heap in
the refused runs rose from nothing to 1,031 and 1,079 MiB with not one fall, and the sampler,
comparing each sample to 1,024 MiB, refused it at `heapMb` in 3 of 10 runs (`skills build` 1 of 3
and 1 of 4, `skills package` 1 of 3).

So a used heap past the bound is a breach only once an old-generation collection has run
(`heapBreached`): a sample that fell from the same job's previous one by more than the young
generation holds (on Node 26.7, 192 or 96 MiB by host, read from the worker's `resourceLimits`; a scavenge frees
no more), so what it still reads is held. A heap that
rises with no such fall is stopped at `stopMb`, halfway from the bound to V8's ceiling (1,536 MiB at
the defaults, 384 under a 512 MiB flag), never within the sampler's 32 MiB headroom of the ceiling,
so V8's ceiling is still never left to stop a job. Half the room is the trade between the two
misreads: garbage below the stop, and a parent stalled while a true breach allocates toward V8's
ceiling above it. Measured with the stop in place, all cold and with no flag: 10 of 10 admitted on
`skills build` and 10 of 10 on `skills package` beside 8 busy loops (load average 36 to 44), and
8 of 8 on `skills build` beside 16 (load average 50), where 3 of the 8 ran to the end with no
collection at all and peaked at 1,081 to 1,157 MiB, 379 MiB below the stop. Nothing bounds that
margin but the measurement: a document that holds little but allocates more than the stop with no
collection is refused there.

## A reused thread

Every job, on any thread, is judged against the same applied bound and the same stop — no job gets
credit for, or is charged with, what its thread held before it. That is sound only if a reused
thread starts its job holding about what a fresh one does, so a reused thread checks its own heap
before the job (`settleReusedHeap` in `parse-limits.ts`):

- **The bound** is `reusedThreadHeapMb(appliedMb)` = `FRESH_THREAD_HEAP_MB` + B, with
  **B = ⌊appliedMb / 8⌋**, the thread's own applied bound read as the pool reads it. A fresh thread
  holds 23.3 to 24.1 MiB of used heap once both parsers have loaded (Node 26.7.0), so
  `FRESH_THREAD_HEAP_MB` is 24, and the bound is 152 MiB at the default applied 1,024 MiB, 88 under
  a 1,024 MiB process flag (applied 512), 72 under 768 (applied 384) and 56 under 512 (applied
  256). The worst-case difference between a job's verdict on a fresh and on a reused thread is B:
  an eighth of the room, at every bound.
- **Over the bound**, the thread forces a full collection of its own heap (V8's `gc`, taken once as
  the worker loads, under a lock, with `--expose-gc` cleared again — `parse-collector.ts` says why)
  and reads again. A thread with no collector (a runtime that refuses the flag) is retired
  instead, its job on a fresh thread, and the process is warned once.
- **Still over**, the thread is retired before it runs anything: the job runs on a fresh thread,
  never on another reused one, and the jobs behind it may use an idle thread meanwhile.

The pool samples a reused thread's heap only once its check has reported, so the job is never
judged on what the previous job left. Every check is reported to the parent and counted there
(`reuse-check`, `reuse-collect`, `reuse-retire` tier passes; `reuseHeap` the heap each settled to).

Measured with the `parse` facet (`vat-lab parse run <subject> --instrument tree:. --command
resources-validate --env NODE_OPTIONS=--max-old-space-size=N`, darwin/arm64, Node 24.21.0, cold, 2
runs each, on a host the lab called contaminated, so the milliseconds are indicative; the adopter's
corpus is 2,680 documents, 53 MB, VAT's 362). The cost is the whole check (reads and collections)
against the workers' `worker-job` time:

| Corpus | Flag | Applied | B | Checks | Collected | Cost per collection | Cost of worker time | Retired | Settled heap, mean / max |
|---|---|---|---|---|---|---|---|---|---|
| VAT | 1,024 | 512 | 64 | 390 | 2 (0.5%) | 2.1 ms | 4.5 / 1,902 ms (0.24%) | 0 | 41.2 / 87.5 MiB |
| VAT | 512 | 256 | 32 | 390 | 4 (1.0%) | 3.2 ms | 13.1 / 2,079 ms (0.63%) | 0 | 32.1 / 54.0 MiB |
| adopter | 1,024 | 512 | 64 | 3,175 | 13 (0.4%) | 4.3 ms | 58.9 / 27,697 ms (0.21%) | 0 | 39.2 / 86.2 MiB |
| adopter | 768 | 384 | 48 | 3,175 | 35 (1.1%) | 4.7 ms | 166.7 / 30,846 ms (0.54%) | 0 | 35.8 / 71.9 MiB |

Every settled maximum is within its bound, so the measured difference from a fresh thread (the
maximum less 24 MiB) is 63.5, 30.0, 62.2 and 47.9 MiB against B of 64, 32, 64 and 48.

**Why an eighth.** What a job leaves behind is garbage of a size set by the document, not by the
bound, so how often a check collects follows B's absolute size. A fixed 8 MiB collected before a
quarter of the jobs: 3–5 ms each, 7.7–10% of worker time (390 and 3,175 checks, 96 and 832
collected). A sixteenth met a 2% budget at a 1,024 MiB flag (B = 32: VAT 1.1%, the adopter 1.4%)
and under 768 (B = 24: 1.9%), but not under 512, where B = 16 collected before 47 of 390 jobs
(12%, 4.75% of worker time). An eighth is under 0.7% at every flag measured. The adopter's tree
under a 512 MiB flag cannot be measured at all: the process dies of the MAIN thread's out-of-memory
(a 511.6 MB live mark-compact on the main isolate), on this build and on 0.2.0-rc.13 alike, not of
a parse worker's.

## What the lab could not see

These gaps are findings, not omissions to fill by hand:

- **No per-phase timing inside `resources check` or `resources query`.** `perf` reports wall time
  per command, `crawl` the crawl, and `parse` the parse. Statement planning, hydration and the
  answer have no facet.
- **No per-document maximum.** The `parse` facet reports sums and means per pass, so `timeMs` cannot
  be derived by rule 1.
- **No per-document row or byte count as the limit counts it.** No facet reports a document's rows
  or bytes nested and with its frontmatter expanded, so `outputRows` stays under rule 2 and
  `outputBytes` rests on a one-off probe.
- **No per-worker heap.** The `memory` facet reports process peak RSS, so `heapMb` cannot be derived
  by rule 1. One one-off probe (not a facet) bears on it: a body of 20,000 links (`[l](x)`, ~320 KB)
  peaks at 300 to 400 MiB of LIVE heap in its parse worker — it fails under a 300 MiB V8 ceiling,
  which collects every byte of garbage before giving up, and completes under 400 MiB. Under a
  process-wide `--max-old-space-size=512` (CI's) the pool applies 256 MiB, so that document is a
  true `heapMb` breach there, not garbage counted by the sampler. Test fixtures that mean to breach
  `outputRows` alone use frontmatter rows instead (`overOutputRowsMarkdown`, ~130 KB, refused at
  `outputRows` even under `--max-old-space-size=256`).
- **No width-1 or contended arm.** Nothing runs the cold check with the pool held to one worker,
  or on a host with a known competing load, so "up to about a minute" is an inference from CPU time,
  not a measurement.
- **No one-file-edit arm.** No facet edits one file between repetitions, so the cost of a one-file
  edit per file kind is not recorded.
