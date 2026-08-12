# Zones design — adversarial review findings (2026-08-12)

> Companion to [`2026-08-12-zones-and-resource-meaning-design.md`](./2026-08-12-zones-and-resource-meaning-design.md).
> Two independent reviewers ran against **v1** of that spec. Everything here is folded into the
> current spec; this file preserves the **reasoning and evidence**, which the spec only summarises.
>
> ⚠️ **TEMPORARILY COMMITTED, force-added past `.gitignore:89` — REMOVE BEFORE PR MERGE.** Specs are
> normally never committed; Jeff overrode that on 2026-08-12 for safekeeping on this long-lived
> unmerged branch. Before merge, `git rm --cached` it or fold it into the PR description. Verified
> free of proprietary adopter names before commit.
>
> **Why keep this.** The spec records *what changed*. This records *why the reviewer was right*, and
> — for the findings that were downgraded or remain open — the argument a future session would
> otherwise have to reconstruct. §17's open risks point here.

## Reviewer A — model coherence (opus, adversarial mandate: falsify, don't summarise)

### A1 — FATAL, accepted. Identity's originating zone is undefined and phase-dependent

**Attacked:** `resourceId = hash(originating storage zone, name-or-path at origin)` plus "must be a
storage zone."

**The break, two independent halves:**

1. *No precedence.* `packages/vat-development-agents/resources/skills/vat-audit.md` is
   simultaneously in `filesystem`, `git`, `tree:source`, `package:vat-development-agents`, and
   `skill:vat-audit`. All five are storage zones; all five "originate" it. Because the id **hashes**
   the zone, each choice yields a different opaque id. The id was undefined, with no fallback.
2. *Phase-dependence.* The spec's own §13 has `vat build` populating twice. A stale artifact under
   `dist/` is `filesystem`-only pre-build and `tree:dist` post-build → **two ids for the same bytes
   at the same path inside one run**. The flagship survival lens joins across exactly those two
   populations.

**Why the accepted fix is better than the critique:** the reviewer offered (a) a total precedence
order over zone kinds, or (b) drop the zone from the hash. (b) wins because **nothing in the entire
document ever reads the origin zone back out of the hash** — it is opaque. It was doing zero work
while creating two failure modes. (a) would additionally have forced git/filesystem extents to always
materialise, killing on-demand materialisation.

### A2 — called FATAL, DOWNGRADED to serious. The proving ladder's two pairs are not the same query

**Attacked:** "visible-to-you / invisible-to-CI is the same query as source→bundle survival on an
easier zone pair."

**Its strongest point (accepted):** the spec's own table four lines above says rung 2 "uniquely
proves storage extent" and rung 5 "uniquely proves cross-zone identity." Both cannot be true of one
query.

**Its three differences, evaluated individually:**

| difference | verdict |
|---|---|
| "Rung 2 is a set difference over `resource_zones`; no `edges` row consulted" | **Reviewer is wrong.** The spec's formulation resolves a reference *then* tests target membership. It is an edge query. |
| "Identity mapping differs — dist paths are flattened slugs via `buildPathMap`/`resourceNaming`/`stripPrefix`, a function of packager config, not of source path" | **Correct and decisive.** Rung 2 exercises no path remapping, and remapping is where survival's difficulty lives. |
| "The oracle doesn't transfer — rung 2's is `git check-ignore` (independent); rung 5's would be the packager (the artifact under test)" | **Correct.** |

**Why downgraded:** the ladder itself survives. Rung 2 is still a cheap, correct extent proof with an
independent oracle. What dies is the *sequencing argument* built on it. Accepted replacement: source
tree vs `vat build --dry-run` dist manifest with link rewriting disabled — same transformation shape,
cheap oracle.

### A3 — FATAL, accepted. Contributor merge is a fixpoint, not a sequence

**Attacked:** "Ordering is explicit: edges need zones, zones may need tags, so passes are sequenced."

**Evidence (verified independently):** `packages/agent-skills/src/walk-link-graph.ts` carries
`visitedResourceIds: Set` and `queue: Array<[ResourceMetadata, number]>` — a bounded BFS to closure.
Membership at hop *n+1* depends on (a) resolved edges out of hop *n*, (b) whether hop *n* is
`routable` — and the walker's header notes the two production registries once **disagreed** about
routability — and (c) `excludeRules`/`maxDepth`/`gitignored`/`deferredArtifacts` at each hop.

```
skill-extent ← edges ← resolutionContext(skill) ← skill-extent
```

**Second cycle, already in the shipped schema:** `projection-resources.ts:109`'s
`ResourceTagSourceSchema` includes `'zone'` — tags derived *from* membership — while the spec says
zones may need tags. Both directions asserted in writing.

**The trilemma (this is the part worth preserving):** §7's adequacy test ("a built-in must be
expressible the way a config-declared contributor would be") + §9's declarative-only line + the skill
zone's fixpoint requirement are **pairwise plausible and jointly unsatisfiable**. Escaping by letting
the skill contributor run its own internal closure re-implements per-zone edge resolution *inside* a
contributor — precisely what §2's thesis forbids.

**Accepted fix:** stratified fixpoint with a declared iteration cap and loud non-convergence, plus a
declarative closure primitive (`closureFrom` / `follow` / `maxDepth` / `exclude`). The reviewer's
sharpest line: **`packagingOptions` (`linkFollowDepth`, `excludeReferencesFromBundle`) already is
that primitive in disguise.**

### A4 — serious, accepted. Completeness records identity, not extent

**Attacked:** "The projection records which contributors produced it… directly addresses the
recurring failure mode where a gate silently measures a different population."

**The break:** a contributor set is a set of *identities*; divergence is a difference in *extent*.
And §3.3's on-demand materialisation makes partial divergence the common case.

**Constructed scenario:** a skill with `publish: false`. `vat validate` asks for skills discovered
from config globs → the skill **is** in the extent (packaging correctness is not conditional on
shipping). `vat verify`'s consistency lane asks for the distribution-consistency population → the
skill is **out**. Identical contributor sets. Both report complete. A gate counting broken bundled
references returns 12 and 11.

**Structural second instance:** `vat build`'s two populations share a contributor set and answer
differently.

**Accepted fix + posture:** record `(contributorId, parameterSet, extentDigest)` per zone instance;
have checks *declare the extent they require*. And — accepted verbatim — **if the digest does not
land, delete the claim rather than weaken it**, because it will be cited as a guarantee it does not
provide.

### A5 — serious, RE-RATED UP to fatal. `contentKey` is per-realization

**Attacked:** §14's "`resources` loses its path columns to realizations."

**The break:** far more than paths are per-realization, and one is load-bearing. The packager
**rewrites content** on the way into a bundle — `buildRewriteRules` / `transformContent`
(`skill-packager.ts:729-754`) repoint every bundled link at its flattened dist path. So a resource's
dist realization has **different bytes and a different content key** from its source realization. A
scalar `resources.contentKey` makes the `resource → blob` join — which every blob-derived fact
(tokens, sections, references) depends on — **undefined for any multi-zone resource**.

**Why re-rated:** this is the central join of the projection, not a column-placement nicety.

**Also correct:** `gitignored` is a git-extent fact sitting on a cross-zone identity — and rung 2 of
the proving ladder reads exactly that column. And `pathLower`/`basenameLower` exist (per their own
`describe()` text) so case-insensitive matching is a column not a function call, which hashing a raw
path defeats; Node's two realpath implementations disagree on returned casing, so this is not
hypothetical.

**Accepted fix:** move `contentKey`, `mtime`, `exists`, `isDirectory`, `gitignored`, `isSymlink`,
`symlinkResolves`, `dir`, `depth`, `ext`, `pathLower`, `basenameLower` onto realizations; state a
canonicalization rule explicitly.

### A6 — serious, accepted. Edges cannot hold a candidate set

**Attacked:** §16's claim that wiki/OKF resolvers "require reopening nothing above."

**The break:** `EdgeRowSchema` is keyed `(src, linkOrdinal, zoneId)` with a scalar `dstResource`.
Wiki title resolution is intrinsically many-candidate — `[[Configuration]]` in a flat, case- and
space-forgiving namespace matches `Configuration.md`, `configuration.md`, `docs/Configuration.md`,
`guides/configuration.md`. Three places the ambiguity could go, all fail:

1. **Multiple rows** — forbidden by the key.
2. **`resolution: 'ambiguous'`, `dstResource: null`** — expressible, but discards N and the candidate
   set, making §16's own followability metric ("N-way ambiguity") unbuildable.
3. **Pick a winner** — *is* last-write-wins, the shipped defect §16 promises to fix two bullets
   earlier.

**The line worth preserving:** "§16 proposes to fix last-write-wins and, in the same section, ships a
schema that can only express last-write-wins."

**Same shape breaks inference**, which is not deferred-only: "95% match in the git zone but not the
skill zone" is a *scored candidate*. `origin: 'inferred'` was said to land now — it lands as a
discriminator on a row that cannot carry what inference produces.

**Accepted fix:** split `edge_resolutions(src, refOrdinal, resolutionContextId, candidateOrdinal,
dstResource, dstAnchor, score)`. N=1 costs one join. **The reviewer flagged this as "the one change
that genuinely must land before population," and §15 did not list it.**

### A7 — serious, accepted. Lens cardinality, with the mitigation inapplicable to the first consumer

**Measured by the reviewer, independently confirmed:** 466 directories contain ≥1 tracked file (950
on disk); 1,961 tracked files; 278 tracked `.md`; ~856 markdown links in tracked markdown.

**Two problems, the first structural:**

(a) **The mitigation cannot help the first named consumer.** The always-loaded budget check reports a
per-directory total, so its parameter set **is every directory by definition**. There is no subset to
narrow to.

(b) **466 near-identical copies.** Two `claude-context` instances share extent, resolution semantics,
interpretation, and all traversal policy but the ancestry chain — they differ **only in entry point**.
With `zoneId` in the edges key, one link in `docs/README.md` produces 466 identical rows. Order of
magnitude: `edges` ≈ 856 × 466 ≈ **4 × 10⁵**; `resource_zones` ≈ 278 × 466 ≈ **1.3 × 10⁵**; distinct
information content ≈ 856 edges + 466 short ancestry chains.

**The finding is not the memory cost** (400k rows is tens of MB). It is that **the model has no way
to say "these zones share a resolution,"** so redundancy is structural and grows as
`O(references × directories)` on any repo.

**Accepted fix:** factor zone identity into a **resolution context** (extent + resolution +
interpretation + reference-class policy — what edges key on) and an **entry point** (the directory
parameter — a cheap row naming its ancestry chain). Row count drops ~4 × 10⁵ → ~10³ and the budget
check becomes a join. **Cannot be deferred past sequencing step 2 — it is a change to the zone model.**

### A8 — serious, accepted. Many identities at one realization

**The break:** the inverse of one-identity-many-paths occurs in shipped code and has no row.
`skill-packager.ts:624` / `:1094`: `a-b/c.html` and `a/b-c.html` both flatten to `a-b-c-html`.
`registerBundledAssets` catches `DuplicateResourceIdError`, and its comment states that catch **"is
the ONLY place a bundled-asset collision is ever observable; drop the structured error here and the
fact is gone."** `detectDestinationCollisions` exists because `files:` remapping can do the same.

`ResourceRealizationRowSchema` has no uniqueness constraint on `(zoneId, path)`. So a consumer
resolving a dist reference by `(zoneId, path)` gets a nondeterministic answer — the shipped
`resolveLinks()` last-write-wins bug, reproduced in the data model.

**Also disproves** "duplicate-bundled-resource for free": the interesting duplicate is this
collision, which the schema could not represent.

### A9 — serious, accepted. The SharePoint entity had no legal identity

§9 mints it from a **viewer's** href pattern with zero realizations; §4 required origin to be a
storage zone; §3.4 lists adopter-declared zones as species "either." So its id had no legal value —
and this is the design's own showcase example. Generalises to any adopter-declared external target
(Jira ticket, Confluence page). **Dissolves under A1's fix.**

### A10 — minor, ACCEPTED AND REVERSED A DECISION. Collections vary the interpretation facet

**The break:** the removal argument tested **one** facet against a definition insisting all four are
independent. A collection does not vary extent — granted. It varies **interpretation** ("what counts
as a reference in the first place").

**Evidence (verified):** `packages/resources/src/schema-uri-walker.ts` exists and handles
`uri-reference`; `skill-packager.ts:1038` reads `collectionConfig.validation?.frontmatterSchema`;
`:1025` documents that collections without one are skipped; `:1028` records the failure mode ("won't
rewrite the un-routed collection's frontmatter"). A collection's schema determines which frontmatter
fields are `format: "uri-reference"` — therefore which frontmatter values are references at all. Two
files with byte-identical frontmatter in different collections yield different reference sets.

**`collection` restored as a zone kind.**

### A11 / A12 — minor, accepted

- §2's "incremental (only changed blobs re-derived)" is **retracted by §13** eleven sections later
  ("in-memory for this pass"). Only the blob layer is incremental, and it already was in stage 2.
  Everything path-dependent rebuilds cold every run, twice for `vat build`.
- `blob_links` appeared in **both** the "survives intact" and "rewritten" lists of the section titled
  *Honest accounting*.

### Reviewer A could NOT break (stated explicitly after trying)

- **§5, the blob/projection split.** Looked for a blob-layer fact that isn't a function of bytes;
  found none. `inCodeSpan`/`inFence`, variable-expansion detection, and the syntactic-form enum are
  all lexical. The "is this an import is filename-dependent" reasoning from the shared-`ParseResult`
  precedent is correct.
- **§6's "an edge row exists only in zones that traverse that kind."** Absence is disambiguated from
  never-asked by the zone carrying its traversal policy plus the throw-on-unregistered rule.
- **§10.2's placement argument.** `rag`/`resource-compiler` depending on `resources` correctly rules
  out a projection package above `claude-marketplace`.
- **§11.1's measurements.** "The measurement discipline in this section is the strongest part of the
  document."

## Reviewer B — fact check (opus; told two fabrications were already caught, assume more)

### FALSE (5) — all independently re-verified before acceptance

| claim | truth | root cause |
|---|---|---|
| linkAuth "specced not built", issue #113 open | **SHIPPED.** 9 modules in `packages/utils/src/link-auth/` incl. `macros.yaml`, 5 in `resources`, 12 `LINK_AUTH_*` codes, **#113 CLOSED** | Repeated a 13-day-old memory that arrived **with an explicit staleness warning** |
| `PACKAGED_UNREFERENCED_FILES` | **`PACKAGED_UNREFERENCED_FILE`** singular, `validation-codes.ts:121`, 11 occurrences, no plural anywhere | Third fabricated identifier in this document class |
| 10 packages depend on `agent-schema` | **9** | grep matched the package's **own `name` field** |
| `CLAUDE_PLUGIN_ROOT` 206 occurrences | **82** tracked (reproduced my 213 with the bad method) | `grep -r packages docs` descended into `node_modules` |
| Zed uses `@` for includes | **False.** Zed's `@` *invokes* a rule/skill — opposite direction. Its includes mechanism is not `@` | Assumed from a list in agents.md#11, which says "Zed's includes system" |

Verified TRUE for the other `@` vendors: Gemini CLI (`@./components/instructions.md`, default max
depth 5), Cursor (`@filename.ts`), Amp (`@docs/*.md`).

### OVERSTATED (7)

- **"Zero stale package references, all 11 forward"** — the bullets enumerated only **10**, and the
  omitted 11th is the one that is *not* forward: **`@vibe-agent-toolkit/cat-agents-skill`** at
  `packages/vat-example-cat-agents/docs/distribution.md:156,159,166,501`, including
  `npm install -g @vibe-agent-toolkit/cat-agents-skill`. Real name is
  `@vibe-agent-toolkit/vat-example-cat-agents`. **A published install instruction for a package that
  does not exist.** (`CHANGELOG.md` also names `runtime-claude-skills`, a historical rename — a 12th
  if changelogs are in the population, which is itself a population decision.)
- **24 workspace packages** → **23** carry an `@vibe-agent-toolkit/*` name; the 24th is unscoped
  `vibe-agent-toolkit`. The sentence's own arithmetic (34 − 11) requires 23.
- **452 directories** → **466**, and it was quoted *unqualified* in the very document whose §12.1
  declares the 2026-08-06 corpus figures stale and demands re-measurement.
- **13,387 chain total** → correct at HEAD, **already invalidated by this change-set** (my own edits
  to `docs/architecture/{CLAUDE.md,README.md}`). Current **13,568**. The root figure 30,803 chars /
  7,701 tokens is exactly right, and the −28.2% derivation is sound.
- **"dependency-free root"** → `agent-schema` has `devDependencies: ["@vibe-agent-toolkit/utils"]`.
  Runtime-dependency-free; only `utils` is literally dependency-free.
- **"AGENTS.md `@` imports work because Claude Code and Gemini expand them"** → Claude Code reads
  `CLAUDE.md`, **not** `AGENTS.md`; it expands an AGENTS.md import only once that file is reached via
  `@AGENTS.md` or a symlink.
- **§10.1's line-count table doesn't sum** — 1,297 + 743 + 377 = 2,417, omitting `index.ts` (103),
  so shares total 95% under a heading reading as full accounting. Dependency graph likewise omits
  `agent-config`, on which `agent-skills` also depends (every drawn edge is real; the rejection
  argument is TRUE).

### UNVERIFIABLE (1) — still open

**"`resolveLinks()` is global and last-write-wins today… that is a shipped bug."**
`resource-registry.ts:1495` — takes no zone parameter, mutates `link.resolvedId` **in place on shared
`ResourceLink` objects**, called per-skill from six sites (`skill-packager.ts:1016,1130`,
`packaging-validator.ts:288`, `extract-skill.ts:151`, `lanes.ts:140`, `skills/validate.ts:507`). The
global-mutation shape is confirmed; **no reproduction demonstrates a differing bundle across sibling
skills, and no failing test is cited.** Do not call it a shipped bug until one exists.

### Verified TRUE (selected — the load-bearing ones)

- All six Claude Code vendor claims **verbatim**, including four-hop depth, the code-span/fence skip
  (with documented backtick workaround), `.claude/rules` without `paths:` loading at launch, and HTML
  comment stripping — *plus* two caveats the spec had omitted: comments **inside code blocks are
  preserved**, and **managed-policy CLAUDE.md cannot be excluded** by `claudeMdExcludes`.
- Every projection-schema claim: no identity column on `resources`; exactly four dangling
  `resourceId`/`src` references; `ZoneKindSchema` closed at 6; `resource_tags.source` closed at 5;
  `edges.resolution` and `resources.origin` open strings; `role` gated by `superRefine`.
- `resolveAssetReference` at `packages/utils/src/asset-reference.ts:46` **does** honour `exports` maps
  (lines 20, 24, 77-109).
- Parse cache has no version field **on purpose** — `parse-cache.ts:69-77`, handled by the namespace
  directory derived from the running build.
- `blob_links` already carries `line`, `column`, `ordinal`, `inCodeSpan`, `inFence` as columns, but
  **nothing produces `inCodeSpan`/`inFence` today**.
- The backtick finding holds across all 9 `CLAUDE.md` files, with negative and positive controls.
  **Caveat worth carrying: the population is 6 references across 2 files** — a 6-sample accident, not
  a corpus-wide property.
- `.gitignore:89` is literally `docs/superpowers/`.

### Reviewer B's own error

Claimed root `CLAUDE.md` "has changed slightly since" because it measured **31,010 bytes** against
the spec's 30,803. Both are right: 31,010 **bytes** = 30,803 **chars** (multibyte), and VAT's
estimator runs on the decoded string. The spec's figure was correct.

### Reviewer B's cross-document note

`docs/architecture/zones.md` **fact-checked cleaner than the spec** — it carried none of the four
false claims, declined to state the 452 figure, and did not call linkAuth unbuilt. Where the two
disagreed, zones.md was right. (Both have since been revised.)
