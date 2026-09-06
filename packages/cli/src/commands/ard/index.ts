/**
 * `vat ard` — Agentic Resource Discovery emission.
 *
 * Not registered in `command-loaders.ts` by this module: the loader table is
 * owned elsewhere, and this file only builds the command.
 */

import { Command } from 'commander';

import { ardEmitCommand, DEFAULT_ARD_OUTPUT } from './emit.js';

export { ardEmitCommand, runArdEmit, ArdConfigMissingError, DEFAULT_ARD_OUTPUT } from './emit.js';
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
  author supplies \`ard.entries.<name>.type\`; the specification names no media
  type for any of them, and VAT does not guess. Skipped surfaces are reported
  on stderr.

  \`representativeQueries\` is authored, never generated. Its absence is a
  conformance WARNING upstream, not an error — an honest gap beats a
  fabricated query that makes a resource discoverable for the wrong task.

Requirements:
  ard.publisher  Required — anchors every entry URN.
  ard.baseUrl    Required in practice — VAT has no inline artifact document for
                 these surfaces, so without it no entry has a \`url\` or a
                 \`data\` and emission fails.

Exit Codes:
  0 - Manifest written
  1 - No \`ard:\` config, or a surface could not be derived
  2 - Unexpected internal failure

Example:
  $ vat ard emit --output dist/.well-known/ard.json
`
    );

  return ard;
}
