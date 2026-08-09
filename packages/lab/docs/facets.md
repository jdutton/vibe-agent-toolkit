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

Measurement facets are the hard case: wall time *always* varies. The rule is that a facet reports the
distribution rather than the sample, and the comparator applies tolerance rather than equality. A
perf facet that emits a bare number invites exactly the flapping that made vat's correctness oracle
zero its timings in the first place.

## Room to split into sub-packages later

Each facet lives in its own directory and depends only on the envelope core — never on another facet.
That seam is deliberate: if the lab later splits into `lab-perf`, `lab-sweep` and friends, extraction
is a move rather than a rewrite, and the envelope becomes the shared core they all depend on.

Splitting before there is a reason to is not worth it. Keeping the seam clean so that splitting stays
cheap costs nothing, so that is what this does.
