/**
 * `--base <ref>` — the commit the `changed_files` relation compares the tree with — as one option
 * every statement-running verb declares the same way: `vat resources query`, `vat resources check`
 * and `vat validate` (which forwards it to its checks phase).
 */

import { Option } from 'commander';

/**
 * A fresh `--base <ref>` option. A factory, because Commander mutates an `Option` as it is added.
 *
 * @returns The option
 */
export function baseOption(): Option {
  return new Option(
    '--base <ref>',
    'The commit changed_files compares this tree with (a branch, tag or commit, e.g. origin/main);'
    + ' a statement reading changed_files without it is refused',
  );
}
