/**
 * `vat ard` — Agentic Resource Discovery emission.
 *
 * Not registered in `command-loaders.ts` by this module: the loader table is
 * owned elsewhere, and this file only builds the command.
 */

import { Command, Option } from 'commander';

import { ardEmitCommand, DEFAULT_ARD_OUTPUT } from './emit.js';

export {
  ardEmitCommand,
  buildArdEmitReport,
  runArdEmit,
  ArdConfigMissingError,
  DEFAULT_ARD_OUTPUT,
  type ArdEmitReport,
  type ArdEmitStatus,
} from './emit.js';
export { collectArdSurfaces, type ArdSurfaceCollection, type SkippedArdSurface } from './surfaces.js';

/** Build the `vat ard` command group. */
export function createArdCommand(): Command {
  const ard = new Command('ard');

  ard.description('Emit an Agentic Resource Discovery (ARD) manifest for this project').addHelpText(
    'after',
    `
Description:
  ARD has no registry and no upload: a publisher hosts a JSON-LD document at
  https://{domain}/.well-known/ard.json and registries crawl it. VAT builds that
  document out of the surfaces this project already declares.

  ⚠️ ARD is v0.91, status Proposal. VAT emits against it and reads nothing back.
`
  );

  ard
    .command('emit')
    .description('Build the ARD manifest and write it to disk')
    .option('-o, --output <path>', `Output path (default: ${DEFAULT_ARD_OUTPUT})`)
    .option('--project-root <dir>', 'Project root to read the config from (default: cwd)')
    .addOption(
      // Rejected by Commander rather than falling through to `text`, as the
      // sibling `vat okf validate` does: `--format Json` in a pipeline must
      // fail HERE, where the mistake is, not downstream in `jq`.
      new Option('--format <format>', 'Output format: text (default) or json')
        .choices(['text', 'json'])
        .default('text')
    )
    .option(
      '--strict',
      'Exit 1 when the manifest advertises nothing, or a configured surface was skipped'
    )
    .option('--debug', 'Verbose logging to stderr')
    .action(ardEmitCommand)
    .addHelpText(
      'after',
      `
Derivation:
  Every published skill in \`skills.config\` becomes an entry, typed
  application/ai-skill+md — a media type VAT COINS, since the specification
  names none for a skill (it occurs once, in an example).

  A marketplace, an OKF bundle and an MCP server are emitted ONLY when the
  author supplies \`ard.entries."<kind>:<name>".type\`; the specification names
  no media type for any of them, and VAT does not guess. Skipped surfaces are
  reported on stderr — including a \`skills.config\` key that discovery does not
  find, which is never advertised.

  \`ard.entries\` is keyed by "<kind>:<name>" — skills, marketplaces and OKF
  bundles are independent key spaces, so a bare name that matches two of them
  is REFUSED rather than applied to both.

  \`representativeQueries\` is authored, never generated. Its absence is a
  conformance WARNING upstream, not an error — an honest gap beats a
  fabricated query that makes a resource discoverable for the wrong task.

Requirements:
  ard.publisher  Required — anchors every entry URN.
  ard.baseUrl    Required in practice — VAT has no inline artifact document for
                 these surfaces, so without it no entry has a \`url\` or a
                 \`data\` and emission fails.

Exit Codes:
  0 - Manifest written — INCLUDING one that advertises nothing. An empty
      \`entries\` list is a legal ARD document, and skipped surfaces are reported
      on stderr at this exit code. Gate on \`--format json\` (\`status\`,
      \`entryCount\`, \`skippedCount\`), or make both conditions fail with
      \`--strict\`
  1 - No \`ard:\` block in the config, or a surface could not be derived. Under
      \`--strict\`, also an empty manifest or a skipped surface
  2 - System error (no project root, no config file, invalid config, unexpected
      internal failure)

Example:
  $ vat ard emit --format json --strict
`
    );

  return ard;
}
