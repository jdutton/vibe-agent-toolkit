# Facets

A **facet** is one kind of measurement. It decides what goes in a report's `body`; the envelope
decides everything needed to know whether two bodies may be held next to each other.

## The shapes

Facets are not all the same shape, and conflating them produces reports that answer neither question
well.

**Verdict facets** — `verdict`. The output is what vat DECIDED: an exit code and a multiset of
findings per verb, plus the normalized document it printed. The comparator is exact — multiset
difference for findings, string equality for documents — and every difference must be accounted for
by a committed, reviewed declaration, in both directions. See [The verdict facet](#the-verdict-facet).

**Measurement facets** — resource integrity, performance, I/O accounting. The output is numbers, and
numbers need spread. A single sample is not a measurement; a median over repeats with the spread
reported alongside is.

**Extent facets** — `population`. The output is a *set*, and a set needs neither spread nor
tolerance: the comparator is exact set difference, and one member's difference is real. The
distinction from a measurement facet is not cosmetic. Every other facet answers *how expensive was
this?*; `population` answers *what did it cover?*, and for four facets that question was unreachable
from the instrument — which is how a crawl change came to be checkable only by a throwaway script.

An extent facet has two obligations a cost facet does not:

- **It reports the set, never only its size.** Two runs enumerating 1,382 files each and disagreeing
  about *which* 1,382 are not the same measurement, and a facet reporting only a count renders that
  as agreement.
- **It carries a reference the subject did not produce.** A population compared only against another
  run of the same instrument is self-referential — two runs of one lane agree trivially. `population`
  holds each run against git's own listing, which answers the one containment direction that needs
  no knowledge of the subject's include/exclude globs: *did the crawl emit a path git does not
  track?*

It also records the **lane the subject said it took**, read back out of the subject's own output
rather than from the environment the caller set. Setting a variable proves what was asked for; only
the output proves what happened, and an A/B whose two arms silently ran the same lane is a clean
result that means nothing.

That reading is not `population`'s alone. Every row of an `io` report carries the same two fields,
`lane` and `extentSource`, read by the same reader (`src/harness/lane.ts`) out of the same kind of
document — because a call count is a measurement of *some* enumerator, and a row that does not
say which one leaves the reader inferring it from a call-site signature, which is what the
2026-09-11 git-vs-filesystem A/B had to do (`realizations.js:51` at 0 calls versus 12,003). The
rendered row names its arm (`projection via git`), and `io compare` and `population compare` append
one of four arm clauses to every command row — the same clause, from the same `laneNote`:

| Both sides' arms | Clause on the row |
|---|---|
| Both named, and differ | `[projection via filesystem → projection via git]` — the `→` is reserved for this case |
| Both named, and the same | `[both sides ran the 'projection via git' arm — this compares one enumerator with itself]` |
| Neither named | `[arm UNPROVEN on both sides — neither output reported a lane]` |
| Exactly one named | `[arm UNPROVEN on the before side — lane UNREPORTED by the subject's output; the after side ran 'projection via git']` (or `after` / `before` swapped) |

The one-sided clause deliberately does not use the arrow: a side that cannot prove which arm it
ran is not a different enumerator, it is an absent proof, and rendering it as `[A → B]` read as
"the arm changed" where the honest verdict is "one side cannot say". It is a qualifier, not a
refusal — the row's numbers stand and the exit code is unaffected.

The reader is shared; the repeat it is pointed at is not, and neither is what it does with a
malformed field. `io` reads the arm off the **last** repeat's stdout — the repeat whose dumps the
row reports — and never off repeat 0, the warm-up. `population` discards no repeat and reads the
arm, the root and the file list off its **first**. A subject whose warm-up prints a different arm
from its steady state would therefore be named differently by the two facets for one command. And
a `lane` of the wrong type is `null` on an `io` row (a qualifier on counts that are real either
way) but a **refusal** on a `population` row, whose schema extends the shared one: a population is
nothing but the subject's own claim, and `null` is the label an old-but-honest build gets, so a
subject that printed a corrupt lane must not read the same as one that printed none.

Every reader in the lab — `lane.ts`, and the `population` and `verdict` facets — goes through one
document reader (`harness/document-shape.ts`), which parses JSON first and YAML second (`yaml`'s
`parseAllDocuments`, single document, a leading `---` tolerated). So a row measured over the
default `io run` spec (`resources-scan`, which prints YAML) reads its real lane, the same as one
measured over `--command resources-population` (JSON) — both go through the same parser, and
neither is privileged. `null` still means *the output did not say* — the build is too old to
report a lane, or the output is not a document this reader can classify at all — and it is spelled
`lane UNREPORTED by the subject's output` on the row.

Mixing the two specs in one compare produces NO arm clause at all: the comparator pairs command
rows by name, a `resources-scan` row never pairs with a `resources-population` row, and the
report prints one `added` and one `removed` row with nothing to qualify. The one-sided clause
(`arm UNPROVEN on the <before|after> side`) is reached only when the SAME command name carries a
lane on one side and not the other — a `resources-population` row measured under a vat build too
old to print `lane`, against one measured under a current build — and it is never rendered as an
arm change.

Every shape uses the same coordinate header. The comparator knows which kind it is holding and
diffs accordingly — multiset differences for findings, set differences for populations,
distribution differences for numbers.

## The contract

A facet owns:

- **A stable `facet` name** — `perf`, `io`, `parse`, `crawl`, `population`, `verdict`. It goes in the envelope header and
  two reports with different names are refused against each other.
- **A body schema** — strict, and validated by the facet after it has confirmed the header names it.
  The envelope reader deliberately does not validate bodies; it does not know their shapes.

  ⛔ **There is no `facetVersion`, and adding one back is a defect.** A facet used to carry an
  integer it was expected to bump whenever the body's shape moved. The strict schema decides the
  same question better: it moves the instant a field is added, renamed or retyped, and it moves for
  whoever made the edit rather than for whoever remembered. Both sides of a comparison are validated
  against *this build's* schema — not merely against each other — so a matched pair of pre-change
  reports, which agree with each other perfectly, is refused too. What no schema can see is a field
  whose MEANING moved while its name and type stayed put; no integer could see that either, it could
  only be told. The remedies there are to make the build DECLARE the thing that moved (as
  `CrawlTimingDump.charges` does) or to invalidate explicitly by deleting the stored reports.
- **A capture function** — given a resolved coordinate and a vat to run, produce a body.

What a facet must **not** own: anything about how vat is obtained or invoked. That is the
[run harness](run-harness.md), shared by every facet, so a new facet inherits axis C for free.

## Determinism and what is excluded from comparison

A facet body must contain nothing that varies between two identical runs. The envelope already
excludes `capturedAt` for this reason — it moves every run, so comparing it would report a difference
between two identical measurements.

Measurement facets are the hard case, but not all in the same way, and the difference decides how
their comparator works.

**A continuous, noisy observable — wall time.** It *always* varies. The facet reports the
distribution rather than the sample, and the comparator applies tolerance rather than equality. A
perf facet that emits a bare number invites exactly the flapping that made vat's correctness oracle
zero its timings in the first place.

**A discrete, deterministic observable — call counts.** Measured: `vat resources scan docs/` records
the same 436 attributed calls on three consecutive warm runs, and the same 568 on three consecutive
cold runs. Nothing varies, so the comparator uses **exact equality**, and it is a sharper instrument
than any tolerance gate — a delta of one call is real.

That sharpness is why such a facet must still repeat itself. Determinism is a property of the code
being measured, not a promise the lab can make on its behalf: if repeats *disagree*, vat has become
nondeterministic, and that is a finding in its own right rather than noise to be averaged away. The
facet reports a `stable` flag so the comparator knows whether it is entitled to read an exact delta.

One consequence for repeat counts: in `warm` mode the first repeat populates vat's on-disk cache and
therefore systematically differs from the rest, so it is a warm-up and is discarded. Verifying
stability then needs two more, which makes three the smallest honest number of repeats.

## The verdict facet

`vat-lab verdict run|compare` is the crucible: it compares what two vat builds DECIDE over a set of
real trees, and every wave-A document change is measured with it. Source:
`src/facets/verdict/`.

```bash
vat-lab verdict run --subjects <file> --instrument <spec> [--env K=V] [--unset K] --out <dir>
vat-lab verdict compare <baselineDir> <candidateDir> [--deltas <file>] [--control]
```

**Subjects** come from a local YAML file that is never committed — `--subjects` is required and has
no default, because a default path is a place someone eventually commits by accident. Each subject
is an alias (`crucible-1`, never an adopter's name), a path (relative paths resolve against the
file's directory), a verb list, an optional `contextPath` (required iff `context-path` is listed),
`sqlFiles` (required iff `resources-query` is listed) and `buildVerbs`.

**The verb matrix** (`verbs.ts`): `audit`, `skills-validate` (with `--verbose`, which is what makes
legacy `skills validate` publish its finding list), `resources-validate`, `resources-check`,
`context-all`, `context-path`, and `resources-query` once per SQL file (row `resources-query:<file>`).
`buildVerbs: true` adds `build`, `verify` and `marketplace-publish-dry-run`, run in an APFS clone
(`cp -c -R` per entry, minus `.claude/worktrees`, then the clone's `origin` removed) under the OS
temp directory — macOS only, and refused for a git worktree subject, whose clone would share the
real repository's config. Each verb's argv is a function of the arm's `InstrumentVersion`, so a
future per-arm divergence is one function, not a second matrix.

**Per-arm environment.** Each arm runs under the caller's `--env`/`--unset` plus two lab-owned
settings: `VAT_PROJECTION_STORE_DIR=<out>/<alias>/store` (a private projection store, so the second
arm never reads what the first wrote) and `CLAUDE_CONFIG_DIR` unset. An arm naming either is
refused. Only the caller's part is recorded in the body (`arm`), because the store path differs
between any two captures and would make every pair of arms distinguishable. **Nothing the lab
writes lands inside a subject** — VAT itself is one: an `--out` inside any subject path is refused.

**Two layers**, per (alias, verb) row:

1. **Verdict** — exit code plus the finding multiset, read by `extract.ts`. It recognises a
   `Report<T>` by the envelope identity keys (`ENVELOPE_IDENTITY_KEYS` in
   `harness/document-shape.ts`: `status`, `examined`, `findings`, `summary`, `data`) with a numeric
   `examined` and an array `findings` — never by a version string — and reads every legacy shape
   with one structural rule. This layer stays failable while a document is reshaped.
2. **Document** — stdout after the ONE normalizer (`normalize.ts`: absolute roots, line endings,
   and wall-clock fields; no rewrite without a measurement behind it), string-compared, with a diff
   excerpt of at most 80 lines in the render.

A row is **UNMEASURED** when, in either arm, the verb did not run, exited 2, or printed stdout the
lab could not parse. Two unmeasured arms trivially agree, so an unmeasured row is a delta in its own
right and is never rendered as "no change".

**What may be compared.** Exactly one axis may move, and it must be the instrument. A moved subject
or subject version is refused — re-capture the baseline immediately before the candidate. Two
captures of one instrument are a control whether or not the caller said so: `movedAxes = []` needs
`--control`, and indistinguishable arms (same instrument including its closure digest, same arm
environment) are refused without it.

**The deltas file** — `data/verdict-deltas.yaml`, committed and reviewed, the default for
`--deltas` (resolved from the lab package, not the cwd). It names one `baseline` (the baseline arm's
vat version; a compare against any other is refused) and entries keyed by subject alias and verb,
each declaring any of `exit {from, to}`, `findingsAdded`, `findingsRemoved`, `document: reshaped`
and `unmeasured: true`, with a `reason` and a `changelog` reference (`.changes/<fragment>.md#<anchor>`
or `CHANGELOG.md#<anchor>`) that must name a heading that exists. It is checked **both ways**: an
observed delta no entry declares fails, and a declared delta that did not occur fails — as a
multiset, item by item. Every entry is validated, none filtered: an entry naming an alias the run
did not cover, or a verb that alias did not run, is a refusal.

Two consequences of layer 2 for a declaration:

- **A finding or exit change needs `document: reshaped` too.** Any finding or exit move also changes
  the normalized document, so the document delta is observed alongside it. An entry that declares
  only the exit or the findings leaves that document delta undeclared, and the compare fails.
- **Once a row declares `document: reshaped`, any further reshape on that row goes through unseen.**
  Layer 2 is one string equality per row, so a declared reshape covers every document difference on
  that (alias, verb), including ones nobody reviewed. Layer 1 is still exact on that row: every
  exit or finding move must still be declared item by item. Read the diff excerpt the render prints
  for an accepted row; the declaration does not vouch for it.

A partial run uses a partial
subjects file and a matching deltas file. `compare` exits `1` on any undeclared or unused delta, `2`
on any refusal, `0` otherwise.

**The planted-delta proof.** `test/integration/verdict-planted-delta.integration.test.ts` plants a
delta through two probe instruments with distinct closures: an undeclared exit and finding delta
fails, a declared delta that did not occur fails, the exact declaration passes, and both-arms-exit-2
and both-arms-unparseable rows fail as unmeasured. Those cases were seen red before the control and
refusal cases were written, because a compare that reported nothing would satisfy the latter.

## Room to split into sub-packages later

Each facet lives in its own directory and depends only on the envelope core — never on another facet.
That seam is deliberate: if the lab later splits into `lab-perf`, `lab-verdict` and friends, extraction
is a move rather than a rewrite, and the envelope becomes the shared core they all depend on.

Splitting before there is a reason to is not worth it. Keeping the seam clean so that splitting stays
cheap costs nothing, so that is what this does.
