/**
 * Corpus command group — Phase 1 ships only `scan`.
 */

import { Command } from 'commander';

import { corpusScanCommand, type CorpusScanOptions } from './scan.js';

export function createCorpusCommand(): Command {
  const corpus = new Command('corpus');

  corpus
    .description('Run vat audit (and optionally vat skill review) at scale across a tracked plugin seed')
    .helpCommand(false);

  corpus
    .command('scan [seed-file]')
    .description('Audit each plugin in the seed; write a per-run snapshot under --out')
    .argument('[seed-file]', 'Path to seed YAML (default: corpus/seed.yaml)')
    .requiredOption('--out <dir>', 'Output directory for the run snapshot (no default — must be specified)')
    .option('--with-review', 'Also invoke vat skill review per plugin (LLM-backed; uses API tokens)')
    .option('--debug', 'Enable debug logging and preserve cloned tempdirs')
    .action(async function (this: Command, seedFile: string | undefined) {
      await corpusScanCommand(seedFile, this.optsWithGlobals() as CorpusScanOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Reads a seed YAML listing plugins to audit (each entry: { source, name,
  validation? }), runs 'vat audit' against each (and optionally 'vat skill
  review' with --with-review), writes summary.yaml plus per-plugin sibling
  files into a date-sha subdirectory of --out.

  source forms accepted (same as vat audit):
    - local path (absolute or relative)
    - https://host/owner/repo.git[#ref[:subpath]]
    - GitHub web URL (https://github.com/owner/repo/tree/<ref>/<subpath>)
    - GitHub shorthand (owner/repo, with optional #ref:subpath)
    - SSH URL (git@host:owner/repo.git or ssh://...)
    - file:// URL (local bare-repo testing)

Output:
  <--out>/<UTC-date>-<vat-short-sha>/
    summary.yaml          # index: per-plugin status + totals
    <name>-audit.yaml     # full audit output per plugin
    <name>-review.md      # full skill-review output (only with --with-review)

Exit codes:
  0  - scan completed (regardless of unloadable plugins)
  2  - scan failed to start (seed missing, --out missing, etc.)
  130 - interrupted by SIGINT (partial results written)

Example:
  $ vat corpus scan --out ~/scratch/vat-corpus-runs
  $ vat corpus scan corpus/seed.yaml --out ~/scratch/vat-corpus-runs --with-review
`
    );

  return corpus;
}
