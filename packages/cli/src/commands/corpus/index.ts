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
    .command('scan')
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
  A YAML report on stdout (status ok, findings or error); examined counts the
  seed entries. Its data holds:
  - outDir:  the resolved --out
  - entries: one row per entry — name, audit (ok | findings | unloadable),
             review (ok | skipped | error), outputPath (its audit file,
             relative to outDir; null when unloadable)
  An entry the scan could not finish — its audit could not run, or its
  requested review did not — is a CORPUS_ENTRY_INCOMPLETE warning naming it.
  What the plugins' audits found is in their audit files, not in this report.

  Files, under <--out>/<UTC-date>-<vat-short-sha>/:
    summary.yaml          # index: per-plugin status + totals
    <name>-audit.yaml     # the vat audit report for the plugin — the same
                          #   envelope and schema (packages/cli/schemas/corpus-audit.json).
                          #   An audit over 0 files carries one RESOURCE_CHECK_BROKEN,
                          #   never a clean row.
    <name>-review.md      # full skill-review output (only with --with-review)

Exit Codes:
  0 - Scanned, whatever the plugins held (an entry refused for a coded reason is a
      CORPUS_ENTRY_INCOMPLETE warning: status findings, still exit 0; this verb never exits 1)
  2 - Could not run (error.code: USAGE_INVALID for a seed file that is not
      there, CONFIG_INVALID for a seed that does not parse or validate — an
      empty plugins list included,
      INPUT_UNREADABLE for one the OS will not read, RUN_INCOMPLETE when a
      write under --out failed — the entries that finished are in data —
      and INTERNAL_ERROR when an entry's audit throws something VAT did not
      code: a defect in VAT ends the scan rather than becoming a warning row)

Requirements:
  projectRoot: optional (tolerates absence)
  config:      not used

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat corpus scan --out ~/scratch/vat-corpus-runs
  $ vat corpus scan corpus/seed.yaml --out ~/scratch/vat-corpus-runs --with-review
`
    );

  return corpus;
}
