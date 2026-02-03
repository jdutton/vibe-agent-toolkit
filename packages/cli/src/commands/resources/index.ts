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
  WITH path: Scans all *.md recursively under path (ignores config)
  WITHOUT path: Uses vibe-agent-toolkit.config.yaml patterns

Filtering:
  --collection <id>: Only scan files in specified collection
                     (requires config mode - no path argument)

Output Fields:
  status, filesScanned, linksFound, anchorsFound, durationSecs
  collections: Per-collection resource counts (resourceCount)
  files: (only with --verbose) Array with per-file details

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
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates internal links and anchors in markdown files.
  External URLs are NOT validated (by design).

Path Argument Behavior:

  WITH path argument (e.g., "vat resources validate docs/"):
    • Scans all *.md files recursively under the specified directory
    • IGNORES vibe-agent-toolkit.config.yaml (collections, includes, excludes)
    • DOES NOT show collection statistics in output
    • Use for: Quick validation of a specific directory tree

  WITHOUT path argument (e.g., "vat resources validate"):
    • Uses vibe-agent-toolkit.config.yaml to determine files to scan
    • Applies include/exclude patterns from config
    • SHOWS collection statistics and per-collection validation rules
    • Validates frontmatter against collection-specific schemas (if configured)
    • Use for: Full project validation with collection-aware rules

  ⚠️  To see collection statistics and use collection-specific validation,
      run WITHOUT a path argument and configure collections in config file.

Filtering:
  --collection <id>: Only validate files in specified collection
                     (requires config mode - no path argument)

Output Formats:
  --format yaml (default)
    Structured YAML output to stdout. Errors grouped by file.

  --format json
    Structured JSON output to stdout. Errors grouped by file.

  --format text
    Human-readable format. Errors to stderr (test-format style).

Output Fields (success):
  status, filesScanned, linksChecked, durationSecs, validationMode
  collections: Per-collection stats (resourceCount, hasSchema, validationMode)

Output Fields (failure):
  status, filesScanned, filesWithErrors, errorsFound, durationSecs
  errorSummary: Count of each error type (broken_file, broken_anchor, etc.)
  collections: Per-collection stats including filesWithErrors, errorCount
  errors: Detailed errors grouped by file

Checks:
  Internal file links, anchor links (#heading), cross-file anchors (file.md#heading)

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

  Note: For collection-specific schemas, use Mode 2 (no path argument)
        and configure schemas per collection in config file
`
    );

  return resources;
}

export { showResourcesVerboseHelp } from './help.js';
