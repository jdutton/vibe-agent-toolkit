/**
 * ESLint rule: no-link-following-fs
 *
 * In product source, flags every use of an fs call that FOLLOWS a symbolic link —
 * `stat`, `statSync`, `existsSync`, `realpath`, `realpathSync` (and their
 * `.native` forms), from `node:fs`, `fs`, `node:fs/promises` or `fs/promises`,
 * however reached (see `fs-binding-scan.cjs`).
 *
 * A Windows kernel asked to follow a link to `\\host\share` opens an SMB session
 * and offers the operator's NTLM credentials to that host before any answer comes
 * back. So the kernel may be asked to follow a link only once the chain to it has
 * been read by its text, hop by hop, and shown local — which the one guarded module
 * does (`@vibe-agent-toolkit/utils` `followedStatSync`, `followedKindSync`,
 * `realpathNativeSync`, `pathPresent(path, { follow: within }, …)`). Three rounds of
 * hand sweeps for "the sites that resolve links" each missed sites; this rule is
 * the sweep.
 *
 * `symlink` and `symlinkSync` are flagged unless CALLED with a third argument (the
 * link's type): with none, Node on Windows `stat`s the target to pick `file` or `dir`,
 * so creating a link is a follow of its unread text. The type is read syntactically —
 * a callback passed by name in the third place reads as a type.
 *
 * `lstat`, `fstat`, a file handle's `stat()` and `readlink` follow nothing and are
 * not flagged. Opening or reading a file through a link is outside this rule.
 *
 * ## Scope
 *
 * Product source: a file under `packages/<pkg>/src/` that is not itself a test
 * file — the layout is this repo's, which is why the rule is not in
 * `configs.recommended`.
 *
 * Option `allowFiles: string[]` — repo-relative paths: the guarded module itself,
 * and files whose every such call acts on the operator's own path, each with its
 * reason beside it in the config. The repo's config derives the list from
 * `LINK_FOLLOWING_FS_CALLS`, which pins how many calls each listed file holds;
 * `dev-tools/test/eslint-allowlist-ratchets.test.ts` asserts that count exactly —
 * one more call in a listed file is red, and so is one fewer.
 */

'use strict';

const { productSourceFsBan } = require('./fs-binding-scan.cjs');

module.exports = productSourceFsBan({
  docs: {
    description:
      'Disallow fs calls that follow a symbolic link (stat, existsSync, realpath) in product source outside the ' +
      'guarded module — the kernel would follow a link no walk has read',
    bans: '`stat`/`statSync`/`existsSync`/`realpath`/`realpathSync`, and `symlink`/`symlinkSync` called with no type, from `node:fs` or `node:fs/promises` under `packages/*/src/`',
    useInstead: '`followedStatSync`/`followedKindSync`/`realpathNativeSync(path, within)` or `pathPresent(path, { follow: within }, …)`',
  },
  messageId: 'follows',
  message:
    '`{{name}}` follows a symbolic link with no walk of its chain first: on Windows a link to \\\\host\\share ' +
    'sends the operator\'s credentials to that host. Use followedStatSync / followedKindSync / ' +
    'realpathNativeSync(path, within) or pathPresent(path, { follow: within }, …) from @vibe-agent-toolkit/utils.',
  modules: new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']),
  banned: new Set(['stat', 'statSync', 'existsSync', 'realpath', 'realpathSync']),
  untyped: {
    names: new Set(['symlink', 'symlinkSync']),
    messageId: 'untypedLink',
    message:
      '`{{name}}` with no type has Node on Windows `stat` the target to pick `file` or `dir` — the kernel ' +
      'follows a link text no walk has read, and a text naming a network share sends the operator\'s ' +
      'credentials to the share\'s host. Pass the type, decided from what VAT already read — for a link being ' +
      'copied, from its chain read by text (`copyTree` asks `linkCopyType` in utils `link-following.ts`).',
  },
});
