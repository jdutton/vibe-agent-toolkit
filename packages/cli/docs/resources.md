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
- `--verbose` - Add `data.files`: per-file link/anchor counts and checksums
- `--collection <id>` - Only report files in the named collection (config mode — no path argument).
  A name `resources.collections` does not declare is refused (`USAGE_INVALID`, exit 2)
- `--format <format>` - `yaml` (default) or `json`. The same document either way

**Exit Codes:** derived from the published document, never chosen beside it.
- `0` - Scanned at least one file
- `1` - Scanned nothing: one non-overridable `RESOURCE_CHECK_BROKEN` finding
  (the path or config enumerates no markdown, or `--collection` names a
  collection no file matched) — a scan of nothing is not a population
- `2` - The scan could not run: `[path]` names no directory (`USAGE_INVALID`), a
  directory the OS will not list (`INPUT_UNREADABLE`), an unusable config
  (`CONFIG_INVALID`)

**Output:** the shared report envelope on stdout — YAML, or JSON with
`--format json` (schema: `packages/cli/schemas/resources-scan.json`); logs on
stderr.

- `examined` — files scanned. A scan reports no finding of its own.
- `durationMs` — wall time of the run.
- `data.root` is stated once and is the only absolute path in the document;
  every `data.files[].path` is relative to it.
- `data.collections` — resources per configured collection (`{}` when none).

`data.lane` names which enumerator produced the population — `projection` (the
default) or `walk` (`VAT_RESOURCES_CRAWL=walk`). Two scans of one tree
that report different populations are only interpretable if each says which lane
produced it, so the field is derived from the load that ran rather than read back
from the environment. `data.extentSource` names the projection lane's own
enumerator (`git` or `filesystem`), or is `null` for the walk.

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
#       checksum: 47dd7b50af765df240fe2514f029fc697c907fc37a3267e22060f2f9f611975c
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
  `VAT_PROJECTION_STORE=0`, which skips only the store), or `null` when the walk
  answered: the walk lane was selected (`VAT_RESOURCES_CRAWL=walk`), or the crawl
  declined a projection bound to another root and walked
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

**Derived relations** — computed for the run, and only when the statement names one:

| Relation | Columns | Needs |
|---|---|---|
| `edges`, `edge_resolutions`, `lens_contexts` | the resolved link graph | — |
| `claude_context_chains`, `claude_context_loads` | what Claude Code loads at each working location | — |
| `changed_files` | `path`, `status` (`added` \| `modified` \| `deleted` \| `renamed` \| `copied` \| `type-changed`), `oldPath`, `similarity` | `--base <ref>` |

`changed_files` compares the working tree (staged or not) plus untracked, non-ignored files with
the commit `--base` names, keeping paths under the project root, relative to it. A rename or copy
across the root's boundary is seen from inside: renamed or copied in is `added`, renamed out is
`deleted`. git pairs only paths the index knows into a rename, so a move not yet `git add`ed reads
as deleted plus added. Without `--base`, with a ref that names no commit, or outside a git working
tree, a statement reading it is refused with the fix (`USAGE_INVALID`, exit 2) — never answered
with an empty relation. A path that is not UTF-8 refuses it too.

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
  statement, an unbound `?`, a name the projection lacks), `[path]` names no
  directory, or the crawl failed

**Example:**
```bash
vat resources query 'SELECT path FROM resource_realizations LIMIT 5' --format json | jq '.data.rows[].path'
```

### vat resources check [path]

**Purpose:** Run VAT's built-in checks and every SQL assertion declared under
`resources.checks` against this tree's resource projection.

**Options:**
- `[path]` - Project root to check (defaults to the current directory)
- `--check <name>` - Run only this check, by its built-in name or its key in `resources.checks`
- `--base <ref>` - The commit `changed_files` compares this tree with. A check reading
  `changed_files` without it fails as `RESOURCE_CHECK_BROKEN` naming the fix; other checks are
  unaffected. `vat validate --base <ref>` forwards it to its checks phase
- `-v, --verbose` - Print warning and info findings on stderr too; errors are always printed there
- `--budget <seconds>` - Kill the run if it goes this long without completing a unit of work
  (default 300; `0` removes the bound)
- `--format <format>` - `yaml` (default) or `json`
- `--debug` - Enable debug logging

**Output:** the shared report envelope on stdout (schema: `packages/cli/schemas/resources-check.json`);
each finding also as a `location:line: severity: message [code]` line on stderr.

**Exit Codes:** `0` no error-severity check violated, `1` one was (or nothing was checked:
`RESOURCE_CHECK_BROKEN`), `2` the run could not do its job.

**Reserved row columns.** A check's statement selects its violations, one finding per row. Four
column names are reserved and matched exactly (case-sensitive); every other column is evidence in
the message:

- `path` — the finding's `location`, when it is a project-relative path.
- `severity` — that row's severity, exactly `error`, `warning` or `info`; NULL or absent means
  the check's declared severity. A `resources.validation.severity` override on `CUSTOM:<name>`
  still wins.
- `line` — the finding's 1-based line; NULL or absent omits it.
- `column` — the finding's 1-based column within `line`; it requires a `line`.

Any other value in a reserved column fails the check as `RESOURCE_CHECK_BROKEN` — "ran and selected
N rows, but row R's severity = "high" is not one of error, warning, info" — and its entry in
`data.checks` carries `broken: true` with `rows`. A column that matches a reserved name only
case-insensitively (`Severity`) gets one stderr warning per check and stays evidence.

⚠️ `SELECT *` or a join feeds a projection table's own columns of those names into the finding:
`realization_conditions.severity`, `blob_conditions.severity` and `.line`,
`harness_blob_imports.line`, and `blob_references.line` and `.column`. After a join that line can
belong to a different table than the `path`. Alias a column (`b.line AS refLine`) to keep it as
evidence.

A finding with a `line` but no usable `path` prints its coordinates after the message, never as a
prefix: `error: <message> [<code>] (line 3, column 5)`.

**What a check examined.** Zero rows is a check's pass, so zero violations over a thousand files and
zero violations over nothing read the same — and the run's `examined` counts the whole population,
which one check whose `WHERE` matches nothing hides behind. A check states its own denominator with
`examined`, a second statement whose ROW COUNT is what the check ranged over:

```yaml
resources:
  checks:
    skills-have-owners:
      description: Every skill names an owner
      sql: SELECT path FROM resource_realizations WHERE path LIKE 'skills/%' AND path NOT IN (…)
      examined: SELECT path FROM resource_realizations WHERE path LIKE 'skills/%'
      # allowEmpty: true   # only if zero skills is a legitimate answer
```

- Its count is published on the check's `data.checks` entry as `examined`. The key is present
  exactly when the check declares `examined` and that statement completed — absent on a check that
  declares none (and on every built-in), absent rather than `0` when it did not finish.
- `examined: 0` fails the run as `RESOURCE_CHECK_EXAMINED_NOTHING` (error, exit 1, not overridable),
  naming the check; the check's own violations are still reported beside it.
- `allowEmpty: true` declares that zero is legitimate: no finding, and the entry publishes
  `examined: 0` beside `allowEmpty: true`, so the exemption is visible in every report.
  `allowEmpty` without `examined` is refused when the config loads.
- The examined statement follows every rule `sql` does, names derived relations the same way, is
  timed into the check's `durationSecs`, and is bounded by `--budget` like any statement. If it
  fails, the check is `RESOURCE_CHECK_BROKEN`, its entry carries `broken: true` with `rows` and no
  `examined`, and none of its rows are reported.
- A check that did not run at all is absent from `data.checks` (or `broken` without `rows`), so
  "examined 0" and "not run" never look alike.

The same applies when the checks run as the `checks` phase of `vat validate`.

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

```yaml
resources:
  include:
    - "docs/**/*.md"
    - "agents/**/README.md"
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
  lane: projection
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
  lensSecs: 3.75e-7
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
  lensSecs: 3.75e-7
  lensesEvaluated: []
  lensPopulation: none
  checksRun: 3
  checks:
    - name: claude-rule-glob-inert
      durationSecs: 0.0000399
      rows: 0
      builtin: true
```
