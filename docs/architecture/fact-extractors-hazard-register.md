# Fact Extractors — Hazard Register

The living register of hazards the fact store enforces or accepts, under
[Fact Extractors](./fact-extractors.md) P1: no wrong answer at exit 0 from any hazard listed here.

Each row has a status — `enforced`, or `accepted` (`accepted, counted` where the cost is counted) —
and either the kind of enforcer that proves it red or the bound that limits it. A change that builds
part of the design adds or updates its rows in the same PR. A new hazard becomes a row here, never a
new rule in the ADR. Rows name invariants and mechanisms, never plan steps.

A status is the design's commitment for that hazard. Like the ADR it serves, the register is decided
and not yet built: an `enforced` row holds only once the change that builds its enforcer has proved
it red on a seeded violation.

| Hazard | Status | Enforcer kind, or bound |
|---|---|---|
| Clock regression | accepted | Bound: a stale hit needs a backward step within one granule, size, ino and ctime unchanged; `--verify` or a cold run clears it. |
| Undetected plugin impurity | accepted | Bound: refused at load (`EXTRACTOR_UNCONFORMED`, naming `vat extractor test`) until a pass is recorded outside the evictable store under the plugin's source closure plus the compatibility digest, no runtime tuple (I2's exemption; sampling covers a new runtime). Rejected: running it unconformed. |
| Plugin trust | accepted | A plugin has the user's rights and writes any project's facts; the store copies what it reads (value and line extractors opt in); PR CI runs the author's code. Bound: CI caches are ref-scoped, never restored from a PR into a protected branch; its rows leave only by eviction or `vat cache clear`. |
| Non-module code payloads (wasm, data files) | enforced | Files read while a module evaluates join its code identity; the observed-inputs instrument. |
| git's env, config and global file inputs | enforced | Pinned (settled); env, config and pass-through allowlists, both ways. |
| Behaviour-defining config dropped by pinning | enforced | Once per effective-config hash (counted), the extent's file list and status are compared, pinned vs unpinned git; a difference refuses, naming it, unless the key is dropped deliberately (`core.excludesFile`); Windows CI with system `autocrlf=true`, and an LFS-filter fixture: an unchanged tree has zero changed files. |
| git older than the pinning floor | enforced | Refuses, naming the version found and the floor, the lowest version honouring every pinning variable; a stubbed `git --version` seed. |
| An index bit (assume-unchanged / skip-worktree) hides a change | enforced | Refuses, naming the path, except a skip-worktree file absent in a sparse checkout; each bit seeded. |
| Cost: pinned git drops performance keys (`core.fsmonitor`, `core.untrackedCache`, `feature.manyFiles`) | accepted, counted | The answer is unaffected because the keys are dropped. |
| A repo another user owns | enforced | Refuses, naming git's dubious-ownership cause and its control (settled): exact paths, `*` refused, an extent-key input (I9). Rejected: honouring global config (un-pins git); the non-git lane (silent). |
| git's repo-local file inputs and binary | enforced | Declared extent-key inputs, with each passed-through `filter.<driver>` command's resolved binary and version; a Linux-only file-open trace following children (`-f`), both ways, covering {index, objects, refs, packs} and the pass-through set; elsewhere, that plus the pinned env. An artifact derived through a passed-through filter driver is uncacheable, counted, unless the driver is allowlisted with its full input set proved by the trace fixture (LFS). |
| Coarse mtime granularity; a stat memo on another filesystem | enforced | I2a's racy rule, judged on the tree's own filesystem; a stat-seam re-hash test. |
| Identifier case collision | enforced | Relation naming (settled); refused at config load; manifest columns, which SQLite matches case-insensitively, by the static manifest check. |
| PID reuse | enforced | Liveness is PID plus process start time; a two-process test. |
| Lease start time | enforced | The kernel's stored process creation time, one source on writer and checker sides (Linux: `/proc`); doubt means alive; two-process test, clock seam stepped. |
| Cost: start-time probe off Linux | accepted, counted | A child process, killed at limit (I8). |
| Store across hosts or containers | enforced | A lease records machine id, boot id and PID namespace: same machine, boot and PID namespace: judged by PID and start time; same machine, other boot: dead; otherwise (another machine or PID namespace) foreign, so alive, never evicted; each seeded. |
| Store on a network filesystem | enforced on Linux; accepted on macOS, Windows | Linux: a store root whose fs type is not on an allowlist of known-local types refuses, naming the path; an unlisted type seeded. Elsewhere, bound: documented unsupported; a probe is Deferred. |
| Store shared with another OS user | enforced on POSIX; accepted on Windows | POSIX: a root not the current uid's, or group- or world-writable, refuses at every open, naming the path; seeded both ways. Windows bound: the root sits under the user's profile, per-user by default. |
| Module resolution drift | enforced | Code identity adds the specifier→file map, `NODE_PATH`, `--conditions`, re-resolved warm; a native addon hashes with its libraries or refuses; a shadowing file or `exports` edit misses. |
| Cost: code-identity validation | accepted, counted | One stat per closure file plus re-resolution, memoised under the stat memo's racy rule. |
| ctime not independent of mtime | enforced | A first-use probe per filesystem; if ctime stays with mtime held, the stat memo is distrusted there, bytes re-hashed (counted); a stat-seam fixture. |
| A plugin loaded through an import wrapper | enforced | I11's lint and allowlist. |
| A plugin hangs at module evaluation | enforced | Kill at limit (I8). |
| Mixed VAT builds on one store | enforced | The namespace (settled); I7's test. |
| Concurrent writer | enforced | Whole row sets (I6); I7's test. |
| Eviction or retirement mid-run | enforced | Leases (settled); I7's test. |
| Crash mid-write | enforced | I6's kill mid-write. |
| Claim held under a lease judged alive | accepted, counted | Bound: a waiter at its limit extracts the pair itself, idempotently. |
| Schema introspection sees the hydration set | enforced | One lane on every runtime until the declared floor has an authorizer: `EXPLAIN` at prepare, counted, refuses an `OpenRead` of root page 1 (the schema table) and any virtual-table open but `json_each`/`json_tree`, by identity (virtual-table pointer equal to theirs on the connection), never name or alias; bare `PRAGMA` and second statements, the store's keyword and single-statement guard. Seeds `dbstat`, `pragma_table_info`, `sqlite_schema`, `dbstat AS json_each`, `pragma_table_info(...) AS json_tree`, each alone and beside another statement. |
| Answer depends on hydration order | enforced | Hydration inserts rows in canonical order (path, then row ordinal); I0 seeds an order-dependent statement. |
| Tree mutated mid-run | enforced | Before the answer the extent is re-statted under I2a's racy rule, own-granule entries re-hashed (counted), and HEAD and the index re-read; any move refuses (tree moved); a two-process test checks out between extent derivation and answer; a stat-seam seed. |
| Ambient process inputs (`LANG`/locale, `TZ`, cwd, env) | enforced | Unseen by an fs-read instrument: the conformance suite runs every producer under two values of each, rows identical. |
| Absence read as empty | enforced | I1's enforcer. |
| Spurious refusal | enforced | I0's differential: zero refusals, unseeded corpus, every arm, limits outside the measured range; limit refusals counted apart. |
| Stale key from another history | enforced | I0's warm arm on a store another history populated. |
| Core-producer and resolve memo inputs | enforced | Each input moved alone misses (I2). |
| Federated or core relations without `root` | accepted until relations carry `root` | Bound: in a multi-root run a statement over one refuses; a two-root seed. |
| Store growth from unreadable or foreign leases | accepted, counted | Bound: a same-machine lease from another boot is dead, so evictable; a pinned-bytes counter; a warning names `vat cache clear`. |
| Cost: stats, one per population file plus a fixed few | accepted, counted | Per file, never per byte; the pre-answer re-stat included. |
| Cost: full extent derivation | accepted, counted | Gated once the incremental extent lands. |
| Cost: whole-relation hydration | accepted, counted; gated if push-down lands | Rows stay within the bound extent. |
| Cost: lens evaluation decodes rows | accepted, counted | Gated once its core producer lands. |
| Cost: racy re-hash | accepted, counted | Bound: racy-granule entries re-hash every run; memo refreshed after the answer. |
| Cost: any edit to the contract closure refuses every plugin | accepted | Bound: a minimal closure, runtime imports confined (settled). |
| Cost: re-attempts (per-run failures; failures stored under a tighter limit) | accepted, counted | The refusal names the file. Rejected: persisting a per-run outcome (I6). |
| A pathological document hangs, exhausts the heap or overflows the stack in the parser | enforced for the crawl lanes' parse | One bounded worker per job, killed at its limit and replaced (I8): wall clock, heap, stack, output rows and bytes, input size, each with a kill-at-limit fixture; the run refuses that file, naming it and the limit, and keeps every other file's rows. Nothing persists (I6). |
| A process-wide heap flag (`--max-old-space-size` in `NODE_OPTIONS` or `execArgv`) lifts a worker's `resourceLimits` | enforced | The pool samples each worker's heap every 50 ms against `heapMb`; a child process run under a 4 GiB flag still stops at the heap limit. |
| The wall-clock limit includes a cold worker's first parser load | accepted | Bound: `timeMs` is set with headroom over the load plus the slowest measured parse ([limits](./fact-extractors-limits.md)); a breach is per run, so a slow start re-attempts next run. |
| A parse outside the two crawl lanes runs in-process, unbounded: `parseFileCached` and direct `parseMarkdown` calls in skill packaging (its link walk `walk-link-graph.ts` included), skill validators and the CLI | accepted until those callers move onto the pool | Bound: only the files a skill's link graph reaches, never the resources corpus; a hang there still blocks the run (I8 holds for the crawl lanes only). |
| A check or query answers at exit 0 over a corpus missing a parse-limited file | accepted until I1's absence refusal lands | Bound: the refusal is counted and named on stderr and in the blob refusal summary; the registry lane's finding is an error (exit 1). |
| Cost: a small cold corpus parses through one worker instead of the main thread | accepted, counted | Measured on 20 documents under load: the main thread waits ~200 ms more in total for the worker round trip than an in-process parse takes; wall time +0.9% to +17% min across A/Bs whose pairs disagreed ([limits](./fact-extractors-limits.md)). Rejected: keeping an unbounded in-process route for small runs (I8). |
