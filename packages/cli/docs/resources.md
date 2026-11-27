# vat resources - Markdown Resource Commands

## Overview

The `vat resources` commands provide intelligent discovery and validation of markdown resources,
including link integrity checking and anchor validation.

## Commands

### vat resources scan [path]

**Purpose:** Discover markdown resources in a directory

**What it does:**
1. Recursively scans for markdown files
2. Parses each file to extract links and headings
3. Publishes what it found as the shared report envelope
4. Exits 0 when it scanned at least one file, 1 when it scanned none

**Path Argument:**
- `[path]` restricts the scan to that subtree of the project
- Recursively finds all `*.md` / `*.html` files under that directory
- The path **replaces** the config's `resources.include` patterns
- The config's `resources.exclude` patterns **still apply** — a path run never
  scans build output, vendored trees, or test fixtures the project excluded
- To scan the project's full configured set, run without a path argument:
  `vat resources scan`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging
- `--verbose` - Add `data.files`: per-file link/anchor counts and content keys (`<parserKind>.sha256.<SHA-256 of the raw bytes>`)
- `--collection <id>` - Only report files in the named collection (config mode — no path argument).
  A name `resources.collections` does not declare is refused (`USAGE_INVALID`, exit 2)
- `--format <format>` - `yaml` (default) or `json`. The same document either way

**Exit Codes:** derived from the published document, never chosen beside it.
- `0` - Scanned at least one file, and admitted every file it enumerated
- `1` - A file enumerated but not admitted: one error finding each —
  `RESOURCE_UNREADABLE` (the read failed), `RESOURCE_PARSE_LIMIT_EXCEEDED` or
  `RESOURCE_PARSE_WORKER_DIED` (its parse was refused); or scanned nothing: one
  non-overridable `RESOURCE_CHECK_BROKEN` finding (the path or config
  enumerates no markdown, or `--collection` names a collection no file
  matched) — a scan of nothing is not a population
- `2` - The scan could not run: `[path]` names no directory (`USAGE_INVALID`), a
  directory the OS will not list (`INPUT_UNREADABLE`), an unusable config
  (`CONFIG_INVALID`)

**Output:** the shared report envelope on stdout — YAML, or JSON with
`--format json` (schema: `packages/cli/schemas/resources-scan.json`); logs on
stderr.

- `examined` — files enumerated, admitted or not. The scan's only findings are
  the files it could not admit.
- `durationMs` — wall time of the run.
- `data.root` is stated once and is the only absolute path in the document;
  every `data.files[].path` is relative to it.
- `data.collections` — resources per configured collection (`{}` when none).

`data.extentSource` names the enumerator that produced the population (`git` or
`filesystem`). It is derived from the load that ran rather than read back from
the environment, so two scans of one tree that report different populations
say which enumerator produced each.

The lab's population facet (`packages/lab`) reads this document: the file count
from `examined`, the population from `data.files` (so it runs the scan with
`--verbose`).

**Example:**
```bash
# Recursively scan all *.md files under docs/
vat resources scan docs/ --verbose
# Equivalent to: find all files matching docs/**/*.md pattern

# Output:
# ---
# status: ok
# examined: 12
# findings: []
# summary: { errors: 0, warnings: 0, info: 0 }
# gate: { strict: false }
# durationMs: 234
# data:
#   root: /home/you/my-project
#   lane: projection
#   extentSource: git
#   collections: {}
#   files:
#     - path: docs/README.md
#       links: 5
#       anchors: 3
#       contentKey: markdown.sha256.47dd7b50af765df240fe2514f029fc697c907fc37a3267e22060f2f9f611975c
```

**Requirements:**

- **`projectRoot`**: optional with **loud-cwd fallback**. When invoked with an
  explicit `[path]`, that path is the effective base. Without a path, VAT walks
  up from `cwd` for `vibe-agent-toolkit.config.yaml` then `.git/`; if neither is
  found, the command falls back to `cwd` and emits a single stderr warning
  identifying the fallback. The scan still completes — the warning is the
  contract that prevents silent surprise.
- **Config**: optional. Uses built-in include/exclude defaults if no config file
  is present.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the loud-cwd fallback policy and the projectRoot discovery ladder.

### vat resources validate [path]

**Purpose:** Validate markdown resources with strict error reporting

**What it does:**
1. Recursively scans for markdown resources
2. Validates all links (internal, anchors, external if configured)
3. Publishes every finding flat in the shared report envelope
4. Exits 0 with no error-severity finding, 1 with one, 2 when it could not run

**Path Argument:**
- `[path]` restricts the scan to that subtree of the project
- Recursively finds all `*.md` / `*.html` files under that directory
- The path **replaces** the config's `resources.include` patterns
- The config's `resources.exclude` patterns **still apply** — a path run never
  scans build output, vendored trees, or test fixtures the project excluded
- To scan the project's full configured set, run without a path argument:
  `vat resources validate`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--debug` - Enable debug logging
- `-v, --verbose` - Print warning and info findings on stderr too (errors are
  always printed there), and add `data.files`, one `{path, status, summary}` row
  per resource validated. Every other envelope field is identical in both modes.
- `--collection <id>` - Scope the whole report — findings, `examined` and so the
  exit code — to one collection's files. A finding at a path that never became a
  resource (a file the collection matched and could not read) stays in it. A name
  `resources.collections` does not declare is refused (`USAGE_INVALID`, exit 2)
- `--format <format>` - `yaml` (default), `json` (the same document), or `text`
  (one `location:line: severity: message [code]` line per finding, every severity,
  then a status line, on stdout). Under `yaml` and `json` the finding lines go to
  stderr instead — the errors only, with warnings and info collapsed into one
  count line, unless `-v` prints those too.
  Any other value is a usage error (exit 2) naming the three
  accepted values; so is a `--validation-mode` other than `strict` or `permissive`
- `--no-check-frontmatter-links` - Skip frontmatter URI-reference link validation across all collections (default: enabled)

**Exit Codes:** derived from the published document, never chosen beside it.
- `0` - No error-severity finding (warnings and info never fail it)
- `1` - At least one error-severity finding — including a run that validated no
  resource at all (`examined: 0`), which carries one non-overridable
  `RESOURCE_CHECK_BROKEN` finding rather than passing: a declared `--collection` that
  matched nothing or a path with no markdown is not a verdict about anything.
  It is also printed on stderr as its finding line, `error: Nothing was examined: … [RESOURCE_CHECK_BROKEN]`
  (under `--format text` that line is in the stdout document instead)
- `2` - The run could not finish (`status: error`, `error.code` says which):
  `[path]` or `--frontmatter-schema` names nothing (`USAGE_INVALID`), an input
  the OS will not read (`INPUT_UNREADABLE`), an unusable config (`CONFIG_INVALID`)

**Output:** the shared report envelope on stdout (schema:
`packages/cli/schemas/resources-validate.json`):
- `examined` — resources validated
- `findings` — every finding, flat: `{code, severity, message, location, line?,
  link?, fix?, reference?}`, `location` relative to `data.root`
- `summary` — `{errors, warnings, info}` over `findings`
- `data.root` — the project root, the one base every `location` and `path` is
  relative to
- `data.collections` — per configured collection: `resourceCount`, `hasSchema`,
  `validationMode?`, `filesWithErrors`, and `summary` over its files' findings
- `data.population` — where the file list came from: `store` (the projection
  store answered), `derived` (the projection was built this run, including with
  `VAT_PROJECTION_STORE=0`, which skips only the store); never `null`
- `data.files` — under `--verbose` only

**Example (success):**
```bash
# Recursively validate all *.md files under docs/
vat resources validate docs/
# Equivalent to: find all files matching docs/**/*.md pattern

# Output:
# ---
# status: ok
# examined: 12
# findings: []
# summary: { errors: 0, warnings: 0, info: 0 }
# gate: { strict: false }
# durationMs: 456
# data:
#   root: /home/you/my-project
#   collections: {}
```

**Example (errors):**
```bash
vat resources validate docs/

# stdout:
# ---
# status: findings
# examined: 12
# findings:
#   - code: LINK_BROKEN_FILE
#     severity: error
#     message: "File not found: docs/missing.md"
#     location: docs/README.md
#     link: ./missing.md
#     line: 15
#   - code: LINK_BROKEN_ANCHOR
#     severity: error
#     message: "Anchor not found: #non-existent-section"
#     location: docs/guide.md
#     line: 42
# summary: { errors: 2, warnings: 0, info: 0 }
# gate: { strict: false }
# durationMs: 456
# data:
#   root: /home/you/my-project
#   collections: {}
```

Findings in a `jq` pipeline: `vat resources validate --format json | jq '.findings[] | "\(.location):\(.line) \(.code)"'`.

**Requirements:**

- **`projectRoot`**: optional with **loud-cwd fallback**. With an explicit
  `[path]` the path is used as the base directory; without it VAT walks for a
  `vibe-agent-toolkit.config.yaml` then `.git/` ancestor, and falls back to
  `cwd` with a stderr warning if neither is found.
- **Config**: optional. Defaults are applied when no config file is present;
  `--frontmatter-schema` is independent of config.

**Leading-`/` URI-reference resolution.** Markdown body links and frontmatter
URI-references whose path component starts with `/` (e.g.
`[See](/docs/foo.md)`, `parent_spec: /docs/foo.md`) are RFC 3986 §4.2
absolute-path references and are resolved against the discovered `projectRoot`.
Once cwd-fallback has fired, the effective `projectRoot` is `cwd` and leading-`/`
links resolve against `cwd` — consistent with the loud-cwd contract. The
`absolute_no_root` failure mode fires only when `projectRoot` is genuinely
undefined (e.g. a programmatic embedder that did not supply one); leading-`/`
links that escape `projectRoot` via path traversal surface as
`absolute_escapes_root`. Both surface as `broken_file` issues.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for the projectRoot ladder, the loud-cwd fallback policy, and the rationale
behind RFC-3986-compliant leading-`/` resolution.

### vat resources query &lt;sql&gt; [path]

**Purpose:** Ask this tree's resource projection one read-only SQL question.

**Options:**
- `--param <value>` - A value bound to the next `?` placeholder (repeatable, in order)
- `--base <ref>` - The commit `changed_files` compares this tree with (below)
- `--format <format>` - `yaml` (default) or `json`
- `--debug` - Enable debug logging

**What the statement can read.** The run's own projection, never another repository's: each run
holds only the projection tables its statement names, as an identifier — plain, `"blobs"`,
`[blobs]` or `` `blobs` ``. A single-quoted `'blobs'` is a string, so a statement reaching a table
through one, as `FROM 'blobs'` does, is refused, whatever else it names. A statement reads only a
relation it names itself: one held because ANOTHER declared statement names it is refused, so a
check's verdict never depends on which other checks are declared. A statement reaching a relation
the run does not hold is refused, as is one that asks which relations exist or what the connection
did: the schema table (`sqlite_schema`, `sqlite_master`, `sqlite_temp_schema`), `pragma_*`
functions, `dbstat`, `changes()`, `total_changes()` and `last_insert_rowid()`. `json_each` and
`json_tree` over a column are answered, and so are `jsonb_each` and `jsonb_tree` where the
runtime's SQLite has them (SQLite 3.51.0 and later). Beside SQLite's own functions, VAT adds two:

- `sha256(x)`: the lowercase hex SHA-256 of a TEXT value's UTF-8 bytes or a BLOB's bytes (NULL for
  NULL). A number answers NULL, since SQLite and JavaScript spell `1.0` differently: hash
  `CAST(x AS TEXT)` for a number's spelling. NULL rather than a refusal, so a verdict over a
  mixed-type column never depends on the order a `WHERE`'s terms are tested in. TEXT holding
  invalid UTF-8 is hashed after each bad sequence becomes U+FFFD; `CAST(x AS BLOB)` hashes the
  stored bytes.
- `regexp(pattern, text[, flags])`, and the `text REGEXP pattern` operator that calls it: 1 when the
  pattern matches anywhere in `text`, else 0, NULL when either is NULL. The pattern is a JavaScript
  RegExp, always compiled with the `u` flag (a code point is one character; an escape `u` does not
  define is an error); `flags` may add `i`, `m` and `s`, each once, and nothing else (`g` and `y`
  would carry state from one row to the next). Anchor with `^` and `$` for a whole-value match. A
  `text` that is not TEXT (a number or a BLOB in `data__values.value`) is not matched: NULL, like a
  NULL; `CAST` it to match its spelling. A pattern that does not compile, a non-TEXT pattern, or
  flags that are not TEXT, repeat one, or add another refuse the statement (`USAGE_INVALID`), and
  they are checked before the text, so a malformed pattern over a column of NULLs is refused too.
  A call SQLite never makes, such as a pattern over zero rows, is never checked. ⚠️ The engine
  backtracks, so a pattern with nested quantifiers (`(a+)+$`) can run for minutes on a long text it
  does not match; only the run's budget stops it: `vat resources check`'s default, or `vat resources
  query --budget`. **`vat resources query` without `--budget` has no bound**: such a pattern runs
  until it ends or you kill it.

⚠️ **Every relation is a table, filled once before the statement runs, but a CTE is not.** SQLite
may inline a plain `WITH` term at each place it is read (the runtime's SQLite does so whether a
term is read once or more), and a read inside a correlated subquery, or one the planner places in
a loop over outer rows, then runs the term again for every outer row. An adopter's check that
attributed files to their nearest `package.json` through a CTE read from a correlated subquery
took 1.25 s with plain `WITH` and 0.024 s with `AS MATERIALIZED`, which computes the term once.
When a CTE reads `data__values`, `data__routes`, `resource_realizations` or a join of them and is
read from a subquery, write `AS MATERIALIZED`:

```sql
WITH manifests AS MATERIALIZED (
  SELECT path, substr(path, 1, length(path) - length('/package.json')) AS dir
    FROM data__routes WHERE path GLOB 'packages/?*/package.json'
)
SELECT ...
```

A write is refused before it runs,
`WITH … DELETE … RETURNING` included, and so is a statement holding a NUL character, since SQLite
drops everything after it. Placeholders are `?` only; a named one (`:p`, `@p`, `$p`, `#p`, `$$`,
`#$`) is refused. Rows of a statement without `ORDER BY` come in the same order warm or cold:
primary-key order for a plain scan of one relation; a join, `GROUP BY` or `DISTINCT` follows the
plan.

**Derived relations** — computed for the run, and only when the statement names one:

| Relation | Columns | Needs |
|---|---|---|
| `edges`, `edge_resolutions`, `lens_contexts` | the resolved link graph | — |
| `claude_context_chains`, `claude_context_loads` | what Claude Code loads at each working location | — |
| `changed_files` | `path`, `status` (`added` \| `modified` \| `deleted` \| `renamed` \| `type-changed`), `oldPath`, `similarity` | `--base <ref>` |

**Data relations**: JSON, JSONC and YAML files and `.npmrc` as rows, read only when a statement
names a `data__*` or `workspace_*` relation (the workspace step reads its manifests from these rows;
routing: `resources.extractors.data`, under
[Configuration](#configuration)). A file's rows are keyed by its content key (`blob`) and the
`variant` it was parsed as (`json` strict, `jsonc` with comments and trailing commas, `yaml` a YAML
1.2 stream under the core schema, `ini` an `.npmrc`), so identical bytes share one row set:

| Relation | Key | Columns |
|---|---|---|
| `data__files` | `blob`, `variant` | `documents`, `bom`, `nodeCount`, `maxDepth` |
| `data__documents` | `blob`, `variant`, `doc` | `rootType`, `nodeCount`, `maxDepth` |
| `data__nodes` | `blob`, `variant`, `doc`, `ordinal` | `parent`, `pointer` (RFC 6901, `''` at the root), `key`, `idx`, `depth`, `type`, `value`, `lexeme`, `childCount`, `tag`, `aliasOf`, `shadowed`, `line`, `column` |
| `data__conditions` | `blob`, `variant`, `doc`, `seq` | `node`, `code` (`DATA_DUPLICATE_KEY`, `DATA_LOSSY_NUMBER`, `DATA_NON_STRING_KEY`), `severity`, `message`, `line`, `column` |
| `data__routes` | `root`, `path` | `blob`, `variant`, `state` (`facts`, `defective`, `refused`), `code` |
| `data__values` | `root`, `path`, `variant`, `doc`, `pointer` | `key`, `depth`, `type`, `value`, `lexeme`, `line` |

- `data__nodes` lists every node in pre-order, containers included. The root has `depth` 1 and
  each child its parent's plus 1; `maxDepth` is the deepest container's depth, 0 when the root is a
  scalar. `line` and `column` are 1-based, at a member's key, the column in UTF-16 code units.
- `value` holds a scalar as SQLite stores its source type: a string is TEXT, an integer lexeme
  (`1`) INTEGER, any other number (`1.0`) REAL, a boolean INTEGER 1 or 0, and `null`, an object or
  an array NULL. `lexeme` keeps a number's source text; read `type` to tell `true` from `1`.
- **The last occurrence of a key wins.** An earlier occurrence and its descendants are
  `shadowed`, and each repeat is one `DATA_DUPLICATE_KEY` row in `data__conditions`.
- `tag` and `aliasOf` are YAML's; both are null for JSON. `tag` is a node's explicit tag as YAML
  resolves it (`!!str` is `tag:yaml.org,2002:str`, `!foo` stays `!foo`), null when the source wrote
  none.
- `data__routes` and `data__values` are computed for the run. `data__routes` has one row per
  routed path with its pair's `state`; `data__values` joins the routes to the nodes no later key
  shadows, so a question about a path needs no join:

```bash
vat resources query "SELECT path, value FROM data__values WHERE pointer = '/engines/node'"
```

- ⚠️ **A path no route covers has no rows, and that reads as a pass.** `data__values` and the
  row-set tables hold routed files only, so `WHERE path = 'x.json'` over a file that exists but is
  not routed selects zero rows, exactly as it does over a routed file with no violation. A check
  whose violation is "a row exists in file X" asserts its own input with an `examined` count over
  `data__routes`, so a file that is not routed, or falls out of routing later, fails as
  `RESOURCE_CHECK_EXAMINED_NOTHING` instead of passing:

  ```yaml
  checks:
    golden-has-no-title:
      description: The golden schema declares no title
      sql: "SELECT path FROM data__values WHERE path = 'schemas/golden.schema.json' AND pointer = '/title'"
      examined: "SELECT COUNT(*) FROM data__routes WHERE path = 'schemas/golden.schema.json' AND state = 'facts'"
  ```
- `blob` is a content key (`<parser>.<kind>.<hex>`), the identity of the bytes VAT read, not a
  documented digest: a tracked file in a git repository is keyed by its git object ID (`git-sha1` or
  `git-sha256`), and only a file read from disk by the SHA-256 of its bytes. Do not parse a digest
  out of it.

Every `data__*` relation answers from the routed files that have rows. A routed file with none is
one `DATA_FILE_NO_ROWS` error finding at its path, once per run of `check` or `query` that names a
`data__*` relation. A run whose statements name only `workspace_*` relations reports only the files
the workspace step reads (each `package.json` and `pnpm-workspace.yaml`), though it still extracts
every routed file. In `check`, every declared check's statement drives it, so `--check foo` reports
a broken file another check reads. The finding names the file's state, code and remedy: `defective`
(the bytes or the file decide it: fix it or `exclude` it) or `refused` (this run decided it: run
again). A root `package.json` or `pnpm-workspace.yaml` the workspace step reads is never told to
`exclude` itself, since that refuses its root `DATA_REQUEST_UNROUTED`: it is told to fix the file,
make it smaller or simpler, or run again, the same remedy its root's `WORKSPACE_ROOT_NO_ROWS` gives. The finding fails the run
(exit 1); `query` still publishes its rows, and every check still reports its own findings. Which
code is which state:
[validation-codes.md](../../../docs/validation-codes.md#data-instance-codes). Ask `data__routes`
which files those are.

A routed file's rows are held to the data extractor's own output caps: 262,144 rows (nodes,
conditions, and its file and document rows) and 64 MiB of the rows' JSON, against 16,384 rows and
4 MiB for a markdown or HTML document; the depth cap (1,000 levels) is the same for both. A file
past one is `defective` with `PARSE_LIMIT_EXCEEDED`, and no config moves them. A 1.1 MB JSON Schema
document is about 23,000 rows and 6.6 MB of rows' JSON. With the projection store off (outside a
git repository, or `VAT_PROJECTION_STORE` off), a run holds at most 64 MiB of extracted rows'
JSON in memory, and a routed file past that is `refused` with `PARSE_LIMIT_EXCEEDED`, named; with
the store on, row sets are written as they are extracted, so no such bound applies.

**A check takes its subjects from `data__routes WHERE state = 'facts'`.** A file with no rows is
already its own error finding, and it has no values: a check that takes every routed path as a
subject and then asks `data__values` for something reads that file as "declares nothing" and
reports a second, false finding. The same goes for a `workspace_packages` member whose
`package.json` route is not `facts`. Only an existence question ("is this file routed at all?")
reads every route whatever its state, because a broken file still exists.

**YAML rows.** A file routed as `yaml` is read as YAML 1.2 under the core schema:

- **Every document is rows.** `doc` numbers a stream's documents from 0, each with its own
  ordinals; `data__files.documents` counts them, `nodeCount` sums them and `maxDepth` is the
  deepest. An empty stream (nothing, or only comments) is a `data__files` row with `documents` 0
  and no other rows; a document with no content (`---` alone) is one null root.
- **Aliases are expanded.** An alias is a copy of the node its anchor names: one row per copied
  node, each with `aliasOf` the ordinal of the row it copies (the anchored node for the alias's own
  row, the matching descendant for each copied one), so a query sees the value wherever it is used.
  Every other row has `aliasOf` null. The alias's own row is placed at the alias; a copied
  descendant keeps its original's `line` and `column`. Expanded rows count against the
  `outputRows` and `outputBytes` caps like any other, and the walk stops at the first cap they
  pass, so an alias bomb (many rows, or one long string aliased many times) is
  `PARSE_LIMIT_EXCEEDED` before its expansion is written out. A stream stops being read once its
  documents alone pass `outputRows`, and a document nested past `outputDepth` is refused before it
  is composed. An alias naming no anchor before it is `DATA_PARSE_ERROR`.
- **`<<` is a key like any other.** It is stored literally, with its value, and never merged into
  its mapping: query `pointer` `/<<` (or the alias's rows under it), not the merged keys.
- **A key that is not a string** (`1:`, `true:`, `~:`, a collection) keys its member by its trimmed
  source text and raises `DATA_NON_STRING_KEY`; repeated keys compare by that text.
- **Only YAML 1.2 is read.** A `%YAML` directive naming any other version is `DATA_YAML_VERSION`
  (`defective`). No YAML 1.1 reading is applied: `yes`, `on` and `no` are strings, `0777` is the
  decimal 777, and `<<` is not a merge. A YAML 1.1 tag (`!!binary`, `!!timestamp`, `!!omap`,
  `!!pairs`, `!!set`) is kept in `tag` and its node read as written, never decoded: a `!!binary`
  or `!!timestamp` is a string of its source text, an `!!omap` or `!!pairs` an array of one-member
  objects, a `!!set` an object whose values are null.
- **Numbers keep their source text.** `lexeme` is the number as written (`0x1F`, `+1`, `1e3`,
  `.inf`). `value`'s storage class follows the lexeme rule above, which reads only an optional
  minus and digits as an integer, so `0x1F`, `0o17` and `+1` are stored REAL (31.0, 15.0, 1.0) and
  a `type = 'number'` filter, not `typeof(value) = 'integer'`, finds them. `.inf`, `-.inf` and
  `.nan` are `DATA_LOSSY_NUMBER`: `.inf` reads back as a REAL infinity, and `.nan` as NULL, since
  SQLite holds no NaN.
- **Line and column mean what they mean for JSON.** CR, LF and CRLF are each one line break, a
  lone CR included, and columns count UTF-16 code units.

**`.npmrc` rows.** Every `**/.npmrc` is read as `ini`, by npm's own `ini` parser, as one document
whose root is an object:

- **Only allowlisted keys are stored, never secrets.** An `.npmrc` routinely holds credentials
  (`_authToken`, `_auth`, `//<registry>/:...`), so only the top-level keys on a reviewed list
  (`NPMRC_ALLOWED_KEYS` in `packages/resources/src/projection/data-ini.ts`: today
  `link-workspace-packages`) become rows. Every other key, and everything from the first
  `[section]` header on, is dropped before any row, condition or message is built, and no
  condition or message quotes a value or a line of the file. The bracketed-array form (`key[]=v`)
  is dropped too.
- **Values are what `ini` returns.** A string, stored as written: `${VAR}` is stored literally,
  never expanded, because the environment is not a file fact. `true`, `false` and `null` (quoted or
  not) and a bare key are a boolean or null node. Never a number, so `lexeme` is null.
- **Last occurrence wins,** as npm and pnpm read it: earlier ones are `shadowed`, each repeat one
  `DATA_DUPLICATE_KEY` naming the key, never a value.
- **No other route reaches the allowlist.** `.npmrc` is always `ini` (a `jsonc` glob does not
  apply to it), and no other file is ever `ini`: `include` routes by extension and no extension
  means `ini`. Only `exclude` keeps an `.npmrc` out.

**Workspace relations**: which `package.json` files are members of each analysis root's npm,
yarn, bun or pnpm workspace, and which member each member's dependencies name. Computed per run from the
data rows, never stored, read only when a statement names one:

| Relation | Key | Columns |
|---|---|---|
| `workspace_packages` | `root`, `path` | `dir` (`.` for the root), `name`, `version`, `private`, `workspaceRoot` |
| `workspace_dependencies` | `root`, `path`, `field`, `name` | `range` (as written), `targetPath` (the `package.json` of the member it names, or null), `protocol` (`workspace`, `catalog`, `npm`, `link`, `file`) |
| `workspace_conditions` | `root`, `path`, `code`, `seq` | `message` |

- **Membership.** The root `package.json`'s `packageManager` decides: `pnpm` reads
  `pnpm-workspace.yaml`'s `packages`; `npm`, `yarn` and `bun` read `package.json#workspaces` (an
  array, or yarn's `{ packages }`). With no `packageManager`, the manager is read from which files
  exist at the root, by path only and never their content: a `pnpm-workspace.yaml` means pnpm,
  otherwise exactly one manager's lockfiles name it (`.yarnrc.yml` means yarn berry, `yarn.lock`
  without it yarn 1), a `WORKSPACE_MANAGER_INFERRED` condition naming the files. With no lockfile,
  or several managers', it is `WORKSPACE_MANAGER_UNKNOWN`: membership is still `workspaces`, and a
  dependency whose target depends on the manager (the root's name, a nameless member's folder
  name, a `workspace:` path, a bare path the managers read differently, `link:<package name>`) has
  `targetPath` null with the same code. The manager's conditions sit at the root `package.json`
  (`.` when the run holds none). yarn 1 reads `workspaces` only from a root `package.json` whose
  `private` is truthy; a root listing a workspace package without it declares no workspace
  (`WORKSPACE_NOT_DECLARED`). A `pnpm-workspace.yaml` with no root `package.json` is a
  pnpm workspace with no root row. pnpm ignores `node_modules` and `bower_components` (a `test` directory is a member like
  any other). Patterns are canonicalised (`./packages/*`, `..` segments) and `!` excludes; a member
  is a `package.json` whose directory a pattern matches. The root `package.json` is always the
  `workspaceRoot` row; a root that declares no workspace has no rows. `field` is `dependencies`,
  `devDependencies`, `peerDependencies` or `optionalDependencies`.
- **pnpm versions.** The one version rule read is what `pnpm-workspace.yaml` without `packages`
  means: before pnpm 10.5, every package when the file has no other key (pnpm refuses a file with
  other keys, a `WORKSPACE_PACKAGES_MALFORMED` condition, and VAT reads the root only); from 10.5,
  the root only. With no pnpm version that file is a `WORKSPACE_MANAGER_VERSION_UNKNOWN` condition
  and the root only is read.
- **What `targetPath` names.** The member a dependency **names**, a structural fact, never the
  package an installer would link: that depends on registry versions, the manager's version
  checks, `link-workspace-packages` from user-global config or the environment, catalogs and
  `enableTransparentWorkspaces`, none of which a repository holds. (The design spec reads
  `targetPath` as the member a dependency links; this names instead, awaiting the spec owner's
  confirmation.) A `workspace:<path>`, `file:` or `link:` range, or a bare path (no protocol
  prefix, such as `../b`), names the member at that directory: `file:`, `link:` and a bare path
  from the declaring package, a `workspace:` path from the declaring package under pnpm and bun and
  from the project root under yarn berry; npm and yarn 1 have no `workspace:` path form. A bare
  path's `protocol` is labelled as its manager reads it: under pnpm `link` for a directory and
  `file` for a tarball, otherwise `file`. A path naming no member, or bun's `link:<package name>`
  (a `bun link` registration, not a directory), is null with `WORKSPACE_PATH_UNRESOLVED`. Every
  other range (`workspace:*`, `workspace:^1.2.0`, `catalog:`, a plain range, a git URL) names the
  member whose name is the dependency's name; `npm:<name>@`, and pnpm's and bun's
  `workspace:<name>@`, name `<name>`. npm names a member with no `name` by its folder (the `name`
  column stays null); under any other manager that member is `WORKSPACE_MEMBER_NAMELESS` and no
  name reaches it. No version is checked, no catalog resolved and no `.npmrc` read. The root is
  reachable by name under yarn berry and pnpm (any range) and bun (`workspace:` only, and a member
  of the same name wins), never under npm or yarn 1. Two members a name reaches with one name are
  each `WORKSPACE_DUPLICATE_NAME`, and a dependency on that name is null. A `package.json` routed
  as `jsonc` is read from its `jsonc` rows with a `WORKSPACE_READ_AS_JSONC` condition: every
  package manager parses it as strict JSON. A check judges policy in SQL over `protocol` and `range`: "a
  dependency that names a member must use `workspace:`" is
  `protocol <> 'workspace' AND targetPath IS NOT NULL`.
- **A defective member** (a member `package.json` with no rows) keeps its `workspace_packages` row
  with `name`, `version` and `private` null, has no dependency rows, and is a
  `WORKSPACE_MEMBER_NO_ROWS` condition; a member routed away with `exclude` is the same row with
  `WORKSPACE_MEMBER_EXCLUDED`. While a member's name is unknown, every name match in its root is
  uncertain, and the root carries one `WORKSPACE_TARGET_UNKNOWN` condition at its `package.json`
  naming those members: a null `targetPath` may name one of them, and so may a match, since a name
  may be shared.
- **A `workspace:` dependency under a root that declares no workspace** is a condition at its
  manifest, never a refusal: `WORKSPACE_NOT_DECLARED` when pnpm is the manager and the root holds no
  `pnpm-workspace.yaml`, `WORKSPACE_ROOT_OUTSIDE_ROOT` otherwise (run VAT from the workspace root;
  for a fixture, route it away with `exclude`, which ends it).
- **A root that cannot be answered** has no rows. That is a root input that decides membership with
  no rows (the root `package.json`, or a `pnpm-workspace.yaml` the rules read:
  `WORKSPACE_ROOT_NO_ROWS`), one routed away (`DATA_REQUEST_UNROUTED`; routing it back is the only
  way to this root's rows), a repeated `packages` key, or one beneath it, in `pnpm-workspace.yaml`
  (`WORKSPACE_DUPLICATE_KEY`), or a `<<` merge key beneath `packages`, or at the top level of a file
  with no `packages` of its own (`WORKSPACE_MERGE_KEY`: pnpm's js-yaml refuses the first and merges
  the second, while the rows hold `<<` literally). **What a query sees:** while
  another root answers, the refused root has no `workspace_packages` or `workspace_dependencies`
  rows and one `workspace_conditions` row, `WORKSPACE_ROOT_REFUSED`, at the refusing file, its
  message leading with the code. When no root answers, all three relations refuse, the code
  leading the message: `RUN_INCOMPLETE` when a rerun may answer (a root input hit the time cap,
  changed under the run, lost its parse worker, or found the file busy or the machine out of open files), `INPUT_UNREADABLE`
  otherwise. The refusal still carries every `DATA_FILE_NO_ROWS` finding, so the
  file that failed is named in the same output. The `data__*` relations over the same files still
  answer.
- **A workspace above the analysis root.** A root that declares no workspace, holds a
  `package.json` and sits below its repository's git top level gets a `WORKSPACE_ROOT_MAY_BE_ABOVE`
  condition at `.`: a workspace above may hold its packages, and the relations have no rows for it.
  A check over workspace membership should read `workspace_conditions` for these gap codes.
  Every code: [validation-codes.md](../../../docs/validation-codes.md#data-instance-codes).

A member dependency that names another member but is not written `workspace:`:

```bash
vat resources query "SELECT path, field, name, range FROM workspace_dependencies WHERE targetPath IS NOT NULL AND protocol <> 'workspace'"
```

`changed_files` lists what THIS CHANGE touched: the working tree (staged or not) plus untracked,
non-ignored files, snapshotted as one git tree (the snapshot the projection itself takes) and
diffed once against the merge base of `--base` and `HEAD` (`git merge-base --all <ref> HEAD`) —
GitHub's "files changed", so a branch behind its base never lists what the base moved since. Paths
are kept under the project root, relative to it. Because both sides of every move are in the
snapshot, a move is `renamed` whether or not it was `git add`ed; a copy is `added`; a file removed
from the index but unchanged on disk (`git rm --cached`) is no row. A rename across the root's
boundary is seen from inside: renamed in is `added`, renamed out is `deleted`. A submodule, or a
nested repository with a commit, is one row naming its directory, listed when the commit it records
moved; its files are its own. A conflicted file mid-merge is listed as it stands on disk, conflict
markers and all — the snapshot is the working tree. The snapshot reads a file marked
assume-unchanged, or marked skip-worktree and present on disk, as it stands, and takes an untracked
file a sparse checkout's definition leaves out. Two flagged states refuse the relation, naming the
file and the fix: a skip-worktree file deleted from disk outside a sparse checkout (git would hide
the deletion), and a skip-worktree file on disk inside a directory a sparse index holds collapsed
while `sparse.expectFilesOutsideOfPatterns` is true (git would hide an edit to it). A statement reading it is refused with the fix —
never answered with an empty relation — and the refusal code says whose fault it is:

| Cause | Fault (`kind`) | Code |
|---|---|---|
| no `--base` | `base` | `USAGE_INVALID` |
| a ref that names no commit | `base` | `USAGE_INVALID` |
| a ref that shares no history with `HEAD` in a full history (no merge base) | `base` | `USAGE_INVALID` |
| a ref with more than one merge base with `HEAD` (a criss-cross history: pass one of them) | `base` | `USAGE_INVALID` |
| git not found on `PATH` | `git-failed` | `BACKEND_UNAVAILABLE` |
| git out of time, or more output than VAT reads (compare against a nearer base) | `git-failed` | `BACKEND_UNAVAILABLE` |
| a snapshot that fails for a cause git does not state, or whose second attempt times out | `git-failed` | `BACKEND_UNAVAILABLE` |
| not inside a git working tree (a bare repository and a directory inside `.git` included) | `repository` | `INPUT_UNREADABLE` |
| no commits yet, or a git that cannot resolve `HEAD` | `repository` | `INPUT_UNREADABLE` |
| a shallow clone cut off before the base and `HEAD` meet (no merge base, shallow) | `repository` | `INPUT_UNREADABLE` |
| a shallow clone whose history may hide a nearer merge base (`fetch-depth: 0`, or `git fetch --deepen=<n>`) | `repository` | `INPUT_UNREADABLE` |
| a partial clone missing blobs the diff needs (`git fetch --refetch`) | `repository` | `INPUT_UNREADABLE` |
| a snapshot git refuses, its `fatal:`/`error:` quoted (a nested repository with no commit, an object it cannot write, a clean filter that fails) | `repository` | `INPUT_UNREADABLE` |
| a directory under the root git cannot list (fix its permissions, or ignore it) | `repository` | `INPUT_UNREADABLE` |
| a file under the root git cannot read | `repository` | `INPUT_UNREADABLE` |
| a skip-worktree file deleted from disk outside a sparse checkout (`git update-index --no-skip-worktree`) | `repository` | `INPUT_UNREADABLE` |
| a skip-worktree file on disk inside a directory a sparse index holds collapsed, files expected outside the patterns (`git config --unset sparse.expectFilesOutsideOfPatterns`) | `repository` | `INPUT_UNREADABLE` |
| a filesystem that folds case whose `core.ignorecase` is not true (`git config core.ignorecase true`) | `repository` | `INPUT_UNREADABLE` |
| on such a filesystem, a changed path, or a rename's old side wherever its new side lands, spelling the root in another case or Unicode normalisation | `repository` | `INPUT_UNREADABLE` |
| a path under the root that is not UTF-8 | `repository` | `INPUT_UNREADABLE` |
| a listing git returned that VAT cannot read | `repository` | `INPUT_UNREADABLE` |

A statement defining a CTE named `changed_files` is refused as `USAGE_INVALID` too, with or without
`--base`. So is one that uses `changed_files` as a bare alias with no `AS` (`FROM resources
changed_files`) and is run without `--base`: a known over-match — the relation is detected by name,
so spell the alias with `AS`, or name it something else. The exit code does not tell these apart — the code does: `vat
resources query` exits 2 with it as `error.code`; `vat resources check` and `vat validate` report
`RESOURCE_CHECK_BROKEN` (exit 1) on the checks that read it, with it as the finding's
`reason.refusal`. `--base` is read only when a statement names `changed_files`; otherwise it is
accepted and unused.

**Output:** the shared report envelope on stdout — YAML, or JSON with
`--format json` (schema: `packages/cli/schemas/resources-query.json`):
- `examined` — resources in the population the statement ran over (the tracked
  tree), never the rows it selected
- `data.columns` — the result columns, in order, even when no row was selected
- `data.rows` — the selected rows, exactly as SQLite holds them
- `data.population` (`derived` | `store`), `data.populationSecs`,
  `data.lensSecs`, `data.lensesEvaluated` — where the population came from and
  what it cost; `data.boundsStatement` / `data.limits` when a bounded lens ran
- `data.lensPopulation` (`none` | `store` | `derived`) — the same tell for the
  lenses the statement named: `none` when it named no lensed relation, otherwise
  whether every lens population was a store hit

**Exit Codes:** derived from the published document.
- `0` - The statement ran over a populated tree — zero rows is an answer, `ok`
- `1` - The population was empty (`RESOURCE_CHECK_BROKEN`)
- `2` - The statement was refused (`USAGE_INVALID`: not a query, a second
  statement, an unbound `?`, a name the projection lacks), a derived relation it reads could not
  be evaluated (under that relation's own refusal code, above), `[path]` names no directory, or
  the crawl failed

**Example:**
```bash
vat resources query 'SELECT path FROM resource_realizations LIMIT 5' --format json | jq '.data.rows[].path'
```

### vat resources check [path]

**Purpose:** Run VAT's built-in checks and every SQL assertion declared under
`resources.checks` against this tree's resource projection.

**Options:**
- `[path]` - Project root to check (defaults to the current directory)
- `--check <name>` - Run only this check, by its built-in name or its key in `resources.checks`.
  The run still evaluates every lens and data relation every declared check names, so it costs what
  a full run costs and reports the same `DATA_FILE_NO_ROWS` findings
- `--base <ref>` - The ref whose merge base with HEAD `changed_files` compares this tree with. A check reading
  `changed_files` without it fails as `RESOURCE_CHECK_BROKEN` naming the fix; other checks are
  unaffected. `vat validate --base <ref>` forwards it to its checks phase
- `-v, --verbose` - Print warning and info findings on stderr too; errors are always printed there
- `--budget <seconds>` - Kill the run if it goes this long without completing a unit of work
  (default 300; `0` removes the bound)
- `--format <format>` - `yaml` (default) or `json`
- `--debug` - Enable debug logging

**Output:** the shared report envelope on stdout (schema: `packages/cli/schemas/resources-check.json`);
each finding also as a `location:line: severity: message [code]` line on stderr.
- Every finding one check produced — its violations, and `RESOURCE_CHECK_BROKEN` or
  `RESOURCE_CHECK_EXAMINED_NOTHING` about it — carries `check: <name>`. A finding about the whole
  run (an empty corpus, no check ran, an interrupted run) carries none.
- A declared check's violation carries `evidence`: the row's columns other than the reserved ones,
  in the order SQLite returned them, values as SQLite returned them (a BLOB, or a non-finite number
  such as `Infinity`, as the text the message shows — so JSON and YAML agree). `path` is evidence
  only when its text is no location (below); then the finding has no `location`.
- A check whose rows could not be read carries `reason` on its `RESOURCE_CHECK_BROKEN` finding:
  `{column, value, row, allowed}` — the reserved column, its value as `evidence` renders it, the
  first bad row (1-based), and what the column may hold. One whose `examined` statement returned no
  count carries `{statement: "examined", rows, columns?, value?, allowed}` (below). A statement that
  failed carries none — unless it read a derived relation that refused (`changed_files` without
  `--base`, say): then `{refusal: <code>}`, the code `vat resources query` exits with for it.
- Two cross-field rules hold for every finding: `evidence` only on one that names its `check`, and
  `reason` only on `RESOURCE_CHECK_BROKEN`. The document is re-parsed against its schema before it
  is published, and the committed JSON Schemas (`resources-check.json`, `orchestrator.json`) carry
  both rules — and every finding's own, a `column` only beside its `line` — as
  `anyOf: [{not: {required: [key]}}, <rule>]` (`presenceImplies`), never as `if`/`then`, so a
  consumer validating against them refuses what the run refuses.
- `data.checks[]` — one entry per check that ran: `name`, `durationSecs`, `rows`, and `broken`,
  `builtin`, `examined`, `allowEmpty`, `examinedNothing: true` and `nearMisses` when they apply
  (below).

**Exit Codes:** `0` no error-severity check violated, `1` one was (or nothing was checked:
`RESOURCE_CHECK_BROKEN`), `2` the run could not do its job.

**Reserved row columns.** A check's statement selects its violations, one finding per row. Four
column names are reserved and matched exactly (case-sensitive); every other column is evidence, in
the message and in the finding's `evidence`:

- `path` — text, the finding's `location` when it is one: a non-empty relative path with `/`
  separators inside the root (not the root itself, no leading `/` or `\`, no drive, no UNC path,
  no `..` that climbs out, and no other `\` on Windows, where it is the separator), published in
  its normalised form (`docs/../a.md` is the location `a.md`). Text that is no location — absolute, climbing, empty — gives
  a finding with no location and keeps the value as `evidence.path`: the projection's own relations
  hold such values (`roots.path` is absolute; `realization_conditions.path` is `../`-prefixed for an
  outside-root closure reference), and a check over them reports at its declared severity. A value
  that is not text (a number, a BLOB) fails the check as `RESOURCE_CHECK_BROKEN`. NULL or absent:
  no location and no evidence entry.
- `finding_severity` — that row's severity, exactly `error`, `warning` or `info`; NULL or absent
  means the check's declared severity. A `resources.validation.severity` override on
  `CUSTOM:<name>` replaces the severity of EVERY row of that check — raising a row's `info` as
  well as lowering its `error`.
- `finding_line` — the finding's 1-based line; NULL or absent omits it.
- `finding_column` — the finding's 1-based column within `finding_line`; it requires a line.

Any other value in a reserved column fails the check as `RESOURCE_CHECK_BROKEN` — "ran and selected
N rows, but row R's finding_severity = "high" is not one of error | warning | info" — and its entry in
`data.checks` carries `broken: true` with `rows`. A column that nearly names a reserved one — the
same once case and every `_` are removed (`Finding_Line`, `findingSeverity`), or the bare
`severity`, `line` or `column` — gets one stderr warning per check, stays evidence, and is listed
as the statement spelled it in that check's `data.checks` entry as `nearMisses: ["Finding_Line"]`
(absent when there is none). It is read from the statement's columns before the statement runs, so
it is listed however many rows the check selected — none included — whether or not they could be
read, and on a check that threw as it ran.

No projection relation has a column named `finding_severity`, `finding_line` or `finding_column`,
so `SELECT *` or a join never sets one: a table's own `severity`, `line` or `column` is evidence
(and, as a near miss, warned about).
Place a finding by aliasing deliberately — `SELECT r.path, b.line AS finding_line FROM …`.
`path` is different: many relations carry one, and a `SELECT *` over a join of two of them returns
two `path` columns, of which a row keeps only one — the rightmost. Name the `path` you mean
(`SELECT r.path, …`), or the finding is placed at whichever relation the join listed last.

A finding with a `line` but no usable `path` prints its coordinates after the message, never as a
prefix: `error: <message> [<code>] (line 3, column 5)`.

**What a check examined.** Zero rows is a check's pass, so zero violations over a thousand files and
zero violations over nothing read the same — and the run's `examined` counts the whole population,
which one check whose `WHERE` matches nothing hides behind. A check states its own denominator with
`examined`, a second statement returning ONE count of what the check ranged over — exactly one row
with one column holding a non-negative integer, as `SELECT COUNT(*)` returns:

```yaml
resources:
  checks:
    skills-have-owners:
      description: Every skill names an owner
      sql: SELECT path FROM resource_realizations WHERE path LIKE 'skills/%' AND path NOT IN (…)
      examined: SELECT COUNT(*) FROM resource_realizations WHERE path LIKE 'skills/%'
      # allowEmpty: true   # only if zero skills is a legitimate answer
```

- Any other result — no row, several rows or columns, NULL, text, a negative or a fraction — fails
  the check as `RESOURCE_CHECK_BROKEN` with `reason: {statement: "examined", rows, columns?,
  value?, allowed}`: how many rows came back, how many columns when one did, and the value when
  exactly one cell did. Its entry carries `broken: true` with `rows` and no `examined`.

- Its count is published on the check's `data.checks` entry as `examined`. The key is present
  exactly when the check declares `examined` and that statement completed — absent on a check that
  declares none (and on every built-in), absent rather than `0` when it did not finish.
- `examined: 0` fails the run as `RESOURCE_CHECK_EXAMINED_NOTHING` (error, exit 1, not overridable),
  naming the check in its `check`; the check's own violations are still reported beside it. The
  check's entry then carries `examinedNothing: true` — present exactly when that finding is, so
  `jq '.data.checks[] | select(.examinedNothing)'` lists the same checks the findings name.
- `allowEmpty: true` declares that zero is legitimate: no finding, and every entry of that check
  publishes `allowEmpty: true` whatever it counted, so the exemption is visible in every report.
  `allowEmpty` without `examined` is refused when the config loads.
- The examined statement follows every rule `sql` does, names derived relations the same way, is
  timed into the check's `durationSecs`, and is bounded by `--budget` like any statement. If it
  fails, the check is `RESOURCE_CHECK_BROKEN`, its entry carries `broken: true` with `rows` and no
  `examined`, and none of its rows are reported.
- A run killed by `--budget` (or dying) after a check completed broken still publishes that check's
  `RESOURCE_CHECK_BROKEN` as a completed run does — message, `check` and `reason`. One killed
  during its examined statement is `broken` with `rows`, but its `durationSecs` covers only the
  violations statement (the unfinished one cannot be charged) and its message says the run stopped.
- A check that did not run at all is absent from `data.checks` (or `broken` without `rows`), so
  "examined 0" and "not run" never look alike.
- ⚠️ `examined` is optional, so a check that declares none can pass over an empty population and
  nothing refuses it. Declare it on every check; a consumer that needs the guarantee can require an
  `examined` key on each `data.checks` entry that is neither `builtin` nor `broken`.

**One population for both statements: `with`.** `examined` is a statement of its own, so it cannot
see a CTE defined in `sql`. Put the CTEs in `with` instead, without the `WITH` keyword, and VAT
prepends `WITH <with>` to both `sql` and `examined`:

```yaml
resources:
  checks:
    package-manifests:
      description: A package manifest breaks a rule
      with: pop AS (SELECT path FROM data__routes WHERE state = 'facts' AND path LIKE 'packages/%')
      sql: SELECT path FROM pop WHERE …
      examined: SELECT COUNT(*) FROM pop
```

- A statement with its own leading `WITH` is merged: `WITH <with>, <its own CTEs> …`. The result is
  `WITH RECURSIVE` when either side is; `with` may begin with `RECURSIVE`.
- The composed statements are what run, so every rule above applies to them; a finding or `reason`
  that quotes a statement quotes the composed one.
- Refused when the config loads (`CONFIG_INVALID`, naming `resources.checks.<name>.with`): `with`
  that begins with `WITH`, holds no definition, or holds anything but `name [(columns)] AS [NOT]
  [MATERIALIZED] (…)` definitions separated by commas; and a CTE name defined both in `with` and in
  a statement's own `WITH`.

The same applies when the checks run as the `checks` phase of `vat validate`: its findings are
these findings, `check` and `evidence` included, and the phase's `data.checks` is this list.

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

```yaml
resources:
  include:
    - "docs/**/*.md"
    - "skills/**/README.md"
  exclude:
    - "node_modules/**"
    - "**/test/fixtures/**"
  # Optional: per-code severity overrides (keys are validation codes,
  # values are error | warning | info | ignore). External-URL findings
  # default to `warning` (non-fatal), so a dead external link won't fail
  # the build unless you raise its severity here.
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore        # don't fail the build on dead external links
      FRONTMATTER_SCHEMA_ERROR: error
```

**Dot-directories are scanned.** `**` traverses path segments beginning with a
dot, so the default `**/*.md` reaches `.claude/`, `.github/` and the like — as do
your own patterns. Visibility is decided by git and by `exclude`, never by a
leading dot. To keep a dotted tree out of the scan, exclude it by name:

```yaml
resources:
  exclude:
    - ".claude/worktrees/**"
```

**Which files become data rows** (`resources.extractors.data`). With no block, every
`**/package.json` is read as `json`, every `**/tsconfig*.json` and `**/jsconfig*.json` as `jsonc`,
every `**/pnpm-workspace.yaml` as `yaml`, and every `**/.npmrc` as `ini`. A block adds to or
overrides that:

```yaml
resources:
  extractors:
    data:
      include: ['tools/waivers.json', '.github/workflows/*.yml'] # more files, routed by extension
      jsonc: ['**/turbo.json', '.vscode/*.json'] # read as JSONC whatever the extension
      exclude: ['**/test/fixtures/**']          # never read, defaults included
```

One variant per path, decided in this order: `exclude` removes it; an `.npmrc` is `ini`; a
`jsonc` glob makes it `jsonc`; a default names its variant; an `include` glob routes it by extension, case-insensitive
(`.json` as `json`, `.jsonc` as `jsonc`, `.yaml` and `.yml` as `yaml`; any other extension is not
routed). A `jsonc` glob that matches a `package.json` makes the workspace step read its `jsonc` rows,
with a `WORKSPACE_READ_AS_JSONC` condition, since package managers read it as strict JSON. Patterns are
anchored at the project root and match dot directories; `**/node_modules/**` is never read. The
block is strict: an unknown key is a config error. A declared block that routes no file in the tree
refuses a statement naming a `data__*` or `workspace_*` relation (`CONFIG_INVALID`). An `include` glob that matches
no `.json`, `.jsonc`, `.yaml` or `.yml` file in the tree, while the block routes other files, does not refuse: `vat
resources check` reports it as a `DATA_INCLUDE_GLOB_INERT` warning naming the glob, and `vat
resources query` writes the same finding, with its code, to stderr when its statement names a
`data__*` relation; `resources.validation.severity` resolves it in both, so `ignore` silences it.
`allowEmpty: true` excuses both: one key, two meanings, so setting it for an empty block also
silences a mistyped `include` glob. Only `true` is accepted.

**Credentials files of the named kinds are never stored as data rows**, whatever glob matches them,
because the rows live in the projection store under the cache root, which CI caches. The rule is
built in and runs after the order above. The list is closed and matches by file name,
case-insensitively, at any depth; it is not a guarantee. A secret in a file under any other name
(a `secrets.yml`, a `kubeconfig.yaml`), or a hard link to a listed file (a name check cannot see
one), is routed like any ordinary file, so keep secrets out of files a glob routes. These kinds are
not routed at all: `.yarnrc`, `.netrc`, `_netrc`, `.git-credentials`, `.pypirc`, `.env`, `.env.*`, `.docker/config.json`, `.config/gh/hosts.yml`, `.config/gh/hosts.yaml`, `.aws/credentials`, `.kube/config`, `.pgpass`, `.cargo/credentials`, `.cargo/credentials.toml`, `.gem/credentials`, `.terraformrc`, `terraform.rc`, `.ssh/**`, `auth.json`, `local.settings.json`, `credentials.json`, `client_secret*.json`, `*service-account*.json`. An `.npmrc` is always read as variant `ini` through its key allowlist. A
`.yarnrc.yml` or `.yarnrc.yaml` is variant `yarnrc`: it is read as YAML and only these top-level
keys are kept: `checksumBehavior`, `compressionLevel`, `defaultSemverRangePrefix`, `enableGlobalCache`, `enableImmutableInstalls`, `enableScripts`, `enableStrictSsl`, `enableTelemetry`, `nmHoistingLimits`, `nmMode`, `nodeLinker`, `npmPublishAccess`, `npmPublishRegistry`, `npmRegistries`, `npmRegistryServer`, `npmScopes`, `packageExtensions`, `plugins`, `pnpMode`, `supportedArchitectures`, `yarnPath`. Any other key answers zero rows, so a check about one (`enableHardenedMode`,
`npmMinimalAgeGate`, `catalog`, `cacheFolder`) passes on nothing. Under a kept key every key starting
`npmAuth` is dropped at any depth, and so is any scalar or map key holding a URL with a password,
with a query string, or (other than an ssh or git+ssh URL, whose lone username names the ssh user
and is kept) with a username (`https://token@host`, `https:u:pw@host`), a flow-collection key, a key
that is an alias, and any value aliasing a dropped one. A refused file is never parsed or stored; its bytes are hashed, as every file the run
reads is, to key it. Each one a glob would have routed is a `DATA_CREDENTIAL_FILE_NOT_ROUTED`
warning naming its path (its location, so
`resources.validation.allow.DATA_CREDENTIAL_FILE_NOT_ROUTED` can waive exactly one file), reported
as `DATA_INCLUDE_GLOB_INERT` is; `exclude` the path or waive it per path rather than overriding the
code's severity, which silences every credentials file. When the rule is why a declared block
routed no file, the `CONFIG_INVALID` refusal says so.

**If a broad glob already routed an untracked `.yarnrc.yml` or `.docker/config.json`** before this
rule, its token was stored in the projection store and may be in a CI cache. Rotate the token,
delete the CI `actions/cache` entries earlier releases saved (a `vat cache prune` cannot reach
them), and run `vat cache clear` locally.

## Integration with vibe-validate

The exit code is the gate — 1 exactly when an error-severity finding (or the
nothing-validated refusal) is in the document — so a vibe-validate step needs
nothing more than the command:

```yaml
# vibe-validate.config.yaml
validators:
  markdown:
    run: vat resources validate docs/
```

`--format text` prints one `location:line: severity: message [code]` line per
finding on stdout, for an extractor that reads compiler-style lines.

## More Information

- GitHub: https://github.com/jdutton/vibe-agent-toolkit
- Issues: https://github.com/jdutton/vibe-agent-toolkit/issues

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `resources scan`

A scan of a project that declares no collections. Produced by `vat resources scan .`.

```yaml vat-report=resources scan
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 184
data:
  root: /work/project
  extentSource: git
  collections: {}
```

### `resources validate`

The same project validated. Produced by `vat resources validate`.

```yaml vat-report=resources validate
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 82
data:
  root: /work/project
  population: derived
  collections: {}
```

### `resources query`

One read-only SQL statement; the answer is under `data.rows`. Produced by `vat resources query "SELECT count(*) AS n FROM resources"`.

```yaml vat-report=resources query
status: ok
examined: 16
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 225
data:
  root: /work/project
  columns:
    - n
  rows:
    - n: 16
  population: derived
  populationSecs: 0.221
  lensSecs: 0
  lensesEvaluated: []
  lensPopulation: none
```

### `resources check`

The built-in checks, cut to the first. Produced by `vat resources check`.

```yaml vat-report=resources check
status: ok
examined: 16
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 86
data:
  root: /work/project
  population: store
  populationSecs: 0.0819
  lensSecs: 0
  lensesEvaluated: []
  lensPopulation: none
  checksRun: 3
  checks:
    - name: claude-rule-glob-inert
      durationSecs: 0.0000399
      rows: 0
      builtin: true
```
