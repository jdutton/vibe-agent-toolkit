# Run harness

How the lab obtains a vat to run. This is axis C made real, and every facet depends on it.

## Why it is shared, not per-facet

Every facet needs to invoke vat, and every facet needs the resulting report stamped with *which* vat
it invoked. If each facet resolved its own instrument, they would drift — and two reports whose
`instrument` fields were computed differently are not comparable even when they look it.

So the harness resolves the instrument once, stamps the coordinate, and hands facets something that
runs commands. A facet never sees a path.

## Instrument sources

Three ways to name a vat, all resolving to the same thing: an executable plus an
[`InstrumentVersion`](../src/envelope/coordinate.ts).

**A working tree.** Point at a checkout; the harness uses its built `packages/cli/dist/bin.js` and
reads the version from its `package.json` and the commit from git. This is the dev-build case, and
the reason `InstrumentVersion` carries a commit at all: every dev build in this repo shares the
semver of the release it branched from, so a comparison keyed on version alone would read a dev build
and a release as the same instrument.

**A built artifact.** A path straight to a `dist/`, for comparing two builds without two checkouts.
Prefer a working tree when you have one: a `dist/` has no checkout to ask, so its coordinate records
`commit: null`, and two `dist:` arms carrying the same version are indistinguishable to
`movedAxes` — it will report that *no* axis moved for what is genuinely a two-build comparison.

**A released version.** `npx @vibe-agent-toolkit/cli@0.1.41` — the case that makes "did we get better
since the last release?" a one-liner. The commit is unknown here and the coordinate records `null`
rather than guessing.

### Never the `vat` wrapper

`packages/cli/dist/bin/vat.js` is a **context-detecting wrapper**, not the CLI: it re-resolves vat
from `process.cwd()` and delegates to the dev build, local install, or global install it finds there.
The harness always runs the measured command with `cwd` set to the **subject**, so measuring through
the wrapper runs whatever vat the *subject* has installed — while the report is still stamped with
the version and commit read from the checkout that was named. Both arms of an A/B can silently
resolve to the same third binary and agree.

So the tree and dist routes resolve `bin.js` and **refuse** the wrapper by name rather than falling
back to it. The CLI reached the same conclusion independently for its own phase subprocesses — see
`resolveBinPath()` in `packages/cli/src/commands/phase-utils.ts`.

The `npx` route is the one exception, and a known limitation: `npx` runs the published package's
`bin` entry, which *is* the wrapper. A subject with its own vat installed can therefore capture an
`npx:` arm. Compare published versions on a subject that does not depend on vat, or use `dist:`
against an unpacked tarball.

## Where the subject comes from

Independent of the instrument. A subject is a local path or a git URL on a moving ref; the harness
resolves the ref to a commit at fetch time and stamps it. For a folder with no git it computes a
content fingerprint instead, which is the only thing that makes two runs over a working directory
comparable.

`VAT_ROOT_DIR` is the existing mechanism for pointing vat at a project other than its own cwd, and
the harness drives it rather than inventing a parallel path.

## Which commands get measured

The harness owns the command list too — [`harness/commands.ts`](../src/harness/commands.ts) — for the
same reason it owns the instrument. `perf` and `io` do not merely happen to measure the same three
corpus-enumerating verbs; they *have* to, or their reports describe different work and holding one
beside the other means nothing. Two per-facet copies would be free to drift the moment one gained a
fourth command or changed an argument, and the drift would be invisible: both reports would still be
well-formed, still name their commands, and still disagree about what was measured.

It is also the only way a second facet can have defaults at all without importing the first, which
the [facet contract](facets.md) forbids.

The default is a default, not a definition. `MEASURABLE_COMMANDS` in the same file is the named
registry — the three defaults plus `validate` and `verify` — and `vat-lab <facet> run --command
<name>` selects from it. The flag is repeatable (`--command validate --command verify`), an unknown
name is a usage error listing every valid one, and a run with no `--command` measures exactly the
default set. A caller driving the library directly still passes whatever specs it likes.

`validate` and `verify` take no `{subject}` argument: both **reject** a positional path and take
their scope from the config at the working directory, which the harness has already set to the
subject. `verify` reads the built `dist/` tree, so a subject measured with it must have been built.

## Which exit codes mean the run finished

A command declares its own, as `completedExitCodes`; absent means `[0]`. vat's convention is `0`
success, `1` validation findings, `2` system error — so `validate`, `verify` and `resources-validate`
accept `[0, 1]`, because a validator exiting 1 ran the whole corpus and merely had something to
report at the end of it. Without that, those three were unmeasurable on any real project: every real
project has findings, so every repeat "failed" and every row was poisoned. `resources-scan` and
`audit` keep the `[0]` default — both are documented as exiting 0 whatever they find.

Exit `2` is never accepted. That run did not complete, and its duration is the duration of giving
up — fast enough that timing it reads as an improvement.

Two rules then apply to a row's repeats, in `summarizeRepeatFailures`, shared so both facets phrase
them alike: **any failure poisons the whole row**, and **the accepted codes must be uniform across
the repeats**. The second is what stops a set where one repeat exited 0 and another exited 1 from
being averaged: both completed, but they did different amounts of work, and a median over the mixture
describes neither.

## Two properties the harness must preserve

**Env injection must reach the child.** The I/O facet works by `NODE_OPTIONS=--require`, and vat's
own launcher spawns a second node process for the real binary. Verified: the preload propagates to
descendants automatically, so a run under it records both PIDs. The harness must not clobber `env`
when spawning, or the facet silently measures the launcher alone.

**The instrument must never be resolved from the lab's own cwd by accident.** A harness that falls
back to "whatever vat is on PATH" produces reports stamped with an instrument that was not the one
requested. Resolution failures are errors, not fallbacks.

## What this is not

Not a general process runner, and not a place for facet logic. It answers "which vat, which project,
run this command, give me stdout and exit code" — and stamps the coordinate. Everything about what
the output *means* belongs to a [facet](facets.md).
