# Zones: extents and lenses

**Status markers used throughout:** ✅ shipped — 🔷 proposed, not yet built.

Everything here is 🔷 **proposed**. No zone machinery exists in code today. It is recorded because it
changes the shape of the [resource projection](./resource-projection.md), and because several shipped
behaviours turn out to be special-cased instances of it.

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

A naive "one context lens per directory" would give one instance per source directory — 466 in this
repository. They differ **only in entry point**: same extent, same resolution semantics, same
interpretation, same traversal policy but for the ancestry chain. Keying edges on the instance stores
identical resolutions once per directory, growing as `O(references × directories)`.

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

Consequences:

- A source file bundled into three skills is **one identity with four realizations**.
- A file generated only into build output is minted there.
- **Zero realizations is legal.** A plugin named in a marketplace manifest but not installed has no
  local path — known but not present. This generalises the existing declared-but-unwritten idea (a
  `files:` target not yet written).
- Therefore `resources` is an **entity** table, not a file table. Plugins, skills, marketplaces and
  external document libraries are all linkable resources that are not markdown content.

### Most columns belong to the realization

`contentKey`, `mtime`, `exists`, `isDirectory`, `gitignored`, `isSymlink`, `symlinkResolves`, `dir`,
`depth`, `ext`, `pathLower`, `basenameLower` are all properties of *a path in a zone*, not of an
identity. `resources` keeps `(resourceId, kind, origin, observed, vatId)`.

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
edges            (src, refOrdinal, resolutionContextId, kind, origin, resolution)
edge_resolutions (src, refOrdinal, resolutionContextId, candidateOrdinal,
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
**macros — generic config, not privileged code** (`packages/utils/src/link-auth/macros.yaml`). Its
per-provider "what does *not found* mean" rule (`link-auth/resolve.ts`) is the interpretation facet
already in production. That macro vocabulary is auth-provider-specific today; generalising it into the
lens/resolver vocabulary is expected work.

## 8. Zones already exist, special-cased

Two shipped behaviours are zone facts written as bespoke rules, and become derived under this model:

- **`NON_PORTABLE_ASSET_REFERENCE`** (`packages/agent-schema/src/validation-codes.ts:348`) flags a
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

## 9. Related

- [Resource Projection](./resource-projection.md) — the table shapes zones operate over
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the git/non-git
  scanning taxonomy the `git` and `filesystem` extents formalise
- [Skill Packaging Shapes](./skill-packaging.md#inventory-layer) — the inventory layer that enumerates
  skill, plugin and marketplace extents
- [Validation Codes](../validation-codes.md) — the codes referenced in §8
