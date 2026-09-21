---
name: vat-knowledge-resources
description: Use when working with VAT resource collections, per-directory frontmatter schema validation, link validation, or the vat resources commands. Covers collection configuration, schema mapping, validation modes, querying the resource projection with SQL via `vat resources query`, and declaring standing SQL assertions that gate CI via `vat resources check`.
---

# VAT Resources: Collections & Frontmatter Validation

## What Resource Collections Are

A **resource collection** is a named group of files that share a validation schema.
Collections are defined in `vibe-agent-toolkit.config.yaml` and enable different
directories to have different required frontmatter — without writing a single line of code.

## Config Format

```yaml
resources:
  collections:
    # Name your collection to match the doc type
    systems:
      include: ["docs/systems/**/*.md"]
      exclude: ["docs/systems/README.md"]   # exclude human-only ToCs
      validation:
        frontmatterSchema: "schemas/system.schema.json"
        mode: permissive    # required fields enforced; extra fields allowed

    adrs:
      include: ["docs/architecture/adr/**/*.md"]
      validation:
        frontmatterSchema: "schemas/adr.schema.json"
        mode: permissive

    skills:
      include: ["**/SKILL.md"]
      validation:
        frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
        mode: strict         # SKILL.md: no extra fields beyond spec
```

## Validation Modes

| Mode | Required fields | Extra fields | Use for |
|---|---|---|---|
| `permissive` | Enforced | Allowed | Docs with project-specific extras |
| `strict` | Enforced | Error | SKILL.md, API specs, tightly controlled schemas |

**`strict` only rejects extras when the JSON Schema sets `"additionalProperties": false`.** `mode: strict` makes VAT *honor* that schema constraint; without it (or with `additionalProperties: true`), extra fields are still allowed even in strict mode. So a tight schema is two parts: `mode: strict` in the collection config **and** `"additionalProperties": false` in the schema file. `permissive` ignores `additionalProperties` and always allows extras. When `mode` is omitted, collection validation defaults to `permissive`.

## Running Validation

```bash
# Validate all collections (reads vibe-agent-toolkit.config.yaml)
vat resources validate

# Validate specific collection only
vat resources validate --collection systems

# Validate with extra schema (adds to collection schemas)
vat resources validate --frontmatter-schema ./extra.json
```

## Asking the Projection a Question Directly

`vat resources validate` answers the questions it was written for. When you need one it has no
field for — which files carry which headings, what links at what, which paths the parser refused
and why — `vat resources query` runs ONE read-only SQL statement against the same population:

```bash
vat resources query "SELECT path FROM resource_realizations WHERE ext = '.md' LIMIT 5"
vat resources query 'SELECT * FROM blob_conditions'        # what was refused, and why
vat resources query 'SELECT rawRef FROM blob_references WHERE syntacticForm = ?' --param markdown-link
```

A statement naming a table or column that does not exist gets the real columns of the tables it
named — VAT ships no schema version, so that listing is how you find what a name became. The
statement is also **compiled before the projection is populated**, so a typo costs milliseconds
instead of a full crawl (measured on an adopter: 8.3 s → 0.5 s). Writes are refused by the engine
(`PRAGMA query_only`), `ATTACH` is refused, and a statement carrying a second statement is refused
outright, because SQLite compiles only the first and **discards the rest without error**.

### 🚨 The corpus is the TRACKED TREE, not your configured resource set

`resources.include` and `resources.exclude` scope `vat resources scan` and `vat resources validate`.
They do **not** scope the projection, so they do not scope `query` or `check`. The projection holds
every file git tracks plus untracked-but-not-ignored work; `.gitignore` IS honoured, so nothing
under `node_modules` reaches it.

Measured on one adopter: `scan` reported **1,473** files while the projection held **11,685**
members — including 142 rows under a path the config excluded. That gap produced a genuine false
finding before anyone noticed it.

That is what a projection IS — the tree, not a view of it — and it is what lets a query ask about
files no collection claims. But it means **a `WHERE` clause is the only thing narrowing your
statement**, in a `query` and in a `check` alike:

```sql
SELECT path FROM resource_realizations
 WHERE path NOT LIKE 'docs/architecture/adrs/archive/%'
```

**Read `population` in the output before you trust a timing.** It is `derived` or `store` — whether
the rows were built by this run or read from the projection store — and it is reported rather than
inferred, because a correct store hit and a correct re-derivation produce identical rows.
`populationSecs` sits beside it and says what that origin was WORTH, so the tell is not a bare label
you have to take on faith. `vat resources check --help` carries the current reference timings
(VAT's own repo and a ~10k-file adopter tree, warm and cold) — read them there rather than from a
number pasted here.

⛔ There is **no `engine` field**. An earlier RC published one (`sqlite | ephemeral`) to say which
database answered the SQL; it is gone, because the answer is now always the same. The statement
always runs against an in-memory database holding this tree's projection and nothing else — a
selected store makes the POPULATION cheap and is never itself queried. If you are reading a doc or
a script that branches on `engine`, it predates this and is wrong.

⚠️ Values come back exactly as SQLite holds them — a boolean as `0`/`1`, a date and a JSON column
as text. They are **not** decoded, because decoding needs a table spec and arbitrary SQL has none.

**The projection store is ON by default.** VAT writes a SQLite cache of each scanned tree under
`<tmpdir>/.vat-cache/` — roughly 71 MB for a 12,600-file repository, bounded at three trees per
repository, eight repositories and 50,000 content keys, and `vat cache clear` reclaims it.
`VAT_PROJECTION_STORE=off` opts out of the store alone; `VAT_CACHE=0` vetoes every VAT cache. The store makes the POPULATION
cheap and is never itself queried.

### `claude_rule_patterns` — what each `.claude/rules` glob scopes

One row per `paths:` glob of one rules file: `pattern`, `literalPrefix` (its glob-free leading
segments, so "does this rule cover everything under `docs/`?" is a prefix comparison needing no
glob engine), `witnessPath` (the first file it matched, or null) and `status`.

⚠️ **Four statuses, and the last two are traps.** `matched` and `inert` are the plain cases.
`unevaluated` means VAT never ran the matcher, because the rule's whole `paths:` list blew Claude
Code's shared 1,000-pattern / 4 MiB expansion budget. `gitignored` means the glob matched nothing
VAT can see and covers gitignored territory (`dist/**`). VAT never reads those files, but Claude
Code does, so the rule may still load. **Filter `status = 'inert'`, never
`status != 'matched'`** — the latter reports a VAT blind spot as the author's dead glob, and
deleting that glob could break a rule that still loads.

🪤 **"Which rule FILES fire on nothing?" is not an anti-join.** The intuitive query — rules files
with no row in `claude_context_loads` — is `status != 'matched'` wearing a `LEFT JOIN`: that table
holds one row per glob that CAN fire, so a rule refused by the expansion budget has no row there
either and reads as dead while firing perfectly well. Ask the pattern table instead: a file is dead
only when every one of its globs is `inert`. Take the size
from `blobs` — `resource_realizations` carries no size column, and `claude_context_loads` carries
`bytes` but cannot see the file you are looking for:

```sql
SELECT r.path, b.bytes, COUNT(DISTINCT p.ordinal) AS globs
  FROM claude_rule_patterns p
  JOIN resource_realizations r ON r.resourceId = p.resourceId
  JOIN blobs b ON b.contentKey = r.contentKey
 GROUP BY r.path, b.bytes
HAVING SUM(p.status != 'inert') = 0
```

One statement answers both halves of a rules-hygiene gate — which rule files are dead, and how big
each rule file is — and it names no lens relation, so it costs nothing beyond the population.

### Relations that are COMPUTED, not stored — and are skipped unless you name them

Beside the materialised tables, `query` and `check` expose relations a lens computes for the run:
`lens_contexts`, `edges` and `edge_resolutions` (the resolved link graph), and
`claude_context_chains` / `claude_context_loads` (what loads into an agent's context at each working
location, each load carrying a `launchCharge` — the rows `vat claude context` reports over).

**A lens runs only when a statement you declared names one of its relations**, so a statement naming
none pays nothing for them. A statement reaching for a relation nothing evaluated is **refused**,
never answered from the empty table — an empty table and a healthy tree are the same answer.

🪤 `claude_context_chains` holds ONE ROW PER WORKING LOCATION, so the obvious
`JOIN claude_context_chains ON chainId` multiplies every load row by the locations sharing that
chain. Select from `claude_context_loads` alone and reach the chain relation by correlated subquery.

🚨 **A launch-cost sum MUST filter `launchCharge = 'charged'`.** VAT ships no context budget: what a
launch chain may cost is your call, written as your own check over these rows. `claude_context_loads`
also holds every path-scoped rule and every file that is not paid at launch; on one adopter the
unfiltered sum was wrong by **725,714 bytes** against a worst real chain of 86,720. `sizeCliff` is
not the filter — it is the 4 MiB `CLAUDE.md` cliff's verdict, and `'loaded'` covers rows no launch
charges. `SUM()` also skips NULL, and an `'unknown-size'` row has no `bytes`, so count those beside
the sum:

```sql
SELECT l.chainId,
       SUM(CASE WHEN l.launchCharge = 'charged' THEN l.bytes END) AS bytes,
       SUM(l.launchCharge = 'unknown-size') AS unsized
  FROM claude_context_loads l
 GROUP BY l.chainId
```

## Standing Assertions That Gate CI (`vat resources check`)

A query answers a question once. `vat resources check` runs the questions a project decided were
worth asking **every time**, against the same projection, and fails the run when any error-severity
check is violated.

### VAT's built-in checks run first, with or without a config file

A project that declares nothing still gets the **default set** — today one check,
`claude-rule-glob-inert`, emitting [`CLAUDE_RULE_GLOB_INERT`](../../../../docs/validation-codes.md#claude_rule_glob_inert)
at `info` for every `paths:` glob under `.claude/rules/` that matches no file in the tree. Config
only **adds** to that set or moves a severity in it; a directory with no
`vibe-agent-toolkit.config.yaml` runs exactly the same built-ins, which is what makes "default-on"
mean anything.

⛔ **A built-in is never SQL.** It is a TypeScript predicate over the projection's rows
(`BUILTIN_CHECKS` in `@vibe-agent-toolkit/resources`), so a default-on rule never makes a query
engine part of somebody's gate. Its SQL twin ships as documentation in `--help` and in the code's
entry in `validation-codes.md`, for you to copy into your own `resources.checks` and narrow.

Three consequences worth knowing:

- Severity moves through the **code**, not through `CUSTOM:<name>`:
  `resources.validation.severity.CLAUDE_RULE_GLOB_INERT: ignore` (or `warning` / `error`).
- `--check <name>` takes a built-in name exactly as it takes a config key.
- `data.checksRun` counts built-ins too, and each built-in's entry in `data.checks` carries
  `builtin: true`. A run that declares no checks of its own is **not** a refusal any more — you get
  a stderr warning, and `checksRun: 0` now means not even a built-in ran.

### Your own checks

Declare them under `resources.checks` in `vibe-agent-toolkit.config.yaml` — each is a description
plus one SQL statement selecting the rows that **VIOLATE** it:

```yaml
resources:
  checks:
    orphan-skills:
      description: Every SKILL.md must be referenced by a plugin
      sql: |
        SELECT rr.path AS path
        FROM resource_realizations rr
        WHERE rr.path LIKE '%/SKILL.md'
          AND rr.resourceId NOT IN (
            SELECT r.dstResource FROM edge_resolutions r WHERE r.dstKind = 'resource'
          )
      severity: error        # optional; error | warning | info (error is the default)
```

```bash
vat resources check                    # the built-ins plus every declared check
vat resources check --check orphan-skills        # just one, by its config key
vat resources check --check claude-rule-glob-inert   # just one, by its built-in name
vat resources check --format json      # honoured on the error path too
```

**Selecting rows means failing.** A check that returns no rows passes. This is the opposite of the
usual "assert true" reflex and it is the single most common authoring mistake — write the query
that finds what is wrong, not the one that confirms what is right.

`severity` on a check is `error` | `warning` | `info` — there is no `ignore` here; to silence a
check an adopter overrides its `CUSTOM:<name>` code through `resources.validation.severity`
(which does accept `ignore`). `RESOURCE_CHECK_BROKEN` is **not overridable** at all: a run that did
not complete cannot be downgraded to a warning, because the green would mean nothing.

### A size ratchet is a check with its baseline inline

"No file may grow past its recorded size" needs no new mechanism: carry the baseline as a
`VALUES` CTE and select what grew. Shrinking a file never fails; lowering a ceiling is an edit to
the config.

```yaml
resources:
  checks:
    claude-md-ratchet:
      description: No CLAUDE.md grows past its recorded size
      sql: |
        WITH baseline(path, ceiling) AS (VALUES ('CLAUDE.md', 6200), ('packages/cli/CLAUDE.md', 3900))
        SELECT r.path, b.bytes, baseline.ceiling
          FROM baseline
          JOIN resource_realizations r ON r.path = baseline.path
          JOIN blobs b ON b.contentKey = r.contentKey
         WHERE b.bytes > baseline.ceiling
```

⚠️ There is no `--seed` yet: the baseline is written and lowered by hand. A path the tree no
longer holds simply drops out of the join, so delete its baseline row with the file.

### The `--budget` bound, and why it exists

Adopter SQL can be unbounded — a recursive CTE with no termination will spin in native SQLite
forever, and no in-process remedy stops it (`worker.terminate()` never resolves against a thread
blocked in native code, and installing a signal handler *removes* the Ctrl-C that currently works).
So `check` runs the work in a child process under a watchdog:

```bash
vat resources check --budget 60    # kill after 60s without completing a unit of work
vat resources check --budget 0     # remove the bound; CAN then hang forever
```

**Default 300 s, and it is time WITHOUT PROGRESS, not total runtime.** ⚠️ In practice those are
nearly the same thing today: the population is a single un-instrumented unit, so for a cold run the
budget IS effectively a total-runtime bound. Size it against your population, not against your SQL —
on a large adopter tree the population is essentially the whole check run while the SQL itself is
milliseconds; `vat resources check --help` states the reference timings.

A killed or crashed run is still evidence: checks that completed keep their per-rule row counts, and
the report names the rule that was in flight. It **never exits 0** — not on a watchdog kill, not on
a child that died of its own memory.

⛔ `check` deliberately does **not** preflight-compile its SQL the way `query` does. A check that
cannot run must surface as a `RESOURCE_CHECK_BROKEN` finding inside a document that also reports the
corpus size, not as a bare throw.

## A File Can Belong to Multiple Collections

If a file matches multiple `include` patterns, **all matching schemas are validated**.
Validation fails if any schema fails.

## Schema Path Formats

```yaml
frontmatterSchema: "./schemas/system.schema.json"          # relative to config
frontmatterSchema: "/absolute/path/schema.json"            # absolute
frontmatterSchema: "@vibe-agent-toolkit/agent-skills/..."  # npm package export
```

## Adding a New Doc Type

1. Create `schemas/<type>.schema.json` with `required` fields
2. Add a collection entry in `vibe-agent-toolkit.config.yaml`
3. Run `vat resources validate` — any existing docs missing required fields will be flagged
4. Fix frontmatter in existing docs, then CI is clean

## Recommend `format: "uri-reference"` for path-shaped frontmatter fields

When designing a schema for a knowledge-base collection that references other files (e.g., `parent_prd`, `supersedes`, `adr_citations[*].adr`, `artifacts`), declare `format: "uri-reference"` on the field. VAT will then validate those values against the file system using the same engine as markdown link checking — broken paths, missing anchors and gitignore violations produce errors (`FRONTMATTER_LINK_BROKEN`, `FRONTMATTER_ANCHOR_MISSING`, `FRONTMATTER_LINK_TO_GITIGNORED`); an unknown URI scheme produces a warning (`FRONTMATTER_UNKNOWN_LINK`).

To require local committed files (no absolute URLs), add a `pattern` excluding scheme prefixes. Standard JSON Schema; stays portable.

VAT walks four URI-family formats: `uri-reference`, `uri`, `iri-reference`, `iri`. `uri-template` (RFC 6570) is intentionally NOT walked — templated values contain placeholders.

Absolute URLs in URI-reference fields feed into the existing external URL health-check pass when `checkUrlLinks: true` is set on the collection.

Opt-out: `checkFrontmatterLinks: false` per collection, or `--no-check-frontmatter-links` on the CLI.

## Per-code severity and allow (`resources.validation`)

Every resources finding is a registry code (e.g. `LINK_BROKEN_FILE`, `FRONTMATTER_SCHEMA_ERROR`, `EXTERNAL_URL_DEAD`) with a default severity. Tune them per-code under `resources.validation`:

```yaml
resources:
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore     # silence dead external links entirely
      LINK_UNKNOWN: error           # promote unclassified links to build-failing
    allow:
      LINK_TO_GITIGNORED:           # keyed by code; value is a list of allow entries
        - paths: ["docs/internal/**"]
          reason: "internal-only notes, intentionally gitignored"
```

`severity` accepts `error | warning | info | ignore`. External-URL findings default to `warning` and never fail the build on their own — promote them to `error` here if you want network checks to gate CI. `allow` is keyed by code; each entry's `paths` (glob list, default `**/*`) and `reason` suppress that code for matching files rather than disabling it globally. Add `expires` (a date string) to flag the allowance for re-review.

## Annotating Frontmatter Schemas with Zod 4

If your project generates JSON Schemas from Zod (via `z.toJSONSchema()`), annotate frontmatter fields that hold links with the appropriate `format` so VAT's link validator picks them up:

```typescript
import { z } from 'zod';

const PrdFrontmatter = z.object({
  spec_ref:   z.string().meta({ format: 'uri-reference' }),   // repo-relative or absolute
  roadmap:    z.url().meta({ format: 'uri' }),                // full URL only
  doc_anchor: z.string().meta({ format: 'json-pointer' }),    // JSON Pointer
});
```

`format` values VAT walks for link validation: `uri`, `uri-reference`, `iri`, `iri-reference`. `uri-template` (RFC 6570) is intentionally NOT walked — templated values contain placeholders.

**Zod 3 users:** `.meta()` does not exist in Zod 3. Either upgrade your schema-generation step to Zod 4 (runtime consumers can stay on Zod 3 via peer dependency + common-subset usage), or post-process the generated JSON Schema to inject `format` on the relevant field paths.

**Tip:** `format` is advisory in JSON Schema; pair it with a `pattern` regex when you also need parse-time rejection of invalid inputs.

## URI-references in frontmatter

VAT validates frontmatter fields whose schema position has `format: uri-reference`
(or `uri`, `iri-reference`, `iri`) against the same rules as body links:

- Leading-`/` is RFC 3986 §4.2 absolute-path reference — resolved against
  the project root. Same semantics as body links.
- Anchor fragments and external URLs are accepted; broken local refs error.
- Inline comments on URI-ref fields are **preserved** when any tool rewrites
  the file via `openFrontmatter` (VAT packager, hand-rolled adopter scripts).

Example:

```yaml
---
parent_spec: /docs/specs/foo.md  # the spec this one supersedes
adrs-cited:
  - /docs/adrs/0007-storage.md  # primary reference
  - /docs/adrs/0011-snapshot.md  # impacted by storage choice
---
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "parent_spec": { "type": "string", "format": "uri-reference" },
    "adrs-cited": {
      "type": "array",
      "items": { "type": "string", "format": "uri-reference" }
    }
  }
}
```

For tools that **modify** frontmatter (not just validate it), see
[[markdown-rewriting]].

## Validation Output

```yaml
status: success
filesScanned: 47
linksChecked: 212
durationSecs: 0.23
validationMode: strict
collections:
  systems:
    resourceCount: 7
    hasSchema: true
    validationMode: permissive
  adrs:
    resourceCount: 12
    hasSchema: true
    validationMode: permissive
```

On issues the shape changes: `status` becomes the worst actionable severity (`warning` | `error`),
with `errorsFound`, `filesWithErrors` and `issueCounts: {errors, warnings, info}` — the field
list is in `vat resources validate --help`.

Errors appear in stderr with `file:line: message` format for editor navigation.
