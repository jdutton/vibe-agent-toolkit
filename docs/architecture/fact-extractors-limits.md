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
| `outputRows` | 16,384 | 896 rows in one document, top-level arrays only; p99 203, p50 9 | **Rule 2.** The limit counts every array in a document's facts, nested ones included (a heading's `children` count like any other row, so one `#` over 20,000 `##` is 20,001 rows), and the frontmatter as the JSON the store writes for it — every array element and every mapping entry a row, each YAML alias at its target's full size, a `!!binary` one row per byte, and every `!!set` member and `!!omap` entry a row (the codec carries them, though `JSON.stringify` writes `{}`). The lab's maximum was counted over top-level arrays only, so rule 1 cannot be applied to it: 16,384 is rule 1 over that count (8,960, up to 16,384). Re-counted as the limit counts it, with the shipped `outputBreach`, over the 2,626 git-tracked markdown documents of the adopter the lab's `adopter-default` arm scans: maximum 1,287 rows (p99 280, p50 24), 12.7× under the limit — and one document's frontmatter alone is 770 rows, so a frontmatter mapping is NOT "a handful of rows", as this record said. That re-count is a one-off probe over the shipped functions, not a lab facet; the per-document count is a lab gap (below). |
| `outputBytes` | 4 MiB | 297,447 bytes in one document, counted as the limit counts it; p99 58,097, p50 3,810 | Rule 1: 2.97 MB, up to 4 MiB (14.1× the maximum). Counted as the worker checks it — the facts' JSON plus the frontmatter expanded (every alias at its target's full size, every `!!set` member and `!!omap` entry, a `!!binary` as its `Buffer` JSON) — with the shipped pool's own `outputBreach`, over the same 2,626 git-tracked markdown documents as the `outputRows` re-count (the probe also reproduces that row's 1,287 / 280 / 24 rows exactly). The largest is a 251,888-byte document. The value it replaces was measured on stored parse-cache entries (233,802 bytes; p99 57,556, p50 3,358), which is not what the worker checks: an entry holds the frontmatter's source text beside its encoding, and the encoding writes a shared anchor once. That re-count is a one-off probe over the shipped functions, not a lab facet; the per-document count is a lab gap (below). |
| `outputDepth` | 1,000 levels | Not observable per document. | Not a headroom value: the store's own ceiling. SQLite's JSON functions read at most 1,000 nested containers (`JSON_MAX_DEPTH`); measured on Node 26's `node:sqlite`, 1,000 read and 1,001 throw "malformed JSON" for the whole statement, so one deeper stored row breaks every `json_extract` over `blobs.frontmatter`. `resolveParseLimits` refuses a looser value. A cyclic anchor nests without end and breaches it. |
| `timeMs` | 30,000 ms | Not observable per document: the `parse` facet reports per-pass sums. Mean 10.3 ms per document over 2,680 documents at a clean load (the adopter arm of [the `vat-lab parse run` arms](#the-vat-lab-parse-run-arms)); 12.1 ms in the cold `resources check` run. | Rule 2: the slowest realistic shape found, a 1,000-level nested list, takes 9.3 s in a worker (the nested-list arm below, a one-document corpus, so its per-pass sum is that document's time); the limit also covers a cold worker's first parser load (about 0.7 s), on a loaded machine. 30 s is that 10.0 s with headroom of three times for load. A mean is no basis: one document can be a thousand times the mean, and the per-document maximum over a real corpus is still not observable (see the gaps below). |
| `heapMb` | 1,024 MiB | Not observable per worker: the `memory` facet reports process peak RSS. The whole process, every worker included, peaked at 1.17 GiB on the adopter's cold run. | Rule 2: no single job can need more than the whole process held, less the main thread's share. Under a process-wide `--max-old-space-size` lower than twice this, the pool applies half of V8's ceiling, floored at the young generation's 96 MiB while the ceiling leaves 32 MiB above the floor (see [the heap under a small flag](#the-heap-under-a-small-flag)). A used heap past the bound is a breach only once an old-generation collection shows it held, or past a stop halfway to V8's ceiling (1,536 MiB at the defaults) with none (see [garbage is not a breach](#garbage-is-not-a-breach)). |
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
  that document at `heapMb` in 2 runs of 20; with the bound floored at the young generation's
  96 MiB it is admitted in 30 of 30. The floor holds only while V8's ceiling leaves 32 MiB above
  it (twice what a job allocates in one 50 ms sample interval at ~300 MiB/s), so under a 64 MiB
  flag the pool still applies 32 MiB and an ordinary document can be refused: such a flag is too
  small to parse with. A 200,000-link breach under the 128 MiB flag is stopped at 96 MiB with the
  child exiting cleanly, 15 of 15 (seeded three in a row in `parse-pool-limits.integration.test.ts`).
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
generation holds (96 MiB; a scavenge frees no more), so what it still reads is held. A heap that
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
