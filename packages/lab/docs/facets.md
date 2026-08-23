# Facets

A **facet** is one kind of measurement. It decides what goes in a report's `body`; the envelope
decides everything needed to know whether two bodies may be held next to each other.

## The two shapes

Facets are not all the same shape, and conflating them produces reports that answer neither question
well.

**Learning facets** — skill lint, compatibility prediction. The output is findings about code we do
not own, and each finding needs per-finding provenance plus a **bidirectional verdict**: is this our
false positive, or their real defect? That bidirectionality is the entire value of scanning upstream.
A sweep that can only say "237 warnings" teaches nothing; one that can say "of 237, 12 are our rule
being wrong" improves vat.

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

Both use the same coordinate header. The comparator knows which kind it is holding and diffs
accordingly — set differences for findings, distribution differences for numbers.

## The contract

A facet owns:

- **A stable `facet` name** — `io`, `perf`, `sweep`, `calibrate`. It goes in the envelope header and
  two reports with different names are refused against each other.
- **A `facetVersion`** — the version of *its* body schema, which it bumps when the body's shape
  changes. Two reports of one facet at different body versions are refused, because differences
  across a schema change belong to the schema rather than to the subject.
- **A body schema** — validated by the facet after it has confirmed the header names it. The envelope
  reader deliberately does not validate bodies; it does not know their shapes.
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

## Room to split into sub-packages later

Each facet lives in its own directory and depends only on the envelope core — never on another facet.
That seam is deliberate: if the lab later splits into `lab-perf`, `lab-sweep` and friends, extraction
is a move rather than a rewrite, and the envelope becomes the shared core they all depend on.

Splitting before there is a reason to is not worth it. Keeping the seam clean so that splitting stays
cheap costs nothing, so that is what this does.
