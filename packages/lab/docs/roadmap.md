# Roadmap

The lab is built in stages and is useful at each one. Nothing below is a commitment to build the
next thing before the last thing has earned its place.

## Vision

One tool that answers three questions with the same machinery, because they are the same question
asked along different axes:

- **Did vat get better, or faster?** — hold the project still, vary the vat build.
- **What moved upstream, and whose quality moved?** — hold the vat build still, vary the project version.
- **Where is vat wrong at scale?** — hold the vat build still, vary the project.

"Better" is not only speed. A skill-lint sweep that finds fewer false positives across 236 upstream
plugins is a quality delta measured exactly the same way a wall-clock delta is, and the same
comparator reports both.

## Stages

**Stage 0 — the envelope. Done.** The three-axis coordinate, the axis-movement rules, and the
refusals that keep incomparable reports apart. Every later stage writes into this.

**Stage 1 — the run harness.** How the lab obtains a vat to run: a working tree, a built `dist/`, or
a released version. This is axis C made real, and every facet depends on it. See
[Run harness](run-harness.md).

**Stage 2 — the `perf` facet. Done.** vat already captures `wallMs` per command and then deliberately
zeroes it, because the correctness oracle must not flap on timing. The fix is a *separate* perf
manifest with median-of-N, spread, warm/cold cache control, and a machine-load guard — leaving the
correctness artifacts byte-exact.

This traded places with the `io` facet, which was planned to come first. Timing was the number the
refactor in flight actually needed, and building it first paid for the shared run harness that `io`
then inherited.

**Stage 3 — the `io` facet. Done.** The `NODE_OPTIONS` preload counter, productised: fs and
child-process calls attributed by call site, with Node's own module loader bucketed out. This is the
N+1 detector. `vat-lab io run|compare` works end to end.

Two things it does differently from `perf`, both forced by the same measured fact — **io counts are
deterministic where wall time is not**:

- **The comparator uses exact equality, with no tolerance gate.** Verified on the real tool: two
  independent captures of the same three commands at the same coordinate produced identical counts on
  every row. Any difference is therefore a real difference, and a tolerance knob would only hide one.

  ⚠️ **That determinism is over the bytes on disk, and the coordinate does not pin all of them.**
  `subjectVersion` records a commit plus, for a dirty tree, a fingerprint of the *tracked* working
  copy. Untracked and gitignored content — scratch directories, local plan files, build leftovers —
  is invisible to the coordinate but perfectly visible to vat's filesystem crawl, so it can move the
  counts while every axis reads as unchanged. Two captures in one session on one machine agree
  because that content held still, not because it was pinned. **Cross-machine and cross-session
  comparisons assume a stable snapshot of the subject, and nothing in the report can currently tell
  you whether you had one.** Compare over a clean checkout when the delta has to be trusted.
  (Making this legible — an ignored-content fingerprint, or at least a warning — is open work.)
- **A capture compares its own repeats and reports whether they agreed.** `stable` is
  `true`/`false`/`null` — `null` when fewer than two repeats were compared, because below that nothing
  could have disagreed and determinism was never tested. A `false` or `null` blocks the comparator
  from claiming a delta: the numbers are still real, but an exact-equality difference has no warrant
  when the measurement is not known to be repeatable. `--runs 3` is the smallest run that tests it at
  all — one warm-up plus two compared.

Six measured facts shape it, and each one is a way the number can be a confident lie:

- **The loader dominates, so attribution is not optional.** On `vat resources scan docs/`, 6,371 of
  6,411 recorded calls come from Node's own ESM module loader. A raw total measures Node, not vat.
  The loader aggregate is still reported, because a reader must be able to tell "6,371 were bucketed
  out" from "there were only 40".
- **Patching the sync API alone misses most of the work.** The same command attributes 40 calls to
  vat when only `fs.*Sync` is counted, and 436 when the promise API is counted too — vat reads
  documents through `fs/promises`. A sync-only counter is precise and wrong.
- **`require('fs/promises')` and `require('fs').promises` are the same object.** Wrapping both
  double-counts every promise-API call. The counter dedupes by function identity.
- **`Error.stackTraceLimit` is a correctness setting, not a tuning one.** The attributor walks the
  stack for the first non-`node:` frame, so at V8's default of 10 the walk falls off the end of deep
  call chains and files the call under the loader. Measured on `vat resources validate docs/`: 333
  calls attributed to vat at limit 10, versus 2,348 at limit 16 — **2,015 of vat's own calls misfiled,
  a sevenfold undercount reported with total confidence**. Attribution saturates at 16; the counter
  uses 24 for headroom. Any stack-walking attributor must raise the limit and prove where it
  saturates, or its bucketing silently depends on how deep the call was.
- ⚠️ **A report merges every process, so `distinctArgs` cannot prove redundancy on its own.** The
  report states a `processes` count and nothing more, so a site reading `32 calls / 16 distinct` is
  ambiguous exactly when it matters most: one process reading each path twice, and two processes
  reading each path once, produce the identical row. That is the confound `distinctArgs` exists to
  detect, and the rendered report cannot resolve it. Measured on `vat audit .` at `119f4d5b`: five
  sites looked redundant, and only the raw per-PID dumps (`io-<pid>-<n>.json` under
  `VAT_LAB_IO_LOG`) showed all five living entirely in the worker process, with the launcher
  contributing 331 calls and none of them. The 2.00× rows were real — **but the report was not what
  established that.** Until a per-process view exists, treat any ratio near the process count as
  unproven and drop to the dumps. Do not fix code on the strength of a merged ratio alone.
- ⚠️ **`distinctArgs` reads the FIRST argument, and for some methods the first argument is not the
  work.** The N+1 argument — 66 reads of 66 files is necessary, 66 reads of one file is a bug —
  holds exactly while argument 0 identifies what was done. For `child_process` it never does: for
  `spawnSync(command, args, options)` argument 0 is the *binary*, and vat resolves git once through
  `which.sync('git')` and passes that same absolute path forever, so the distinct set is permanently
  `{'/usr/bin/git'}` however different the argv and the cwd. Measured on `vat audit .` at
  `119f4d5b`:

  ```
  packages/utils/dist/git-utils.js:60  child_process.spawnSync  count=8  distinctArgs=1  argsCapped=false
  ```

  — rendered as an 8.00× redundancy row, sitting beside rows where that shape means something real,
  and **structurally guaranteed to look that way for every spawn site whatever those spawns did**.
  `argsCapped: false` made it look exact, which made it worse; the row was very nearly reported as a
  vat defect on its own strength. The same shape reaches three `fs` cases where argument 0
  under-identifies the call: the two-path operations (`copyFile`, `cp`, `link`, `rename`, `symlink`
  — argument 0 is only the source, so one template copied to five destinations reads as 5×) and
  `mkdtemp`, whose argument 0 is a *prefix* every call shares by design.

  **The fix is to take no reading rather than a bad one.** `distinctArgs` is now `number | null`,
  and `null` means no reading was taken — the same distinction `stable` draws, and deliberately not
  the `0` that already means something else (a reading was taken, and no call carried a path).
  Neither the renderer nor the comparator will produce a ratio or a delta from it. Keying the set on
  a composed identity instead (command + argv + cwd) was rejected: the counter would be *guessing*
  at what identifies a spawn — cwd is optional, `shell` and `env` change what a command means — and
  a subtly wrong identity is a subtly wrong redundancy claim, which is the failure being fixed.
  Costs: **every report captured before this change must be re-captured**. The refusal that enforces
  it is the strict schema on each side, run against the *build reading it* rather than only against
  the other side — which is what stops a pair of pre-change reports, agreeing with each other
  perfectly, from being read with the new meaning. ⛔ The `dumpVersion` and `facetVersion` integers
  that used to enforce it are gone; see [facets.md](facets.md) and `envelope/envelope.ts` for why
  they were the weaker mechanism, and `readIoBody` in `io/compare.ts` for the one residual this
  particular change leaves — `distinctArgs` becoming nullable moved MEANING and not shape, so no
  schema can see it and the remedy is a declaration rather than a number.

It counts **Node `fs` and `child_process` calls, not kernel syscalls** — dtrace is blocked by SIP for
system binaries on macOS and `strace` is Linux-only, so the Node boundary is the portable place to
measure. The distinction is not pedantry: one `fs.readFile` is not one syscall, and labelling these
syscalls would overstate what the lab can see.

**Stage 3.5 — the `parse` facet.** Sub-phase attribution, read from a timing seam inside vat rather
than injected by the lab. It exists because of a measured cost: a regression hunt over vat's markdown
parse took **24 cold measurement runs** of delete-and-re-time bisecting, because `perf` could say the
command got slower and nothing could say which pass did. The seam brackets each pass plus the whole
function, so `total − Σ(passes)` is published as an **unattributed remainder** — the number that says
whether the breakdown is a complete explanation or a partial one.

Three things it does differently from both older facets:

- **It defaults to a cold cache, and that is not a preference.** vat's parse cache short-circuits
  `parseMarkdownContent` entirely on a hit, so a warm run produces a dump with zero pass invocations.
  Sub-phase attribution exists **only on cache misses**. A warm capture is a well-formed body full of
  zeroes that reads as "parsing is free", which is why `--cache` now has a per-facet default.
- **It distinguishes four zero-states rather than reporting one zero.** No dump at all (the build has
  no seam — the state every A/B baseline arm is in) is a refusal; every document a cache hit,
  cache misses that went to the uninstrumented HTML parser, and a command that never reached the
  parse path at all are three further states that produce identical numbers and support opposite
  conclusions. Each renders as its own sentence.
- **It discards no repeat.** `io` drops repeat 0 as a warm-up because it wants the steady state; here
  repeat 0 is, in `warm` mode, the *only* repeat that parses anything.

⚠️ **`documents.count == cache.misses` is not an invariant**, in either direction, and nothing in the
facet derives one from the other. The cache counts every parser kind while the passes count markdown
only, so HTML work inflates misses with no matching documents; and several call sites reach the
markdown parser directly without consulting the cache, so documents can exceed misses too. The hit
rate is therefore rendered as `hits/(hits+misses)` and labelled as covering all parser kinds — never
as a per-document rate.

**Stage 4 — the `sweep` facet and the corpus registry.** Absorbs `vat corpus scan` and the 236-entry
seed. Subjects tracked on moving refs; every observation stamped with the resolved commit.

**Stage 5 — the `calibrate` facet.** Absorbs the `compat-empirical` harness: what real runtimes do,
against what vat statically predicts.

**Stage 6 — the comparator and report rendering.** The user-facing half: given two reports, refuse or
diff, and render the delta for a human.

**Stage 7 — the CI self-test, and history.** CI runs the lab against a pinned corpus on every merge
and records the report, so movement over time becomes visible rather than anecdotal.

The history does not have to start empty. Reconstructing it is a vary-C sweep: check out past
commits, build each, and run today's lab against the same pinned corpus. The reports carry the
instrument commit, so a reconstructed series and a live one are the same kind of data and sit in the
same chart. Two properties make that work, and both are already decided:

- The instrument axis records a **commit**, not just a version — so builds sharing a semver stay
  distinguishable, which is exactly the case across a run of historical commits.
- The subject is **pinned at observation time**, so a reconstruction over a corpus that has since
  moved still produces reports pinned to what was actually measured.

Reconstructed points must be **labelled as reconstructed**. They were measured on today's machine
under today's load, not on the machine of the day, so they are comparable to each other but not to a
contemporaneous reading. A series that silently mixes the two is worse than one that starts short.

**Later** — context analytics and discoverability facets; graduating the package to published.

## Deliberately not yet

- **Publishing.** The package is publish-shaped and `"private": true`. It graduates when the CLI
  contract stops moving, not before.
- **Splitting into sub-packages.** Plausible later — `lab-perf`, `lab-sweep`. The structure is built
  so the seam is cheap (see [Facets](facets.md)), but splitting before there is a second consumer
  buys nothing.
- **An adopter-facing "why is vat slow on my repo?" diagnostic.** Real demand, different product: it
  wants user-shaped output and a stability promise. It should grow as a flag on the real vat verbs,
  and must not be grown out of the contributor instrument.

## How to add to this backlog

A stage earns its place when there is a question someone actually asked that the lab cannot answer.
Record the question, not the feature — the feature follows from it, and a backlog of features
without questions is how tools grow surfaces nobody uses.
