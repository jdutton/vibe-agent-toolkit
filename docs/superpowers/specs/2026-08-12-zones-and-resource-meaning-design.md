# Extents, lenses, and the resource-meaning framework — design

> **Status:** design, not built. Written 2026-08-12; **revised the same day after two independent
> adversarial reviews** (one model-coherence, one fact-check). The reviews produced 3 fatal and 6
> serious findings against the model, and 5 false factual claims. All are folded in; §18 records what
> changed and what survived, because the failure pattern is itself evidence.
>
> **Supersedes** §6 and §12 of [`2026-08-06-resource-projection-and-parse-cache-design.md`](./2026-08-06-resource-projection-and-parse-cache-design.md).
> That spec's stages 0–2 shipped; read it for the parse cache, the pipeline restructure, and the
> correctness harness. Where the two disagree about the projection, this one is current.
>
> ⚠️ **TEMPORARILY COMMITTED, force-added past `.gitignore:89` — REMOVE BEFORE PR MERGE.**
> `docs/superpowers/` is gitignored by policy and specs are normally never committed. Jeff
> deliberately overrode that on 2026-08-12 for safekeeping while this branch is long-lived and
> unmerged. **Before merging: either `git rm --cached` both 2026-08-12 spec files and let the
> gitignore reassert, or move their content into the PR description for posterity.** Verified free of
> proprietary adopter names before commit; keep it that way — any edit that adds one must be scrubbed
> before the next commit, and `--no-verify` doc commits bypass the gate that would otherwise catch it.
>
> The durable committed references are
> [`docs/architecture/resource-projection.md`](../../architecture/resource-projection.md) and
> [`docs/architecture/zones.md`](../../architecture/zones.md).
>
> **Companion:** [`2026-08-12-zones-adversarial-review-findings.md`](./2026-08-12-zones-adversarial-review-findings.md)
> preserves the two reviewers' full reasoning and evidence — read it before reopening any decision
> listed in §18, and before working §17's open risks, which point into it.
>
> **This file exists in two places.** Working copy: the `resource-projection-stage3` worktree.
> Backup: the **main checkout** at the same relative path, because the worktree is disposable and
> this file is gitignored so git cannot protect it. **The worktree copy is authoritative while that
> worktree exists** — re-copy to the main checkout after any substantive edit.
>
> **Terminology changed in revision.** What v1 called a *storage zone* is now an **extent**; what it
> called a *viewer zone* is now a **lens**. "Storage" read as *where we keep our data* (the cache)
> when it meant *what exists in the world*.

---

## 1. What this is

Stage 3 shipped ten projection table *shapes* as versioned Zod schemas. Nothing populates them. The
original plan deferred zone modelling — skill/plugin/marketplace membership — past population.

That plan is withdrawn. Every capability worth having turns out to be a **cross-zone** question, and
a projection that cannot express zones would force compromises in the very next phase. This is now
confirmed empirically rather than argued: reviewing the schema *against itself* produced a clean
bill; reviewing it against **what population would require** produced three fatal findings.

The framing that drives this, in the owner's words: **we are creating a knowledge-meaning framework
on top of our resources.** The projection is not a cache of parse results. It is data about the
resource space that many lenses read, each extracting a different meaning from the same facts —
including lenses VAT will never ship, supplied by config or invented on demand.

## 2. Thesis: data, not logic

VAT's knowledge about a corpus lives inside procedures. The packager knows which files belong to a
skill because it walks a link graph and bundles them. `resolveLinks()` knows about references because
it stamps them. None of that is available to anything else, and none of it can answer a question it
wasn't written to answer.

The projection turns that knowledge into **iterable data**. Questions previously infeasible become
ordinary queries; questions nobody anticipated become answerable without new traversal code.

Performance corollary, a fundamentals concern rather than an optimisation:

> **The substrate is populated once per lifecycle phase and iterated many times. No consumer
> re-derives it.**

⚠️ **Scope of "incremental," corrected.** Only the **blob layer** is incremental, and it already was
in shipped stage 2. The path-dependent tables are rebuilt cold on every run — twice for `vat build`
(§13). The honest claim is *once-per-lifecycle-phase rather than once-per-check*, which is still a
large win over today, but it is not incrementality and must not be sold as such.

## 3. The model: extents and lenses

**A zone is an extent plus a rule for reading it.** Four facets, independent because real cases vary
each one alone:

| facet | question |
|---|---|
| **extent** | which resources exist here |
| **traversal policy** | which reference kinds are followed |
| **resolution semantics** | how a reference becomes a target |
| **interpretation** | what counts as a reference at all |

Two species:

- An **extent** answers *what exists*: git (tracked ∪ untracked-not-ignored), the filesystem, a build
  tree, an installed plugin directory, a package namespace, a marketplace namespace.
- A **lens** answers *what does this reader traverse and how does it resolve* — **over an extent**.

The split does real work: GitHub's renderer sees git and follows `[]()` but not `@`; Claude sees the
**filesystem** — including gitignored build output — and follows `[]()`, `@` (four hops) and
`.claude/rules` `paths:` globs. "Claude sees gitignored build output the git extent cannot" is not an
intersection; it is a **different base**. Set operations remain useful for reasoning queries, but are
derived, not primitive.

### 3.1 Visibility is extent

There is deliberately **no visibility relation**. "The build extent cannot see source" is what
happens when a reference's target is not a member of that extent. This is the mechanism behind the
`files:`-blindness defect family, converted from a behaviour you must remember into a row you can
query.

### 3.2 Lenses are ephemeral; extents are data

A lens may be **declared in config or invented on demand** to answer a question nobody anticipated.
Therefore the set of lenses is unknown at population time, and:

| materialised (data) | derived per lens (function) |
|---|---|
| resource identities | edges |
| realizations | resolution and its tier |
| blob reference candidates (shape only) | which candidates count as references |
| extent memberships | traversal reachability |

This sharpens the thesis: **facts are data, meaning is a function applied to them.** Inventing a lens
costs a definition, not a population pass. Caching a lens's results is an optimisation with no
data-model commitment.

### 3.3 Lens identity factors into resolution context + entry point

**This is the fix for a fatal cardinality finding, and it changes the model rather than tuning it.**

A naive "one `claude-context` zone per directory" gives 466 instances in this repo (measured
2026-08-12: 466 directories contain at least one tracked file). Those 466 differ **only in entry
point** — they share extent, resolution semantics, interpretation, and all of traversal policy except
the ancestry chain. Keying edges on the instance would store identical resolutions 466 times, growing
as `O(|references| × |directories|)` with no mitigation available.

Worse, "materialise on demand" cannot help the **first named consumer**: the always-loaded budget
check reports a per-directory total, so its parameter set *is* every directory by definition.

So lens identity splits:

- a **resolution context** — extent + resolution semantics + interpretation + reference-class policy.
  Edges and extent memberships key on *this*.
- an **entry point** — the directory (or other parameter), a cheap row naming its ancestry chain,
  joining to a shared resolution context.

All 466 `claude-context` instances then share one resolution context plus 466 small entry rows, and
the budget check becomes a join rather than 466 materialisations.

### 3.4 Zone kinds

Open vocabulary — adding a kind adds rows, never migrates the schema.

| kind | species | notes |
|---|---|---|
| `filesystem` | extent | everything on disk under a root |
| `git` | extent | tracked ∪ (untracked ∧ ¬ignored) |
| `tree` | extent | roles `source` / `dist` / `vendored` |
| `package` | extent | workspace + declared deps, honouring `exports` |
| `skill` / `plugin` / `marketplace` | extent | nested; **closure-defined**, see §7.2 |
| `install` | extent | what an installed plugin reaches |
| `registry` | extent | `installed_plugins.json` / `known_marketplaces.json` |
| `collection` | extent | **retained** — see below |
| `claude-context` | lens | entry point = directory |
| `github-render` | lens | over `git` |
| `wiki` | lens | modelled, not built |
| config-declared | either | §9 |

**`collection` is retained as a zone kind — v1 removed it in error.** v1 argued a collection creates
no visibility boundary and therefore is not a zone. That tests *one* facet against a four-facet
definition. A collection's `frontmatterSchema` determines which frontmatter fields are
`format: "uri-reference"` and therefore **which frontmatter values are references at all**
(`packages/resources/src/schema-uri-walker.ts`; `skill-packager.ts:1038` reads
`collectionConfig.validation?.frontmatterSchema`; `:1025` documents that collections without one are
skipped). Two files with byte-identical frontmatter in different collections yield different
reference sets. That is the **interpretation** facet, varying by collection.

## 4. Identity and realizations

### 4.1 The zone leaves the hash

v1 proposed `resourceId = hash(originating storage zone, name-or-path at origin)`. **That was fatally
wrong, twice over:**

1. **No precedence.** A single file is simultaneously in `filesystem`, `git`, `tree:source`,
   `package:X` and `skill:Y` — all extents, all plausibly "originating." Nothing defined which wins,
   so the id was undefined.
2. **Phase-dependence.** §13 has `vat build` populating twice. A stale artifact under `dist/` is
   `filesystem`-only pre-build and `tree:dist` post-build, so the same bytes at the same path get
   **two ids inside one run** — and the flagship survival lens joins across exactly those two
   populations.

The fix is not precedence rules. **Nothing ever reads the zone back out of the hash** — the id is
opaque. It was doing no work while creating two failure modes.

> `resourceId = hash(rootId, canonicalPath at first observation)`, opaque.
> Origin zone is recorded as an **attribute**, not hashed.
> A **realization** is `(resourceId, extentId, path, …)`.

**`canonicalPath` needs an explicit rule, because three shipped columns exist for this reason.**
`pathLower`/`basenameLower` exist so case-insensitive matching is a column, not a function call.
Hashing a raw path defeats them: on a case-insensitive filesystem `docs/Readme.md` seen via the
filesystem extent and `docs/README.md` recorded in git's index would mint two identities for one
inode — and Node's two `realpath` implementations disagree on which casing they return. **Rule:
canonicalPath is the git-index casing where the path is tracked, otherwise the on-disk casing from
`fs/promises.realpath`, with symlinks resolved.** A symlink and its target therefore share one
identity; a symlinked directory loop mints one identity per real file, not per traversal.

Consequences:

- One source file bundled into three skills is **one identity, four realizations**.
- A file generated only into a build tree is minted there.
- **Zero realizations is legal** — a plugin named in a marketplace manifest but not installed has no
  local path. This generalises the existing declared-but-unwritten idea to *known but not present*,
  and makes `resources` an **entity** table: plugins, skills, marketplaces and external document
  libraries are all linkable resources that are not markdown content.

### 4.2 Most columns are per-realization, not per-identity

v1 said `resources` "loses its path columns." **That was far too narrow, and one column is fatal.**

The packager **rewrites content** on the way into a bundle (`buildRewriteRules` / `transformContent`,
`skill-packager.ts:729-754` repoint every bundled link at its flattened dist path). So the dist
realization's *bytes differ from the source realization's bytes*, and the two realizations of one
identity have **two different content keys**. A scalar `resources.contentKey` makes the
`resource → blob` join — which every blob-derived fact depends on — undefined for any resource
realized in more than one zone.

So: `contentKey`, `mtime`, `exists`, `isDirectory`, `gitignored`, `isSymlink`, `symlinkResolves`,
`dir`, `depth`, `ext`, `pathLower`, `basenameLower` **all move onto `resource_realizations`**.
`resources` keeps `(resourceId, kind, origin, observed, vatId)`.

`gitignored` is the second obvious one: it is a git-extent fact, and the proving ladder's rung 2
reads it — from a table where, under v1, it could not have meant anything.

### 4.3 `(extentId, path)` cardinality must be stated

v1's realization model was one-identity-to-many-paths only. **The inverse occurs in shipped code.**
`skill-packager.ts:624` and `:1094` record that `a-b/c.html` and `a/b-c.html` both flatten to
`a-b-c-html`; `registerBundledAssets` catches `DuplicateResourceIdError` and its comment states that
catch is the **only** place a bundled-asset collision is ever observable. `files:` remapping can
produce the same condition.

So two identities can land at one dist path. `ResourceRealizationRowSchema` has no uniqueness
constraint and v1 never mentioned the case — meaning any consumer resolving `(extentId, path)` gets a
nondeterministic answer, faithfully reproducing the `resolveLinks()` last-write-wins bug §16 promises
to fix.

**Rule: `(extentId, path)` is unique.** A contributor that would emit a second realization at an
occupied path emits a **collision condition row** instead, preserving the diagnostic the current
catch block is the sole carrier of. This also disproves v1's "duplicate-bundled-resource for free" —
the *interesting* duplicate is this collision, not one identity in four zones.

## 5. Blob layer: shape, never meaning

The parse cache is content-addressed, so **the same bytes share one entry across every corpus that
contains them**. The blob layer may store only what a lexer can determine without leaving the file.

A cached fact like "`@vibe-agent-toolkit/utils` is an npm package" would be true here and false
elsewhere, served confidently to both — the same defect class as a shared `ParseResult` letting one
skill inherit another's id: *a cache entry carrying a fact that is not a function of its key*. The
namespace directory (`parse-cache.ts:69-77` — no version field, on purpose, because the namespace is
derived from the running build) protects against shape changes and offers nothing against this.

`blob_references` (renamed from `blob_links` — a markdown link is certainly a link, an `@`-prefixed
token is not) records:

- position: line, column, ordinal
- **syntactic form**: `markdown-link` | `markdown-link-reference` | `markdown-definition` |
  `at-prefixed` | `env-anchored` | `bare-token`
- **lexical features**: extension present, leading `@`, slashes, variable expansion (`${VAR}`,
  `$VAR`, `%VAR%`, `$env:VAR`)
- **context**: `inCodeSpan`, `inFence`

The last two are load-bearing, not decoration: Anthropic documents that import parsing skips code
spans and fenced blocks, so they decide whether an `@` token is an import at all. Both columns
already exist in the shipped schema; **nothing produces them today.**

Everything else is a lens question. `xxx/yyy` is simultaneously path-, package- and
plugin/skill-shaped; only an extent can say which, and **the answer may legitimately differ per
lens** — the same token can resolve as a relative path in the source extent *and* as a package
specifier in the package extent. Even *"is this an import"* is path-dependent, since an `@` token
only means import in a file named `CLAUDE.md`, `CLAUDE.local.md`, or under `.claude/rules/` — and a
filename is not a blob fact. All such classification lands post-enumeration (1′ / phase 4), never in
phase 1.

*This section survived both reviews unbroken.*

## 6. References, edges, resolutions

### 6.1 Resolution splits out of `edges`

v1 kept `edges(src, linkOrdinal, zoneId, dstResource, dstAnchor, kind, resolution)` with a **scalar**
`dstResource`. That cannot express what the design itself requires:

- **Wiki resolution is many-candidate by nature.** `[[Configuration]]` in a flat, case- and
  space-forgiving namespace matches four files. The key `(src, linkOrdinal, zoneId)` forbids multiple
  rows; `resolution: 'ambiguous'` discards N and the candidate set — making §16's own followability
  metric ("N-way ambiguity") unbuildable; picking a winner **is** last-write-wins, the shipped bug
  §16 promises to fix. v1 proposed to fix last-write-wins while shipping a schema that can only
  express it.
- **Scored inference needs candidates.** The motivating diagnostic is *"that reference has a 95%
  match in the git extent but not in the skill extent."* One `dstResource` column holds zero scored
  candidates.

So:

```
edges            (src, refOrdinal, resolutionContextId, kind, origin, resolution)
edge_resolutions (src, refOrdinal, resolutionContextId, candidateOrdinal,
                  dstResource, dstAnchor, score)
```

Single-target resolution is the N=1 case at the cost of one join. Ambiguity, interwiki, and scored
inference become rows instead of migrations. **This must land before population; v1's sequencing
omitted it.**

### 6.2 Edge properties

- **`origin`** — `authored` | `implicit` | `inferred`. Cannot be retrofitted: it changes the meaning
  of every row. Implicit edges (CLAUDE.md ancestry, a rules file matching by `paths:`) have no
  `blob_references` row, so `refOrdinal` is nullable.
- **`kind` opens** — `LinkTypeSchema` cannot express `ancestor-context` or `rules-glob-match`.
- **A row exists only where the lens traverses that kind.** A renderer's relation to an `@` import is
  *no edge*, not an unresolved one; conflating them would report false brokenness on every `@` import
  in every repo. Absence is interpretable because the lens carries its traversal policy.

### 6.3 Graded resolution

`resolution` is already an open vocabulary, so this needs no schema change:

| tier | meaning |
|---|---|
| same plugin | co-bundled — available whenever the referrer is |
| same marketplace | installable from an already-trusted source; may not be installed |
| known other marketplace | reachable, not installed |
| unknown marketplace | no path to it |
| auth-required | reachable with credentials (linkAuth) |
| nonexistent | dead |

### 6.4 Reference classes

| class | certainty | promoted by |
|---|---|---|
| markdown link | certain | every lens |
| `@` import outside code spans | certain syntax | Claude, Gemini — **not** GitHub |
| env-anchored path | certain syntax, lens-conditional resolution | plugin extent resolves; standalone-skill extent cannot |
| npm/package specifier | shape only | package extent |
| plugin/skill reference | shape only, probabilistic | registry extents |
| path-shaped token in a code span | **inferred, scored** | LLM lens — deferred, §16 |

This resolves the `@` collision: `@packages/foo/bar.md` is an import, `@vibe-agent-toolkit/utils` is a
package specifier. Both are `at-prefixed` at the blob layer; only a lens decides.

## 7. Contributors and resolvers

`resources` coordinates observation and must not hold business knowledge — what a skill is, what an
external URL means, how a project's domain classifies a document.

### 7.1 Two kinds of participant

- **Extent contributors** produce membership **rows**. Data, at population. (Inventory layer, git,
  package manifests, config.)
- **Resolvers** provide resolution **semantics** a lens invokes — path, node module, registry, title.
  Functions, at query.

Contributors read the base projection and return rows; `resources` merges without interpreting. No
contributor calls into `resources` internals.

### 7.2 Merge is a stratified fixpoint, not a sequence

v1 claimed "passes are explicitly sequenced." **That is false for the most important contributor.**
`walk-link-graph.ts` (`visitedResourceIds: Set`, `queue: Array<[ResourceMetadata, number]>`) is a
bounded BFS to closure: skill membership at hop *n+1* depends on edges out of hop *n*, on whether hop
*n* is `routable`, and on `excludeRules`/`maxDepth`/`gitignored` at each hop. So:

```
skill-extent ← edges ← resolutionContext(skill) ← skill-extent
```

A cycle, not an ordering. A second is already in the shipped schema: `ResourceTagSourceSchema`
includes `'zone'` (tags derived *from* membership) while zones may need tags.

**Merge is therefore an explicit fixpoint over a stratified dependency graph.** Acyclic strata get
one pass; the closure stratum iterates to a fixed point with a declared iteration cap and **loud
failure on non-convergence**.

### 7.3 Closure must be declarable, or §9's line breaks

If closure-defined extents require privileged code, then the adequacy test ("a built-in must be
expressible the way a config-declared one would be") and the declarative-only rule are jointly
unsatisfiable. So config gets a **closure primitive**:

```yaml
extent:
  closureFrom: <resource>
  follow: [<reference classes>]
  maxDepth: <n>
  exclude: [<globs>]
```

`packagingOptions` (`linkFollowDepth`, `excludeReferencesFromBundle`) is already this in disguise.

### 7.4 Provenance is two-part — and the v1 completeness claim is deleted

v1 claimed recording *which contributors ran* prevents a check's population differing silently
between commands. **It does not.** A contributor set is a set of identities; divergence is a
difference in *extent*, and §3.2's on-demand materialisation makes partial divergence the common
case.

Concretely: a skill with `publish: false` is **in** the extent `vat validate` asks for (packaging
correctness is not conditional on shipping) and **out** of the distribution-consistency extent
`vat verify` asks for. Both record the same contributor set. Both report complete. A gate counting
broken bundled references returns 12 and 11. Structurally: `vat build`'s two populations share a
contributor set and answer differently.

So provenance records **`(contributorId, parameterSet, extentDigest)` per zone instance**, plus the
**lens definition and its parameters** for any result — extent provenance and lens identity together,
or two runs cannot be shown to have answered the same question. A check **declares the extent it
requires** so mismatch is checkable rather than merely recordable.

**If the extent digest does not land, the completeness claim is deleted rather than weakened.** It
would otherwise be cited as protection it does not provide.

### 7.5 A requested kind with no registered contributor throws

Never an empty extent. An empty set is a confident wrong answer.

### 7.6 Ad-hoc lenses have unreviewed populations

The value of inventing a lens on demand is that nobody vetted it; that is also the hazard. **Anything
that fails a build must run through a named, declared lens** — never an improvised one. Exploration
and reasoning may use whatever they like.

## 8. Vocabularies that open

| vocabulary | today | change |
|---|---|---|
| `ZoneKindSchema` | closed enum of 6 | **open** |
| `resource_tags.source` | closed enum of 5 | **open** — becomes contributor id |
| `edges.kind` | `LinkTypeSchema` | **open** |
| `edges.resolution` | open string | unchanged — correct as shipped |
| `resources.origin` | open string | unchanged — correct as shipped |
| `role` | gated to `tree` by `superRefine` | **moves to the zone entity**; gating removed |

## 9. Configurability

A config-declared lens supplies an extent, a **binding environment** (explicit variable values —
`${CLAUDE_PLUGIN_ROOT}` is the built-in instance), a traversal policy, a **resolver selected by
name**, and optional external-target meaning (href patterns → entity kinds with metadata).

The SharePoint case decomposes into existing mechanisms: the href resolves to an **entity resource**
with zero local realizations; tenant identity is `resource_tags` with a config `source`; known facts
are the binding environment; auth-required is a resolution tier. **Four config-supplied facts, zero
new tables.**

> **v1 inconsistency, now resolved.** v1 required origin to be a storage zone while minting the
> SharePoint entity from a *viewer's* href pattern — leaving it with no legal id. Dropping the zone
> from the hash (§4.1) dissolves this.

**Declarative data only — never project-supplied code.** Patterns, bindings, metadata, a named
resolver, and the closure primitive of §7.3. A resolver *function* from config would be a
code-execution surface and would break the promise that extensible tagging adds no plugin API.

**linkAuth is the first shipped instance of this framework** — not, as v1 claimed, an unbuilt design.
`packages/utils/src/link-auth/` ships nine modules **including `macros.yaml`**, `packages/resources/`
ships five more, `docs/validation-codes.md` carries 12 `LINK_AUTH_*` codes, and issue #113 is
**closed**. So "built-ins ship as macros, generic config, not privileged code" is a mechanism on
disk, and `notFoundMeaning` (`packages/utils/src/link-auth/resolve.ts:52`) is the interpretation
facet already in production. Generalise it; do not reinvent it.

> **Design note.** `macros.yaml`'s vocabulary is auth-provider-specific today. Generalising it into
> the lens/resolver vocabulary is expected work, not a defect — flagged so the generalisation is
> deliberate rather than accidental.

## 10. Package placement and rename

### 10.1 `agent-schema` → `@vibe-agent-toolkit/schema` — approved

The package declares itself *"JSON Schema definitions and TypeScript types for VAT agent manifest
format"* (`package.json:4`, verbatim). Measured contents, 2,520 lines total:

| content | lines | share |
|---|---|---|
| validation framework (`validation-codes` 699, `-framework` 414, `-issue` 165, `-config` 19) | 1,297 | 51.5% |
| agent manifest 178, result-types 363, interface 67, tool 50, envelopes 44, llm 41 | 743 | 29.5% |
| package-metadata 201, schema-utils 87, metadata 55, **`resource-registry` 34** | 377 | 15.0% |
| `index.ts` | 103 | 4.1% |

It is **VAT's vocabulary root** — where shared shapes go that everything must name without taking a
dependency. Agents were the first tenant. It is dependency-free *at runtime*; it carries a devDep on
`utils`, so only `utils` is literally dependency-free.

**9 packages depend on it** — `agent-config`, `agent-runtime`, `agent-skills`, `claude-marketplace`,
`cli`, `gateway-mcp`, `resources`, `vat-development-agents`, `vat-example-cat-agents`. (v1 said 10; a
grep matched the package's own `name` field.) Lands as its own mechanical commit **before** any
projection work.

### 10.2 Placement

```
utils ─┐            schema (renamed) ─┐
       └──> resources <──────────────┘        (agent-config omitted from this view;
              ├──> rag ──> rag-lancedb         agent-skills depends on it too)
              ├──> resource-compiler
              └──> agent-skills ──> claude-marketplace ──> cli
```

- **Vocabulary and row shapes** → `schema`.
- **Substrate** (blob facts, identity, realizations, merge, filesystem/git/package extents) →
  `resources`, which owns the parse cache these derive from and stays independently useful for plain
  markdown projects.
- **Agent-artifact contributors** → `agent-skills` / `claude-marketplace`, which own the inventory
  layer.
- **Composition** → `cli`.

**Rejected: a `projection` package above `claude-marketplace`.** `rag` and `resource-compiler` depend
on `resources`, so the projection living there would make `blob_sections` unreachable to the RAG
chunker — deleting a concrete identified win. *Both reviews confirmed this argument.*

## 11. Proving lenses

| rung | pair | uniquely proves | resolver |
|---|---|---|---|
| `@` reachability | claude-context vs github-render | traversal policy, reference classes, implicit edges | new, small |
| visible-to-you / invisible-to-CI | filesystem vs git | **extent, and only extent** | trivial (`git check-ignore`) |
| package references | prose/config vs package extent | non-filesystem resolution semantics | `resolveAssetReference` — ships |
| plugin/skill references | skill vs marketplace vs registry | graded resolution; entities without paths | inventory + registry schemas — ship |
| source→bundle survival | git-source vs skill-dist | cross-zone identity, path remapping | the flagship |

⚠️ **v1's sequencing argument is withdrawn.** v1 claimed rung 2 is "the same query as source→bundle
survival on an easier pair." It is not. Rung 2's pair is *nested* (git ⊆ filesystem, same tree, same
resolution, same interpretation) and involves **no path remapping** — whereas dist paths are
flattened slugs produced by `buildPathMap`/`resourceNaming`/`stripPrefix`, so identity mapping is
where survival's difficulty actually lives. Rung 2's oracle (`git check-ignore`) is independent;
rung 5's would be the packager itself, the artifact under test. Rung 2 stays as a cheap extent proof;
it proves nothing about the flagship's mechanism.

**The honest cheap proxy for survival** is source tree vs a `vat build --dry-run` dist manifest with
link rewriting disabled — same transformation shape, cheap oracle.

The shipped **`PACKAGED_UNREFERENCED_FILE`** (singular; `validation-codes.ts:121`) and the
`FILES_GLOB_*` blindness lanes are the **differential oracle**: the lens query must reproduce their
verdicts exactly on the frozen corpus.

### 11.1 Measured — population is the hard part

Probed 2026-08-12. 34 distinct `@vibe-agent-toolkit/*` names in tracked markdown; **23** scoped
workspace packages exist (the 24th `packages/` entry is unscoped `vibe-agent-toolkit`); **11
nonexistent**.

**Ten are forward references; one is genuinely stale.** v1 claimed all eleven were forward.

- Forward: `agents`, `deploy`, `llm-providers` (architecture README "Phase 3: Future Packages");
  `rag-pinecone`, `rag-weaviate` (`packages/rag/README.md:98`, prefixed "Future:");
  `runtime-state*`, `skill-runtime` (`docs/research/`, proposing new packages).
- **Stale: `@vibe-agent-toolkit/cat-agents-skill`** —
  `packages/vat-example-cat-agents/docs/distribution.md:156` says
  `npm install -g @vibe-agent-toolkit/cat-agents-skill`; the real name is
  `@vibe-agent-toolkit/vat-example-cat-agents`. **A published install instruction for a package that
  does not exist.** (`CHANGELOG.md` also names `runtime-claude-skills`, a historical rename — a 12th
  if changelogs are in the population, which is itself a population decision.)

So the lens has a live example, and the finding is stronger than v1 reported. But the false-positive
class dominates: **a naive check fires on all eleven.** This is the same failure the earlier spec
recorded for `SKILL_DESCRIPTION_COLLISION` — 9 reported pairs, all fixtures, loudest on the authoring
project. **The hard part is population, not resolution**, and severity gets settled against the
adopter corpus, not against a guess.

Separately: **no bare `@scope/pkg` appears outside backticks in any of the 9 `CLAUDE.md` files**, so
Claude Code's import parser skips them all — VAT is safe by accident. Caveat: the population is **6
references across 2 files**, so it is a 6-sample accident, not a corpus-wide property. A bare
`@vibe-agent-toolkit/utils` in a `CLAUDE.md` would be a silently failed import — a defect class with
no name today.

## 12. Vendor claims

Fetched and verified 2026-08-12 against [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory);
annotate `@vendor-claim` and re-verify on version bumps.

1. `@path` imports; relative paths resolve **relative to the importing file**, not cwd; absolute and
   `~/` allowed.
2. **Maximum depth four hops.** The 2026-08-06 spec charges only "one level," so it **understates**
   always-loaded cost on any chained repo.
3. **Import parsing skips code spans and fenced blocks** (with a documented backtick workaround).
4. **`.claude/rules/*` without `paths:` load at launch**, same priority as `.claude/CLAUDE.md`. The
   earlier spec's "rules are always `selected`" rests on a 53/53 base rate, not a rule; `loading`
   must be computed per-file from frontmatter.
5. **Block-level HTML comments are stripped before injection** — but *comments inside code blocks are
   preserved*.
6. `claudeMdExcludes` removes ancestor files by absolute-path glob; `CLAUDE.local.md` and
   `./.claude/CLAUDE.md` both count; **managed-policy CLAUDE.md cannot be excluded**.

Other standards:

7. **No markdown standard has an include directive.** CommonMark treats transclusion as out of scope
   (wiki "Proposed Extensions", never adopted). AsciiDoc `include::`, rST `.. include::`, MediaWiki
   `{{…}}`, Obsidian `![[…]]`, Jekyll `{% include %}`, Hugo/Quarto `{{< include >}}`, MkDocs `{!…!}`,
   MDX `import` — **none chose `@`**.
8. **GitHub supports neither**, and github/markup#209 is titled *"@mentions do not render in
   README.md"* — autolinking is scoped to issues, PRs and comments, so `@AGENTS.md` is inert text.
9. **`@` is a cross-vendor agent convention** — Claude Code, **Gemini CLI** (`@./components/…`,
   default max depth 5), **Cursor** (`@filename.ts`), **Amp** (`@docs/*.md`). ~~Zed~~ — **removed**:
   Zed's `@` is for *invoking* a rule or skill, the opposite direction; its includes mechanism is not
   `@`-based.
10. **Not in the AGENTS.md spec** — agentsmd/agents.md#11 is open with no maintainer resolution. And
    the v1 gloss overstated: **Claude Code reads `CLAUDE.md`, not `AGENTS.md`**, so an `@` import
    inside an AGENTS.md expands only once that file is reached via `@AGENTS.md` or a symlink.

Repo-internal:

11. The variable is **`CLAUDE_PLUGIN_ROOT`** — 82 occurrences in tracked files. (v1 said 206; the
    grep descended into `node_modules`.) `CLAUDE_PLUGIN_DIR` is unrelated:
    `CLAUDE_PLUGIN_DIR_NAME = '.claude-plugin'`, `format-detection.ts:9`.
12. **`NON_PORTABLE_ASSET_REFERENCE`** — key at `validation-codes.ts:348`, rationale quoted from
    `:350`. It flags a skill referencing a bundled asset via `CLAUDE_PLUGIN_ROOT` because the path
    "breaks when the skill is mounted standalone" — i.e. *resolves in the plugin extent, unresolvable
    in the standalone-skill extent*. The model makes it derived rather than special-cased.
13. **Open**: `plugin-env.ts:10` records that VAT does not know whether Claude Code sets
    `CLAUDE_PLUGIN_ROOT` at skill-invocation time. Resolve before shipping a dependent check.
14. `resolveLinks()` (`resource-registry.ts:1495`) takes no zone parameter and mutates
    `link.resolvedId` in place on shared objects, called per-skill from six sites. The
    global-mutation shape is confirmed; **the "order-dependent bundling" consequence is not
    demonstrated by a reproduction** and should not be called a shipped bug until one exists.

### 12.1 Corpus figures — re-measured, and volatile

Earlier calibration used a root `CLAUDE.md` of 43,160 B / 10,728 tokens. It is now **30,803 chars /
7,701 tokens** (−28.2%). Since the root file is the flat tax every directory pays, the earlier "130
of 452 directories (29%) over 12,000" is obsolete. Directories with tracked files: **466**, not 452.

Worst location, measured with the shipped estimator (`Math.ceil(chars/4)`, `link-parser.ts:157`):

| file | tokens |
|---|---|
| `./CLAUDE.md` | 7,701 |
| `./docs/CLAUDE.md` + `@README.md` | 184 + 1,089 |
| `./docs/architecture/CLAUDE.md` + `@README.md` | 360 + 4,234 |
| **total** | **13,568** |

Still over 12,000. Note this figure **moved during this change-set** — it was 13,387 before the
zones.md pointers were added to those two files. **No threshold or flag-rate is quoted until the
sweep is re-run at implementation time.**

## 13. Population lifecycle

- **Run-scoped and lifecycle-phased.** The dist extent does not exist pre-build, so `vat build`
  populates at least twice; survival checks run only against the second.
- **A check requesting an extent that does not exist fails loudly.**
- **In-memory for this pass.** Confidentiality is not a blocker — data stays local to the user who
  already had it — so persistence is a cost/complexity call, deferred.

## 14. What changes on the branch

**Survives close to intact:** `projection-shared.ts` (`PROJECTION_SCHEMA_VERSION`, `JsonValueSchema`,
`ContentKeySchema`); **three of the four** blob tables (`blobs`, `blob_sections`, `blob_conditions`),
needing only new lexical/syntactic fields; the `generate:schemas` pipeline.

**Rewritten:** `resources` becomes an entity table with lineage identity and loses twelve columns to
`resource_realizations`; `blob_links` → `blob_references` with a syntactic-form discriminator (v1
listed this under *both* survives and rewritten); `edges` splits into `edges` + `edge_resolutions`; a
`zones` table appears, factored into resolution contexts and entry points; `ZoneKindSchema`,
`resource_tags.source` and `edges.kind` open; the tree-gated `role` invariant is removed.

Roughly half the path-dependent work on this branch is superseded.

## 15. Sequencing

1. **Rename** `agent-schema` → `schema`. Mechanical, own commit, first.
2. **Schema corrections** — lineage identity, realization columns, `zones` with resolution
   contexts/entry points, `edges` + `edge_resolutions`, opened vocabularies, `blob_references`.
3. **Parser** — lexical reference extraction. `ParseFacts` grows; namespace handles invalidation.
4. **Substrate population** — identity, realizations, blob facts, filesystem/git/package extents.
5. **Contributor seam** with stratified fixpoint + closure primitive; agent-artifact contributors.
6. **Export.** No engine.
7. **Differential validation** against shipped-lane verdicts on the frozen corpus.
8. **Proving lenses** — `@` reachability, visible-to-you/invisible-to-CI, package refs, plugin/skill
   refs.
9. **Source→bundle survival**, with the `--dry-run` manifest proxy as its cheap precursor.

## 16. Deferred: modelled, not built

- **Inference and confidence.** Path-shaped tokens in code spans and prose, scored by basename
  ambiguity within an extent and surviving-prefix depth on failure. `origin: 'inferred'` and
  `edge_resolutions.score` land now; the scoring lands later.
- **Wiki and OKF resolvers.** Title-based, forgiving, flat namespace, interwiki prefixes.
- **Per-lens link resolution as a behavioural fix** to `resolveLinks()` — observable-output change,
  must not ride a schema landing, and needs a reproduction first (§12.14).
- **Persistence** of path-dependent tables.
- **Link followability as a metric** — validity is the wrong axis; a resolving link can be expensive
  and a broken one cheap.
- **Generalising `macros.yaml`** from auth providers to the full lens/resolver vocabulary.

## 17. Open risks

1. **Does the extent digest actually make population divergence checkable**, or does it only move the
   problem? If it does not land, §7.4's claim is deleted.
2. **Does the stratified fixpoint converge** on real corpora, and is the iteration cap principled or
   arbitrary?
3. **Is the closure primitive expressive enough** for every closure-defined extent, or does the skill
   contributor stay privileged in practice?
4. **Cardinality after the resolution-context factoring** — re-derive; the naive figure was
   ~4 × 10⁵ edge rows for a whole-corpus context lens.
5. **`(extentId, path)` uniqueness** — does forcing collisions into condition rows lose anything the
   current `DuplicateResourceIdError` carries?
6. **canonicalPath** under case-insensitive filesystems and symlink loops, on Windows especially.

## 18. Revision record

**Fatal, from the coherence review:** identity's originating zone was undefined and phase-dependent
(§4.1); most `resources` columns are per-realization and `contentKey` breaks the central join (§4.2);
contributor merge is a fixpoint, not a sequence (§7.2), which created an unsatisfiable trilemma with
the declarative-only line (§7.3).

**Serious:** edges cannot hold candidate sets (§6.1); lens cardinality (§3.3); `(extentId, path)`
collisions (§4.3); the completeness claim records identity not extent (§7.4); the proving-ladder
sequencing argument (§11); `collection` wrongly removed (§3.4).

**False factual claims, from the fact-check:** linkAuth called unbuilt when it ships (§9);
`PACKAGED_UNREFERENCED_FILES` invented (§11); 10 dependents when 9 (§10.1); `CLAUDE_PLUGIN_ROOT`
counted through `node_modules` (§12.11); Zed listed as an `@` vendor (§12.9). Plus: one genuinely
stale package reference contradicting "zero" (§11.1); 452 re-used in the document that declares it
stale (§12.1); 24 scoped packages when 23.

**Survived both reviews unbroken:** the blob/meaning split (§5); absence-of-edge-row semantics
(§6.2); package placement (§10.2); every vendor claim in §12; and the §11.1 measurement discipline —
which is also what caught three of the five false claims.

**Method note.** Two of the five factual errors share one cause: counting with a text search before
defining the population — a grep that descended into `node_modules`, and a grep that matched a
package's own `name` field. A third came from repeating a memory that arrived with an explicit
staleness warning. All three are the failure mode this design exists to make queryable.
