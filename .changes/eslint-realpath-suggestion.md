### Breaking

- **`no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` report
  shapes they missed, so a project that linted clean can fail lint on upgrade.** All four report:
  - a call through an aliased import (`import { tmpdir as t } from 'node:os'; t()`) or a renamed
    destructure (`const { mkdirSync: mk } = fs; mk()`);
  - a member call through an `import x = require()` binding, a member read straight off the load
    (`require('node:fs').mkdirSync(p)`, `(await import('node:os')).tmpdir()`) and a computed key
    (`fs['realpathSync'](x)`);
  - (`no-fs-mkdirSync`, `no-fs-realpathSync`, `no-child-process-execSync`) a member call through a
    namespace, default, `require()` or `import()` binding of the `node:*` module (`fs.mkdirSync()`,
    `cp.execSync()` after `const cp = await import('node:child_process')`), which `no-os-tmpdir`
    already reported;
  - (`no-fs-realpathSync`) a call through the `.native` variant (`fs.realpathSync.native(x)`), which
    gets the same editor suggestion as a direct call;
  - any other read of the function — assigned, passed (`paths.map(realpathSync)`), captured,
    re-exported, `.call`/`.bind`, or a truthiness check (`if (fs.realpathSync.native)`) — with no fix.
    A type position (`typeof realpathSync` in a type) is not reported, and neither is a bare runtime
    `typeof` operand (`typeof fs.realpathSync.native`).

  Expect new findings where a test double or a wrapper names the function it intercepts. Migrate the
  call, or keep it with an `eslint-disable-next-line` that says why: for example, a bundled entrypoint
  that must not import the replacement's package.

### Changed

- **`@vibe-agent-toolkit/no-fs-realpathSync` no longer autofixes.** Its fix wrote a one-argument
  `normalizePath(x)`, which does not compile now that `normalizePath` takes `{ within }`. `--fix`
  leaves the call alone; the editor suggestion writes `normalizePath(x, { within: TREE_CRAWLED_IN })`,
  an unbound name that fails the typecheck until you name the tree the path is crawled in.
  With `safeModule` set to your own module (outside `@vibe-agent-toolkit/utils`), whose signature
  the rule cannot know, there is no suggestion either, and the message names no arguments.
- **`@vibe-agent-toolkit/no-child-process-execSync` no longer autofixes.** Its fix turned
  `execSync('ls -la')` into `safeExecSync('ls -la')`, which compiles but runs a binary named
  `ls -la`: `safeExecSync` takes a binary and an argument array, not a shell string. Re-check any
  call an earlier `--fix` rewrote. The editor suggestion appends `ARGV_FROM_SHELL_STRING`, which
  fails the typecheck until you split the command. With `safeModule` set to your own module, there
  is no suggestion either, and the message names no arguments.
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
  The same next-pass removal takes a dead `require()`, `import()` / `await import()` or
  `import x = require()` binding of the module (`const os = require('node:os')`, or a destructure
  `const { tmpdir } = require('node:os')`) for `no-os-tmpdir`, `no-fs-mkdirSync`,
  `no-fs-realpathSync`, `no-child-process-execSync` and `no-manual-path-normalize`: the whole
  statement goes, once nothing references any binding it declares. Where the statement before it
  has no `;` of its own (so what follows would continue it: `[1].map(g)`, `(…)()`, a template, a
  TypeScript `<T>` cast), or a string statement follows that would become a directive, it becomes a
  lone `;` instead. These shapes are never removed
  and stay for you to delete: a declaration with any type-only binding
  (`import { type join, resolve } from 'node:path'`); a declaration's only named specifier, dead,
  beside a live default or namespace binding (`tmpdir` in `import os, { tmpdir } from 'node:os'` while
  `os` is still used); and a `require()` / `import()` / `import x = require()` binding that is
  exported, not directly in a block, a `switch` case, a `static {}` block, a namespace or the file's
  top level (the unbraced body of an
  `if`/`else`/loop/label, `if (x) var os = require('node:os')`, whose removal would make the next
  statement that body, or a `for (var os = require('node:os'); …)` head), declared beside a second
  declarator (`const os = require('node:os'), n = 1`), assigned
  again after its declaration, or destructured with a default value, a rest element, a computed key
  or a nested pattern.
- **Every fix and suggestion of the call rules and `no-raw-node-path`/`no-manual-path-normalize`
  carries the replacement's import itself**, so each is correct applied alone (an editor's "fix this
  problem"). `no-raw-node-path` used to add the import on the first report only: when an
  `eslint-disable` suppressed that first call, the other calls' fixes, applied alone, rewrote to an
  unbound `safePath`. A file with several call sites now takes two passes of ESLint's fix loop instead
  of one (the first rewrites one call and adds the import, the second the rest); one `eslint --fix`
  run still finishes it.
- **An aliased import of the replacement (`import { normalizedTmpdir as nt } from
  '@vibe-agent-toolkit/utils/fs'`) no longer makes the call rules write an unbound call.**
  `no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` counted the
  alias as importing the replacement and rewrote `tmpdir()` to `normalizedTmpdir()` with no import.
  The fix now appends the replacement to that import: `import { normalizedTmpdir as nt,
  normalizedTmpdir }`.
- **`no-manual-path-normalize` resolves `path.sep` through scope.** It matched any `<x>.sep` spelled
  `path.sep`, so `import { posix as path } from 'node:path'` (whose `sep` is always `/`) or a
  parameter named `path` had `s.split(path.sep).join('/')` rewritten to `toForwardSlash(s)`, which
  converts backslashes on Windows where the original did not. It now reports only a `sep` read off a
  whole-module binding of `node:path` (`import path`, `import * as path`, `require()`, `import()`,
  `import path = require()`). A receiver that is a comma expression (`(a, b).replaceAll('\\', '/')`)
  is reported with no fix: the rewrite passed it as two arguments.
- **`no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` report a
  call only when it resolves through scope to the `node:*` module's own function**, by the same scan
  `no-existssync` and `no-link-following-fs` use: a named import (aliased or not), a member of a
  namespace, default, `require()` or `import()` binding (`fs.mkdirSync()`, `cp.execSync()`), or a
  destructure of any of those (`const { mkdirSync } = fs`). Matched by name, `import { mkdirSync } from 'memfs'`,
  a local `function tmpdir()` and a parameter shadowing a namespace (`function f(os) { os.tmpdir() }`)
  were rewritten to the real-fs helpers; they are now left alone, and so is an unbound call with no
  import at all. The shapes this resolution newly reports are under Breaking.
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
