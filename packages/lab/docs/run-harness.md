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

**A working tree.** Point at a checkout; the harness uses its built `dist/bin/vat.js` and reads the
version from its `package.json` and the commit from git. This is the dev-build case, and the reason
`InstrumentVersion` carries a commit at all: every dev build in this repo shares the semver of the
release it branched from, so a comparison keyed on version alone would read a dev build and a release
as the same instrument.

**A built artifact.** A path straight to a `dist/`, for comparing two builds without two checkouts.

**A released version.** `npx @vibe-agent-toolkit/cli@0.1.41` — the case that makes "did we get better
since the last release?" a one-liner. The commit is unknown here and the coordinate records `null`
rather than guessing.

## Where the subject comes from

Independent of the instrument. A subject is a local path or a git URL on a moving ref; the harness
resolves the ref to a commit at fetch time and stamps it. For a folder with no git it computes a
content fingerprint instead, which is the only thing that makes two runs over a working directory
comparable.

`VAT_ROOT_DIR` is the existing mechanism for pointing vat at a project other than its own cwd, and
the harness drives it rather than inventing a parallel path.

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
