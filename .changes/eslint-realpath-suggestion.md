### Changed

- **`@vibe-agent-toolkit/no-fs-realpathSync` no longer autofixes.** Its fix wrote a one-argument
  `normalizePath(x)`, which does not compile now that `normalizePath` takes `{ within }`. `--fix`
  leaves the call alone; the editor suggestion writes `normalizePath(x, { within: TREE_CRAWLED_IN })`,
  an unbound name that fails the typecheck until you name the tree the path is crawled in.
- **`@vibe-agent-toolkit/no-child-process-execSync` no longer autofixes.** Its fix turned
  `execSync('ls -la')` into `safeExecSync('ls -la')`, which compiles but runs a binary named
  `ls -la`: `safeExecSync` takes a binary and an argument array, not a shell string. Re-check any
  call an earlier `--fix` rewrote. The editor suggestion appends `ARGV_FROM_SHELL_STRING`, which
  fails the typecheck until you split the command.
- **`@vibe-agent-toolkit/no-fs-mkdirSync` autofixes only a call whose result is discarded.**
  `mkdirSyncReal()` returns the directory's real path, where `mkdirSync()` returns the first
  directory it created or `undefined`, so `const r = mkdirSync(…)` now gets an editor suggestion
  instead. Re-check any such call an earlier `--fix` rewrote. A rewritten call can also throw where
  `mkdirSync` did not: `mkdirSyncReal` resolves the real path after creating the directory, so a link
  chain it refuses raises `LinkChainRefusedError`, and the OS's own `realpath` refusal surfaces.
- **No call rule rewrites a CommonJS file any more.** In a script-mode file (`sourceType: 'commonjs'`
  or `'script'`) the fix inserted an `import` declaration and left the file unparsable
  (`no-fs-mkdirSync`, `no-os-tmpdir`, `no-manual-path-normalize`, `no-raw-node-path`), and the
  suggestion of `no-fs-realpathSync` and `no-child-process-execSync` did the same. The finding stays;
  `--fix` and the suggestion leave the file alone unless the replacement is already bound.
- **No fix or suggestion from the pack's call rules removes a `node:*` import any more.** An
  `eslint-disable-next-line` on a call AFTER a fixed one used to have its import deleted by the fixed
  call's fix: `--fix` output linted clean and threw `ReferenceError` at run time (`no-raw-node-path`,
  `no-os-tmpdir`, `no-fs-mkdirSync`). The import, or just the dead specifier beside a live one
  (`join` in `import { join, dirname } from 'node:path'`), is now removed on the next `--fix` pass,
  once nothing references it. A single `--fix` pass, and an editor's single fix, leave both imports.
- **`no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` report a
  call only when it resolves through scope to the `node:*` module's own function**, by the same scan
  `no-existssync` and `no-link-following-fs` use: a named import (aliased or not), a member of a
  namespace, default, `require()` or `import()` binding (`fs.mkdirSync()`, `cp.execSync()`), or a
  destructure of any of those (`const { mkdirSync } = fs`). The last three rules now report the member
  and destructured-namespace calls they missed. Matched by name, `import { mkdirSync } from 'memfs'`,
  a local `function tmpdir()` and a parameter shadowing a namespace (`function f(os) { os.tmpdir() }`)
  were rewritten to the real-fs helpers; they are now left alone, and so is an unbound call with no
  import at all.
- **`no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` report two
  more shapes, neither autofixed.** A call through the `.native` variant (`fs.realpathSync.native(x)`)
  gets the same editor suggestion as a direct call; a value reference — the function assigned, passed
  (`paths.map(realpathSync)`), captured or re-exported — is reported with no fix, since there is no call
  to rewrite. A `typeof realpathSync` type position is not reported. Expect new findings where a test
  double or a wrapper names the function it intercepts.
- **The same four rules add the replacement's import correctly beside any import of the safe module.**
  An existing `import type { … }`, `import * as u` or side-effect `import '…'` of
  `@vibe-agent-toolkit/utils/fs` had the replacement appended to it: the value landed in a type-only
  import, the output did not parse, or ESLint crashed (`Cannot read properties of undefined (reading
  'range')`). The replacement now gets its own declaration. A call where an inner binding shadows the
  replacement's name (a parameter `normalizedTmpdir`) is reported with no fix: the rewritten call
  would reach that binding.
