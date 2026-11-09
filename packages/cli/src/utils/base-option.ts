/** `--base <ref>`, the commit `changed_files` compares with, for every statement-running verb. */

import { Option } from 'commander';

/** A fresh `--base <ref>` option. A factory, because Commander mutates an `Option` as it is added. */
export function baseOption(): Option {
  return new Option(
    '--base <ref>',
    'The commit changed_files compares this tree with (a branch, tag or commit, e.g. origin/main);'
    + ' a statement reading changed_files without it is refused',
  );
}
