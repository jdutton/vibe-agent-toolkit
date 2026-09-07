/**
 * `vat okf` command group — Open Knowledge Format bundles.
 *
 * One verb today. The group exists rather than a flat `vat okf-validate`
 * because OKF is a format with more than one producer-side question in it (a
 * bundle's index files are generated artifacts, §8), and a group is cheaper to
 * extend than a top-level verb is to deprecate.
 */

import { Command, Option } from 'commander';

import { okfValidateCommand, type OkfValidateOptions } from './validate.js';

export function createOkfCommand(): Command {
  const okf = new Command('okf');

  okf
    .description('Validate the Open Knowledge Format (OKF) bundles this project publishes')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  An OKF bundle is a directory of markdown concept documents, one per file,
  each carrying YAML frontmatter with a non-empty \`type\`. Bundles are declared
  in vibe-agent-toolkit.config.yaml:

    okf:
      bundles:
        knowledge:
          root: ./knowledge          # required
          severity: error            # optional; error is the default

  The population is defined by the SPECIFICATION, not by a glob: every
  non-reserved .md file anywhere beneath the root is a concept document, and
  only index.md and log.md are reserved. There is deliberately no include or
  exclude — a narrower population would let VAT report a clean bundle while a
  file it never read broke conformance. If a subtree must not be part of a
  bundle, it must not be under the bundle root.

Example:
  $ vat okf validate                   # Every declared bundle
`
    );

  okf
    .command('validate')
    .description('Check declared OKF bundles for conformance (§11)')
    .argument('[bundle]', 'Validate only this declared bundle (default: all of them)')
    .addOption(
      // `.choices()`, not a bare `.option()`: an unrecognised value used to fall
      // through to the YAML branch and exit 0, so `--format Json` in a pipeline
      // failed downstream in `jq` instead of here, where the mistake is.
      new Option('--format <format>', 'Output format: yaml (default) or json')
        .choices(['yaml', 'json'])
        .default('yaml'),
    )
    .option(
      '--spec-version <version>',
      'Cross-check a bundle-root index.md okf_version against this revision (e.g. 0.2). Omitted, a declaration is reported but not judged.',
    )
    .option('--debug', 'Verbose logging to stderr')
    .action(async function (this: Command, bundle: string | undefined) {
      await okfValidateCommand(bundle, this.optsWithGlobals() as OkfValidateOptions);
    })
    .addHelpText(
      'after',
      `
Description:
  Checks each declared bundle against the OKF v0.2 conformance items VAT
  implements:

    §11.1  every non-reserved .md carries a parseable YAML frontmatter block
    §11.2  every one of those blocks carries a non-empty \`type\`
    §6.1   every markdown LINK and IMAGE — the [text](target) form — resolves
           inside the bundle. A leading "/" resolves against the BUNDLE ROOT,
           not the filesystem root, and spelling is judged against the bytes on
           disk, so a link that opens only because the author's filesystem folds
           letter case or Unicode normalization form is reported: the bundle is
           unpacked somewhere that does not fold.
    §8/§12 an index.md carries no frontmatter, except a bundle-root index.md,
           which may carry okf_version and nothing else

  NOT covered by the §6.1 check: wikilinks. \`[[other-concept]]\` is invisible to
  the markdown parser, so a bundle written in that style gets no cross-link
  checking at all, and a clean report says nothing about those links.

  §11.3's structural rules for the BODY of index.md and log.md are not
  implemented, so a clean report means §11.1 and §11.2 in full and §11.3 only
  in part.

  Unknown \`type\` values and unknown frontmatter keys are legal and are never
  reported: §4.1 has no central registry and forbids rejecting extra keys.

  The okf_version a bundle-root index.md declares is a CROSS-CHECK, never an
  input. It is reported as declaredOkfVersion; pass --spec-version to have a
  disagreement reported as a finding.

Exit Codes:
  0 - No error-severity findings
  1 - At least one error-severity finding, an unreadable bundle root among them
      (it is reported as that bundle's own finding, so the other bundles in the
      run are still checked and still reported)
  2 - System error (no config file, unknown bundle name)

Example:
  $ vat okf validate knowledge --format json
  $ vat okf validate --spec-version 0.2
`
    );

  return okf;
}
