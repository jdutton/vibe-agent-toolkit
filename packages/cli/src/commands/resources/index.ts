/**
 * Resources command group
 */

import { Command } from 'commander';

import { scanCommand } from './scan.js';
import { validateCommand } from './validate.js';

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
    .option('--debug', 'Enable debug logging')
    .option('--verbose', 'Show full file list with details')
    .option('--collection <id>', 'Filter by collection ID')
    .action(scanCommand)
    .addHelpText(
      'after',
      `
Description:
  Scans for markdown files and reports statistics. Outputs YAML to stdout.

Path Argument Behavior:
  WITH path: Scans all *.md/*.html recursively under path, still applying the
             config's resources.exclude patterns
  WITHOUT path: Uses vibe-agent-toolkit.config.yaml include + exclude patterns

Filtering:
  --collection <id>: Only scan files in specified collection
                     (requires config mode - no path argument)

Output Fields:
  status, filesScanned, linksFound, anchorsFound, durationSecs
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
    .command('validate [path]')
    .description('Validate markdown resources (link integrity, anchors)')
    .option('--debug', 'Enable debug logging')
    .option('--frontmatter-schema <path>', 'Validate frontmatter against JSON Schema file (.json or .yaml)')
    .option('--validation-mode <mode>', 'Validation mode for schemas: strict (default) or permissive', 'strict')
    .option('--format <format>', 'Output format: yaml (default), json, or text', 'yaml')
    .option('--collection <id>', 'Filter by collection ID')
    .option('--check-external-urls', 'Validate external URLs (default: false, slow operation)')
    .option('--check-html-anchors', 'Strictly validate HTML fragment anchors against element ids (default: false; HTML fragments are often runtime-defined by JS)')
    .option('--no-cache', 'Disable cache for external URL validation (forces fresh checks)')
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
  issues: Detail grouped by file; each entry states its own severity

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
  Use --no-cache to force fresh checks (ignores cache).

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
