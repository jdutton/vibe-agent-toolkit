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

It also reads whether that checkout is **dirty**, with the same `git status --porcelain` the subject
side uses — one definition, in `harness/git-state.ts`, so a single report cannot carry two meanings
of the word. See "A dirty instrument is measured, but never mistaken for a commit" below.

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

## A dirty instrument is measured, but never mistaken for a commit

A `tree:` build made from a checkout with uncommitted changes used to be stamped with HEAD and
nothing else. A real run printed:

```
Subject:    branch @ dd4123f4 (DIRTY working tree)
Instrument: vat 0.2.0-rc.2 (7b65ba86)
```

— the subject side disclosing precisely what the instrument side hid. The bytes measured were not the
bytes at `7b65ba86`, so every comparison that report took part in attributed its delta to a diff that
was not the one under test. That is a correctness bug in the instrument, not a cosmetic one, and it
is invisible at the moment it matters: the numbers are present and the header is well-formed.

So `InstrumentVersion.dirty` now travels in every report, the shared header renders it as
`vat 0.2.0-rc.2 (7b65ba86, DIRTY working tree)`, and `sameInstrument` counts it — a dirty build and
the clean commit it branched from are two instruments.

**A dirty A/B is legitimate and is never refused.** Editing, measuring and watching the number move is
the commonest thing anyone does with a perf tool. What it must never do is *read* as a
commit-to-commit result, so `instrumentTrustNotes` prints a banner above every comparison and every
`ab` run where either arm is dirty, where the two arms differ in dirtiness, or where an arm carries
no commit at all.

**There is deliberately no instrument working-fingerprint**, unlike axis B. What ran is the *built*
output; a fingerprint over the source checkout would precisely identify something that is not the
thing measured, since you can edit source and never rebuild — which is the very failure the label
discloses. The consequence is stated rather than papered over: two dirty arms at one commit compare
*equal* on axis C, and the banner is the only thing that keeps a reader from concluding the
instrument was held still. In the store, a dirty instrument's report is instead named by *when it was
observed*, so a second dirty run can never silently overwrite the first.

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
registry — the three defaults plus `inventory`, `validate`, `verify`, `resources-population`,
`claude-context-all`, `claude-context`, `claude-budget`, `skills-validate` and `skills-list` — and
`vat-lab <facet> run --command <name>` selects from
it. Adding an entry to the registry changes what a caller *can* ask for and nothing about what a
bare run measures. The flag is repeatable
(`--command validate --command verify`), an unknown name is a usage error listing every valid one,
and a run with no `--command` measures exactly the default set. A caller driving the library
directly still passes whatever specs it likes.

**A facet may override which defaults a bare run measures**, and exactly one does. `population`
reads a file list out of the measured command's output, and two of the three shared defaults emit
none — so a bare `population run` over them would be two refusals and one measurement every time,
and a facet whose out-of-the-box output is two thirds noise teaches people to skim past the third.
It defaults to `resources-population` instead: the same scan, asked for the whole list
(`--verbose`) in a format needing no YAML parser (`--format json`). That is its own registry entry
rather than flags added to `resources-scan`, because widening `resources-scan` would change what
every stored `perf` and `io` report was taken over. Overriding the default never narrows what
`--command` can ask for.

`validate` and `verify` take no `{subject}` argument: both **reject** a positional path and take
their scope from the config at the working directory, which the harness has already set to the
subject. `verify` reads the built `dist/` tree, so a subject measured with it must have been built.
`claude-context-all` is subject-less for the same reason — `--all` sweeps every path the projection
realized and takes no positional. So is `claude-budget`, and there for a sharper reason than
convention: it **rejects** (exit 2) any path resolving outside the root it discovered, so a
positional naming the subject fails from every working directory except the subject itself.

## Reaching the rest of the enumerating verbs

`docs/contributing/command-lane-table.md` counts **25 commands that enumerate a corpus**, and those
are the ones where a cost regression actually hurts. This registry reaches ten of them. That gap is
the reason `claude-budget`, `skills-validate` and `skills-list` are here:

- **`claude-budget`** was the largest hole. It shares `claude-context`'s lane, route and population
  exactly — same `buildClaudeContextPopulation`, same two `populate()` passes, same single crawl —
  but asks a different question of it: `context` answers for the paths named, while `budget` sweeps
  every working location through `sweepAlwaysLoadedBudgets()`. Its per-answer cost therefore grows
  with the number of regions in the tree, and the `claude-context` pair is blind to that by
  construction, because both of its arms hold the query count fixed.
- **`skills-validate`** is the `registry-md-html` lane's cheapest read-only door. Every other
  command that builds that registry — `skills build`, `skills package`, `claude plugin build`,
  `agent build`, `skill test run` — writes output; `audit` and `verify` reach it but bundle other
  work on top.
- **`skills-list`** is the closest thing to a control for the crawl itself: one crawl, no
  validation, no parse. Measured over an order of magnitude of document corpus it stays **flat**,
  which is the shape to expect — its extent is the skills glob, not the document corpus — and that
  is what makes it useful as a baseline a downstream change must not move. Run it yourself rather
  than trusting a figure here; `vat-lab perf run <subject> --command skills-list` prints a current
  one.

Fifteen enumerating commands are still unreachable, and they are not all unreachable for the same
reason — which matters, because only one of these groups is a real boundary:

| Why it is out | Commands |
|---|---|
| Reaches a remote service, so the measurement would not be of vat | `corpus scan` (clones over the network), the five `claude org skills` verbs (Anthropic Admin API) |
| Produces build output, so a subject must be prepared and is left dirty | `build`, `agent build`, `skills build`, `skills package`, `claude plugin build`, `skill test run`, `rag index` (also needs an embedding provider) |
| **Nothing but the absence of an entry** | `skill review`, `claude marketplace validate` |

The last row is the honest one: both are read-only and cheap, and neither is here yet. Anyone
adding them should say what lane the row buys that an existing entry does not already cover —
`skills-validate` and `audit` between them already reach `registry-md-html`, so a third door onto
the same lane earns its place only if it isolates something they bundle.

`claude-context-all` and `claude-context` are a **pair**, and the pair is the point. The sweep was
measured at 561 seconds on a large adopter tree, and its per-answer cost scales with the size of the
projection rather than with the query — so the sweep alone cannot say whether a change moved the
population cost or the per-answer cost. `claude-context` answers one path out of the same
enumeration: a fix that halves the sweep while leaving the control unmoved shaved per-answer work,
and one that moves both shaved the crawl.

## Comparing two builds: `ab`, not twelve invocations

`run` measures one instrument. An A/B used to mean hand-orchestrating a dozen `run` invocations and
comparing them by eye, and a session doing exactly that came within one reading of publishing an 8x
result that was an artifact of the ordering. `vat-lab <facet> ab` is that method encoded, available on
every facet through the same `createFacetCommand` factory that builds `run` and `compare`:

```
vat-lab perf ab <subject> --instrument-a tree:<path> --instrument-b tree:<path> \
  [--pairs 6] [--runs 3] [--cache warm|cold] [--command <name>] [--out <dir>] \
  [--control] [--noise-floor <value>]
```

Four properties, each of which the hand-rolled version had no way to enforce:

**Whole arms alternate — A B A B …, never all of A then all of B.** A machine drifts over minutes, and
a block design charges every bit of that drift to whichever arm ran during it. Alternation turns a
systematic bias into a per-pair one, which shows up as pairs disagreeing — a signal you can read.
The second reason is specific to this harness: vat namespaces its dev parse cache per build, so each
arm's *first* invocation is cold whatever `--cache` says. Alternation makes that recur symmetrically
instead of hiding inside one arm's aggregate.

**The estimator is `min`, with `p25` reported beside it — never a median, never a mean.** Every sample
is the true cost plus a non-negative contamination, so the smallest is the closest thing to a clean
observation. Across a handful of samples, one cold repeat is enough to move a median and not the min.

**Every pair's verdict is reported, and so is whether they agreed.** A single pair settles nothing —
two pairs in a prior session actively contradicted each other. Disagreement prints as
`⚠ PAIRS DISAGREE` and exits `EXIT_UNMEASURABLE`; it is never averaged into a consensus no pair
reported.

**`--control` runs the same instrument as both arms**, which measures the machine rather than a
difference between builds, and whatever effect it reports *is* the noise floor. Feed the largest of
those back as `--noise-floor` and any smaller effect is reported as `INDISTINGUISHABLE FROM NOISE`.
Without one, every run says `Noise floor: UNMEASURED` rather than letting silence read as confidence.

`ab` orchestrates and does not measure: capture, comparison and the per-command verdicts all belong to
the facet and arrive as functions, so it works for facets that do not exist yet and cannot acquire an
opinion about what a `perf` verdict means versus an `io` one. The single number it aggregates arrives
through `FacetEstimate`, which carries its own unit precisely so nothing in `ab` has to know what it
is. Every capture is written through the normal store, under `<out>/ab-<stamp>/pair-N/{a,b}/` — the
per-pair directory is load-bearing, because two pairs of one arm share a coordinate and therefore a
filename.

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

**Env injection must reach the child.** The I/O facet works by `NODE_OPTIONS=--require`, and the
preload propagates to descendants automatically, so any node process vat spawns records its own PID.
The harness must not clobber `env` when spawning, or the facet silently measures less than the
command did.

⚠️ **A one-PID report is not a symptom.** `tree:` and `dist:` resolve `packages/cli/dist/bin.js` and
refuse the context-detecting wrapper, so the measured vat does its work in a single process — the
`processes` count is 1 on a perfectly healthy run. The io facet's warning keys on a counted process
that made no `fs` calls at all, never on the PID count; see `measuredLauncherOnly` in
`src/facets/io/render.ts`.

**The instrument must never be resolved from the lab's own cwd by accident.** A harness that falls
back to "whatever vat is on PATH" produces reports stamped with an instrument that was not the one
requested. Resolution failures are errors, not fallbacks.

## What this is not

Not a general process runner, and not a place for facet logic. It answers "which vat, which project,
run this command, give me stdout and exit code" — and stamps the coordinate. Everything about what
the output *means* belongs to a [facet](facets.md).
