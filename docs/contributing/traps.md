# Traps — failures that look like something else

A trap is a failure whose first reading is wrong: the gate says green and nothing ran, the test says
red and the code is fine, the number is precise and measures the wrong thing. Each entry names the
trap, the **tell** that identifies it, and the **remedy**. Add one whenever a session loses time to a
mechanism that will bite the next person; keep it to the mechanism (no session logistics, no
adopter names, no one-run numbers unless the number is the tell).

Where an entry names a rule, the rule is in the root [`CLAUDE.md`](../../CLAUDE.md); this page
holds the *why it looks like something else*. Routing for other kinds of statement:
[`content-routing.md`](content-routing.md).

## The gate

### `vv validate` and the pre-commit hook replay a cached failure as if it ran

vibe-validate caches red as well as green. After a flaky failure, a bare `vv validate` (or the
pre-commit hook, which never forces) returns the identical failure — same `durationSecs`, same
output paths — with `isCachedResult: true`, having executed nothing. Worse, a replayed red can
print `❌ Validation failed` and still **exit 0**. `bun run validate` is exempt: it always carries
`--force`.
**Tell:** a duration identical to the previous run, or near zero; `isCachedResult: true` in the YAML.
**Remedy:** `bun run validate` (never bare `vv validate` for a verdict); run the failing file alone
to get its real cost before touching any timeout.

### `--force` busts vibe-validate's cache, not turbo's

Every test step is `turbo run test:*`, and turbo caches independently. `vv validate --force` can
report `GATE_EXIT=0` with all three test phases replayed and zero test processes started.
**Tell:** per-phase durations — integration or system tests "passing" in under a second.
**Remedy:** `bun run test:unit -- --force` (and the other tiers) and read `Cached: 0 cached`; a real
unit run is minutes, not seconds.

### `Cached: 0 cached` says nothing about ordering

Turbo's `dependsOn: ["^build"]` means dependencies' builds only, never the package's own. Without
the package's own `build` in the list, `cli#test:system` runs against yesterday's `dist/` while the
gate reports every task executed fresh. The cross-package case — `resources`' system tests spawning
the `cli` binary — turbo cannot express at all.
**Tell:** dozens of system-test failures whose messages describe code that was deleted hours ago.
**Remedy:** grep the log for the build's line number versus the test's before believing a
system-test verdict; `bun run build` before a standalone system run.

### A wrapper's exit status is never the gate's

`bun run validate 2>&1 | tail` reports `tail`'s status; a script ending in `echo "EXIT=$?"` reports
the `echo`'s. A failed gate arrives as "completed (exit code 0)".
**Tell:** wall-clock far below a real run; a status that disagrees with the log's own `failedStep:`.
**Remedy:** `bun run validate > "$LOG" 2>&1; echo "GATE_EXIT=$?"` and read the marker *inside* the
log, never the wrapper's status.

### A stored verdict belongs to a tree hash, not to a timestamp

A log's `EXIT=0` proves a run passed on the tree it ran on. Comparing changed-file mtimes to the
log's finish time cannot decide whether that is your tree — a file touched during a six-minute run
is older than the log and still inside it.
**Tell:** you are about to commit on a verdict you did not watch finish.
**Remedy:** `bun run vv snapshot` prints the working tree's hash and its stored verdict; match it to
the `🌳 Working tree:` line in the log. Equal hashes is the proof.

### A second vitest in the same worktree reds the cache tests

vibe-validate's nested-cache tests key on the working-tree hash; any concurrent writer into the tree
(a second vitest's output dirs, coverage) turns a hit into a miss. The failing subset varies run to
run.
**Tell:** `expected undefined to be true` on `isCachedResult` with a different set of tests each
time; 34/34 when the file runs alone.
**Remedy:** never run two suites at once in one worktree; re-run the file alone before diagnosing.

### `openPopulationCache()` returning `undefined` is "the cache declined", not "the hashes differ"

Under parallel unit-test load the first call can return `undefined` (the git tree-hash call did
not answer) while the second keys fine; `expect(first?.cache.treeHash).toBe(...)` then reads as a
value mismatch.
**Tell:** `expected undefined to be '<hash>'` on the left of a cache assertion; 20/20 in isolation.
**Remedy:** read an `undefined` there as a keying refusal; re-run with `--force`; the fix, if it
recurs, is to make the function distinguish "no store selected" from "keying failed".

### `pgrep -f` matches the loop that is waiting

`until ! pgrep -f "bun run validate"; do sleep 15; done` never exits — the pattern is an argument
of the waiter's own command line.
**Tell:** a wait loop still spinning while the log's final line is present.
**Remedy:** capture `PID=$!` and `while kill -0 "$PID"`, or run the job in the background and let
the harness notify.

### A CI failure with no error text is a rerun candidate

Turbo emits a task's output as one group on completion; a task killed by the runner prints nothing
but `script "build" exited with code 1`.
**Tell:** no `error TS…`, no failure summary, one platform only, the sibling platform green on the
same commit.
**Remedy:** `gh run rerun <run-id> --job <job-id>` before reading a line of code; only a reproduced
failure is a defect.

### A gate step's verdict can vanish from the CI log

vibe-validate captures a failed step's output to files and summarises it through an extractor that
keeps only lines carrying an error keyword (`error`, `failed`, `at `, a `file.ts:12` reference). A
verdict without one — `NEW unused export: …`, `STALE allowlist entry: …` — is dropped, and the log
ends at `script "unused-exports" exited with code 1`. Three STALE entries once surfaced only because
the export NAMES contained `Error`; the next round's did not, and the same job reported nothing.
**Tell:** `errorSummary` in the YAML state is bun's one "exited with code" line, with `durationSecs`
showing the step ran.
**Remedy:** the validate workflow's `Print failed step output` step (`bun run
print-failed-step-output`) prints every capture verbatim after a failure; read that block, never the
summary.

### The coverage thresholds were seeded on the wrong platform

`vitest.config.ts` thresholds were written by `autoUpdate` from a local macOS/Node 24 run, and the
`coverage.yml` job that enforces them runs Linux on the Node floor, which counts different branches:
77 % locally was 76.99 % there, and no local run could reproduce the red.
**Tell:** `Coverage for branches (76.99%) does not meet global threshold (77%)` in the coverage job
only, green locally.
**Remedy:** the job is the only writer (`COVERAGE_RATCHET=write`) and fails on its own diff when a
threshold can rise — seed from its "All files" row, never from a local number.

### The duration ratchet reports one package per CI run

Turbo runs every package's unit tier in parallel and kills the rest (`exited with code 130`) the
moment one package's budget reporter fails, so a run that carries six files over budget reports
one. Seed it, push, and the next run reports the next — one CI round per file. The parallel
runner also measures a hover file at 3–9× its serial time, so the red names a file that does no
more work than before.
**Tell:** `OVER BUDGET` for exactly one file while the printed capture shows other packages'
`✓ … NNNNms` lines above the budget; `exited with code 130` for the packages that never reported.
**Remedy:** read every `✓ … NNNNms` line in the printed unit capture and list every unlisted file
over the budget in one change. Seed each at `max(alone, turbo / 4)` with both readings in the
`note` — an entry seeded from the turbo number alone trips the stale line (a tenth of it) on the
next fast local run, which is the mirror failure. Do not seed from one round's single verdict.

### A hook timeout is decided on the timer side

vitest decides a `beforeAll`/`afterAll` timeout on its own timer; the hook's `try/catch` never sees
it. Raising `hookTimeout` guesses against an unbounded quantity (Windows scheduling plus antivirus
per unlink), and `rm(..., { maxRetries })` adds backoff to a failure that was slow, not fast.
**Tell:** all assertions pass, the hook times out, Windows only, a scratch dir that deletes in
milliseconds when idle.
**Remedy:** `removeScratchDir()` from `@vibe-agent-toolkit/utils/testing` races its own timer inside
the hook budget; every unit-tier teardown uses it.

### Reproduce CI by scrubbing `claude` from `PATH`

CI has no `claude` binary. A test that drives the skill-test harness without stubbing preflight
shells out to `claude --version`, passes on a developer machine, and exits 2 on CI.
**Tell:** green locally, exit 2 in the first CI minute, only on harness tests.
**Remedy:** stub preflight (`packages/agent-skills/test/skill-test/preflight-stub.ts`); before
reporting green, run the whole gate with the directory holding `claude` removed from `PATH`. And
never assert on wording a subprocess (git, the network) produced — only on what VAT emits.

### Reproduce a Linux-only filename red on macOS with a case-sensitive image

APFS is case-insensitive by default, so a fixture whose spelling differs from the path under test
passes locally and reds only on the ubuntu runner.
**Tell:** ubuntu red, macOS green, anything filename-shaped in the assertion.
**Remedy:** `hdiutil create -size 512m -type SPARSE -fs 'Case-sensitive APFS' -volname CSTMP
cstmp.sparseimage && hdiutil attach cstmp.sparseimage -mountpoint "$PWD/csmnt"`, then
`TMPDIR="$PWD/csmnt" bunx vitest run <file>` — every `normalizedTmpdir()` fixture lands on the
case-sensitive volume with no test change.

### A POSIX-absolute literal is not absolute on Windows

A fixture root written as `'/proj'` has no drive letter, so `safePath.resolve('/proj', x)` on the
Windows runner yields `D:/proj/x` and every expectation spelled `/proj/...` fails there and only
there. Nothing local reproduces it, and a Windows run that dies at an earlier gate step hides it
until that step is green.
**Tell:** Windows-only red whose diff is the same path with a drive prefix on the received side.
**Remedy:** build the root from the real temp root — `safePath.join(normalizedTmpdir(), '<name>')`
— and derive the expectation with `safePath.join(root, …)`, never a template literal. Model:
`packages/resources/test/okf/config.test.ts`.

## Builds and `dist/`

### `tsc --build` emits `dist/` despite type errors

There is no `noEmitOnError`, so a package with a type error still writes fresh output. A consumer
package's tests then run against a `dist/` nobody chose.
**Tell:** a non-zero `tsc` exit followed by a green (or red) cross-package result.
**Remedy:** a passing build is a precondition for any consumer-package test; if `tsc` errored, the
consumer result is uninterpretable. Restoring a file with `mv` also skips the rebuild — rebuild
explicitly after any revert.

### Vitest resolves a cross-package import to the other package's `dist/`

There is no `resolve.alias` for workspace packages, so `@vibe-agent-toolkit/agent-skills` imported
from `packages/cli/test` is the built `dist/`. A source change — or a deliberate mutation — is
invisible to another package's tests until `bunx tsc --build <pkg>` runs. The mirror image is worse:
a test can keep pinning a bug you fixed months ago, because its `dist/` never moved.
**Tell:** a standalone cross-package run is green right after a schema or barrel change.
**Remedy:** `bunx tsc --build packages/<pkg>` before trusting any cross-package result, and say so
in the writeup. A green standalone cross-package test is evidence the *stale artifact* is
compatible, nothing more.

### `tsc --build` never prunes output for a deleted source

Incremental `--build` (and `--clean`) leaves an orphaned `.js` behind when its `.ts` is deleted;
turbo then bakes the orphan into a cache blob that replays forever, even across `rm -rf dist`. A
second shape is a 0-byte emit of a file that still exists.
**Tell:** an import of a symbol that no longer exists resolving anyway; `find packages -path
"*/dist/*" -name "*.js" -size 0` non-empty.
**Remedy:** every package `build` routes through `tsc-clean-build.ts` (rimraf first);
`turbo run build --filter=<pkg> --force` overwrites a poisoned blob.

### A relative-path build script is invisible to turbo's graph

`"build": "tsx ../dev-tools/src/tsc-clean-build.ts"` imports `@vibe-agent-toolkit/utils` at run time,
but turbo's task graph only sees `package.json` dependency edges, so `utils#build` is not guaranteed
to finish first.
**Tell:** an intermittent `does not provide an export named …` for a symbol that exists, in one
workflow and not another on the same commit.
**Remedy:** the dependency the script needs must be a manifest edge; treat a build race between two
workflows on one commit as scheduling, not language.

### `bun run` uses a different shell on Windows

With `&&` in a script, `bun run` delegates to a POSIX shell on macOS/Linux and to Bun's own shell
on Windows; the two disagree on an unmatched glob (POSIX passes the literal through, Bun errors
`no matches found`).
**Tell:** a `build` script green on macOS, Linux and a cold local build, red on Windows CI in the
first two minutes.
**Remedy:** quote globs in scripts and pass `rimraf --glob` explicitly; only Windows CI can see
this.

### The `vat` wrapper picks its binary from the cwd, not from its own path

`packages/cli/dist/bin/vat.js` is a context-detecting wrapper: cwd inside a VAT repo → that repo's
`bin.js`; cwd with `vibe-agent-toolkit` in `node_modules` → the packaged copy; neither → the global
install. An absolute path to a worktree's wrapper run from the main checkout executes the main
checkout's build, with no banner.
**Tell:** "the fix didn't work" and "the fix works" from two cwds; a missing subcommand that the
worktree definitely has.
**Remedy:** invoke `packages/cli/dist/bin.js` directly to verify a change; `VAT_DEBUG=1` prints
`Context: dev|local|global`. Vary cwd or binary, never both.

### The Bash tool's cwd persists — and is sometimes reset to the main checkout

A `cd packages/x` silently invalidates every later repo-root-relative search (zero hits reads as
"does not exist"). In a worktree session the harness also resets cwd to the **main** checkout after
some calls; a relative `turbo run build` then rimraf'd main's `dist`, and a bare `git` answers about
a different branch's history, confidently.
**Tell:** a sweep returning 0 hits for something edited minutes ago; a build error naming a path
outside your worktree; git numbers that disagree with an instrument you trust.
**Remedy:** prefix every command with an absolute `cd`; `git -C <abs-worktree>`; before anything
destructive, `pwd && git rev-parse --abbrev-ref HEAD` in the same call.

### Turbo's strict env mode makes every `VAT_*` selector inert

`turbo.json` runs in strict env mode, so a `VAT_*` variable set in the shell never reaches a vat
process spawned by a turbo task unless it is declared in `globalEnv`. An A/B arm selected that way
through `bun run build` measures the default arm and looks clean.
**Tell:** two arms with identical output; `turbo run build --dry=json` shows `"passthrough": null`.
**Remedy:** declare the selector in `globalEnv` (hashed — `passThroughEnv` would let arm A's cache
serve arm B); prove reachability with the runner's dry-run, not its docs.

### `vitest.setup.js` strips every `VAT_*` / `VV_*` variable

The setup file deletes them before any test loads (allowlist: `VAT_SKILL_TEST_E2E`), so an
env-driven negative control is a green that disabled nothing.
**Tell:** `VAT_CACHE=0 bunx vitest run <file>` passes tests that assert cache hits.
**Remedy:** drive test controls through constructor options (`new ParseCache({ enabled, env })`),
never `process.env`; confirm a control's positive twin is non-zero before trusting its negative.

### The projection store needs two switches, and file size is not a tell

`VAT_PROJECTION_STORE=sqlite` turns the store on; `VAT_RESOURCES_CRAWL=projection` selects the lane
that produces a projection. One without the other brackets a crawl with nothing to store: zero
rows, exit 0, a schema-only `projection.db` that looks like a working cache, and pure overhead. The
store lives at `<normalizedTmpdir()>/.vat-cache/<namespace>/`, not under the project.
**Tell:** a `.db` file of exactly schema size; a "cache" that never changes a timing.
**Remedy:** before believing a null result from a feature, enumerate every input the feature is
AND-ed behind; proving one switch took effect proves nothing about the ones you did not set.

### `--no-cache` must reach every cache, and a store must evict

`VAT_CACHE=0` / `--no-cache` once bypassed the parse cache and still wrote the projection store; and
the store, keyed on the whole-repository tree hash, grew by a full extent per edit with nothing
reclaiming it. `projectionStoreSelected()` now vetoes on `VAT_CACHE === '0'` (compared exactly, never
truthily), and `writeExtent` prunes to the three most recent trees per root inside its own
transaction — a TTL would have reclaimed nothing, since every extent is minutes old.
**Tell:** a cache directory growing on every edit; a `.db` written under `--no-cache`.
**Remedy:** a new cache joins the existing veto and the existing eviction; `auto_vacuum` is set
before the schema is created or it never applies.

## Tests that prove nothing

### A fixture that cannot distinguish the two answers

When two lanes answer one question differently, every fixture where the answers coincide makes the
suite blind on that axis — sixteen passing install tests could not tell "frontmatter `name`" from
"directory leaf" because every fixture named the directory after the skill. Scale does not help: a
265-file corpus with 2 reference links cannot observe a reference-ordering break.
**Tell:** a test comment that explains away a surprising value ("the directory is named X, not Y").
**Remedy:** name the two competing answers, grep the fixtures for a case where they differ, and
write it first — that is the failing test. Assert the inverse too.

### A fail-closed fix makes the neighbouring positive test vacuous

Widening the set of inputs that answer "yes" (fail closed, error, conflict) means every existing
test whose expected answer is "yes" stops discriminating — the fix satisfies it for free.
**Tell:** a suite that gets greener after a hardening change with no test added.
**Remedy:** after any change that makes a predicate answer "yes" more often, grep for positive
assertions of that answer and give each a paired negative or move it inside the region the blanket
does not cover.

### A test written from a reviewer's diagnosis can guard nothing

A reviewer's finding has two parts — the class and the mechanism — and they fail independently. A
test written from the stated mechanism (a `.strict()` rejection echoing a key) passed with the
sanitizer deleted, because the schema was `.passthrough()` and the real route was zod's enum error
quoting the received value.
**Tell:** the new test stays green with the fix reverted.
**Remedy:** execute the route against `dist` before writing the assertion; always run the reversion
and state how many tests it reds.

### An absence pin must name the route the deleted code used

`expect(fsCache.probeStats).toEqual({ probes: 0 })` was true before the deletion too — the package
had never called `probe()`; the deleted line used `fs.stat`. And a mutant written as a dynamic
`import()` misses a `vi.spyOn` on the default export's property.
**Tell:** the pin is green at the pre-change commit.
**Remedy:** `git grep <observable> HEAD -- <package>` before writing the pin; restore the deleted
code in its original idiom and watch the pin die.

### A round-trip oracle cannot prove the cache ran

Two correct full populations of an unchanged tree produce identical documents, so a byte-identical
export diff stays green under a store that never hits.
**Tell:** mutating the store to always miss leaves the "cache" test green.
**Remedy:** assert the trace of *not working* first (`contributorRuns` `toEqual([])`, a counter at
zero), then the document diff; confirm by mutation which assertion goes red.

### A reuse key is blind to ambient inputs

The projection store's reuse key covered contributor id and declared parameters; the git tracker
and `VAT_EXTENT_SOURCE` arrive through ambient context, change the rows, and appear in neither —
two runs ask one question and get each other's answer.
**Tell:** a false cache hit after changing something the API did not name.
**Remedy:** for every input, ask "would two runs differing only in this produce different rows?";
anything that answers yes belongs in the key.

### `vi.mock('node:child_process')` stops applying once the spawn moves into a dependency

Vitest externalizes `node_modules`, so a mock on a Node builtin reaches first-party files only.
After consolidating a spawn into an npm package, seven of ten tests stayed green while real
subprocesses ran; only the call-count assertions noticed.
**Tell:** a unit test that got slower (331 ms → 5 ms after the fix); only `mock.calls.length`
assertions failing.
**Remedy:** re-point the seam at your own chokepoint module, never force the mock deeper.

### A monkey-patch cannot see a named ESM import

`import { spawnSync } from 'node:child_process'` binds the function at import time; patching the
module object afterwards intercepts nothing, and an instrumentation pass reported filesystem I/O as
the whole cost of a run that was 88 % `spawnSync`. The same applies to fs counters: patch sync,
callback, promise and `child_process` APIs, dedupe wrap targets by function identity
(`fs.promises.readFile === require('fs/promises').readFile`), bucket `node:internal` loader frames
out but report them, and raise `Error.stackTraceLimit` (the default misfiles most user frames as
loader).
**Tell:** a precise attribution that does not move when the suspected code is removed.
**Remedy:** `--cpu-prof` for attribution; the lab's `io` facet for fs counting.

### A `toContain` prefix assertion narrows when a column is appended

`toContain('a\tfalse\tfalse\t-')` written to pin two fields kept passing after two columns landed
between them — now covering different fields than the test is named for.
**Tell:** a tab- or column-structured assertion that survived a format change untouched.
**Remedy:** assert the whole rendered line (`rendered.split('\n')` contains `line`).

### Test files are not typechecked

Every package `tsconfig.json` includes `src/` only, and `vitest --typecheck` is configured nowhere,
so `expectTypeOf` and any compile-time assertion in a test is inert, and a test helper can keep
building an old shape after fields become required.
**Tell:** `.toBeNumber()` on a string field passes; the IDE flags what the gate does not.
**Remedy:** treat a fixture helper as unchecked construction; a runtime assertion on the rendered
value is the only one that fires.

### A conditional spread defeats the excess-property check

TypeScript checks excess properties on a fresh object literal only; `{ ...(cond ? {} : { oldName })
}` carries a renamed key through `typecheck` unflagged, and the consumer reads `undefined` — a
detector silently unarmed, reporting clean.
**Tell:** a rename with zero compiler errors at the producer.
**Remedy:** grep for the old name and expect zero hits; add `oldName?: never` to the type as a
tripwire; assert the signal is *armed*, not merely that nothing failed.

### `Math.max(1, x)` is not a floor when `x` can be `NaN`

`Math.max` propagates `NaN`, and every comparison against `NaN` is false, so a "floored" threshold
becomes no threshold: `misses < NaN` never gates. `if (size < 1) return` likewise passes `NaN`
through and builds a pool of `NaN` workers.
**Tell:** a clamp in the path of a value parsed from env or config.
**Remedy:** validate with a predicate the value must pass (`positiveWhole`), fall through to the
default on refusal, and delete the stored raw value so a later reader cannot reach it.

### `String.prototype.trim()` on git stdout corrupts NUL listings

git sorts by byte value and `0x20` sorts first, so a path beginning with a space is the first entry
of `ls-files -z` — exactly where a leading trim reaches it; `show HEAD:file` loses its trailing
newline. `ls-files -s -z` is immune (mode digit at position 0), which is why the headline function
looked fine.
**Tell:** a file "not there" that `ls` shows; content one byte short.
**Remedy:** a wrapper's normalisation is opt-out per call; test with a fixture whose first path
starts with a space.

### `spawnSync`'s 1 MiB `maxBuffer` truncates without failing

A small overrun leaves `status: 0` with truncated stdout and `error: ENOBUFS`; only a large one
kills the child. `success = status === 0` returns a partial file list marked successful, and every
consumer reads the missing paths as "not there". `git ls-files -s -z` is ~104 bytes per path, so an
8,500-file tree sits at 84 % of the cap.
**Tell:** enumeration results that shrink on large trees only.
**Remedy:** pass an explicit `maxBuffer` for output that scales with the tree and always check
`result.error`; test by shrinking the cap, not by growing the tree.

### `shell: true` launders a missing binary into exit 1

With `shell: true` the spawn target is `cmd.exe`, which exists, so a missing `tsx.cmd` (bun writes
no `.cmd` shims) raises no `ENOENT` — the shell exits 1 and the harness reports `build exited 1`,
byte-identical to the compiler rejecting the fixture.
**Tell:** a harness-shaped failure on one platform since the day the test landed.
**Remedy:** spawn without a shell so the harness can fail in its own voice; resolve bin shims by
what the package manager actually writes.

### A raw NUL byte makes the file invisible to grep

Writing `\0` as a real byte instead of the two-character escape makes git and ripgrep classify the
file as binary; every grep-based sweep skips it silently, including the ones looking for exactly this.
**Tell:** zero hits for text you can see in the editor.
**Remedy:** write the escape; `cat -v` a suspect file; `validate-structure` Rule 9 catches it — a
gate that exists is not a gate that ran, so run it.

### A shared `--include` filter makes N checks one check

Five independent verifications of a rename all inherited `grep --include='*.ts'` from the plan;
the stale field lived in a `.mjs` child-process script that no TypeScript project compiles.
**Tell:** unanimous zeros from checks that share a filter.
**Remedy:** the completeness sweep for a rename is `git grep -n "<symbol>" -- .` — every tracked
file, no filter.

### A before/after diff of the shared tmpdir reads a sibling worker's files as your leak

`os.tmpdir()` is one directory for every process; a parallel vitest worker's transient
`vat-ws-build-*` appears in the after-listing as the subject's leak.
**Tell:** a leak test that flakes only under the full gate.
**Remedy:** `vi.stubEnv('TMPDIR', privateDir)` (+ `TEMP`/`TMP` on win32) so the subject's tmpdir is
its own, and filter to the subject's own prefix.

### An existence-only cache guard races every concurrent first user

`ensureModelFiles` guarded a machine-wide model cache by existence; N cold starters all downloaded
and all `writeFile`d onto the same path, and a reader in the window got a truncated model —
surfacing as ONNX's unrelated-looking `protobuf parsing failed`. CI is cold on every run; the dev
machine is warm, so local `validate` can never reproduce it.
**Tell:** two readers of one artifact disagree in the same run (seven tests fail, three siblings on
the same path pass) — the artifact is being written, not delivered wrong.
**Remedy:** publish atomically (sibling temp → `rename`); refuse a body shorter than
`content-length`.

### Write the marker your change detector reads last

The indexer wrote chunks per resource and flushed document rows after the loop; an interruption
left chunks whose hash matched, so change detection skipped those resources forever. And a forward
fix repairs no database already on disk.
**Tell:** resources present in one table and absent from its companion, never re-indexed.
**Remedy:** the write that answers "is this already done?" is the final write for the unit of work;
ship a detector for the corrupt shape alongside the ordering fix.

### A defaulted parameter is the no-op

Retrofitting a fix behind `param = []` leaves every existing caller on the old behaviour; tests
pass, `tsc` is clean, and nothing in the product changed.
**Tell:** "which call site now behaves differently?" has no answer.
**Remedy:** make the parameter required at internal boundaries; a caller with nothing writes `[]`
where a reviewer can see it. Pre-1.0 forbids the shim anyway.

### A documented remedy is not believed until it is run end to end

Three documented escape hatches on one PR were non-functional — a `files:` entry that also stripped
the link, a `severity: ignore` that no lane honoured, a lane whose detector could not fire — and
none was caught by review, a green suite, CI or Sonar.
**Tell:** a fix string that tells the user to do something nobody has done against a built artifact.
**Remedy:** run the remedy against `dist`, observe the result, and for every guard break the
production code and watch the test go red.

### A notice on stderr is not a finding

A build that dropped two files from a bundle wrote `warning:` to stderr and reported
`status: success, warnings: 0` in the YAML — the machine-readable contract said clean. Deleting the
stderr line left every test green.
**Tell:** a human-visible line with no counterpart in `issueCounts`.
**Remedy:** anything worth telling a human is a `ValidationIssue` through the findings channel;
raw stderr is for progress chatter only.

### A green corpus tool can be blind to the file you changed

Four of the five enumeration lanes answer from `git ls-files`; an untracked file is enumerated by
nothing, so a snapshot → refactor → snapshot comparison reports "identical" over a genuinely
changed tree. `inventory` is the lane that does see untracked files, so the lanes legitimately
disagree there.
**Tell:** exit 0 and "all artifacts identical" after adding a file.
**Remedy:** ask whether the thing you changed is in the population the tool can see — a red test
whose mutation lands outside the population is a second green. The instrument warns on untracked
files rather than widening the crawl.

### A keyword scan cannot define a gate's population

A predicate matching "counts" classified three broken lanes as conforming (one match was a prose
comment); counting `eslint-disable … local/` directives with a tree-wide grep included the prose
that discusses them.
**Tell:** a verdict derived from a regex over source text.
**Remedy:** the scan guards completeness only (over-inclusive is safe); hand-verify each row; assert
the ratchet both ways and detect stale rows.

### Measure a gate with its own matcher, never with grep

The contraband scanner matches word, slug and phrase forms against normalised candidates; a
`grep -iE` alternation does unanchored substring matching and invented a hit inside
`es-object-atoms` in `bun.lock`.
**Tell:** a count from a re-implementation of a matcher the repo already ships.
**Remedy:** build the package and drive the exported pure function (`scanTextForContraband`) over
`git show <ref>:<file>`; print counts only.

### A hand-rolled Linter probe silently matches no config

`new Linter().verify(code, config, filename)` returns a confident zero when `files: ['**/*']` does
not opt in `.ts`, or when the filename is absolute and outside the Linter's cwd.
**Tell:** a message with `ruleId: null` ("No matching configuration found").
**Remedy:** assert a positive control first, throw on any `ruleId: null`, and copy the config shape
from `packages/utils/test/eslint/`.

### `meta.fixable` is a capability flag, not a promise

`@typescript-eslint/no-unused-vars` declares `fixable: 'code'` and emits only a *suggestion* for an
unused import; `--fix` never applies suggestions, so a converged `--fix` leaves the orphan.
**Tell:** errors surviving a `--fix` that "should" have cleaned them.
**Remedy:** a rule that created an orphan removes it itself; do not build a general
side-effect-aware unused-import rule (`sideEffects` is absent by default and ignores `node:`).

### A scripted edit can print `ok` and write nothing

A heredoc that appended tests printed its own `ok`, left the file untouched, and the suite reported
the pre-existing count green; three mutations then "passed" against tests that were never there,
which reads as a test-quality problem.
**Tell:** `git status --short` does not list the file you believe you changed.
**Remedy:** make the script read the file back and assert the new symbol landed; `git status`
before trusting any result from a scripted edit; absolute paths in every heredoc.

### A module that becomes both a definition site and a barrel loses the barrel

`packages/utils/src/testing.ts` was one line, `export * from './test-helpers.js'`; a session adding
a definition overwrote it, and a published subpath silently lost every helper. The 20 red tests were
in another package; `utils` stayed green. The same edit left a duplicate `"./testing"` key in
`package.json`, which JSON tolerates.
**Tell:** `TypeError: <helper> is not a function` in another package's `afterEach`.
**Remedy:** before adding to a file whose body is `export *`, append — never rewrite; re-run
`packages/utils/test` after any `utils/src` edit; `grep -c '"\./<name>"'` after adding an exports
entry.

### Every published barrel surface is pinned in both directions

Each of the 20 published packages with a `.` barrel has a `test/barrel-exports.test.ts` that
compares the runtime export set against a recorded list through `findBarrelDrift`
(`packages/dev-tools/src/pin-barrel-exports.ts`): adding an export fails it, not only removing
one, and the recorded list must be in CODE-UNIT order (`compareCodeUnits` — uppercase before
lowercase), not `localeCompare`.
**Tell:** a `BarrelDrift` object with non-empty `added`, `removed` or `unsorted` on a package you
barely touched.
**Remedy:** `added` → add the name in code-unit order (or move the export to a subpath); `removed`
→ restore it or record the breaking change; `unsorted` → reorder. Run the one-test file before a
full gate.

### Deriving a list from an upstream package costs a pure subpath its purity

Replacing a duplicated git-env key list with a derivation from `@vibe-validate/git` dragged that
package behind the dependency-free `./testing` subpath; `subpath-purity.test.ts` caught it. The first
drift test compared the list with itself.
**Tell:** a purity test red after a "tidy" de-duplication.
**Remedy:** keep the copy; pin it with a drift test that sets a declared *superset* and asks the
real scrub what it removes.

### Editing an agent-facing skill reds a golden drift test in the last phase

`packages/vat-development-agents/test/golden/` is the approved packaged output of every skill; a
one-word description change fails `packaged-output-drift.system.test.ts`, which runs only in the
final validate phase, and the test cannot detect a stale `dist/`.
**Tell:** a red six minutes into the gate on a "documentation" change.
**Remedy:** in the same edit — `bun run vat --cwd packages/vat-development-agents build`, then
`UPDATE_DRIFT_GOLDEN=1 bunx vitest run --config vitest.system.config.ts
test/system/packaged-output-drift.system.test.ts` from that package, then `git diff` the golden and
read it: a diff that is exactly your edit is the all-clear.

### A plan's code blocks are unexecuted claims

Six of seven implementers hit the same lint failures from "use verbatim" blocks written against no
linter: `sonarjs/no-duplicate-string` (a warning, promoted to a block by `--max-warnings=0`),
`switch-exhaustiveness-check`, `concise-regex`, `import/order`, and a `prefer-structured-clone`
autofix that made a JSON round-trip test unable to fail.
**Tell:** every implementer reporting the same gate failure.
**Remedy:** put known plan defects in every subsequent brief verbatim; lint before claiming.

## Git and worktrees

### A git child inside a hook inherits the outer commit's repository

git exports `GIT_DIR` (often the relative string `.git`), `GIT_INDEX_FILE`, `GIT_PREFIX`,
`GIT_WORK_TREE` into hook children; a `spawnSync('git', …)` that inherits them operates on whatever
the outer `git commit` was operating on, and a relative `GIT_DIR` re-resolves against the child's
cwd. Under worktrees the two disagree by construction, and `vat resources validate` runs two levels
inside `git commit`.
**Tell:** a well-formed, confidently wrong answer about the wrong repository.
**Remedy:** delete (never set to `''`) the inherited git variables before targeting a caller-supplied
path; the `rev-parse` that decides which repository is the most important call to clean.

### Strip what git sets, keep what the operator set

`GIT_CONFIG_PARAMETERS` (git's own `-c` channel) and the hook-imposed variables are safe to strip;
`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`/`GLOBAL`/`SYSTEM` are the operator's documented env-only
configuration — how CI points `github.com` at a mirror. Over-stripping made the clone go to the
internet instead of the mirror, silently.
**Tell:** an integration test that rewrites a remote via `GIT_CONFIG_COUNT` stops firing.
**Remedy:** a blacklist framed as "everything that could redirect git" is patched reactively
forever; frame it as "what git sets for a child".

### `git merge-base --is-ancestor` says a squash-merged tag is not an ancestor

A squash merge creates a commit whose tree is identical to the branch tip but whose graph position
is unrelated; `--is-ancestor` and `git cherry` (patch-ids) both report a gap that does not exist.
**Tell:** "7 patches not in main" minutes after a squash merge.
**Remedy:** `git diff <tag> <squash-commit> --stat`; empty means lossless.

### `git checkout -- <file>` reverts the whole uncommitted diff

In a repo that batches every task uncommitted, reverting a one-line probe with `git checkout --`
wipes the whole file's real work back to the last commit.
**Tell:** the next run fails with an import error for something you wrote an hour ago.
**Remedy:** `git diff -- <file>` first; strip the probe line by hand.

### A registry read right after a publish reports packages missing that are there

npm's read replicas lag the write by minutes, unevenly per package; a sweep seconds after
`Publish to npm` reports a false partial publish that looks exactly like the failure
`publish-with-rollback` exists to prevent.
**Tell:** a missing count that shrinks on each poll.
**Remedy:** poll `https://registry.npmjs.org/<name>` every ~30 s until the missing set is empty or
stops shrinking; a stable count over minutes is the real failure. `npm view` adds its own cache.

### An accepted-risk ignore register rots silently

`osv-scanner.toml`'s reasons were written against a tree that moved: 11 of 17 entries were dead,
and VAT's own `overrides` block was pinning the one vulnerable version the register blamed on an
upstream range.
**Tell:** the dependency-audit job green because every advisory is listed.
**Remedy:** re-scan with an empty config (`osv-scanner -L bun.lock --config=<empty>.toml`), diff
against the register, delete every entry with no surviving match; check the patch line, not only
the latest major.

### Deleting a workspace skill through the API means versions first

`DELETE /v1/skills/{id}` fails while any version remains; `GET /v1/skills` lists the vendor's
built-in document skills in the same list as yours, with bare ids and old `created_at`.
**Tell:** a delete that 4xxs on a skill you can list.
**Remedy:** delete each version, then the skill; name ids explicitly in any delete script, never
"everything in the list"; verify by re-listing, not by the delete's own status.

## Product mechanisms that mislead

### A Commander variadic option eats the positional

`--param <values...>` on a command with an optional `[path]` positional keeps consuming argv into
the option array, so `vat resources query 'SQL' --param a docs/` answered about the repo root at
exit 0. `process.argv.includes('--verbose')` has the same root: it matches the word anywhere,
including a directory named `rag`.
**Tell:** a command answering about the wrong tree, or printing another command's help.
**Remedy:** a repeatable single-value option with a collector; the source-sweep test
`no-variadic-cli-options.test.ts` refuses any variadic declaration.

### A population source is bound to one tree

`withResourcePopulationSource` yields a source bound to the project root and its git tree hash;
handing it a build-output directory asks a question it cannot answer and can write the output's
membership under the project's extent key. The failure looked like a stale count.
**Tell:** `expected [ …(2) ] to deeply equal [ Array(1) ]` where the received value is
`<root>/out/<skill>`, not a second copy of the root.
**Remedy:** read the received value, not the count; post-build validation stays on the walk.

### A glob is a net, not a declaration

`PACKAGED_UNREFERENCED_FILE` exempts a declared `files:` dest; a glob `source: "extras/**/*"`
inherited the exemption and shipped a README into a bundle with no finding.
**Tell:** a never-package default that a glob bypasses.
**Remedy:** apply never-package defaults to glob expansion; let an explicit path override; make sure
the escape-hatch fixture is one the glob would also have matched.

### `readdir()` returning `null` once meant two different things

"No such directory" and "I was refused" both read as absent, so a permission refusal produced a
green scan and an `--exclude`d directory broke a valid link. The `no-blind-catch` lint and
`isPathAbsentError` exist because of this class.
**Tell:** a catch that discards the error and returns the same value as the not-found case.
**Remedy:** `if (isPathAbsentError(e)) return null; throw e;` — a refusal is never absence.

### SonarCloud "Coverage on New Code" is always zero

Automatic analysis never runs the tests and nothing uploads a report to it — there is no
`sonar-project.properties` and no sonar step in any workflow. Codecov (`coverage.yml`) is the
coverage authority.
**Tell:** `0.0%` on every PR regardless of tests.
**Remedy:** read Codecov; read Sonar's New / Accepted / Hotspot counts instead.

### `NOSONAR` does nothing under SonarCloud automatic analysis

Automatic analysis reads the code without the project's suppression configuration, so a `NOSONAR`
marker or an "accepted" argument in the PR leaves the smell counted. The only thing that moves the
number is removing the smell at its cause.
**Tell:** a smell still listed after the directive landed.
**Remedy:** fix the cause; the bar is New, Accepted and Security Hotspots all zero in the PR comment.

### A subpath module's re-exports flap by platform under knip

A package that publishes subpaths (`./fs`, `./path`, `./testing`) but names only `src/index.ts` as a
knip entry has every other subpath module judged as an ordinary file. A symbol that module re-exports
is then attributed through the re-export chain in a walk order that differs by platform: the same
tree reported `fs.ts › isPathAbsentError` unused on macOS and used on Linux, and a both-ways
allowlist made the disagreement a red on whichever side did not seed the entry. Breaking an import
cycle in the package did not change the answer.
**Tell:** an unused-exports STALE/NEW pair on CI only, naming a re-export in a file that is a
`package.json` `exports` target.
**Remedy:** derive the workspace's knip `entry` from `exports` (`sourceEntriesOf` in
`packages/dev-tools/knip.config.ts`, which reads a bare string, the `import` condition and the
`default` condition — the first cut read only `import`, so the three `{default, types}` packages
got no entries and the flap stayed open there) — a public entry's exports are API surface and are
never reported — then `bun run unused-exports --prune`.
