# Resource Projection

**Status markers used throughout:** ✅ shipped — 🔷 proposed, not yet built.

## 1. Overview

[Resource Scanning and Object Caching](./resource-scanning-and-caching.md) covers how VAT discovers
what bytes exist and reads them cheaply and correctly. This document covers what gets built from those
bytes: the published, queryable schema every resource-scanning verb produces or consumes, and the
caching that applies to *it* — a different layer from the object-level cache, with a different
lane-awareness story.

This is the durable home for the design shipped in stages 1b and 2 (the pipeline restructure and the
content-addressed parse cache), and the reference point for stage 3 — projection publication and
export, schema documented and versioned, no query engine required — as that work starts.

**The load-bearing decision underneath every table below: facts are rows, not columns.**
Dispositions, tags, problems and relationships are all many-to-many. Adding a zone kind, a tag, a
quality code, or an edge-resolution state is adding rows, never migrating the schema. Extensibility
lives in the vocabularies, which stay open; the table shapes are few and are meant to stay stable.

## 2. What's shipped today, vs. the proposed blob-keyed schema

**The stage-2 parse cache's actual output shape today (✅ shipped) is not the table set below** — it's
narrower and purpose-built: `ParseFacts` (`packages/resources/src/parse-cache.ts:161-177`) —
`{links, headings, estimatedTokenCount, anchors?, parseErrors?, unresolvedReferences?,
frontmatterSource?, frontmatterError?}`, keyed by content key — **`<parserKind>.<sha256>`**
(`content-key.ts:107` documents that identical empty bytes key differently under the two parser
kinds, so the key is not a bare content hash). The content key itself **is shipped and load-bearing
today** (`computeContentKey`, `content-key.ts:110`; consumed by `readContentWithKey`, `:167`, the
entry point for the whole stage-2 cache) — only *exposing it as a projection column* is proposed.
Two other details that matter and that the proposed schema below deliberately does *not* preserve:
**`content` itself is never stored** (`parse-cache.ts:41`) — the confidentiality argument in §5
depends on this — and frontmatter is kept as YAML **source**, never JSON. A companion shape used for
correctness testing, `packages/cli/src/pipeline-oracles/types.ts` (`ParseFactRow`, `EnumerationRow`,
`ConditionFact`), exists as a test oracle, not as a queryable projection.

**The table sets in §2 and §3 below are the proposed (🔷), unbuilt blob-keyed schema** — carried
over from the design spec's §6 as the target shape for stage 3 ("projection publication and export")
to build toward, not a description of what exists in code today. (The prose *around* those tables
still correctly describes shipped reality where it says so — e.g. `checksum`, collections, and
`routable` below are each partly or fully real; only the tables themselves, and any column
introduced by them, are proposed.) The tables are keyed on content, not path: the same bytes
anywhere in the corpus — same file at two paths, same file at two points in history, same file
across two adopters — would produce one row, computed once, reused everywhere.

**Update, stage 3 in progress:** the table *shapes* below are now ✅ shipped as Zod schemas with
generated JSON Schema — `packages/resources/src/schemas/projection-blobs.ts` and
`projection-resources.ts`. There is deliberately **no** contract-version constant: the hand-bumped
`PROJECTION_SCHEMA_VERSION` is removed, and a *stored* projection would take a derived digest of the
row schemas' shape instead (the parse cache's `parseFactsShapeSource()` is the pattern). **Population
is still 🔷
proposed** for all ten tables: nothing yet derives real rows from `ParseFacts` or
`ResourceRegistry` at runtime. Four tables (`blobs`, `blob_links`, `blob_sections`,
`blob_conditions`) and three (`roots`, `resources`, `edges`) have a partial source to populate
from already — several columns (e.g. `wordCount`, `proseBytes`, `codeBlockBytes`, `sectionCount`,
`slugOccurrence`, `column`, `inCodeSpan`, `inFence`) require new parser output that `ParseFacts`
does not yet carry; `resource_realizations`, `resource_zones` beyond a single default "tree" zone, and
zone-sourced `resource_tags` additionally depend on zone modeling (skill/plugin/marketplace
boundaries) that does not exist anywhere in the codebase yet — a separate, larger integration into
`agent-skills`/`claude-marketplace`, not a natural extension of schema definition.

| table (🔷 proposed) | contents |
|---|---|
| `blobs` | content key, bytes, token estimate, frontmatter (JSON), `frontmatter_error`, word count, prose vs. code-block bytes, link/heading/section counts |
| `blob_links` | ordinal, raw href, text, line, column, node type, in-code-span, in-fence |
| `blob_sections` | ordinal, depth, title, slug, slug occurrence, parent, line span, bytes, tokens |
| `blob_conditions` | `(blob, code, severity, message, line)` — parse-time oddities |

**The proposed schema would store frontmatter as a JSON column, not DuckDB's `VARIANT`.** (Measured
against `@duckdb/duckdb-wasm` v1.5.4, 2026-08 — a claim about another vendor's product, worth
re-checking on a future DuckDB upgrade rather than trusted indefinitely.) VARIANT's accessor surface
is narrower than its storage and carries sharp edges: extraction requires a constant key (a key census
can't be expressed at all), `variant_keys()` doesn't exist, `len()` throws on one row shape and
silently returns `NULL` on another, a raw cast is a struct literal rather than JSON, and key order
doesn't survive a Parquet round-trip. At VAT's corpus scale, `json_extract` is fast enough and
portable, so JSON wins on all of those without giving up query capability. (Note this is a deliberate
divergence from the shipped parse cache's YAML-source choice above — a projection query surface and a
cache round-trip are different decisions with different constraints; see §5.)

**The proposed `blob_conditions` table would carry an escape hatch:** when there is no enum yet,
`code = 'PARSE_ODDITY'` with free text, promoted to a real code once the base rate justifies it. Today,
`ParseFacts.parseErrors`/`frontmatterError`/`unresolvedReferences` carry the equivalent information as
fields on the shipped cache entry rather than as a separate row shape.

## 3. Path-dependent tables (🔷 proposed) — rebuilt by joining, cheap, disposable

None of the tables in this section exist in code today — continuing the proposed schema from §2. They
carry everything that depends on *where* content lives, not what it is, and are designed to be cheap
to rebuild by joining against the blob-keyed tables above, so they'd carry no durability promise of
their own.

| table (🔷 proposed) | contents |
|---|---|
| `roots` | a **table**, not an implicit singleton — federating sibling corpora stays additive |
| `resources` | root-relative path, `path_lower` + `basename_lower` (case-insensitivity as columns, not function calls), nullable content key, dir, depth, ext, mtime, VAT id, `origin`, `observed` (false for declared-but-unwritten nodes), `from_enumeration` (false for nodes discovered during parse and filled in afterward), plus the node attributes `exists` / `is_directory` / `gitignored` / `is_symlink` / `symlink_resolves` |
| `resource_realizations` | `(resource_id, zone_id, path)` — one resource id can have many paths (e.g. a source registry and a build-output registry sharing node identity) |
| `resource_zones` | `(resource_id, zone_kind, zone_id, role)`; `zone_kind ∈ {skill, plugin, marketplace, collection, package, tree}`; tree `role ∈ {source, dist, vendored}` |
| `resource_tags` | `(resource_id, tag, value, source)`; `source ∈ {filename, config, frontmatter, zone, harness-convention}` |
| `edges` | `(src, link_ordinal, zone_id, dst_resource, dst_anchor, kind, resolution)` — `zone_id` is part of the key, because link resolution is per-zone: the same link can resolve differently depending on which skill/plugin/collection is doing the resolving. |

**`roots` is a table, so `path` alone is never an identifier.** Any SQL check's column contract must
return a root (or a resource id), never a bare `path`, or a federated corpus with two roots sharing a
relative path becomes ambiguous.

**Content key ≠ `checksum`, and both must be kept as separate columns.** Both are real and shipped
today, in different roles. `checksum` is `SHA256` of the *decoded* UTF-8 string (`checksum.ts`);
invalid UTF-8 collapses to `U+FFFD`, so distinct byte sequences can share a checksum. It's user-facing
(`resources scan --verbose` prints it; `getResourcesByChecksum`, `getUniqueByChecksum`,
`getDuplicates` are public API keyed on it). The content key (also shipped — see §2) is a
**byte-domain** hash (`<parserKind>.<sha256>`) used internally by the parse cache and is a different
column from `checksum` today; the constraint that matters for the *proposed* `resources` table (§3)
is that adding a content-key column there must not collapse it onto `checksum` — doing so would
silently change cross-tree equality and break existing, shipped output.

### Agentic conventions — proposed native modeling (🔷)

The design models the agent-instruction surface as ordinary `resource_tags` rows rather than a
bolt-on concept, once `resource_tags` exists. The organizing axis: files whose selection logic exists
(conditionally-loaded, indexed by a description or glob the harness reads without opening the body)
would carry a `loading` tag with values `always` / `selected` / `referenced`. `SKILL.md`, subagents,
commands, and `.claude/rules/*` would be `selected`; `CLAUDE.md`/`AGENTS.md` and their `@` imports
`always`; anything only reachable by a followed link, `referenced`. Extensible tagging is designed as
a generalization of collections (already a shipped glob → name → schema mechanism) minus the schema —
a project would declare `resources.tags.runbook: ["**/resources/*-runbook.md"]` in its config and get
a tag with no plugin API and no new security surface. **None of this exists today** — there is no
`tags` key in `packages/resources/src/schemas/project-config.ts`, and no `loading` tag anywhere in the
codebase. A tag that recurs across adopters, once this ships, would be a candidate to graduate into a
built-in with smarter detection.

### `routable` — membership is not traversability

**Partially shipped today, independent of the projection schema.** `LINK_FROM_NON_ROUTABLE_FILE` is a
real, shipped validation code (`LINK_FROM_NON_ROUTABLE_FILE`, `packages/schema/src/validation-codes.ts:106-114`), and
`walk-link-graph.ts:74` already carries a `non-routable-source` exclusion reason. What's proposed
(🔷) is *modeling* that behavior as a clean projection property rather than logic embedded in the
walker:

- **Membership** — is this file parsed and in the projection? Determines whether VAT knows its links,
  anchors, and tokens, and whether a rewriter can reach it.
- **Routable** — do we follow links *out of* it, enqueueing its targets and charging them against
  depth limits?

**Decision: HTML is a member and is not routable** — a leaf VAT can read, not a door it walks through,
matching Anthropic's skill-authoring guidance (which routes exclusively through markdown). Once
`resource_tags`/`resource_zones` exist, `routable` would be a per-`(resource, zone)` fact, not a global
column — a file can be a traversal node in one lane and a leaf-only member in another — riding
`resource_tags` or a column on `resource_zones`. Today the same decision is enforced directly in the
walker rather than as a queryable row.

## 4. Tree-shape caching — a different layer from the object cache

[Resource Scanning and Object Caching §5](./resource-scanning-and-caching.md#5-whats-shared-whats-not)
names this split; this is where it matters for the projection specifically. Knowing *which* rows above
are still valid without re-deriving them from scratch requires a manifest of "what did the tree look
like last time" — and that manifest is inherently lane-aware:

- **Git lane**: the write-tree snapshot ([scanning doc §3.1](./resource-scanning-and-caching.md#31-the-git-lane)).
- **Non-git, anchored**: a proposed, unbuilt persisted manifest
  ([scanning doc §3.2](./resource-scanning-and-caching.md#32-the-non-git-lane)).
- **Non-git, ad hoc**: none — always a full crawl.

The object-level cache (§5 below) answers "have I parsed these exact bytes before, ever, anywhere" —
lane-agnostic, and the same regardless of which of the three cases produced the bytes. Tree-shape
caching answers "did *this* tree change since *my* last run" — lane-aware, and this is where a warm
run's actual wall-clock saving comes from. Conflating the two is the mistake this split exists to
prevent: a blob-SHA memo (🔷 proposed) is a lane-specific shortcut *into* the lane-agnostic object
cache, not a replacement for either layer.

## 5. Cache properties (parse cache, ✅ shipped stage 2)

- **Disposable.** No durability promise, no generations, no compaction, no CI-restore contract, no
  on-disk format obligation to adopters. Recovery is "rescan." OS purge *is* the eviction policy.
- **Location:** `normalizedTmpdir()/.vat-cache/<namespace>/parse/`. Uses `normalizedTmpdir()` from
  `packages/utils/src/path-utils.ts`, never raw `tmpdir()` — on Windows CI the latter returns 8.3
  short names. `$XDG_CACHE_HOME` is deliberately not used: `~/.cache` on Linux is not OS-purged, so
  using it would leave the cache with no eviction mechanism at all.
- **Confidentiality is mode `0700`**, and that's explicitly POSIX-only — `chmod` on Windows only
  toggles the read-only bit, so this mitigation does not carry to that platform.
- **Threat model, narrowed by what actually shipped.** The parse cache is *not* a full plaintext copy
  of the corpus: the content key can only be computed by reading the file, so by the time a cache
  lookup happens the caller already holds the content in memory, and it's re-attached from that same
  read on every hit rather than stored again. Measured: cache entries total 484 KiB against a 2,322
  KiB corpus — 21%. The real exposure is link text and hrefs (`ParseFacts.links` stores whole
  `ResourceLink` objects — `text`, `href`, `type`, `line`, `nodeType`; a raw href can be a relative
  corpus path or an external URL), heading text, heading slugs, anchors, and frontmatter YAML source
  — not document bodies. `resolvedPath`/`resolvedId` are not populated by the link parser, so no
  absolute filesystem paths reach the cache via this route. Two carve-outs: frontmatter is stored as YAML
  **source**, so any secret sitting in frontmatter is stored verbatim; and this narrowing is about the
  **parse cache only** — the projection's own `blobs.bytes` column, and any linked-content fetch
  cache, are separate tenants where the full-copy reasoning still applies.
- **Namespacing is version-based, with a dev-checkout escape hatch.** For an installed VAT, the
  namespace is the package version alone (e.g. `0.1.42`) — deliberately, so every machine on the same
  release shares one cache. Version alone is insufficient for a **dev checkout**, so there the
  namespace gets a `-dev-<hash>` suffix over two inputs: the package-root path, which separates one
  worktree from another, and a digest of `ParseFactsSchema`'s own shape, which separates two entry
  formats within one worktree. Both are **derived**, and that is the settled position after two
  attempts at hand-maintaining the second half: a build fingerprint of the emitted parser modules
  (rejected — 65 namespaces holding 267 MB, because every rebuild minted one) and then a hand-bumped
  `PARSER_BEHAVIOR_REVISION` (rejected — a second versioning scheme carried alongside the version
  that already works, protecting only developers, who are the one audience that knows when they
  changed a parser). The shape digest keeps what the build fingerprint was for without its churn:
  rebuilding unchanged code cannot move it, since it reads no file and no mtime. What is left over —
  a change to what a parse *means*, at unchanged shape — is `vat cache clear`, not a number. Three
  earlier hand-bumped constants are gone on the same reasoning
  (`CONTENT_KEY_SCHEMA_VERSION`, `PARSE_CACHE_SCHEMA_VERSION`, `PARSER_BEHAVIOR_REVISION`); two other
  cache tenants — `content-cache.ts` and `external-link-cache.ts` — still use that pattern
  (`const CACHE_VERSION = 1`), which is what is being moved away from, not a precedent this design
  follows.
- **Entries are content-named and written by atomic rename**, so concurrent processes racing on the
  same key are benign rather than merely unlikely.
- **Frontmatter is cached as YAML source, not serialized JSON.** A round-trip through `yaml.parse` →
  JSON loses information (`.inf` → `Infinity` → `null`, `.nan` → `NaN` → `null`, `!!binary` → `Buffer`
  → an object literal; cyclic anchors make `JSON.stringify` throw). Storing the source and re-parsing
  on read is cheap and lossless. (The *projection* column, §2 above, stays JSON — that's a query
  surface, not a cache round-trip, and the two are not the same decision.)
- **Every entry is validated against `ParseFactsSchema` on read**, element by element, not by a
  structural spot-check. An entry whose *shape* this build cannot account for — a wrong field type,
  a fact the envelope has no field for — is a miss. The one shape change it cannot see is the
  addition of an **optional** field, where "written before the field existed" and "legitimately
  absent" are the same bytes. No validator can separate those, so that class is closed one level up
  instead — by the shape digest in the namespace above, which puts the two kinds of entry in
  different directories rather than trying to tell them apart on read.
- **Fail-soft covers corruption, not wrongness.** Any read failure is a cache miss; any write failure
  is a no-op. Neither that nor the schema above covers a well-formed entry bound to the wrong
  content — that is what the scanning doc's key rules exist to close.
- **Bad input never breaks the cache.** A file with invalid HTML or unparseable YAML produces a
  `ParseFacts` entry carrying `parseErrors`/`frontmatterError`/`unresolvedReferences` rather than
  throwing — and because those fields are part of the cached entry, re-validating an already-known-broken
  file's re-parse is free on the next run (validation itself still runs over the rehydrated result).
  (The proposed `blob_conditions` table in §2 would formalize this as its
  own row shape; today it's fields on the same cache entry.)

## 6. Status

- ✅ **Shipped** (stages 1b/2): the pipeline restructure and the object-level, content-addressed parse
  cache described in §5.
- ✅ **Shipped** (stage 3, schema only): the ten projection table shapes as Zod schemas with
  generated JSON Schema, carrying no contract-version constant.
- 🔷 **Proposed** (stage 3 continuation and beyond): population of those tables from `ParseFacts`/
  `ResourceRegistry` at runtime; the git-lane and non-git-lane change-detection manifests from
  the scanning doc; the blob-SHA memo.

> ⚠️ **Several table shapes above are superseded — see [Zones](./zones.md).** Zone modelling was
> originally deferred past population; it has been moved to the front, because the capabilities that
> justify the projection are all *cross-zone* questions. The shapes documented above remain an
> accurate description of what is in `packages/resources/src/schemas/` today; they are not the target.
>
> Revisions that follow, each forced by a concrete case rather than by taste:
>
> - **`resources` becomes an entity table** keyed by an opaque identity — `hash(rootId,
>   canonicalPath at first observation)`. Zero realizations is legal, so a plugin known only from a
>   marketplace manifest is a resource.
> - **Twelve columns move to `resource_realizations`** — `contentKey`, `mtime`, `exists`,
>   `isDirectory`, `gitignored`, `isSymlink`, `symlinkResolves`, `dir`, `depth`, `ext`, `pathLower`,
>   `basenameLower`. All are properties of a path in a zone. `contentKey` forces it: the packager
>   rewrites content into bundles, so a resource's source and dist realizations have different bytes.
> - **`(extentId, path)` is unique**, with collisions emitted as condition rows — two source paths can
>   flatten to one dist slug, and that diagnostic currently survives only inside a `catch`.
> - **`blob_links` becomes `blob_references`**, recording syntactic shape and lexical features rather
>   than classified link types. Classification needs the corpus, and the parse cache is
>   content-addressed across corpora.
> - **`edges` splits into `edges` + `edge_resolutions`** with a candidate ordinal and a score. A scalar
>   target cannot express ambiguous resolution or scored inference, and collapsing candidates to one
>   winner is the last-write-wins behaviour per-zone resolution exists to remove.
> - **`edges` gains `origin`** (`authored` / `implicit` / `inferred`) and a nullable reference ordinal,
>   because implicit edges have no blob row; `kind` opens.
> - **`ZoneKindSchema` and `resource_tags.source` open**; `role` moves to the zone entity and loses its
>   `tree` gating. `collection` is **retained** as a zone kind — a collection's `frontmatterSchema`
>   determines which frontmatter values are references at all, which is the interpretation facet.

## Related

- [Zones](./zones.md) — the lens model these tables are read through: storage vs. viewer zones,
  per-zone resolution, resource identity and realizations, and the contributor seam.
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the input side: how
  bytes are discovered and read, and the object-level cache this document's tables are built from.
- The design journey behind this document — rejected approaches, falsified claims, and the
  measurements that produced these decisions — lives in the (gitignored, not committed) design spec.
