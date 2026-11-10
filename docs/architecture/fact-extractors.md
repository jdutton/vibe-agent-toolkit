# Fact Extractors

**Status:** Accepted. Amended in the PR whose implementation proves a clause wrong; see
[How this ADR changes](#how-this-adr-changes).

The living list of hazards this design enforces or accepts is the
[hazard register](./fact-extractors-hazard-register.md). The store this document governs is described
in [Resource Projection](./resource-projection.md), whose target-state notes point back here.

## Context and goal

The goal is a **queryable repository**: a check or question about the tree is a SQL statement, fast enough
for every commit, over facts in a cached, integrity-checked **fact store**, filled by per-file
**extractors**.

**Scope.** The store guarantees answers faithful to extractor output; conformance and parity guard
extractors.

Vocabulary: an **extractor instance** turns one file's bytes into rows of declared tables; a **row set**
is one (content key × instance) pair's rows; the **extent** says where content
lives in one tree; a **resolve step** derives what SQL cannot; a **core
producer**, what needs git or a second lane.

## Priorities, ranked for any unanticipated trade-off

- **P1. No wrong answer at exit 0 from any hazard in the [register](./fact-extractors-hazard-register.md)** (I0, I1). Each hazard is *enforced* or *accepted* with its bound; a new one joins the register, never blocking the design. A refusal is always acceptable and names its cause and clearing command; a rising refusal rate is a defect.
- **P2. The warm loop is the product:** many fast questions at a cost scaling with the change (I10).
- **P3. Explainable.** Every miss, refusal and answer, from the run's record alone.
- **P4. Built-ins first, plugin generality second.** The plugin contract grows only when a real second extractor needs it. The query surface is the adopter contract (rejected: aliasing a renamed column); pre-1.0 its breaks are batched, each with a rename map.
- **P5. Cold-run speed and store size come last.** They stay bounded.

Methods:

- **Simple.** A mechanism is explainable by one invariant and provable red; of two that hold it, take the one with less state.
- **Measure first.** No warm-path mechanism ships without a lab record of the cost it removes.

## Invariants

Every enforcer is proved red on a seeded violation and lands with the step making its invariant
true.

**I0. Cache transparency.** For the same tree, warm, cold, partially evicted and store-off runs give
identical answers, or one of them refuses. *Fails:* the cache moves the answer. *Enforcer:* a
differential run over a corpus, with seeded mutations.

**I1. Honest answers.** A query or check answers only from facts current for the tree it names, never
another tree or root, or refuses with a code. Absent facts are never read as zero or empty, except
rows a per-kind `accept: [defective]` admits, which `bound` records. *Fails:* a
green check over facts never there. *Enforcer:* a code-owned absence-cause enumeration, a
required field of I3's "absent" result, maps each cause to a refusal code; I0 seeds each cause, both
ways; a containment regression shows a statement counts only its own tree.

**I2. One keying rule: a key covers its observed inputs.** Every stored key (extent, row set,
memo) covers bytes, code, config, options, declared inputs and
runtime (node, v8, unicode, icu, platform, arch); a child process's inputs as declared inputs, or the
artifact is uncacheable; exempt: the plugin conformance record's runtime tuple
([register](./fact-extractors-hazard-register.md)). *Fails:* a hit served after an input moved.
*Enforcer:* an observed-inputs instrument shows every input is in the key or the
stored trace; moving each input class alone must miss.

- **I2a. Content is the bytes used.** The content key hashes the working-tree bytes alone: no parser kind, path, origin, commit, git OID or cleaned blob. Every byte a producer or stratum consumes is re-hashed at use; a mismatch refuses the pair and writes nothing. The content key is never `checksum`. A stat-tuple match is trusted only under git's racy rule. *Fails:* rows filed under bytes other than those read. *Enforcer:* a planning-to-use race test; a stat-seam re-hash test.
- **I2b. Code identity is the code that runs:** the closure loaded from a phase's entry modules, lazy imports included, hashed from compiled source, plus the runtime tuple; never the host's whole closure, a lockfile or a version. A warm hit validates it without importing. *Fails:* rows keyed under code that did not make them, or a rebuild missing everything. *Enforcer:* code edits, both ways: code that runs misses, code that does not run never does.

**I3. One answer to "is this pair present".** One per-pair answer for every consumer: statements,
strata, resolve, the registry and non-git lanes. *Fails:* the gap
I1 forbids. *Enforcer:* a lint rule makes one module the only reader of fact tables, and an undeclared
read throws at run time.

**I4. One answer to "which extractors read this path".** Every lane gets the same (instance, variant)
set for a path. Which instances read a path is an extent fact, never in a
`row_set_key`; the chosen variant enters as an option; `mime` enters only through those two. *Fails:* lanes disagree on a file's facts. *Enforcer:* a lint rule makes one module the only
router; every lane routes a fixture tree alike.

**I5. Pure producers.** Extract is a pure function of (bytes, options, declared inputs). Resolve is pure over its declared reads and sources. *Fails:*
rows unlike their key, shared across trees. *Enforcer:* the conformance suite fails a set of impure
extractors and gates every built-in; plugins per the [register](./fact-extractors-hazard-register.md).

**I6. Only key-determined outcomes persist.** A row set is stored whole or not at all, an outcome only
if the key preimage plus the recorded limit determine it, so time, heap, stack-depth
and recursion outcomes stay per run. A success replaces a stored failure and may be
served under a limit tighter than its own. *Fails:* a timeout on a loaded box
becomes a permanent blank. *Enforcer:* a kill mid-write leaves no partial row set; a seeded per-run
timeout leaves no stored outcome; a seeded success replaces a stored failure.

**I7. One consistent view per answer.** No concurrency hazard makes a run read stored facts as absent or
mixed; each is a [register](./fact-extractors-hazard-register.md) row. *Fails:* parallel checks answer from half of two states.
*Enforcer:* one two-process test per row.

**I8. Termination.** Every run ends with an answer or a refusal within its limit. *Fails:* a never-returning check blocks a commit. *Enforcer:* one kill-at-limit
fixture per blocking class, every wait, child process and handshake included.

**I9. Trust is explicit.** A plugin loads only because config names it (rejected: auto-discovery). *Fails:* unchosen code runs. *Enforcer:* an installed but
unnamed extractor is never imported.

**I10. The warm path is bounded by the change, plus the rows the statements read.** A warm unchanged run
extracts only pairs with no stored outcome servable under its limit (each counted and named) and writes only the lease
plus one claim per such pair before the answer; a one-file edit extracts only that file's routed pairs. Any other
cost not scaling with the change, decoding a row outside the answer included, is a counted
[register](./fact-extractors-hazard-register.md) row. *Fails:* every check pays for the whole repository. *Enforcer:* deterministic work
counters, store writes included; for uncounted sites, the lab's N vs 2N relative-time scaling of the
warm unchanged path against an interleaved control, per phase: time growing with N beyond its own counter's slope is red
(seed: an uncounted loop inside the extent phase).

**I11. One contract.** Every parser, built-in or plugin, reaches the store only through the extractor
contract; the old path is deleted (rejected: a markdown path beside it). *Fails:* a second path the
contract never exercises. *Enforcer:* an import-boundary lint confining non-literal `import()` and `require` (literal lazy
imports allowed) to the registry module, its
allowlist asserted both ways; the loadable set is exactly the built-ins plus config-named
manifests.

## Hazard register

The register lives in its own document, [Fact Extractors — Hazard Register](./fact-extractors-hazard-register.md):
every hazard the store enforces or accepts, with its status and its enforcer kind or bound.

## Settled decisions

- **Relation naming.** A relation name is the `__` join of instance and table, parts free of `__`; core relations have none. Every relation with a `path` column carries `root`, derived from the schema. Names are lowercase identifiers (columns may be camelCase); the joined name is unique after casefolding; no part has a leading or trailing `_`; reserved names are derived, never hand-kept. Rejected: per-extractor schemes.
- **One diagnostic vocabulary:** one registered code family, dispatched on. Rejected: per-step code tables.
- **The `row_set_key` preimage** is content, extractor identity, the contract module's code identity, options, declared inputs, schema digest and runtime; routing enters only as I4 says. Rejected: path, root, commit, tree hash and limits.
- **A stored failure is keyed by the `row_set_key` preimage plus its limit, served only under it or a tighter one.** Rejected: keying failures like successes.
- **No opt-in turns a refused pair into an answer;** `accept` admits `defective` only. Rejected: `accept: [refused]` (P1).
- **One file feeds several extractors, and each pair fails alone.** Rejected: one parser per kind.
- **The manifest is static, checked before code loads, compatible by a digest of the contract's shape plus the contract module's source closure, no runtime tuple.** The contract module's runtime imports stay inside the contract package. Rejected: a version field, a peer range or a deprecation shim.
- **Cross-file facts come from SQL; resolve is the escape hatch; relations needing git are core producers.** Rejected: everything as resolve.
- **git runs pinned:** it reads no system or global config, attributes or ignore file; `GIT_*` is allowlisted; keys are passed explicitly (`GIT_CONFIG_COUNT`): every key VAT uses, `safe.directory` only from `VAT_GIT_SAFE_DIRECTORY` (or its config key), and an allowlist of keys that change git's answer (`core.autocrlf`, `core.eol`, `core.safecrlf`, `filter.<driver>.*`; an omission refuses, per the [register](./fact-extractors-hazard-register.md)), read once from unpinned effective config. These, the repo-local remainder and binary are extent-key inputs (I2). Rejected: declaring git's inputs one by one, a list that cannot fail.
- **`row_set_key` is the one identity of a per-file fact and the unit of eviction.** Rejected: a per-extent presence summary.
- **The cache namespace's end state is exactly a shape digest of the core and store-protocol tables plus the store-protocol implementation's code identity.** Rejected: a namespace keyed on all code identity.
- **Each run gets its own database: only the needed relations, rows restricted to the bound tree's extent; an unhydrated relation does not exist there,** so a statement reaching it refuses. Rejected: an empty schema per relation in the answering database (allowed in a planning database that never answers); an authorizer, which cannot gate rows; TEMP views (I7).
- **Extent derivation is full until the incremental extent lands,** after its design passes a blind review against: submodules, ignored territory, `.gitignore` edits, non-local contributors, collected base trees, diff/read races. Rejected: any delta, copy-forward included, before then.
- **TypeScript facts come from per-file syntax.** Rejected: a per-tsconfig Program.
- **Routability is a traversal rule in `resources`:** the link walker follows links only out of matching members. Rejected: membership or routing making a file traversable.
- **Store off is one flag/env pair.** Rejected: a second control.
- **The store is single-host; liveness is judged by process.** A foreign or unreadable lease means alive; a move or restore clears leases. Rejected: wall-clock leases.
- **CI gates on work counters; time is compared relatively.** Rejected: millisecond ceilings.
- **An instance named in `resources.extractors` that examined nothing is an error, with a per-instance `allowEmpty`. "Examined" counts its routed pairs in the bound extent, from the extent unhydrated, every run.** Rejected: a warning.
- **A data defect in consumed input fails a query or check unless the reader opts in per kind.** Rejected: a warning (I1).

**Reopening:** only a lab record or a new invariant violation, never preference.

## Non-goals

Cross-host or container-shared stores; replay of past trees.

## Deferred

P3 governs only detail beyond the bound row sets; pinned git's dropped keys pass through once shown answer-neutral; limit defaults come from the lab (Measure), the parse pool's recorded in [Parse Limits](./fact-extractors-limits.md) and the extractors' still open; an off-Linux network-fs probe.

## How this ADR changes

- **Implementation is the oracle.** When a build step finds a clause wrong or unbuildable, that step's
  PR amends this ADR in the same change, and names the amendment under its own heading in the PR body.
- **A new hazard becomes a row in the [hazard register](./fact-extractors-hazard-register.md),** not a
  new rule here.
- **A changed Settled decision keeps its old choice as the new rejected alternative,** with the reason.
- **Review covers the amended clause together with the code that proved it.**
