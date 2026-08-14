---
package: "@vibe-agent-toolkit/lab"
status: experimental
tags: [quality, benchmarking, profiling, corpus]
---

# @vibe-agent-toolkit/lab

The quality lab. Generates analyzable reports about a project, and compares them along exactly one
axis at a time — so a delta always has one thing to attribute it to.

> **Status: publish-shaped, not published.** Built as a public package — real exports, a versioned
> CLI contract, docs — but carrying `"private": true` while the interface still moves. Graduating it
> is the intent, not keeping it private. See [Roadmap](docs/roadmap.md).

## Using it

The binary is **`vat-lab`**, and every facet exposes the same two verbs — `run` produces a report,
`compare` diffs two of them:

```bash
vat-lab <facet> run <subject> --instrument <spec> [--command <name>]... [--out <dir>] [--runs <n>] [--cache warm|cold] [--id <name>]
vat-lab <facet> compare <baseline> <candidate>
```

`--command` names one measurable vat command instead of the default set and may be repeated
(`--command validate --command verify`); see
[Which commands get measured](docs/run-harness.md#which-commands-get-measured).

Facets today are **`io`** (filesystem-call counts) and **`perf`** (wall time). A minimal
vary-the-instrument comparison — the same project, measured by two builds of vat:

```bash
vat-lab io run ../some-project --id some-project --out ./before
# ...change vat, rebuild...
vat-lab io run ../some-project --id some-project --out ./after
vat-lab io compare ./before/<report>.json ./after/<report>.json
```

Reports default to `.vat-lab/`, which this repo gitignores — keep it that way, since lab output
landing inside the tree being measured changes the next run's numbers.

## The three axes

Every report is a measurement at a coordinate, and carries the whole triple or it is comparable to
nothing:

| Axis | Field | What it is |
|---|---|---|
| **A** | `subject` | Which repository or folder was measured |
| **B** | `subjectVersion` | Which commit of it — or, for a folder with no git, a content fingerprint |
| **C** | `instrument` | Which build of vat did the measuring |

A comparison holds two axes still and varies one:

- **Vary C** — did vat get better, or faster? Regression and benchmarking, for quality as well as speed.
- **Vary B** — what moved upstream, and did their quality move or did ours?
- **Vary A** — how does the ecosystem look? The cross-sectional survey.

**Varying two at once is refused by default.** A delta across two simultaneous changes cannot be
attributed to either, so the comparator returns a `REFUSED:` rather than a number nobody can act on.
Callers pass `allowMultiAxis` to say out loud that they know the result is uninterpretable.

## Subjects move on purpose

A subject is tracked on a moving ref — `#main`, not a pinned SHA. Upstream moving *is* the signal a
survey exists to see, and pinning the subject would hide it.

Pinning happens at observation time instead: a run resolves whatever ref it was given to a concrete
commit and stamps it into the report. The subject keeps moving, every report stays retrospectively
pinned, and any two reports remain diffable.

## Why a separate CLI, not a `vat` subcommand

The lab drives vat through its **command-line boundary only**, never through its internals. That is
what lets one run measure two different vat versions — a released one against a dev build — and what
lets it measure a repository with no vat config at all.

An in-process command group would live inside exactly one vat version and inherit its internal API,
which forecloses the cross-version comparison that is the whole point. See
[Scope and migration](docs/scope.md) for what this means for the verbs that exist today.

## Sub-topics

This README is the front door. The detail lives next door:

- **[Scope and migration](docs/scope.md)** — what belongs in the lab, what stays in vat, and the
  backlog of verbs to move with the evidence for each.
- **[Roadmap](docs/roadmap.md)** — the staged plan. Deliberately not built all at once.
- **[Facets](docs/facets.md)** — the report-body contract, and how to add one.
- **[Run harness](docs/run-harness.md)** — how the lab obtains a vat to run: a working tree, a built
  `dist/`, or a released version via `npx`.

## Refusals

The lab refuses rather than coerces. A report from another envelope format, another facet, or an
older body schema is refused, because a comparator that tolerates a schema change reports
differences belonging to the change rather than to the subject — the most expensive wrong answer
this package can give.
