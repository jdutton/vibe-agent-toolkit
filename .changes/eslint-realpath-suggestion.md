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
  Two shapes are never removed and stay for you to delete: a declaration with any type-only binding
  (`import { type join, resolve } from 'node:path'`), and a declaration's only named specifier, dead,
  beside a live default or namespace binding (`tmpdir` in `import os, { tmpdir } from 'node:os'` while
  `os` is still used).
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
- **The call rules and `no-raw-node-path`/`no-manual-path-normalize` rewrite a call only when the
  rewritten call reaches the replacement**: its name is unbound at the top level or bound by a value
  import of it from `@vibe-agent-toolkit/utils` (or a subpath) or the configured `safeModule`, AND no
  parameter or local of that name shadows it at the call site. A same-named import from another module
  (`import { normalizedTmpdir } from './local'`), a type-only import of it, a local declaration of that
  name, or a parameter (`function f(safePath) { return path.join('a', safePath); }`) had the call
  rewired onto that binding; it is now reported with no fix.
- **`no-raw-node-path` reports a call only when its callee resolves through scope to the `node:path`
  import**, not when it is merely spelled like it. A parameter or local named `path` or `join`
  (`function f(path) { return path.join('a'); }`) was reported and rewritten to `safePath`; it is now
  left alone.
- **`no-manual-path-normalize` does not autofix an optional-chained receiver**
  (`a?.replaceAll('\\', '/')`): `toForwardSlashAnyPlatform(a)` dropped the `?.`. It is reported with no
  fix.
- **An import a fix adds lands below a file's hashbang (`#!/usr/bin/env node`)**, not above it, which
  left the file unparsable.
- **`no-fs-mkdirSync` and `no-fs-realpathSync` do not rewrite a call whose first argument is a
  `new …` expression** (`mkdirSync(new URL(…))`): the replacement takes a string path. It is reported
  with no fix.
- **`no-fs-realpathSync`'s suggestion appends `{ within }` after a parenthesised argument's closing
  parenthesis**: `realpathSync((x))` became `normalizePath((x, { within: … }))`.
