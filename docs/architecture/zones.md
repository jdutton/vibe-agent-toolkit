# Zones: extents and lenses

**Status markers used throughout:** ✅ shipped — 🔷 proposed, not yet built.

**Partly built as of 2026-08-13.** The projection schema, resource identity and realizations, the
blob layer, and the **contributor seam with its stratified fixpoint** (§6) are ✅ in code — six extent
contributors ship and a whole-corpus population of this repository runs end to end. Everything on the
*lens* side is still 🔷 proposed: `edges`, `edge_resolutions`, `lens_entry_points`, resolution tiers
and the resolvers that grade them are the derived-per-lens column of §2's table and nothing populates
them yet. The model is recorded here because it changes the shape of the
[resource projection](./resource-projection.md), and because several shipped behaviours turn out to
be special-cased instances of it.

## 1. What a zone is

**A zone is an extent plus a rule for reading it.** Four facets, each varying independently in real
cases:

| facet | question it answers |
|---|---|
| **extent** | which resources exist here |
| **traversal policy** | which reference kinds are followed |
| **resolution semantics** | how a reference becomes a target |
| **interpretation** | what counts as a reference in the first place |

The projection records facts about resources. A zone is the lens that turns those facts into meaning
— and the same facts, read two ways, legitimately produce two answers. That is the model working, not
an ambiguity to resolve.

## 2. Extents and lenses

Two species:

- An **extent** answers *what exists here*: git, the working filesystem, a build-output tree, an
  installed plugin directory, a package namespace, a marketplace namespace.
- A **lens** answers *what does this reader traverse, and how does it resolve* — **over an extent**.

The split does real work. It makes both of these true without set algebra:

- A markdown renderer sees git, and follows `[]()` but not `@` imports.
- Claude sees the **filesystem** — including gitignored build output — and follows `[]()`, `@`
  imports, and `.claude/rules` `paths:` globs.

"Claude can see gitignored build output that the git extent cannot" is not an intersection of two
zones. It is a *different base*. Set operations remain useful for reasoning queries ("what can CI
reach that a renderer will not follow?"), but they are derived, not primitive.

### Visibility is extent

There is deliberately **no visibility relation**. "The build extent cannot see source" is what happens
when a reference's target is not a member of that extent, so it resolves to nothing.

This is the mechanism behind the `files:`-blindness defect family: a link that resolves in source and
silently dies in the packaged bundle. Per-lens resolution turns that family from a behaviour
contributors must remember into a row anyone can query.

### Lenses are ephemeral; extents are data

A lens may be declared in config **or invented on demand** to answer a question nobody anticipated. So
the set of lenses is not known at population time:

| materialised (data) | derived per lens (function) |
|---|---|
| resource identities | edges |
| realizations | resolution and its tier |
| blob reference candidates (shape only) | which candidates count as references |
| extent memberships | traversal reachability |

Facts are data; meaning is a function applied to them. Inventing a lens costs a definition, not a
population pass. Caching a lens's results is an optimisation with no data-model commitment.

### Lens identity factors in two

A naive "one context lens per directory" would give one instance per source directory — **468** in
this repository (directories holding at least one tracked file, re-measured 2026-08-13; it was 466 on
2026-08-12 and 452 before that, so quote it with its date or not at all). They differ **only in entry
point**: same extent, same resolution semantics, same interpretation, same traversal policy but for
the ancestry chain. Keying edges on the instance stores identical resolutions once per directory,
growing as `O(references × directories)`.

The always-loaded budget is what makes the entry point worth a row at all. Measured with the shipped
estimator (`estimateTokens`, `Math.ceil(chars / 4)` — `packages/resources/src/link-parser.ts:131`)
over each directory's CLAUDE.md ancestry chain plus its transitive `@` imports, on 2026-08-13:

| chain | tokens |
|---|---|
| `./CLAUDE.md` | 7,701 |
| `./docs/CLAUDE.md` + `@README.md` | 184 + 1,089 |
| `./docs/architecture/CLAUDE.md` + `@README.md` | 360 + 4,233 |
| **worst directory (`docs/architecture`)** | **13,567** |

One directory of 468 is over 12,000 and 146 are over 8,000. The figure moves whenever the root
CLAUDE.md does — it was 13,568 a day earlier — so **no threshold or flag rate is quoted from it**.

So lens identity splits into a **resolution context** (extent + resolution + interpretation +
reference-class policy), which edges and memberships key on, and an **entry point** (the directory or
other parameter), a cheap row naming its ancestry chain and joining to a shared context.

## 3. Zone kinds

An **open vocabulary** — adding a kind adds rows, never migrates the schema.

| kind | species | notes |
|---|---|---|
| `filesystem` | extent | everything on disk under a root |
| `git` | extent | tracked ∪ (untracked ∧ ¬ignored) — "committed or potentially committed" |
| `tree` | extent | roles: `source`, `dist`, `vendored` |
| `package` | extent | workspace packages and declared dependencies, honouring `exports` maps |
| `skill` / `plugin` / `marketplace` | extent | nested; **closure-defined** — see §6 |
| `install` | extent | what an installed plugin can reach |
| `registry` | extent | `installed_plugins.json` / `known_marketplaces.json` namespaces |
| `collection` | extent | see below |
| `claude-context` | lens | entry point is a directory |
| `github-render` | lens | over `git` |
| `wiki` | lens | modelled, not built — title resolution, interwiki prefixes |
| config-declared | either | see §7 |

**Collections are zones — but on the interpretation facet, not visibility.** It is tempting to say a
collection creates no visibility boundary and therefore is not a zone. That tests one facet against a
four-facet definition. A collection's `frontmatterSchema` determines which frontmatter fields are
`format: "uri-reference"` and therefore **which frontmatter values are references at all** (see
`packages/resources/src/schema-uri-walker.ts`; `skill-packager.ts:1038` reads
`collectionConfig.validation?.frontmatterSchema`, and `:1025` notes collections without one are
skipped). Two files with byte-identical frontmatter in different collections yield different
reference sets.

### The `wiki` lens — evidence, and two constraints it must satisfy

The `wiki` row above is modelled and unbuilt. Two facts about real corpora constrain what building
it may assume.

**Wikilinks are not captured at all today.** `isCandidate()` in
`packages/resources/src/reference-lexer.ts` admits a bare token only when it contains a `/` **and**
ends in an extension, so `[[foo]]` never becomes a `blob_references` row, and
`ReferenceSyntacticForm` has no member for it. No check can fire on a reference no producer emits.

**Measured (a private multi-package adopter monorepo, canonical tree, 2026-09-06):** 47 distinct
wikilink targets over 99 occurrences in 1,945 markdown files; **7 targets (15%) resolve to nothing,
accounting for 27 of the 99 occurrences**, two of them inside `packages/*/CLAUDE.md` — files an
agent loads. ⚠️ Pruning `.claude/worktrees` is load-bearing for that measurement: an unpruned scan
sees 55,203 markdown files and inflates every occurrence count by roughly 32×, because each worktree
duplicates the corpus.

**Constraint 1 — a wikilink's namespace is declared, never inferred.** That corpus uses one syntax
for two unrelated target spaces: `[[UXD-057]]` is an anchor inside a single backlog file, and
`[[a-name-is-not-an-identity]]` is a file *outside the repository entirely*. Nothing in the token
distinguishes them; only the lens can. Inferring a namespace from shape is the mistake
[content routing](../contributing/content-routing.md) and the packaging rules both name — a pattern
that matches is not a declaration.

**Constraint 2 — resolution has three outcomes, not two.** A lens must distinguish *resolved*, from
*unresolved* (shaped like a reference in this lens's space and naming nothing — a finding), from
*not-applicable* (not in this lens's space at all — silent). Collapsing the last two makes a broken
reference and an ordinary sentence containing a slash indistinguishable, which is precisely the
noisy-signal failure `reference-lexer.ts` documents when it trades recall for precision.

## 4. Identity and realizations

A resource has **one identity and many realizations**:

- `resourceId = hash(rootId, canonicalPath at first observation)`, opaque
- a **realization** is `(resourceId, extentId, path, …node attributes)`

**The origin zone is an attribute, not part of the hash.** Hashing it looks appealing and fails twice:
a single file is simultaneously in the filesystem, git, source-tree, package and skill extents with no
defined precedence; and extents are phase-dependent (a build extent does not exist before a build), so
the same bytes at the same path would mint different ids at different points in one command. Nothing
ever reads the zone back out of an opaque hash, so it was doing no work.

**`canonicalPath` needs an explicit rule.** `pathLower`/`basenameLower` exist precisely because case
matters; hashing a raw path defeats them, and Node's two `realpath` implementations disagree about
which casing they return. Rule: **git-index casing where the path is tracked, otherwise on-disk casing
with symlinks resolved.** A symlink and its target share one identity; a symlinked directory loop
mints one identity per real file.

> ⚠️ **Open — the rule is stated and only half tested.** The symlink half is covered on macOS: a
> symlink and its target collapse to one identity, and a directory loop terminates. The **case-
> insensitivity half is not**, and neither is Windows. Both matter here and nowhere else in the
> model: `pathLower`/`basenameLower` exist *because* case matters, Node's two `realpath`
> implementations disagree about which casing they return (`realpathSync` preserves the casing asked
> for, `realpath` returns the casing on disk), and on APFS or NTFS a single file is reachable under
> spellings that hash differently. The git-index-casing clause is what is supposed to make the answer
> deterministic where a path is tracked — untracked paths on a case-insensitive filesystem have no
> such anchor, and that case has no test. Windows is where a symlink test would actually exercise the
> divergence, and VAT's symlink tests do not run there today. Resolve before any check depends on
> two populations minting the same id for the same file.

Consequences:

- A source file bundled into three skills is **one identity with four realizations**.
- A file generated only into build output is minted there.
- **Zero realizations is legal.** A plugin named in a marketplace manifest but not installed has no
  local path — known but not present. This generalises the existing declared-but-unwritten idea (a
  `files:` target not yet written).
- Therefore `resources` is an **entity** table, not a file table. Plugins, skills, marketplaces and
  external document libraries are all linkable resources that are not markdown content.

### Most columns belong to the realization

`contentKey`, `contentState`, `mtime`, `exists`, `isDirectory`, `gitignored`, `isSymlink`,
`symlinkResolves`, `dir`, `depth`, `ext`, `pathLower`, `basenameLower` are all properties of *a path
in a zone*, not of an identity. `resources` keeps `(resourceId, kind, origin, observed, vatId)`.

`contentState` (`keyed` | `deferred` | `unreadable` | `none`) exists because a null `contentKey`
answers four different questions at once, and demand-driven keying adds a fifth. A file that could
not be read and a file nobody has asked about are not the same fact, and letting them share a
spelling is the completeness failure `zone_provenance.extentDigest` exists to prevent. The pairing
is pinned by a schema refinement in both directions, so a key without the state — or a state without
the key — fails to parse rather than being merged into the projection.

`contentKey` is the one that forces the issue: the packager **rewrites content** into the bundle
(`skill-packager.ts:729-754` repoints bundled links at flattened dist paths), so a resource's source
and dist realizations have **different bytes and different content keys**. A single scalar
`contentKey` on the identity would make the `resource → blob` join — which every blob-derived fact
depends on — undefined for any multi-zone resource.

### `(extentId, path)` is unique

The inverse of one-identity-many-paths also occurs: `skill-packager.ts:624` records that `a-b/c.html`
and `a/b-c.html` both flatten to `a-b-c-html`, and `registerBundledAssets`' `DuplicateResourceIdError`
catch is the only place that collision is observable today. A contributor that would emit a second
realization at an occupied path emits a **collision condition row** instead, so the diagnostic
survives and no consumer resolving `(extentId, path)` gets a nondeterministic answer.

## 5. References and edges

### The blob layer records shape; a lens assigns meaning

The parse cache is content-addressed, so **the same bytes share one entry across every corpus that
contains them**. A blob entry may contain only what a lexer can determine without leaving the file.

A cached fact like "`@some-scope/pkg` is an npm package" would be true in one repository and false in
another, and served confidently to both — the same defect class as a shared parse result letting one
skill inherit another's identity: *a cache entry carrying a fact that is not a function of its key*.

So the blob layer records position, **syntactic form** (markdown link / link reference / definition /
`@`-prefixed / variable-anchored / bare token), **lexical features** (extension, leading `@`, slashes,
variable expansion), and **context** (`inCodeSpan`, `inFence`). Nothing else.

Classification is a per-lens question. `xxx/yyy` is simultaneously path-, package- and
plugin/skill-shaped; only an extent can say which. Even *"is this an import"* is path-dependent,
because an `@` token means import only in a file named `CLAUDE.md`, `CLAUDE.local.md`, or under
`.claude/rules/` — and a filename is not a blob fact.

### Edges and resolutions are separate tables

```
edges            (src, refOrdinal, contextId, kind, origin, resolution)
edge_resolutions (src, refOrdinal, contextId, candidateOrdinal,
                  dstResource, dstAnchor, score)
```

A single scalar target cannot express what the model requires. Wiki title resolution is
many-candidate by nature — `[[Configuration]]` in a forgiving flat namespace may match four files —
and collapsing that to one winner *is* last-write-wins, the very defect per-lens resolution exists to
remove. Scored inference has the same shape: "95% match in the git extent, absent from the skill
extent" is a scored candidate, and there is nowhere to put a score on a scalar column. Single-target
resolution is the N=1 case at the cost of one join.

Edge properties:

- **`origin`** — `authored` | `implicit` | `inferred`. Implicit edges (the CLAUDE.md ancestry chain, a
  rules file matching by `paths:`) have no blob reference row, so `refOrdinal` is nullable. `origin`
  cannot be added later: it changes the meaning of every row.
- **A row exists only where the lens traverses that kind.** A renderer's relation to an `@` import is
  *no edge*, not an unresolved one; conflating them would report false brokenness on every `@` import
  in every repository.
- **Resolution is graded**, over an open vocabulary:

| tier | meaning for the reader |
|---|---|
| same plugin | co-bundled — available whenever the referrer is |
| same marketplace | installable from an already-trusted source; may not be installed |
| known other marketplace | reachable, plugin not installed |
| unknown marketplace | no path to it at all |
| auth-required | reachable only with credentials |
| nonexistent | dead |

⚠️ **The tier above grades a CANDIDATE, not an edge — and the shipped schema puts it on the wrong
table.** Every tier in that list is a statement about a *target*: whether **it** is co-bundled,
installable, or dead. An edge with two candidates — one in the same plugin, one in an uninstalled
marketplace — has no single tier, so one string on `edges` cannot describe it. What genuinely
belongs on the edge is the *verdict over the candidate set* (`resolved` / `ambiguous` /
`nonexistent`), which is derivable from the candidates rather than authored beside them.

The current `EdgeRowSchema.resolution` mixes both vocabularies in one column. Fix it by moving the
tier to `edge_resolutions` and either deriving the edge verdict or dropping the column. **Do this
while the tables are still empty**: the schema makes exactly this argument about `origin` — a
discriminator added after rows exist changes the meaning of every row written before it.

### A destination is not always a resource

`dstResource` is a foreign key into `resources`, so it can only name something the projection
contains. Three real destination classes do not satisfy that, and today all three collapse into
`dstResource: null`, which reads as *"resolves to nothing"*:

- **External URLs.** `https://example.com/x` is a real, identifiable destination that must never be
  a resource — projecting it would mean projecting the web.
- **Targets outside the corpus boundary.** On the primary adopter, 13 wiki-links resolve to memory
  files **outside the repository**. They resolve perfectly well; the corpus simply stops short of
  them. ⚠️ **Provenance: NOT the shipped projection.** Wiki links are not lexed at all — see "a
  wiki alias" under *What the model must survive* below — so `blob_references` cannot hold this
  number and no SQL produced it. The only wiki-link scanner on record is the prototype cited in that
  same subsection, the one whose fence defect produced three wrong numbers. Whether 13 came from it
  is unrecorded, which is itself the point: treat 13 as indicative of the *class*, never as a count,
  and re-measure once wiki-link recall lands.
- **Declared-but-unwritten targets**, which `resources.observed` already anticipates on the node
  side but which have no edge-side expression.

The collapse has teeth beyond tidiness. **A dangling-link count that cannot separate "dead" from
"outside the corpus" is not a defect count**, and any measurement of link health must report the
two separately or it reports a fiction.

It also defeats grouping. *"Which document is cited most often?"* and *"which references can be
deduplicated into one reference-style definition?"* are both `GROUP BY destination`, and an
external destination has no key to group on — its identity survives only as unnormalized text in
`blob_references.rawRef`, where `https://x/y`, `https://x/y#frag` and `https://X/y` are three
different strings for one destination.

⇒ **Carry a canonical `dstKey` on `edge_resolutions`**: the resource id for an internal target, a
normalized URI for an external one, and a normalized out-of-corpus path for the third class. Then
every reverse-index and dedupe query is one `GROUP BY dstKey` regardless of destination class, and
`dstResource` stays a true foreign key that is null exactly when the target is not in the corpus —
a fact, rather than an absence standing in for four different ones.

🚨 **`dstKey` does NOT deliver the dangling-count requirement this section opens with, and must not
be sold as if it did.** It is a *grouping* key, not an *existence verdict*. Nothing in the
projection stats a path outside the population — `RealizationConditionRowSchema.observed` is
explicitly null for `CLOSURE_REFERENCE_OUTSIDE_ROOT`, "the target lies outside the population
entirely" — so a genuinely dead target and a live out-of-corpus target both normalize to an
out-of-corpus path, both get `dstResource: null`, and `dstKey` does not tell them apart. Separating
"dead" from "outside the corpus" needs a **verdict column fed by something that actually looked**,
which is a second decision this section has not taken. `dstKey` fixes grouping; it is not the
defect-count fix.

Three things `dstKey` must specify before anyone builds it, none of which are settled here:

- **A `dstKind` discriminator.** Three namespaces in one column — an opaque `hash(rootId,
  canonicalPath)`, a normalized URI, a normalized out-of-corpus path — means a `GROUP BY dstKey`
  result cannot say what class it grouped without re-parsing the key string. That is the same
  "identity survives only as text" failure this section objects to, moved one column over.
- **Stability across extent widening, which the next paragraph recommends.** Widening moves a
  destination from the out-of-corpus class (a path) into the resource class (a hash): the key
  changes *class*, not merely value. Anything comparing `dstKey` across runs — a dedupe cache, a
  run-to-run diff, a lab cross-version compare — is invalidated by precisely the action we endorse.
  Case-only renames, symlinks, and one relative link resolved from two bundle roots have the same
  problem on the out-of-corpus branch, which has no identity service the way the resource branch has
  `identity.ts`.
- **What "normalized URI" means, exactly.** Host case is insensitive; **path case is not** — a
  blanket case-fold merges genuinely distinct targets on any case-sensitive server, so the
  `https://X/y` example above licenses a wrong normalization if read literally. Fragments and query
  strings need rulings too: `dstAnchor` is documented as joining `blob_sections.slug`, which an
  external `#frag` can never do, so it is either dropped in normalization or parked in a column
  whose documented meaning does not apply to it.

⚠️ Widening the extent is the *better* answer wherever it is available — an out-of-corpus target
that the reader can genuinely reach is evidence the extent is drawn too small, and extents are
data. `dstKey` is for the destinations no extent should ever contain.

### What the model must survive

Recorded because each of these was tested against the design rather than assumed, and two of them
changed it.

**Two that changed it:**

- **A markdown image is a reference with a destination, and it is invisible.** `LinkNodeType` is
  `link | linkReference | definition | htmlAttribute` — no image — and `![solo](solo.png)` parses to
  **zero** links. Both producers are blind to it independently: mdast yields no link node, and
  `reference-lexer.ts` excludes `image` spans. So a markdown image's destination never reaches the
  reference layer, while *packaging must copy that file*.
  ⚠️ **The blindness is markdown-only — do not generalise it to every blob.** `<img src>` **is**
  captured (`html-link-parser.ts:453`), arrives as `nodeType: htmlAttribute`, and gets its own
  `syntacticForm` of `html-link`. A producer that adds an `image` reference kind must not
  double-handle the HTML rows that already exist.
  The blind spot is already shipping a defect: on `[![alt](img.png)](url)` the packaging rewriter
  silently no-ops, because a regex replay matches the inner image href while mdast reports only the
  outer link, and the lookup misses. An image must be a reference kind, not a masked span.
- **A reference definition is not an edge.** `[a]: /url` is a `markdown-definition`; the edge
  belongs to the *use* (`[text][a]`), with the definition as resolution machinery. Counting both
  double-counts every inbound link and inflates every reachability walk — and it is not
  hypothetical, because rewriting repeated links into reference form (a token-economy transform)
  *creates* these rows. A transform that improves a document must not change its link graph.

**Three the model already handles, so nobody re-litigates them:**

- 🚨 **A link inside a fence — HANDLED FOR TOKENS, NOT FOR LINKS. This bullet used to claim the
  whole case and was wrong.** The *principle* holds and is why the columns exist: a prototype
  wiki-link scanner that dropped fenced links at scan time produced three wrong numbers, so
  `inCodeSpan` and `inFence` are stored rather than filtered, and whether to traverse is lens
  policy. But the principle is only implemented for **lexer-derived tokens**. For a markdown link
  the exclusion *is* in the scanner, on both producers: mdast yields a `code` node so
  `astCandidates` never sees the link (and AST rows hardcode `inCodeSpan: false, inFence: false`
  besides), while the lexer's `isCandidate` admits a bare token only with a slash *and* an
  extension. ⇒ `[a](b.md)` in a fence yields **no row at all**, and a slashed path yields a
  `bare-token` row that has lost the link grammar entirely — its text, its form, the fact anyone
  authored it as a link. A "what does this mention" lens cannot recover from the table what the
  scanner declined to put there. Measured below: every markdown form is 0/0 across both columns.
- 🚨 **A wiki alias — the TABLE handles it, the PRODUCER cannot. This bullet used to claim the
  whole case and was wrong.** `text` and `rawRef` are indeed distinct columns, so the *shape* is
  right. But nothing lexes `[[…]]` at all — there is no wiki branch in `reference-lexer.ts`, and
  the bare-token slash rule rejects `[[Target|shown]]` — and when one is built the only producer
  that could emit it is the lexer, whose row builder hardcodes `text: null` because a lexer token
  has no markup to carry link text. `LexicalReferenceSchema` has no `text` field and
  `ExactLexicalColumns` is a compile-time guard that stops the file building if the two key sets
  diverge. ⇒ carrying the display half of an alias is a **parse-cache shape change**
  (`ParseFactsSchema` is `.strict()`), not a lens change. Cheap, but not free, and not done.
- ⚠️ **Anchor existence — one join short.** `dstAnchor` does resolve against `blob_sections.slug`,
  with `slugOccurrence` disambiguating repeated headings, but it is not one hop and the last hop is
  not single-valued: `dstResource` is a resource id while `blob_sections` is keyed on `contentKey`,
  so the route runs `edge_resolutions → resources → resource_realizations.contentKey →
  blob_sections`. A resource may have **zero** realizations (a config-declared target), and the
  packager rewrites content, so a resource's source and dist realizations have **different bytes** —
  which is exactly why `resources.contentKey` was removed. Whether an anchor exists therefore
  depends on *which realization you ask*, and a consumer must say which. Handled at the level of
  shape; under-specified at the level of query.

**One the model admits but the lexer does not.** An embed (`![[foo]]`) *inlines* its target, so the
target's tokens are charged to the referrer, while a link (`[[foo]]`) only points. `EdgeKindSchema`
is an open vocabulary and takes `embed` without a migration — but the distinction is lexical, and a
lexer that does not separate the two forms makes the difference unrecoverable downstream. Any
token-accounting question depends on this one.

### Edge volume is a policy choice, not a corpus property

Measured 2026-09-08, in two sessions the same day, by SQL over the shipped projection
(`vat resources query`).

**The corpus, stated because a measurement without one is not reproducible:** the primary adopter,
9,840 blobs / 12,002 realizations / 127 MB of text / 31,615,948 estimated tokens. The projection's
corpus is the **tracked tree** — `resources.include`/`exclude` do not scope it — and `.gitignore`
*is* honoured. Verified for this run rather than assumed, because this repository has been bitten
by the opposite: the adopter carries **35 git worktrees on disk**, `.gitignore:145` ignores
`.claude/worktrees`, and `git ls-files` returns **0** tracked files beneath them. None of the counts
below are worktree-inflated.

| syntactic form | references | share | in code span | in fence | plain |
|---|---|---|---|---|---|
| `bare-token` | 50,935 | 44.4% | 14,839 | 1,172 | 34,924 |
| `at-prefixed` | 40,118 | 35.0% | 8,636 | 712 | 30,770 |
| `env-anchored` | 12,651 | 11.0% | 1,131 | 489 | 11,031 |
| `markdown-link` | 11,002 | 9.6% | **0** | **0** | 11,002 |
| `markdown-link-reference` | 32 | — | **0** | **0** | 32 |
| `html-link` | 14 | — | **0** | **0** | 14 |
| `markdown-definition` | 11 | — | **0** | **0** | 11 |
| **total** | **114,763** | | **24,606** | **2,373** | **87,784** |

> ⚠️ This table previously omitted `at-prefixed` — **40,118 references, 35% of the corpus** — and so
> summed to 74,645 against its own stated total. The omitted row is the `@`-import form that §5 uses
> as its own worked example of lens policy, i.e. the single form a producer must decide about first.
> Any sizing taken from the old table under-counted by a third.

A producer does not face "114,763 edges". It faces whatever its lens policy admits, and the range
is genuinely an order of magnitude: **authored forms alone are 11,059 (9.6%)**, while admitting
every lexer-derived token as an `inferred` edge is 114,763. That is the ~11k-vs-~115k span, and it
is decided before any code runs.

⚠️ **The two policies are NOT independent axes, and the doc used to present them as if they were.**
Every reference inside a code span is a lexer-derived token — the markdown forms are 0/0 across both
columns, because an AST link in a code context yields no link node at all (see "a link inside a
fence" above). So "traverse code spans" is a **sub-lever of "promote bare tokens"**, not a second
dimension: under an authored-only policy it changes the count by exactly zero, and under
full promotion it moves the ceiling by 21% (114,763 → 90,157), not by 10×.

⇒ **Size the producer against a declared policy, never against the reference count**, and state
the policy as *which origins*, with code-span traversal named underneath the `inferred` one. A
benchmark that does not state which policy it assumed is measuring an arbitrary point in a 10×
range.

### ⭐ A token in backticks is the PRECISE half, not the noisy one

The intuition that code spans hold examples and placeholders, and prose holds real references, is
**backwards on this corpus by 3.4×**. Measured over `bare-token` references outside fences with at
least one slash, counting a reference as a hit when its raw text is a path-suffix of some
`resource_realizations.path`:

| where the token sits | references | resolve to a real corpus path | rate |
|---|---|---|---|
| inside an inline code span | 14,839 | 11,060 | **74.5%** |
| plain prose | 34,924 | 7,565 | **21.7%** |

Backticks are the convention an author uses to *name a real file*; a path-shaped token loose in
prose is more often a package name, a glob, a URL fragment or an illustration. ⇒ **if bare-token
promotion is ever turned on, turn it on for in-code-span tokens first** — that is the high-precision
third of the population, and excluding code spans discards the best evidence while keeping the
worst.

⚠️ This is a **path-suffix proxy, not resolution.** It ignores the referrer's directory, so it
over-counts wherever a suffix matches a file the author did not mean, and it under-counts a target
outside the corpus that resolves perfectly well. It is sound for *comparing the two populations*,
which is what the policy decision needs, and unsound as an absolute link-health figure. The real
answer needs the producer this section exists to size.

⚠️ The costs that survive are narrow and real: negative examples ("never write `dist/foo`"),
placeholders (`path/to/file.md`), and quoted paths belonging to *another* repository all become
edges asserting a relation nobody declared. They are a minority, and they are the same minority
bare-token promotion carries everywhere.

### ⛔ Rewriting link syntax is not a token-economy lever — measured, not argued

The same measurement sized three transforms that a token-economy rewriter would perform, against
the 31,615,948-token corpus above:

| transform | saving | basis | share of corpus |
|---|---|---|---|
| trim naked-path link text to basename (715 of 11,002 live links) | 11,410 B | bytes / 127,236,626 B | **0.009%** |
| reference-style `[id]` dedupe (1,785 repeated pairs, 3,193 redundant uses) | 142,176 B | bytes / 127,236,626 B | **0.11%** |
| delete every byte-identical duplicate file (98 content keys) | 312,098 tok | tokens / 31,615,948 tok | **0.99%** |

The first two rows are measured in **bytes** and the third in **tokens**; the shares are therefore
against different denominators and are only comparable because bytes-per-token is a near-uniform
~4.0 across this corpus. Stated explicitly so nobody recomputes row 1 against the token count and
gets a different intermediate.

Two further facts make the first transform worse than its 0.009% suggests: **606 of 8,635 basenames
are ambiguous corpus-wide (7%)**, so the trim needs per-target verification against a scope rather
than being a blanket rewrite; and link text is the *routing signal* a reader uses to decide whether
to spend a read, so shortening it trades comprehension for nothing measurable.

🔑 **The cost is the documents, not their link syntax, and the lever is therefore selection rather
than spelling** — what an entry point pulls in, which is `lens_entry_points` plus reachability over
the edge relation. That is the same graph, applied to *what to load* instead of *how to write it*.

## 6. Contributors and resolvers

`resources` coordinates observation. It must not hold business knowledge — what a skill is, what an
external URL means, how a project's domain classifies a document.

- **Extent contributors** produce membership **rows**: data, at population.
- **Resolvers** provide resolution **semantics** a lens invokes: functions, at query time.

Contributors read a base projection (identity, realizations, blob facts) and return rows; `resources`
merges without interpreting.

### Merge is a stratified fixpoint

Closure-defined extents are not orderable. A skill's extent is a least-fixed-point over the edge
relation, and the edge relation is per-lens: `walk-link-graph.ts` is a bounded BFS where membership at
hop *n+1* depends on the resolved edges out of hop *n*, on whether hop *n* is routable, and on
exclusion rules and depth at each hop. A second cycle is already visible in the shipped schema, whose
tag `source` vocabulary includes `zone` — tags derived from membership, while membership may depend on
tags.

So acyclic strata get one pass, and the closure stratum **iterates to a fixed point** with a declared
iteration cap and loud failure on non-convergence.

Closure must be *declarable*, or a built-in could never be expressed the way a config-declared zone
would be:

```yaml
extent:
  closureFrom: <resource>
  follow: [<reference classes>]
  maxDepth: <n>
  exclude: [<globs>]
```

`packagingOptions` (`linkFollowDepth`, `excludeReferencesFromBundle`) is already this in disguise.

### The contributor seam, as built ✅

One interface, and every contributor is an instance of it:

```ts
export interface ExtentContributor {
  readonly id: string;
  readonly kind: string;
  readonly stratum: ContributorStratum;
  contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution>;
}
```

`contribute` returns rows and nothing else — `contexts`, `resources`, `realizations`, `memberships`,
`tags`, `conditions` — and the merge driver never reads a field of them for meaning.
`ContributorRegistry` keys on `id`, refuses a duplicate, and partitions by `stratum` *before* any
`contribute` call, which is why `id` and `kind` are constructor arguments while everything that
*shapes* an extent arrives in `parameters`. The driver resolves one parameter binding per contributor
and writes that same value both into `contribute` and into `zone_provenance.parameterSet`, so a
provenance row cannot describe a parameter set its extent did not run under.

**Six contributors ship.** `filesystem`, `git` and `package` are `base`; `skill`, `plugin` and
`marketplace` are `closure`. A skill extent is not a fourth walker — it is the generic closure
primitive under a per-skill id, handed a declaration translated from that skill's packaging config.

**Between the strata**, blob derivation turns the base's `contentKey` columns into the four
blob-keyed tables. It is deliberately *not* a contributor (it declares no extent, so it has no
context to attach a digest to), and its position is forced: the base is what records content keys and
the closure stratum is what reads `blob_references`. Without it every closure extent is its declared
root and nothing else — and the run reports success.

It derives from `keyed` realizations only, so demand-driven keying gives it a second occasion to run:
if anything promoted a `deferred` row during the closure stratum, derivation repeats **after** the
fixpoint, picking up only what is newly keyed. Re-running is safe because derivation skips blobs that
already exist, and it cannot serve a stale reference index to the closure stratum — the memo
`ClosureExtentContributor` keeps is keyed on `blob_references` row count as well as base identity, and
nothing reads that index after the fixpoint has converged. The two runs are reported separately rather
than summed: on a second pass `blobsAlreadyPresent` counts nearly everything the first pass derived,
so there is no honest arithmetic that combines them.

#### Convergence, measured 2026-08-13

Populating **this repository** with all six contributors — 61 skill extents plus plugin and
marketplace, 66 contributors in total — the closure stratum reaches its fixed point on **pass 2**:
one productive pass, then one confirming pass in which no contributor's digest moves. Nothing needed
a third. The run produced:

| table | rows |
|---|---|
| `resources` | 5,721 |
| `resource_realizations` | 8,001 |
| `resource_extents` | 8,041 |
| `resolution_contexts` | 170 |
| `zone_provenance` | 170 |
| `blobs` | 4,697 |
| `blob_references` | 44,585 |
| `blob_sections` | 5,805 |

The 170 extents are 1 `filesystem`, 1 `git`, 62 `package`, 61 `skill`, 37 `plugin`, 8 `marketplace`,
each with exactly one `zone_provenance` row. **Every row count above is volatile**: a second run
seven minutes later, on the same working tree with an editor open in it, gave 4,696 blobs / 44,572
references / 5,785 sections and one `BLOB_CONTENT_CHANGED` condition — the stage recording that a
file's bytes moved between enumeration and derivation. Quote these with the date, and do not assert
them in a test.

That last condition is now **unreachable inside `populate()`**, and deliberately so. The per-run
content cache (`content-cache.ts`) reads and keys each path once and hands the same bytes to every
later stage, so a population describes one consistent instant rather than a smear across whichever
contributor read first — a projection whose realization row names one blob while its `blobs` row
describes different bytes is not more truthful, it is inconsistent. The guard remains for a
`populateBlobs` call whose builder carries no cache, where the derivation-time read is genuinely a
second read of the file.

`edges`, `edge_resolutions` and `lens_entry_points` are **0** because nothing populates them — they
are the derived-per-lens output of §2, not rows a contributor emits. §17 risk 4's naive pre-factoring
estimate was ~4 × 10⁵ edge rows for a whole-corpus context lens; after the resolution-context
factoring the *materialised* substrate that a lens is evaluated over is the 44,585 reference
candidates above, and the per-directory duplication the naive figure came from (§2's 468 instances)
is gone by construction — one resolution context, not one per directory.

**Depth 2 is structural, not a corpus-size fact.** A closure contributor's output is a function of
the base's paths and its `blob_references`, and a closure pass can add neither: it only re-realizes
paths the base already realized. So the *only* thing that can carry the stratum past pass 2 is one
closure contributor reading another closure contributor's rows. Exactly one such dependency ships —
`PluginExtentContributor` absorbs the members of any `skill` extent nested inside a plugin directory
— and it costs a pass only when the plugin contributor is registered *before* the skill ones, which
is registration order rather than corpus content. (Reasoned from the code, not separately measured.)

The cap is therefore **8**, four times the measurement: headroom for depth in the *contributor
graph*, which is the thing that could plausibly grow, while still failing a genuine cycle in seconds.
Reaching it throws `ClosureNonConvergenceError` naming the contributors still moving — never a
truncated extent reported as a complete one.

#### The closure primitive, as declared

The §6 sketch above is inert config data with one field added — the `kind` the contributor is
registered under, which the declaration must agree with:

```yaml
extents:
  my-skill-bundle:
    kind: skill                          # open vocabulary; must match the registered kind
    closureFrom: skills/foo/SKILL.md     # root-relative; admitted before any traversal
    follow: [markdown-link, markdown-link-reference, markdown-definition]   # default
    maxDepth: 2                          # number of hops, or "full"
    refusals:                            # ORDERED cascade — first match wins
      - label: DIRECTORY_TARGET          # opaque to the primitive; reported as the condition code
        kinds: ['directory']             # resources.kind values
      - label: NAVIGATION_FILE
        basenames: ['README.md']         # case-insensitive basename set
      - label: EXCLUDED_BY_PATTERN
        patterns: ['**/*.test.md']       # picomatch, dot: true, over root-relative paths
    admitPaths: ['notes/CLAUDE.md']      # exact paths that outrank the whole cascade
```

**An ordered, labelled cascade, one override, and a refusal is transitive.** `refusals` is a
first-match-wins list, and **the order is behaviour**: each rule carries a `label`, the winner's
label becomes the refused candidate's `realization_conditions.code`, so a directory that *also*
matches a pattern is attributed to whichever rule comes first. That is the same property
`walk-link-graph.ts`'s `classifyExclusion` has, and it is why the closure can now reproduce a
domain cascade's *reasons* and not only its membership. Within one rule the three matchers are
unordered — they yield that rule's single label — and they exist as three because one predicate
cannot express the other two: a basename set is not a path glob (a case-insensitive filesystem
generates spellings no alternation enumerates — `Readme.md`, `README.MD`), and an entity kind is not
a path at all (a directory's path is shaped exactly like a file's).

A refused candidate is not merely excluded from membership: **the closure does not traverse through
it**, so the subtree reachable only via that candidate is refused with it. That transitivity is the
whole reason a refusal is worth expressing — see the measurement below. Only the refused candidate
gets a condition row; everything pruned behind it never reached a rule, and claiming otherwise would
attribute a refusal that never happened.

The label is **opaque to the primitive** — it never interprets one. That is what keeps the primitive
generic while letting the skill translation supply `SKILL_REFUSED_NAVIGATION_FILE` and friends, one
per `classifyExclusion` branch it can express.

`admitPaths` is the one thing that outranks the whole cascade, for the same reason `closureFrom`
does: an explicit declaration outranks a net, because a glob never named the file it caught. Checked
before any rule runs, so an admitted path reports no label either. Exact string equality, never a
prefix test — the explicit-vs-glob distinction is the entire content of the rule, and it is the same
line `refusesAgentInstructionFile` draws for the `files:` escape hatch.

Every optional field carries a default rather than staying optional, so a parsed declaration is
total and assignable to the `JsonValue` that `zone_provenance.parameterSet` records verbatim.

#### What the declaration expresses, and what it does not

§7.3's adequacy test — *a built-in extent must be expressible the way a config-declared one would be*
— was run against the hardest case VAT has, the skill bundle, whose privileged walker
(`walk-link-graph.ts`) already computes the answer. Most of the cascade translates exactly; what does
not is listed below, and each unexpressible row names the oracle it would need:

| walker feature | verdict |
|---|---|
| `linkFollowDepth` *membership* | **expressible** — same union, same off-by-one |
| `depth-exceeded` *the REASON* | **expressible** — `maxDepth` bounds ADMISSION, not ENUMERATION: a member sitting at the bound still has its references resolved and judged, and one only the budget turns away becomes a `CLOSURE_DEPTH_EXCEEDED` condition carrying the same provenance a refusal does. The primitive's own verdict rather than a `refusals` label, so `matchedPattern` is null — which is what the walker's row says too (`makeExclusion` attaches `matchedRule` only for `pattern-matched`) |
| `excludeReferencesFromBundle` *membership* | **expressible** — first-match-wins and any-match select the identical file set, so a flat union of every rule's patterns in one refusal rule is exact |
| `excludeNavigationFiles` | **expressible** — a refusal rule over the navigation basename set, gated on the knob exactly as `classifyExclusion` gates its branch |
| `agent-instruction-file` *membership* | **expressible** — a refusal rule over the agent-instruction basename set, unconditionally (that branch is deliberately not gated on the navigation knob), and the explicit-`files:` escape hatch becomes `admitPaths` |
| `directory-target` *membership* | **expressible** — a refusal rule over `kinds`, which reads `resources.kind`; a path glob cannot express it |
| those four exclusions' REASON | **expressible** — each refusal rule carries a `label` reported as the condition code, and the cascade is declared in `classifyExclusion`'s own branch order. Pinned head-to-head against the walker's `excludeReason` by the corpus shadow's reason-mismatch bucket |
| a refusal's PROVENANCE (`sourcePath`, `sourceLine`, `linkHref`, `targetExists`, `matchedRule`) | **expressible** — `realization_conditions` gained the columns (projection schema v4) and the closure fills them at the refusal site; each of the five is compared field by field against the walker's own row by the corpus shadow |
| `excludeReferencesFromBundle` *WHICH rule matched*, and its `template` payload | **expressible** — one refusal rule per declared rule, in declared order, so the primitive's first-match-wins scan is `excludeMatchers.find(...)`'s; the winner's first pattern lands in `matchedPattern` and its `template` rides in the rule's opaque `payload` |
| `deferredArtifacts` (`files:`) | **not expressible** — its three-way classification is keyed on filesystem existence and on gitignore, and the closure does no I/O by construction. Only the one fact `admitPaths` needs — which sources are explicit, non-glob agent-instruction files — is a pure function of the config |
| `skill-definition` | **not expressible** — the verdict compares the target against *this walk's own* `skillRootPath`, and a declaration has no vocabulary for "the same file as my own root" |
| `gitignored`, `outside-project`, `unreadable-target`, `missing-target` | **not expressible** — each needs an oracle the closure does not consult |
| routable vs non-routable | **not expressible** — `follow` names a reference *form*, never the parser kind of the *target* |

Read the membership, reason and provenance rows together: the primitive now selects the same files
for those causes, names the same cause, and carries the same `sourcePath` / `sourceLine` /
`linkHref` / `targetExists` / matched-rule provenance a verdict *issue* needs in order to name a
location an author can open — so the `LINK_TO_NAVIGATION_FILE` / `LINK_TO_DIRECTORY` split VAT's
verdict engine reports is reproducible from a projection. What is still missing is the six reasons
whose oracles a projection does not consult (git, the project boundary, two read outcomes, its own
skill root, the target's parser kind).

**Measured at corpus scale, with its own negative control.** Over this repository's fourteen declared
skills, swept across `linkFollowDepth` 0/1/2/full (56 cells, 9 of which follow a real edge), the two
arms now differ on **nothing**. Stripping just the three refusal matchers out of the same declaration
— changing nothing else — brings back exactly the 253 differences measured before them:
`pruned-behind-exclusion` **239**, `navigation-file` **9**, `directory-target` **3**,
`agent-instruction-file` **2**. The 239 is the transitivity above: a refusal at one navigation or
agent-instruction hub removes everything reachable only through it. Nothing was ever walker-only at
any depth, which is what made this a *narrowing* problem rather than a "teach it to see" one.
See `packages/cli/test/integration/projection-skill-extent-corpus.integration.test.ts`.

**The last difference was a SILENCE, not a disagreement.** With membership identical, the two arms
still classified different *sets of references*: the walker runs `checkExclusions` before its depth
check, so it records a verdict for a link out of a member sitting at `maxDepth`, while the closure
stopped enumerating there and said nothing. Neither arm bundled those targets, so every
membership-shaped comparison was structurally blind to it, and the comparison had grown a pairing
rule that counted the unpaired walker rows instead of comparing them. Closing it in the primitive
(bound admission, never enumeration) rather than in the test took the compared population from
**59 paths to 94** and the per-field provenance population from 59 to 94 — 35 verdicts the closure
had simply not had: **18 `depth-exceeded`, 14 `pattern-matched`, 2 `navigation-file`, 1
`directory-target`**. The rule of thumb it leaves behind: *when two implementations differ because
one is silent, teaching the comparison to tolerate the silence hides the gap in the test instead of
closing it in the code.*

> ⚠️ Found while measuring that difference: **`walkLinkGraph`'s asset bundling ignores `maxDepth`
> entirely** — assets are added by `processLink` unconditionally, so a depth bound narrows the
> document closure and not the asset set. Observed in shipped code, not yet filed.

### Provenance is two-part

Recording *which contributors ran* detects only total absence. Population divergence is a difference
in **extent**, and on-demand materialisation makes partial divergence the common case — a skill marked
`publish: false` is inside the extent one command asks for and outside another's, with an identical
contributor set and both reporting complete.

So provenance records **`(contributorId, parameterSet, extentDigest)`** per zone instance, plus the
**lens definition and its parameters** for any result. A check **declares the extent it requires**, so
a mismatch is checkable rather than merely recorded.

### Two hard rules

- **A zone kind requested with no registered contributor throws**, naming the missing contributor.
  Never an empty extent — an empty set is a confident wrong answer.
- **Anything that fails a build runs through a named, declared lens**, never an improvised one. The
  value of an on-demand lens is that nobody vetted it, which is also why it must not gate CI.

## 7. Configurability

A config-declared lens supplies an extent, a **binding environment** (explicit variable values —
`${CLAUDE_PLUGIN_ROOT}` is the built-in instance), a traversal policy, a **resolver selected by
name**, the closure primitive above, and optional external-target meaning (href patterns mapped to
entity kinds with metadata).

An external document library then decomposes into existing mechanisms: the href resolves to an
**entity resource** with zero local realizations; tenant or system identity is a tag with a config
source; the reader's known facts are its binding environment; auth-required is a resolution tier. No
new tables.

**Declarative data only — never project-supplied code.** The moment config can supply a resolver
*function* it becomes a code-execution surface, and the guarantee that extensible tagging adds no
plugin API stops holding. New resolution logic is a built-in added upstream.

This follows the principle already **shipped** in authenticated link resolution
([#113](https://github.com/jdutton/vibe-agent-toolkit/issues/113), closed): built-ins ship as
**macros — generic config, not privileged code** (`packages/resources/src/link-auth/macros.yaml`). Its
per-provider "what does *not found* mean" rule (`link-auth/resolve.ts`) is the interpretation facet
already in production. That macro vocabulary is auth-provider-specific today; generalising it into the
lens/resolver vocabulary is expected work.

## 8. Zones already exist, special-cased

Two shipped behaviours are zone facts written as bespoke rules, and become derived under this model:

- **`NON_PORTABLE_ASSET_REFERENCE`** (`packages/schema/src/validation-codes.ts:348`) flags a
  skill document referencing a bundled asset via `CLAUDE_PLUGIN_ROOT`, because it "points at the
  plugin, not the skill, so the path breaks when the skill is mounted standalone" (`:350`). That is
  exactly *resolves in the plugin extent, unresolvable in the standalone-skill extent*.
- **`LINK_FROM_NON_ROUTABLE_FILE`** (`:106`) and the walker's `non-routable-source` exclusion encode
  membership-versus-traversability in traversal code. Under the model, `routable` is a per-`(resource,
  lens)` fact: a file can be a traversal node in one lane and a leaf-only member in another.

> ⚠️ **Open vendor question.** `packages/agent-skills/src/skill-test/plugin-env.ts:10` records that VAT
> does not know whether Claude Code sets `CLAUDE_PLUGIN_ROOT` when it loads a plugin via
> `--plugin-dir`. The plugin extent's resolution rule rests on that unverified assumption; resolve it
> before shipping a check that depends on it.

## 9. Open, not resolved

Four questions the built seam rests on, none of which is settled. They are recorded as open rather
than folded into the prose above, because each has a shipped consequence.

1. **`canonicalPath` on case-insensitive filesystems, and on Windows** (§4). The rule is stated and
   the symlink half is tested on macOS; the case-insensitivity half and Windows are not covered at
   all. Identity is the join key every other table hangs off, so a wrong answer here is not a local
   defect.
2. **Does Claude Code set `CLAUDE_PLUGIN_ROOT` at skill-invocation time?** (§8, and
   `packages/agent-skills/src/skill-test/plugin-env.ts:10`.) The plugin extent's resolution rule
   assumes it does. Unverified against the vendor, so no check may depend on it yet.
3. **Where the resolution tier lives, and whether `dstKey` is carried** (§5). Both are corrections
   to the shipped edge schema rather than new capability, and both are **cheap only while `edges`
   and `edge_resolutions` hold no rows** — which is true today, because nothing populates them.
   Once a producer exists, either change rewrites the meaning of existing rows.

   🚨 **Cheap is not free, and this item used to say "free" — which was wrong.** An empty table is
   not an absent consumer. Both row shapes have committed, npm-**published** JSON Schemas:
   `packages/resources/schemas/projection-edges.json` and `projection-edge-resolutions.json` are
   tracked, shipped by `package.json` `files` + `exports: { "./schemas/*": … }`, and have been
   readable by any consumer since v0.2.0-rc.6. `generate-resources-json-schemas.ts` states the
   intent outright — a schema in `NON_TABLE_ROW_SCHEMAS` is a claim that *this row shape is
   published but no projection table holds it*. And `test/projection-edges.test.ts` pins the shape
   across 17 assertions. Pre-1.0 policy makes the change **permitted**; it does not make it
   invisible. Changing either shape regenerates a published artifact, lands a diff under
   `schemas/`, and owes a CHANGELOG entry.
4. **Whether an image is a reference kind** (§5). It decides whether packaging can see the files it
   must copy, and a defect is shipping on the rewriter path today because it cannot.

## 10. Related

- [Resource Projection](./resource-projection.md) — the table shapes zones operate over
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the git/non-git
  scanning taxonomy the `git` and `filesystem` extents formalise
- [Skill Packaging Shapes](./skill-packaging.md#inventory-layer) — the inventory layer that enumerates
  skill, plugin and marketplace extents
- [Validation Codes](../validation-codes.md) — the codes referenced in §8
