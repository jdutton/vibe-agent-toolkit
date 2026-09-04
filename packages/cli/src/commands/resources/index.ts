/**
 * Resources command group
 */

import { Command, Option } from 'commander';

import { checkCommand } from './check.js';
import { queryCommand } from './query.js';
import { scanCommand } from './scan.js';
import { validateCommand } from './validate.js';

/** What every subcommand's `--debug` flag says it does. */
const DEBUG_HELP = 'Enable debug logging';

/** The two serializations `scan` and `query` offer of one document. */
const OUTPUT_YAML = 'yaml';
const OUTPUT_JSON = 'json';

/**
 * The `--format` option `scan` and `query` share.
 *
 * A factory rather than a shared instance: Commander mutates an `Option` as it
 * is added, so one object handed to two commands is one object two commands
 * disagree about. `validate` deliberately does NOT use this — it offers a third
 * format, `text`, which is a different question.
 *
 * @returns A fresh option for one command
 */
function yamlOrJsonFormat(): Option {
  return new Option('--format <format>', 'Output format: yaml (default) or json')
    .choices([OUTPUT_YAML, OUTPUT_JSON])
    .default(OUTPUT_YAML);
}

export function createResourcesCommand(): Command {
  const resources = new Command('resources');

  resources
    .description('Markdown resource scanning and link validation (run before commit)')
    .helpCommand(false) // Disable redundant 'help' command, use --help instead
    .addHelpText(
      'after',
      `
Example:
  $ vat resources validate docs/       # Validate markdown in docs directory

Configuration:
  Create vibe-agent-toolkit.config.yaml in project root. See --help --verbose for schema.
`
    );

  resources
    .command('scan [path]')
    .description('Discover markdown resources in directory')
    .option('--debug', DEBUG_HELP)
    .option('--verbose', 'Show full file list with details')
    .option('--collection <id>', 'Filter by collection ID')
    .addOption(yamlOrJsonFormat())
    .action(scanCommand)
    .addHelpText(
      'after',
      `
Description:
  Scans for markdown files and reports statistics. Outputs YAML to stdout,
  or JSON with --format json (the same document, for consumers without a
  YAML parser).

Path Argument Behavior:
  WITH path: Scans all *.md/*.html recursively under path, still applying the
             config's resources.exclude patterns
  WITHOUT path: Uses vibe-agent-toolkit.config.yaml include + exclude patterns

Filtering:
  --collection <id>: Only scan files in specified collection
                     (requires config mode - no path argument)

Output Fields:
  status, filesScanned, linksFound, anchorsFound, durationSecs
  root: The one absolute path every reported file path is relative to
  lane: Which enumerator produced the population — 'walk' or 'projection'
  collections: Per-collection resource counts (resourceCount)
  files: (only with --verbose) Array with per-file details

Requirements:
  projectRoot: optional (falls back to cwd with a warning)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Examples:
  $ vat resources scan docs/                    # Scan all *.md under docs/
  $ vat resources scan --verbose                # Include full file details
  $ vat resources scan --collection guides      # Only scan guides collection
`
    );

  resources
    .command('query <sql> [path]')
    .description('Run one read-only SQL statement against the resource projection')
    .option('--debug', DEBUG_HELP)
    .option('--param <values...>', 'Values bound in order to the ? placeholders in the statement')
    .addOption(yamlOrJsonFormat())
    .action(queryCommand)
    .addHelpText(
      'after',
      `
Description:
  Populates this tree's resource projection and runs ONE read-only SQL
  statement against it. Answers questions no command reports a field for --
  which files carry which headings, what links at what, which paths were
  refused and why.

  One tree, one answer. The statement always runs against an in-memory
  database holding THIS tree's projection and nothing else. A selected
  projection store makes the population cheap and is never queried -- it is
  one database per VAT release shared by every root on the machine.

One query, and read-only:
  The statement must BE a query -- its first significant token has to be
  SELECT, WITH or VALUES. Anything else (ATTACH, PRAGMA, DELETE, EXPLAIN) is
  refused before it reaches SQLite. That is a gate on statement KIND and
  deliberately not an inspection of your SQL; EXPLAIN is excluded even though
  it is side-effect free, because admitting a prefix keyword would mean
  deciding safety by looking PAST the first token.

  Read-only-ness stays the engine's job: the connection is put into PRAGMA
  query_only, so a write is refused by SQLite rather than by pattern-matching.

  One statement only -- SQLite compiles the first and discards the rest WITHOUT
  error, so trailing text would be silently ignored. A comment after the
  terminating semicolon is fine ('SELECT 1;  -- see ADR-14').

Output Fields:
  status, root, rowCount, durationSecs
  population: 'derived' or 'store' -- whether the rows were built this run or
              read from the projection store. Reported because it cannot be
              inferred: a correct hit and a correct re-derivation produce
              identical rows
  populationSecs:
              What that population cost. The store's whole job is to make it
              cheap, so this is the number that says whether it did
  rows:       The selected rows, exactly as SQLite holds them -- a boolean as
              0/1, a date and a JSON column as text. Values are NOT decoded,
              because decoding needs a table spec and arbitrary SQL has none

Exit Codes:
  0 - The statement ran  |  2 - The statement was refused, or the crawl failed

Requirements:
  projectRoot: optional (falls back to cwd with a warning)
  config:      optional (uses defaults if absent)

Examples:
  $ vat resources query 'SELECT path FROM resource_realizations LIMIT 5'
  $ vat resources query 'SELECT COUNT(*) AS n FROM blobs'
  $ vat resources query 'SELECT * FROM blob_conditions'      # what was refused
  $ vat resources query 'SELECT target FROM blob_references WHERE kind = ?' --param markdown-link
`
    );

  resources
    .command('check [path]')
    .description('Run the project\'s declared SQL assertions over its resource projection')
    .option('--debug', DEBUG_HELP)
    .option('--check <name>', 'Run only this check, by its key in resources.checks')
    .option(
      '--budget <seconds>',
      'Kill the run if it goes this long without completing a unit of work'
      + ' (default: 300; 0 removes the bound and can then hang forever)',
    )
    .addOption(
      // Hidden because it is not an operator's flag: it is how a supervising
      // parent tells the child it spawned to do the work rather than spawn one
      // of its own, and where to append its progress. Documenting it would
      // invite adopters to depend on a file whose only contract is the
      // `.strict()` schema the same build reads it with.
      new Option('--cost-log <path>', 'Internal: append per-unit progress here').hideHelp(),
    )
    .addOption(yamlOrJsonFormat())
    .action(checkCommand)
    .addHelpText(
      'after',
      `
Description:
  Runs every assertion declared under \`resources.checks\` in
  vibe-agent-toolkit.config.yaml against the same projection \`vat resources
  query\` reads, and fails the run when any error-severity check is violated.

  A query answers a question once. This runs the questions a project decided
  were worth asking every time.

Declaring a check:
  resources:
    checks:
      orphan-skills:
        description: Every SKILL.md must be referenced by a plugin
        sql: SELECT path FROM resource_realizations WHERE ...
        severity: error        # optional; error is the default

  The statement selects the VIOLATIONS -- zero rows is a pass. Each returned
  row becomes one finding, and its columns are that finding's evidence; a
  selected \`path\` column anchors the finding to the file.

  Findings are ordinary validation issues with the code CUSTOM:<name>, so
  resources.validation.severity can downgrade or ignore one you inherited.

  A check's SQL runs through the same surface as vat resources query, so
  the same rule applies: it must be a query, beginning SELECT, WITH or VALUES.
  A comment after the terminating semicolon is accepted.

A check that cannot run FAILS:
  A renamed column breaks a check's SQL. That is reported as an error naming
  the check and listing the columns the projection actually has -- never
  skipped, because a check that stopped running looks exactly like one that
  passed.

  That report carries the code RESOURCE_CHECK_BROKEN, and NO
  resources.validation.severity entry can silence it -- the config schema
  refuses it as a severity key. Downgrade or ignore the CHECK all you like;
  you cannot downgrade the news that it stopped checking.

A check with NOTHING TO RUN OVER fails the same way:
  Zero findings is the pass condition, so a run whose projection enumerated no
  members passed every check while asserting nothing. If checks ran and
  membersEnumerated is 0, that is reported as RESOURCE_CHECK_BROKEN at error
  and the run fails. Usual causes: a broad .gitignore pattern, a shallow or
  sparse CI checkout, or a root that resolved somewhere other than intended.
  Declaring no checks at all is different -- that stays a warning and exit 0.

A run that HANGS is killed and reported, not waited on:
  A check's SQL is adopter-authored and unbounded -- an accidental cross join
  or a WITH RECURSIVE that never terminates runs forever, and nothing inside
  the process can stop it (the query is synchronous and holds the event loop).
  So the work runs in a child process and --budget <seconds> bounds it.

  The budget is time WITHOUT PROGRESS, not total runtime: the clock resets
  every time the run finishes a unit (the population, then each check, then
  once more when the checks are done and the document is being built). So a
  large repository with many rules is never at risk while its rules keep
  finishing. Default 300.

  That per-unit property holds for the CHECKS. It does NOT hold for the
  population, which reports progress only when it FINISHES -- so for that one
  unit the budget is a total bound, and a population slower than the budget is
  killed however healthily it is working. A cold population is ~33-35s here
  (~1.2s warm) and most of that is one uninterruptible parse stage, so the
  default is set well above it rather than pretending to instrument it. On a
  large adopter tree with a cold parse cache, raise the bound.

  An interrupted run NEVER exits 0 and never looks like a pass. There are two
  ways to be interrupted and they are reported differently:

    Killed by the budget -- exit 1, status: error, and a RESOURCE_CHECK_BROKEN
    finding naming the check that was in flight and the bound that was blown.

    Died -- the child process was terminated by a signal, most often because it
    ran out of memory materialising a result set (Node aborts with SIGABRT) or
    because something outside killed it (a runner's OOM killer sends SIGKILL).
    Also exit 1, status: error, RESOURCE_CHECK_BROKEN -- naming the signal, and
    saying plainly that raising --budget is not the remedy.

  Either way the checks that COMPLETED keep their entry under checks (including
  rows), but their individual violations are NOT in issues -- the progress the
  child records is costs, not findings. Read that issue list as incomplete.

  Interrupted before the population finished, there is no projection and no
  honest document: that is an operator error (exit 2) saying which of the two
  happened.

  --budget cannot be combined with --cost-log (exit 2): --cost-log means the
  work runs in this process, where the budget could not be enforced.

  --budget 0 removes the bound and runs everything in this process. Nothing
  will then stop a runaway statement. An empty --budget is refused rather than
  read as 0 -- an unset shell variable must not silently remove the bound.
  Ctrl-C still works at a keyboard, because this command installs no signal
  handler -- do not add one, a process blocked in synchronous SQLite survives
  SIGINT once a handler exists.

Output Fields:
  status, root, population, populationSecs, checksRun, membersEnumerated,
  issueCounts, durationSecs, checks
  checksRun: How many checks ran. Read it: no findings from four checks and no
             findings from NO checks are otherwise the same document
  membersEnumerated:
             How many members the projection enumerated -- the corpus the
             checks ran AGAINST, where checksRun is how many rules ran. Four
             checks over 8,000 files and four over 0 are otherwise the same
             document, and only one of them is a gate
  checks:    What each check COST -- {name, durationSecs, rows} per check, or
             {name, durationSecs, broken} for one whose statement threw. rows
             is what the statement SELECTED, and it is a memory signal: rows
             are fully materialised. It is not a finding count -- a severity
             override of 'ignore' drops findings the statement still selected,
             so sum(rows) and issueCounts legitimately disagree
  populationSecs:
             What the shared population cost. It is NOT charged to any check:
             every check's durationSecs is its own statement and nothing else,
             so this is the term that reconciles them against durationSecs
  issues:    One row per violation ({code, severity, message, path?})

Exit Codes:
  0 - No error-severity findings
  1 - At least one (a violation, a broken check, an empty corpus, a run killed
      for making no progress within --budget, or a run whose child DIED)
  2 - System error, an unknown --check name, an unusable --budget (including an
      empty one, or one passed with --cost-log), or a run interrupted before
      its population completed

Examples:
  $ vat resources check
  $ vat resources check --check orphan-skills
  $ vat resources check --budget 60
`
    );

  resources
    .command('validate [path]')
    .description('Validate markdown resources (link integrity, anchors)')
    .option('--debug', DEBUG_HELP)
    .option('-v, --verbose', 'Show all scanned resources, including those without issues')
    .option('--frontmatter-schema <path>', 'Validate frontmatter against JSON Schema file (.json or .yaml)')
    .option('--validation-mode <mode>', 'Validation mode for schemas: strict (default) or permissive', 'strict')
    .option('--format <format>', 'Output format: yaml (default), json, or text', 'yaml')
    .option('--collection <id>', 'Filter by collection ID')
    .option('--check-external-urls', 'Validate external URLs (default: false, slow operation)')
    .option('--check-html-anchors', 'Strictly validate HTML fragment anchors against element ids (default: false; HTML fragments are often runtime-defined by JS)')
    .option('--no-cache', 'Disable every disk cache for this run: the parse cache and the external URL cache (forces fresh parses and fresh checks)')
    .option('--no-check-frontmatter-links', 'Skip frontmatter URI-reference link validation across all collections (default: enabled)')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates links and anchors in markdown files.

Path Argument Behavior:

  WITH path argument (e.g., "vat resources validate docs/"):
    • Scans all *.md files recursively under the specified directory
    • The path REPLACES the config's resources.include patterns...
    • ...but resources.exclude STILL APPLIES, so a path run never scans
      build output, vendored trees, or test fixtures the project excluded
    • Use for: Quick validation of a specific directory tree

  WITHOUT path argument (e.g., "vat resources validate"):
    • Uses vibe-agent-toolkit.config.yaml to determine files to scan
    • Applies include AND exclude patterns from config
    • SHOWS collection statistics and per-collection validation rules
    • Validates frontmatter against collection-specific schemas (if configured)
    • Use for: Full project validation with collection-aware rules

  Collections apply in both modes — membership is decided per file against the
  collection's own patterns, so a path run still gets collection-specific
  schemas for whatever it scanned.

Filtering:
  --collection <id>: Only validate files in specified collection
                     (requires config mode - no path argument)

Output Formats:
  --format yaml (default)
    Structured YAML output to stdout. Errors grouped by file.

  --format json
    Structured JSON output to stdout. Issues grouped by file.

  --format text
    Human-readable format. Issues to stderr as
    file:line:column: severity: message

Output Fields (success):
  status, filesScanned, linksChecked, durationSecs, validationMode
  collections: Per-collection stats (resourceCount, hasSchema, validationMode)

Output Fields (issues found):
  A field named error* counts ERROR-severity issues only — the ones that fail
  the run. A field named issue* counts issues of every severity.

  status: success | warning | error — the worst ACTIONABLE severity found, the
          same vocabulary every other vat validation lane reports. An info-only
          run is success; issueCounts below says what was actually seen.
  filesScanned, durationSecs
  errorsFound: Count of error-severity issues (drives the exit code)
  filesWithErrors: Files carrying at least one error-severity issue
  issueCounts: {errors, warnings, info} — every issue, split by severity
  issueSummary: Count of each issue code, ALL severities
  collections: Per-collection stats including filesWithErrors, errorCount
  issues: One row per file with findings, carrying only that file's counts
          ({file, errors?, warnings?, info?, codes}). A zero bucket is omitted,
          and a file that emitted nothing has no row — filesScanned above stays
          the true denominator.

Verbosity:
  -v, --verbose
    Replaces each file's counts row with its per-issue detail (line, column,
    code, severity, message) — the pre-summary shape. That form is for
    '> file' then grep, not for reading. Every other field above is a total
    about the run and is identical in both modes.
    --format text is unaffected: it already prints one line per issue.

Validation Checks:
  - Internal file links (relative paths)
  - Anchor links within files (#heading)
  - Cross-file anchor links (file.md#heading)
  - External URLs (only with --check-external-urls flag)

External URL Validation:
  By default, external URLs are NOT validated (for speed).
  Use --check-external-urls to enable HTTP checking of external links.
  External-URL findings (EXTERNAL_URL_DEAD/TIMEOUT/ERROR) are configurable
  warnings — they do NOT fail the build by default. Promote them to errors
  or silence them via resources.validation.severity in your config.
  Results are cached in system temp directory (24h alive, 1h dead).
  Cache is shared across all projects (URLs are universal).

Caching:
  Two disk caches sit under <tmpdir>/.vat-cache: parse results (keyed by file
  content, so a changed file is never served stale) and external-URL checks.
  --no-cache turns BOTH off for this run — it is not external-URL-specific.
  'vat cache clear' deletes them.

HTML Fragment Anchor Validation:
  By default, HTML fragment anchors (#id) are NOT validated against the
  target file's element ids — HTML fragments are frequently defined at
  runtime by JS (hash routers, hash query-params), so a static miss is not
  proof of breakage. Use --check-html-anchors to strict-check fully-static
  HTML against literal id/name attributes. Markdown anchor checking is
  unaffected — heading slugs are statically authoritative and always checked.

Frontmatter Validation:
  --frontmatter-schema <path>
    Validate frontmatter against JSON Schema file.

    Behavior:
      - Files without frontmatter: OK (unless schema requires fields)
      - Extra fields: OK by default (unless schema sets additionalProperties: false)
      - YAML syntax errors: Always reported

    Common pattern: Define minimum required fields, allow extras.

    Example schema:
      {
        "type": "object",
        "required": ["title", "description"],
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "category": { "enum": ["guide", "reference", "tutorial"] }
        }
      }

  --validation-mode <mode>
    Validation mode for schemas (default: strict).

    Modes:
      - strict: Enforce schema exactly (respect additionalProperties: false)
      - permissive: Allow extra fields (schema layering use case)

    Use permissive mode when:
      - Multiple schemas validate the same frontmatter
      - Schemas define different sets of fields
      - Extra fields should not cause validation failures

Exit Codes:
  0 - Success  |  1 - Validation errors  |  2 - System error

Requirements:
  projectRoot: optional (falls back to cwd with a warning)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Examples:

  Mode 1: Quick directory scan (no collections)
  $ vat resources validate docs/
    Validates all *.md in docs/ recursively
    Ignores config file, no collection stats

  Mode 2: Project validation with collections
  $ vat resources validate
    Uses vibe-agent-toolkit.config.yaml
    Shows collection stats and applies collection-specific validation

  Filter by collection
  $ vat resources validate --collection guides
    Only validates files in the guides collection
    Requires config mode (no path argument)

  With frontmatter schema (Mode 1)
  $ vat resources validate docs/ --frontmatter-schema schema.json
    Validates docs/ with single schema for all files

  With external URL validation
  $ vat resources validate docs/ --check-external-urls
    Validates all links including HTTP checks of external URLs

  Note: For collection-specific schemas, use Mode 2 (no path argument)
        and configure schemas per collection in config file
`
    );

  return resources;
}

export { showResourcesVerboseHelp } from './help.js';
