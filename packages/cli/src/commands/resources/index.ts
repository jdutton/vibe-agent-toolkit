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
    .option('--verbose', 'Show verbose help')
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
    .action(scanCommand)
    .addHelpText(
      'after',
      `
Description:
  Recursively scans for markdown files and reports statistics. Outputs YAML to stdout.
  Path argument: base directory (defaults to current directory)
  When path specified: recursively finds all *.md files (ignores config)
  When no path: uses vibe-agent-toolkit.config.yaml include/exclude patterns

Output Fields:
  status, filesScanned, linksFound, duration

Example:
  $ vat resources scan docs/           # Recursively scan all *.md under docs/
`
    );

  resources
    .command('validate [path]')
    .description('Validate markdown resources (link integrity, anchors)')
    .option('--debug', 'Enable debug logging')
    .option('--frontmatter-schema <path>', 'Validate frontmatter against JSON Schema file (.json or .yaml)')
    .option('--validation-mode <mode>', 'Validation mode for schemas: strict (default) or permissive', 'strict')
    .option('--format <format>', 'Output format: yaml (default), json, or text', 'yaml')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Recursively validates internal links and anchors in markdown files.
  Path argument: base directory (defaults to current directory)
  When path specified: recursively finds all *.md files (ignores config)
  When no path: uses vibe-agent-toolkit.config.yaml include/exclude patterns
  External URLs are NOT validated (by design).

Output Formats:
  --format yaml (default)
    Structured YAML output to stdout. Errors grouped by file.

  --format json
    Structured JSON output to stdout. Errors grouped by file.

  --format text
    Human-readable format. Errors to stderr (test-format style).

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
  $ vat resources validate docs/
    Parse frontmatter, report YAML syntax errors only

  $ vat resources validate docs/ --frontmatter-schema schema.json
    Validate frontmatter against schema
`
    );

  return resources;
}

export { showResourcesVerboseHelp } from './help.js';
