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

- **I2a. Content is the bytes used.** The content key hashes the working-tree bytes alone: no parser kind, path, origin, commit, git OID or cleaned blob. Every byte a producer or stratum consumes is re-hashed at use; a mismatch refuses the pair and writes nothing. A stat-tuple match is trusted only under git's racy rule. *Fails:* rows filed under bytes other than those read. *Enforcer:* a planning-to-use race test; a stat-seam re-hash test. *Amended 2026-11-19; see [Amendment 2026-11-19](#amendment-2026-11-19-content-identity-per-source).*
- **I2b. Code identity is the code that runs:** the closure loaded from a phase's entry modules, lazy imports included, hashed from compiled source, plus the runtime tuple; never the host's whole closure, a lockfile or a version. A warm hit validates it without importing. *Fails:* rows keyed under code that did not make them, or a rebuild missing everything. *Enforcer:* code edits, both ways: code that runs misses, code that does not run never does.

**I3. One answer to "is this pair present".** One per-pair answer for every consumer: statements,
strata, resolve, the registry and non-git lanes. *Fails:* the gap
I1 forbids. *Enforcer:* one predicate per tier: for the blob tier, the `blobFactsReader` answer,
which stored admission and the checks gate both ask (`storedComputeBy` in `stored-admission.ts`),
and which `uncoveredContentKeys` (`store-hydration.ts`) applies for the projection hit
(`readCachedProjection` in `merge.ts`) and the derivation's reuse read (`storedBlobTier`, called
from `storedTierReads` in `stored-reads.ts`); for the harness tier, `harnessUnsettledKeys`; `projection-tier-reuse.integration.test.ts` holds the reuse read to the same answer
for a partly covered key; `store-concurrency.integration.test.ts` shows no reader half a replaced
extent; the blob writer contract (`resources/testing`, run against every store) replaces what was
uncovered at read or evicted since. `local/fact-store-access-boundary` holds every read and write of
the port's stored facts to the run's one reader (`stored-reads.ts`), an exact same-named forward
aside, and keeps the resources testing helpers out of every module but tests. *Not enforced:* that
no module writes a predicate of its own; the rule matches the four member names by spelling, so a
member reached through a variable (`store[name]`) passes, and it does not cover `attachedTo` (the
query lane's copy, which reads inside SQLite for the keys a hit admitted);
`local/projection-sqlite-import-boundary` limits only which files import the backend; and no
run-time check throws on an undeclared read.

**I4. One answer to "which extractors read this path".** Every lane gets the same (instance, variant)
set for a path. Which instances read a path is an extent fact, never in a
`row_set_key`; the chosen variant enters as an option; `mime` enters only through those two. *Fails:* lanes disagree on a file's facts. *Enforcer:* `projection/router.ts` is the one router
module: only it composes the MIME tables (`dev-tools/test/parser-kind-router-boundary.test.ts`), and
every lane that routes through it routes a re-typed fixture alike
(`resources/test/projection-mime-routing-sites.test.ts`). A kind a contract fixes (a `SKILL.md`, a
frontmatter block) is the router's `MARKDOWN_BY_CONTRACT`. The parser-kind decisions still made
outside the router, by extension or by a literal kind, are listed and recorded as a known defect
([parser-kind decisions outside the router](../contributing/known-defects.md#parser-kind-decisions-outside-the-router)).
`dev-tools/test/parser-kind-decisions.test.ts` holds three counted lists both ways: the files holding
a kind literal, the files using `MARKDOWN_BY_CONTRACT`, and the files holding a parser-routed
extension literal; it refuses an aliased or re-bound `MARKDOWN_BY_CONTRACT`, so no use escapes the count.

**I5. Pure producers.** Extract is a pure function of (bytes, options, declared inputs). Resolve is pure over its declared reads and sources. *Fails:*
rows unlike their key, shared across trees. *Enforcer:* the conformance suite fails a set of impure
extractors and gates every built-in; plugins per the [register](./fact-extractors-hazard-register.md).

**Per-file purity (owner ruling 2026-11-25).** A file's parse depends only on its contents and the VAT config, which fixes its parser route. Nothing else a run observes may reach a per-file row. The multi-file layer is a pure function of the manifest, the per-file rows and a closed list of per-run observations: stat results, realpath and link resolution, ignore-oracle verdicts, untracked listings, config and schemas. *Enforcer:* in the `vat validate` parent process on a one-file warm miss, no member is read a second time and no path under the project's parent directory is read beyond the members, the config, its schemas and the ignore files, counted per path at the `node:fs` boundary (`work-counters-validate-edit.system.test.ts`, proved red by a seeded read of each link target in `resolveLinkEntry`). *Not enforced:* reads of files outside that directory, environment and clock observations, the skill and audit link resolvers, and reads in child processes.

**I6. Only key-determined outcomes persist.** A row set is stored whole or not at all, an outcome only
if the key preimage plus the recorded limit determine it, so time, heap, stack-depth
and recursion outcomes, and a parse worker's death, stay per run. A success replaces a stored failure and may be
served under a limit tighter than its own. *Fails:* a timeout on a loaded box
becomes a permanent blank. *Enforcer:* a kill mid-write leaves no partial row set; a seeded per-run
timeout leaves no stored outcome; a seeded success replaces a stored failure.

**I7. One consistent view per answer.** No concurrency hazard makes a run read stored facts as absent or
mixed; each is a [register](./fact-extractors-hazard-register.md) row. *Fails:* parallel checks answer from half of two states.
*Enforcer:* one two-process test per row.

**I8. Termination.** Every run ends with an answer or a refusal within its limit. *Fails:* a never-returning check blocks a commit. *Enforcer:* one stop-at-limit
fixture per blocking class, every wait, child process and handshake included; where the class is
stopped by killing a thread, the fixture proves the thread is gone.

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
- **No opt-in turns a refused pair into an answer;** `accept` admits `defective` only. Rejected: `accept: [refused]` (P1). `resources.validation` `allow` and `severity` govern only how a refused file is REPORTED: they may clear its finding, so a run exits 0 without it, but its pair never becomes facts, and packaging refuses every refused file it reaches, allowed or not.
- **One file feeds several extractors, and each pair fails alone.** Rejected: one parser per kind.
- **The manifest is static, checked before code loads, compatible by a digest of the contract's shape plus the contract module's source closure, no runtime tuple.** The contract module's runtime imports stay inside the contract package. Rejected: a version field, a peer range or a deprecation shim.
- **Cross-file facts come from SQL; resolve is the escape hatch; relations needing git are core producers.** Rejected: everything as resolve.
- **git runs with the operator's config; the extent key is git's answer.** The extent key is git's dirty-corrected tree hash and content keys hash the bytes read, so a config, ignore or attributes change that moves membership misses. Content normalized beneath an unchanged tree hash is an open hole until the stat memo lands ([register](./fact-extractors-hazard-register.md)). Every call through `runGit` scrubs git's redirect env and turns its pathspec env off; the spawns vibe-validate's tree snapshot makes are an accepted register row, requested of vibe-validate. Rejected: pinning git, which drops the operator's config. *Amended 2026-11-19: normalization beneath an unchanged tree hash is outside what VAT supports; see [Amendment 2026-11-19](#amendment-2026-11-19-content-identity-per-source).*
- **`row_set_key` is the one identity of a per-file fact and the unit of eviction.** Rejected: a per-extent presence summary.
- **The cache namespace's end state is exactly a shape digest of the core and store-protocol tables plus the store-protocol implementation's code identity.** Rejected: a namespace keyed on all code identity. Until every stored tier carries code identity, the namespace is the VAT version and nothing else, in a dev checkout as in an installed build: within one version no code, dependency or skill-text declaration change invalidates the cache, and a developer clears it (`vat cache clear`) when they want it cold. Rejected (owner ruling 2026-11-25, cache invalidation kept simple): a dev namespace digesting the checkout path, the parse-facts shape and the skill-text declaration (`skillTextDeclarationDigest`), and a namespace digesting the resolved dependency versions, which separated what a developer can clear and grew the namespace's inputs past the version.
- **Each run gets its own database: only the needed relations, rows restricted to the bound tree's extent; an unhydrated relation does not exist there,** so a statement reaching it refuses. Rejected: an empty schema per relation in the answering database (allowed in a planning database that never answers); an authorizer, which cannot gate rows; TEMP views (I7).
- **Extent derivation is full: every extent row is derived from the current tree's manifest, the per-file facts its content keys name, and the multi-file layer recomputed from those rows.** Per-file facts are reused from the store by content key, so a miss extracts only the files whose key the store does not cover; nothing is copied forward from an extent of another tree. Rejected: copying any extent row forward from a stored extent, and patching a stored extent by a diff against another tree; either needs a design that passes a blind review against submodules, ignored territory, `.gitignore` edits, non-local contributors, collected base trees and diff/read races. Rejected: re-deriving on every miss the per-file facts the store holds, which made a one-file edit cost a whole-tree extraction (was: extent derivation full until the incremental extent lands, any delta rejected before then; reuse by content key is not a delta, since no extent row survives from another tree).
- **One reader of the store per run, and no stored row decoded twice in a process.** Every population and lens of a run reads and writes the store through the run's one reader (`PopulationRun.stored`, `stored-reads.ts`); no other module reaches the port's `readBlobFacts`, `readExtent`, `writeBlobFacts` or `writeExtent` (`local/fact-store-access-boundary`, its exemptions held both ways against the tree). The reader holds what it read of each content key per table (per reference form of `blob_references`; the two harness tables as one unit), each from one read: a later request reads only what it does not hold, with the key's ledger presence (`FactStore.readBlobFacts`'s required `present`) in the same transaction, and a key found absent is forgotten whole and answered uncovered. So no caller guesses its widest request up front: the query lane reads the AST forms, and a populating lens after it reads only the lexical ones. A tree is held from one read, and a wider extent request reads it again whole and counts as a repeat, since extent rows are not immutable: the claude-context lane asks first for the whole extent for its import roots. A row decoded again from one store file while a store on it is open counts `store.rows.decoded.repeated` (a ledger in the projection-sqlite store module, one per file, shared by every open connection to it and dropped at the last close), asserted zero in every arm of the `vat validate` system tests, clean and edited, parent and checks child, and in the warm claude-context arms (`vat claude context`, and `vat resources query` running the claude-context lens). The ledger is kept only while something reads the counts (`workCountsObserved`: the counts dump, an in-process read, a test reset), so a production run pays nothing for it. Rejected: memoizing the store's reads beneath a second reader, which hides a second path rather than deleting it. The query lane's copy attaches the store through the port's required `attachedTo` (its target typed by what an attach uses, `StoreAttachTarget`, so the port names no SQLite module): every wrapper of the port forwards it or does not compile, and a test double with no database file refuses it. Rejected: refusing a wrapper at run time (`instanceof` on the backend's class), which compiled a wrapper that dropped the copy and failed only when a hit ran. *Not covered:* the parent and its checks child are separate processes, so the same rows decoded once in each are not a repeat (a tracked cost, `known-defects.md`); the query lane's child decodes no lexical reference and copies them inside SQLite instead.
- **TypeScript facts come from per-file syntax.** Rejected: a per-tsconfig Program.
- **Routability is a traversal rule in `resources`:** the link walker follows links only out of matching members. Rejected: membership or routing making a file traversable.
- **Store off is one flag/env pair.** Rejected: a second control.
- **The store is single-host; liveness is judged by process.** A foreign or unreadable lease means alive; a move or restore clears leases. Rejected: wall-clock leases.
- **CI gates on work counters; time is compared relatively.** Rejected: millisecond ceilings.
- **An instance named in `resources.extractors` that examined nothing is an error, with a per-instance `allowEmpty`. "Examined" counts its routed pairs in the bound extent, from the extent unhydrated, every run.** Rejected: a warning.
- **A data defect in consumed input fails a query or check unless the reader opts in per kind.** Rejected: a warning (I1).

**Reopening:** only a lab record or a new invariant violation, never preference.

## Non-goals

Sharing a store across machine kinds (for example a Windows runner and an Ubuntu runner); replay of
past trees. Restoring a store onto another machine of the same kind is in scope. *Amended
2026-11-19; was "Cross-host or container-shared stores"; see
[Amendment 2026-11-19](#amendment-2026-11-19-content-identity-per-source).*

## Deferred

P3 governs only detail beyond the bound row sets; limit defaults come from the lab (Measure), the parse pool's recorded in [Parse Limits](./fact-extractors-limits.md) and the extractors' still open; an off-Linux network-fs probe; storing key-determined limit outcomes (the output and input caps) under their limit, until which they are per run like the rest ([register](./fact-extractors-hazard-register.md): `Cost: key-determined parse-limit breaches`); supervising the parse pool off the main thread, until which the heap sampler and the wall-clock timer run on the parent's event loop and a parent blocked past the stall-to-crash window lets V8 stop a worker first (register: the process-wide heap flag row); serving a population's held pairs from the store around a refused one, until which one refusal re-derives the whole population every run while it persists, counted and named as `store miss: N refused pair(s)` ([register](./fact-extractors-hazard-register.md): `A check or query answers at exit 0 over a corpus missing a file`, its store-hit clause).

## Amendment 2026-11-19: content identity per source

The governing text is
[Content Keying and Git: Decision](./content-keying-and-git.md#decision-content-identity-is-per-source).
This ADR changes as follows; each old choice becomes a rejected alternative.

- **I2a, content key.** Was: the content key hashes the working-tree bytes alone, never a git OID or
  cleaned blob, and every consumed byte is re-hashed at use. Now: content identity is per source. A
  file git holds (tracked, unmodified since the index) is identified by its git blob object id; any
  other file by VAT's content key. Within one run each file is read and hashed at most once and every
  lane shares that read and key; "re-hashed at use" means the producer consumes the one read that
  produced the key, never a second read to re-prove it. Rejected: a working-tree-bytes key for
  git-held files, because line endings, `eol`/`text` attributes, `core.autocrlf` and clean/smudge
  filters are not semantic to VAT, so the cleaned blob names the content.
- **Normalization beneath an unchanged tree hash.** Was: an open hole until the stat memo lands.
  Now: outside what VAT supports; VAT does not defend against normalization differences. Rejected:
  closing the hole for files whose meaning depends on normalization.
- **Warm path.** A warm store hit proves the tree unchanged; no lane re-admits or re-hashes files to
  prove it again, and a mid-run re-check uses git's tree comparison. "One run" is one VAT process;
  the supervised checks child of `vat validate` is a separate process (on a warm store it can start during the resources phase, see
  [resource-scanning-and-caching 3.7b](resource-scanning-and-caching.md#37b-the-checks-child-starts-during-the-resources-phase-on-a-warm-store)). Enforced by
  `packages/cli/test/system/work-counters-validate.system.test.ts` (`content.read`,
  `content.hashed`, the parse lookups, `registry.admitted`, `registry.built`). The store is on by
  default; a store-off run is held to correctness only.
- **Non-goals.** Was: cross-host or container-shared stores. Now: sharing across machine kinds;
  same-kind restore (CI save and restore keyed per runner OS) is in scope. Content-keyed entries hit
  across machine kinds, and by the first change above that hit is correct; machine kinds are
  separated by the CI cache's own key and the extent key's root id. I2's runtime tuple is the one
  input that can change facts for the same bytes. Rejected: a host-bound store, which forbids CI
  cache restore for no soundness gain.

Built: the one-read rule, as one admission per VAT process run (`RunContext`, `RunPopulation`, and
registry views per phase; see [content keying](./content-keying-and-git.md)), for `vat validate`,
`vat verify`, `vat resources validate`, `vat skills validate` and `vat resources scan`; `vat rag index`
admits through one run but its index step re-reads each file, and `vat audit`, `vat skills build`,
`vat claude plugin build` and `vat ard emit` are not covered yet. Store hydration is built for the
resources view: on a warm store hit each member is admitted from its stored blob facts
(`stored-admission.ts`) with no read, hash or parse; skill discovery and the skills phase are served
from stored `skill_text` facts (`skill_text_facts`, `skill_text_matches`), which the markdown parse
job computes beside the other markdown blob facts, with a per-file fallback that reads and scans a
file the store does not serve, counted as `skillText.storeMiss`. Not built: the git-OID path
(planned with incremental repopulation) and I2's runtime tuple in the parse-cache and blob keys (a
namespace carries the VAT version only).

## How this ADR changes

- **Implementation is the oracle.** When a build step finds a clause wrong or unbuildable, that step's
  PR amends this ADR in the same change, and names the amendment under its own heading in the PR body.
- **A new hazard becomes a row in the [hazard register](./fact-extractors-hazard-register.md),** not a
  new rule here.
- **A changed Settled decision keeps its old choice as the new rejected alternative,** with the reason.
- **Review covers the amended clause together with the code that proved it.**
