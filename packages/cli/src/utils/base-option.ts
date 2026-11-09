/** `--base <ref>`, the commit `changed_files` compares with, for every statement-running verb. */

import { Option } from 'commander';

/** A fresh `--base <ref>` option. A factory, because Commander mutates an `Option` as it is added. */
export function baseOption(): Option {
  return new Option(
    '--base <ref>',
    'The ref changed_files compares with (a branch, tag or commit, e.g. origin/main): this tree against'
    + ' the merge base of <ref> and HEAD. Read only when a statement names changed_files, which'
    + ' without it is refused',
  );
}
