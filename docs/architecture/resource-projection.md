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
over from the (retired, uncommitted) design spec as the target shape for stage 3 ("projection
publication and export") to build toward, not a description of what exists in code today. (The prose
*around* those tables still correctly describes shipped reality where it says so — e.g. `checksum`,
collections, and `routable` below are each partly or fully real; only the tables themselves, and any
column introduced by them, are proposed.) The tables are keyed on content, not path: the same bytes
anywhere in the corpus — same file at two paths, same file at two points in history, same file
across two adopters — would produce one row, computed once, reused everywhere.

**Update, stage 3 in progress:** the table *shapes* below are now ✅ shipped as Zod schemas with
generated JSON Schema — `packages/resources/src/schemas/projection-blobs.ts` and
`projection-resources.ts`. There is deliberately **no** contract-version constant: the hand-bumped
`PROJECTION_SCHEMA_VERSION` is removed, and a *stored* projection would take a derived digest of the
row schemas' shape instead (the parse cache's `parseFactsShapeSource()` is the pattern). **Population
is still 🔷
proposed** for all ten tables: nothing yet derives real rows from `ParseFacts` or
`ResourceRegistry` at runtime. Four tables (`blobs`, `blob_references`, `blob_sections`,
`blob_conditions`) and three (`roots`, `resources`, `edges`) have a partial source to populate
from already — several columns (e.g. `wordCount`, `proseCodeUnits`, `codeBlockCodeUnits`, `sectionCount`,
`slugOccurrence`, `column`, `inCodeSpan`, `inFence`) require new parser output that `ParseFacts`
does not yet carry; `resource_realizations`, `resource_zones` beyond a single default "tree" zone, and
zone-sourced `resource_tags` additionally depend on zone modeling (skill/plugin/marketplace
boundaries) that does not exist anywhere in the codebase yet — a separate, larger integration into
`agent-skills`/`claude-marketplace`, not a natural extension of schema definition.

| table (🔷 proposed) | contents |
|---|---|
| `blobs` | content key, bytes, decode provenance (`encoding`, `encodingSource`, `replacementCharacters`), token estimate, frontmatter (JSON), `frontmatter_error`, word count, prose vs. code-block size counts (UTF-16 code units), link/heading/section counts |
| `blob_references` | ordinal, raw ref, text, line, column, `startOffset`/`endOffset` (UTF-16 code units), syntactic form, lexical features (extension, leading `@`, slash count, variable-expansion syntax, in-code-span, in-fence) |
| `blob_sections` | ordinal, depth, title, slug, slug occurrence, parent, line span, bytes (UTF-8), tokens |
| `blob_conditions` | `(blob, code, severity, message, line)` — parse-time oddities |

**The proposed schema would store frontmatter as a JSON column, not DuckDB's `VARIANT`.** (Measured
against `@duckdb/duckdb-wasm` v1.5.4, 2026-08 — a claim about another vendor's product, worth
re-checking on a future DuckDB upgrade rather than trusted indefinitely. ⚠️ It was measured on the
**wasm** build, and a later correction established that wasm was the wrong build to spike at all —
see *Why not a columnar engine* at the end of this section. VARIANT's accessor surface is a SQL-level
property and so is unlikely to differ on `@duckdb/node-api`, but it has not been re-measured there.)
VARIANT's accessor surface is narrower than its storage and carries sharp edges: extraction requires
a constant key (a key census can't be expressed at all), `variant_keys()` doesn't exist, `len()`
throws on one row shape and silently returns `NULL` on another, a raw cast is a struct literal
rather than JSON, and key order doesn't survive a Parquet round-trip. At VAT's corpus scale,
`json_extract` is fast enough and portable, so JSON wins on all of those without giving up query
capability. (Note this is a deliberate divergence from the shipped parse cache's YAML-source choice
above — a projection query surface and a cache round-trip are different decisions with different
constraints; see §5.)

**The proposed `blob_conditions` table would carry an escape hatch:** when there is no enum yet,
`code = 'PARSE_ODDITY'` with free text, promoted to a real code once the base rate justifies it. Today,
`ParseFacts.parseErrors`/`frontmatterError`/`unresolvedReferences` carry the equivalent information as
fields on the shipped cache entry rather than as a separate row shape.

### Why not a columnar engine — and why the published half of that spike is the wrong build

The projection ships on SQLite (`packages/projection-sqlite`, opt-in). DuckDB was spiked in 2026-08
and not adopted. The spike is recorded here for one reason: it ran against `@duckdb/duckdb-wasm`
v1.5.4, and a **2026-08-17 correction established that wasm was the wrong build to spike**. Without
both halves written down, the next person to revisit a columnar engine re-runs a spike whose answer
is already known, from a starting point that has already been refuted.

Measured on `@duckdb/duckdb-wasm` v1.5.4 (2026-08):

- cold start **1,393 ms on node against 4,635 ms under bun**;
- **149 MB installed** for **44.7 MiB actually needed**;
- a **3.9 MiB extension sidecar** — `json` *and* `parquet` are both network downloads — which has to
  be warmed at build time and seeded again at runtime;
- ⚠️ **a cache miss on `LOAD parquet` hangs rather than erroring.** It is synchronous on the blocking
  build, so no JS timer can interrupt it: any path that could miss needs a killable child process and
  an external `SIGKILL`, and **there is no Windows answer** to that;
- fixed-size `FLOAT[N]` **does not survive a Parquet round-trip** — it returns as `FLOAT[]` and
  `array_cosine_similarity` stops binding.

⛔ **The correction (2026-08-17): every one of those caveats is wasm-only.** `@duckdb/node-api`
statically links parquet, so there are zero `LOAD`/`INSTALL` statements on that path — and the hang,
the sidecar, the `SIGKILL` requirement and the bun-vs-node cold-start gap all evaporate with them.

⚠️ **Exactly one caveat survives, and it is an open question rather than a refutation: 108 MB for one
platform binding.** That is not the same decision in both directions — 108 MB in a private
application is a cost the owner absorbs, while 108 MB in a *published* toolkit is a cost every
adopter absorbs on install, once per platform. The obvious mitigation, `optionalDependencies`
gating, is a pattern this repo has separately found unreliable: optional dependencies are installed
by default rather than skipped, so the gate does not hold and the bytes reach adopters anyway.

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

### Agentic conventions — native modeling (✅ shipped, stage 4)

The agent-instruction surface is ordinary `resource_tags` rows rather than a bolt-on concept. The
organizing axis: files whose selection logic exists (conditionally-loaded, indexed by a description
or glob the harness reads without opening the body) carry a `loading` tag with values `always` /
`selected`. `CLAUDE.md` and `CLAUDE.local.md` are `always` — their location *is* the loading
mechanism, since ancestors load at launch and subdirectory ones load on demand. `SKILL.md`,
subagents and commands are `selected`: their index entry is unconditional, their body is not.

⛔ **`loading` answers one question — what does turn zero cost — and only two classes can answer
it from a path.** An earlier draft had a third, `referenced`, holding two unrelated things:

- **Harness configuration** (`settings.json`, `.mcp.json`, `plugin.json`, `marketplace.json`) —
  the *client* parses these; their bytes never reach a context window under any traversal. Summing
  their `tokenEstimate` would be wrong in both directions at once: counting JSON the model cannot
  read, while missing the several thousand tokens of tool schemas an `.mcp.json` injects into the
  system prompt. That indirect cost is real, is a different quantity needing a different estimator,
  and is not `loading`.
- **`README.md`** — "nothing until traversed" is equally true of every `.ts` file in the tree, so
  as a class it partitioned nothing. And a README *can* be always-loaded, via an `@README` import:
  VAT's own worst location, `docs/architecture`, is 253 tokens of `CLAUDE.md` and **4,009 tokens of
  imported README**. Its class is therefore graph-dependent, exactly like `AGENTS.md`.

So three conventions decline the question for one coherent reason — `rules-file` because
frontmatter decides, `agents-md` and `readme` because the import graph decides — and `referenced`
returns only when a closure contributor can produce it. `resource_tags.value` is a plain nullable
string, so that costs no schema change.

⚠️ **Two entries the earlier draft got wrong, both corrected against vendor documentation rather
than against taste** (`packages/resources/src/projection/agentic-tags.ts` carries the
`@vendor-claim` and the citations):

- **`.claude/rules/*` are not uniformly `selected`.** A rule *without* `paths:` frontmatter loads
  unconditionally, at the same priority as `.claude/CLAUDE.md`. The 53/53-carry-`paths:`
  measurement that motivated `selected` is a **base rate, not a rule**, so the tag ships with no
  `loading` value at all until something reads frontmatter.

  ⚠️ **Two consequences, and the second is a correction the budget check now implements.** First,
  VAT's own `claude-rules` collection *requires* `paths:` — deliberately stricter than the vendor,
  because an unscoped rule is charged to every session whether or not the work touches what it
  guards, and that cost is precisely what this check exists to surface. Second, the design's
  instruction to **exclude rules files from the always-loaded chain sum is right only for rules
  that carry `paths:`**. A rule that omits it *is* always-loaded, and excluding it under-reports
  exactly the file whose cost is worst — the same direction of error the `loading` rank rule exists
  to prevent. The rule is `paths:` present → `selected` (excluded), absent → `always` (charged).

  ⭐ **The magnitude, so nobody "simplifies" the rule back to a class-wide answer.** The same
  refusal to read frontmatter fails in the other direction too, and that direction has a measured
  size: charging every `.claude/rules/*` file as always-loaded **overstated one measured corpus by
  29,715 tokens — a 3× error on the very metric this check exists to report** (2026-08, the only
  corpus then carrying rules files at scale, where **all 53 of them carried `paths:`**). That
  53/53 is a base rate and not a rule — which is exactly why `loading` must be computed per file
  from frontmatter rather than assumed for the class. Neither wholesale answer is close: one
  under-reports the worst file, the other triples the number. Without the figure a reader cannot
  tell whether this correction was cosmetic or dominant, and a future edit that flattens it back to
  "rules files are `always`" has nothing to argue against.

  ⭐ **This passage shipped BEFORE the code obeyed it, and that gap was a real defect.**
  `alwaysLoadedBudget`'s `qualifies()` excluded every rule admission, so `vat claude budget` and
  `vat claude context` disagreed about the same directory — the query lane classed an unscoped root
  rule `always`, the check dropped it, and a repo whose root rules omit `paths:` was told *"Every
  instruction chain checked is within budget."* Unreachable from VAT's own tree, where all rules
  carry `paths:`, which is why nothing went red for it. `qualifies()` now admits `root-rule` and
  only `root-rule`; the path-scoped kinds stay excluded, for the reason above.
- **`AGENTS.md` is not `always`.** Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the latter is
  charged only where a `CLAUDE.md` imports it. Its class is a property of the import graph, so it
  too ships with no `loading` value.

`.claude/rules/`, `.claude/agents/` and `.claude/commands/` are all discovered **recursively**, and
a plugin's components live at `<plugin>/agents/` rather than under `.claude/` — anchored to a
directory holding `.claude-plugin/plugin.json`, because a bare "directory named `commands`" rule
false-positives on every CLI in this monorepo.

Extensible tagging is designed as a generalization of collections (already a shipped glob → name →
schema mechanism) minus the schema — a project would declare
`resources.tags.runbook: ["**/resources/*-runbook.md"]` in its config and get a tag with no plugin
API and no new security surface. **That half does not exist yet**: there is no `tags` key in
`packages/resources/src/schemas/project-config.ts`, so today the vocabulary is built-in only. A tag
that recurs across adopters would be a candidate to graduate into a built-in with smarter detection.

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
  on-disk format obligation to adopters. Recovery is "rescan." ⚠️ **OS purge is the eviction policy
  on macOS only** — `/var/folders` is atime-purged there, but Linux `/tmp` persists to reboot, so on
  CI runners and on most adopter servers nothing evicts anything and the cache grows without bound.
  See *Eviction and cache lifecycle* below for the 🔷 proposed design and the five defects a review
  found in the obvious version of it.
- **Location:** `normalizedTmpdir()/.vat-cache/<namespace>/parse/`. Uses `normalizedTmpdir()` from
  `packages/utils/src/path-utils.ts`, never raw `tmpdir()` — on Windows CI the latter returns 8.3
  short names. `$XDG_CACHE_HOME` is deliberately not used: `~/.cache` on Linux is not OS-purged
  either, so moving there would surrender the one platform that purges for free without gaining
  eviction on any platform that does not — while promoting a cache with no lifecycle into a
  long-lived per-user directory. That is the same platform asymmetry the bullet above states.
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
  (`CONTENT_KEY_SCHEMA_VERSION`, `PARSE_CACHE_SCHEMA_VERSION`, `PARSER_BEHAVIOR_REVISION`).
  `external-link-cache.ts` followed, and is the interesting case: it is a tenant that deliberately
  lives OUTSIDE the namespace — external reachability is a fact about the world, not about this
  build — so it has no directory rename to fall back on, and `ExternalLinkCacheEntrySchema` at its
  read boundary has to carry the whole load, with its TTL bounding the one class a schema cannot see.
  `content-cache.ts` (the linkAuth content cache) followed for the same reason and by the same
  route — `StoredContentMetadataSchema`, `.strict()` on the envelope, with its 30-minute TTL as the
  bound. No hand-bumped cache version remains anywhere in the package.
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

### Eviction and cache lifecycle (🔷 proposed)

**Nothing evicts the parse cache, and on Linux nothing ever will.** The bullets above describe a
cache with no lifecycle at all: entries are written and never removed, and the only de-facto GC is
the platform accident named in the *Disposable* bullet. That makes this strand **independently
justified** — it is worth building whether or not any content-identity work ever follows it, because
it is the only thing standing between an unbounded `/tmp` directory and every long-lived CI runner
or adopter server. `vat cache clear` is the whole of the current answer, and it is a manual one.

The shape under consideration is mark-and-sweep: a **manifest** of the content keys a tree still
roots, plus a periodic sweep that drops entries no manifest reaches. A design of exactly that shape
was reviewed on 2026-08-17 and **five defects were found**. They are recorded here because every one
of them will be re-hit by whoever builds this, and four of the five are silent when they go wrong.

1. **Fail-soft is inverted for a root set.** Everywhere else in this cache a corrupt read costs one
   reparse; a corrupt *root set* deletes everyone else's entries. A run killed mid-write leaves a
   truncated manifest that parses cleanly as a **smaller** root set, which is a valid-looking
   instruction to delete. Required: the manifest is written by atomic temp+`rename`, the same
   discipline the entries already use; an unparseable or unexpectedly-absent manifest **aborts the
   sweep** rather than reading as empty; and the manifest is written **before** the entries it roots.
2. **Nothing roots the SHA-256 keyspace.** "Non-git corpora need no root tracking" and "drop blobs
   unreachable from any root" are individually reasonable and jointly delete every SHA-256 entry on
   the first sweep. That keyspace needs an explicit exemption — separate directories per keyspace,
   so the sweep cannot reach it by accident — and then a retention policy of its own, because
   `~/.claude/plugins/` churns on every plugin update and grows forever inside the *live* namespace.
3. **Manifest identity is the worktree path, never the tree hash.** Tree-hash keying mints a fresh
   manifest per edit — on the order of **200 a day at ~55 KB each** on an active checkout — and
   makes the effective root set the union of every intermediate tree state, so nothing is ever
   unreachable and the sweep never collects. The tree hash is only an "unchanged ⇒ skip the rewrite"
   validator, and it is unsound even for that alone: root sets are **command-scoped**
   (`vat resources validate` on a subtree parses a different blob set than `vat build` does), so
   a manifest update is **union, never replace**.
4. **Namespace-level removal is the write-time TTL that was already rejected.** Dropping a whole
   namespace directory on age has only one signal available — mtime — and a namespace serving 100%
   warm hits writes nothing. It therefore looks stalest exactly when it is most valuable.
5. **No name grammar and no lock.** "Delete what is not in the live set" would eat `auth-<user>/`
   and `external-links.json` — tenants that deliberately live outside the namespace (see the
   namespacing bullet above) and whose contents are **not** freely re-derivable, since link auth
   needs credentials. That is data loss, not a cache miss, so the sweep needs a name grammar stating
   what it is permitted to consider in the first place. And the `last-swept` marker has to be
   *acquired* — `O_EXCL` or rename — with stale-lock recovery, because a CI matrix, or this repo's
   own three test suites, would otherwise sweep concurrently; `cache/clear.ts` already documents
   that shape producing `ENOTEMPTY`. Neither the manifest nor the marker gets `isSafeShardDir`'s
   ownership/mode hardening as the design stood, so in a world-writable `/tmp` a local user could
   plant a marker and **silently disable sweeping** for everyone on the box.

## 6. Deliberately not built: history and temporal replay

Replaying the projection across a repository's history — "what did this corpus look like at commit
X" — is **not built and not planned.** It is recorded here rather than dropped for two reasons: two
live invariants keep the door open and are breakable by someone who does not know why they exist,
and one finding dissolves most of the demand for the door.

**The two invariants, both live today:**

- **`parseMarkdownContent(content)` must stay content-only.** It takes bytes, not a path, so a blob
  that is not on disk — one read straight out of `git cat-file` — is parseable. Adding a path
  parameter or an `fs` read to that signature would close history permanently, silently, and for a
  reason having nothing to do with history.
- **Nothing path-, origin- or commit-derived may ever enter the cache key.** The content key is
  `<parserKind>.<sha256>` over bytes (§2), and this is one of the reasons: the same blob parsed at
  HEAD and parsed at a commit from last year must land on the same entry, or any historical pass
  re-parses the entire corpus from cold.

**Validation stays HEAD-only by design**, and that is not a gap waiting to be filled. Checking a
historical document against today's config is an anachronism — it reports findings that were not
findings when the document was written, under rules that did not exist.

🎯 **The finding that dissolves the project.** The highest-value temporal question anyone actually
asked for is **provenance staleness** — a document citing sources that have since moved on. That
needs *"last commit touching X versus last commit touching Y"* for a few hundred paths. It does not
need a replay of anything. It is a product feature reachable one `git log -1` at a time; replay is a
research project, and the two were only ever conflated because both contain the word "history."

The price of the replay road is four problems inherited from the prototype, recorded so the price is
visible before anyone pays it: `commits.seq` used as a **replay-range ordinal**, which silently
changes meaning the moment commits are appended; **per-commit edge snapshots** — 1.9 M rows for 400
commits — where a change-log is the shape that data wants; **`--first-parent` only**, so everything
merged in is invisible; and **`(ref, commit)` needed as the identity** for any multi-branch corpus,
which a bare commit key cannot express.

## 7. Status

- ✅ **Shipped** (stages 1b/2): the pipeline restructure and the object-level, content-addressed parse
  cache described in §5.
- ✅ **Shipped** (stage 3, schema only): the ten projection table shapes as Zod schemas with
  generated JSON Schema, carrying no contract-version constant. Includes the `blob_links` →
  `blob_references` rename — the old name was a claim the data cannot make (a markdown link is
  certainly a link, an `@`-prefixed token is not), so the table now records syntactic shape and
  lexical features rather than classified link types. Classification needs the corpus, and the
  parse cache is content-addressed across corpora — the same bytes share one blob-keyed row
  everywhere they appear, so a fact true in one repository and false in another cannot live on
  that row. §2's table above already reflects the new name.
- ✅ **Shipped** (stage 3): population of those tables from `ParseFacts`/`ResourceRegistry` at
  runtime, and export.
- 🔷 **Proposed** (beyond stage 3): the git-lane and non-git-lane change-detection manifests from
  the scanning doc; the blob-SHA memo.
- ✅ **Shipped** (stage 4): `resource_tags` has a producer. `AgenticConventionContributor`
  (`stratum: 'base'`, `readsBlobs: false`) classifies every realization by path and emits the
  convention vocabulary plus a `loading` row; it is registered in the repo-wide lane after the
  enumerator whose realizations it reads. It is a *contributor*, not a schema change — the table's
  key `('resourceId','tag','value','source')` is unchanged. The six extent contributors still
  return `tags: []`, which is the rule `git-extent.ts` states: tags are for classification
  contributors.
  - ⛔ **Three conventions carry no `loading` value, on purpose.** `rules-file` (Anthropic
    documents that a rule *without* `paths:` frontmatter loads unconditionally, so the class is a
    frontmatter fact and this lane declines to parse), `agents-md` (Claude Code reads `CLAUDE.md`,
    not `AGENTS.md` — an `AGENTS.md` is charged only where a `CLAUDE.md` imports it, making the
    class a property of the import graph), and every path matching nothing. A missing row is the
    positive statement *"a path cannot answer this"*.
  - `changeset`, `deferred-source`, `deferred-dest` and `entry-point` were dropped from the
    vocabulary the earlier draft listed: the first belongs to the npm Changesets release tool that
    no agent harness reads, and the other three are the skill packager's and a lens's outputs
    rather than functions of a path.
- ✅ **Consumed as of 2026-08-23.** `resource_tags` has its first reader: the always-loaded
  context-budget check reads the `claude-md` tag to decide which realizations set an instruction
  chain (`packages/resources/src/projection/claude-context-budget-sweep.ts › claudeMdIdentities()`,
  and the same lookup in `claude-context-accounting.ts`'s caller). It ships as `vat claude budget`,
  a command of its own rather than a check folded into `vat resources validate` — a validation run
  must not emit findings nobody asked for. `lens_entry_points` remains unbuilt, and the check does
  not join against it. A populated table is still not evidence of a *useful* one any more than a
  typed one was evidence of a populated one; what changed is that this one now has a consumer that
  would break if it went empty.

> ✅ **The Zones revisions below have LANDED** — this note is kept as the record of what changed and
> why, not as a warning about pending work. Zone modelling was originally deferred past population
> and moved to the front, because the capabilities that justify the projection are all *cross-zone*
> questions. `packages/resources/src/schemas/` now implements every revision listed here.
>
> ⚠️ **§2 above has not been swept for this and still describes the pre-Zones shape in at least two
> places** — it calls `resource_realizations` a table the projection "does not yet carry", and keys it
> on `zone_id` where the shipped schema uses `extentId`. Read
> `packages/resources/src/schemas/projection-*.ts` as the authority until that sweep lands.
>
> Revisions, each forced by a concrete case rather than by taste:
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
  measurements that produced these decisions — is captured in the committed docs and in the code
  itself. There is no separate design spec to consult, and no uncommitted one is coming back. Within
  this document: the columnar-engine spike and the correction that refuted its premise (§2), the
  eviction design and the five defects a review found in it (§5), the namespace rejections and what
  replaced them (§5), and the history road and the finding that dissolves it (§6). Elsewhere:
  [Content Keying and Git](./content-keying-and-git.md) for why a git blob OID and VAT's content key
  hash different preimages, [Resource Scanning and Object Caching](./resource-scanning-and-caching.md)
  for the two-lane cost model, and `packages/resources/src/cache-namespace.ts`'s module docstring for
  the two hand-maintained namespace discriminators that were tried and removed.
