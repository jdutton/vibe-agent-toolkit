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

Four measured facts shape it, and each one is a way the number can be a confident lie:

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

It counts **Node `fs` and `child_process` calls, not kernel syscalls** — dtrace is blocked by SIP for
system binaries on macOS and `strace` is Linux-only, so the Node boundary is the portable place to
measure. The distinction is not pedantry: one `fs.readFile` is not one syscall, and labelling these
syscalls would overstate what the lab can see.

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
