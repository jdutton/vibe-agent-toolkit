### Changed

- **`@vibe-agent-toolkit/no-fs-realpathSync` no longer autofixes.** Its fix wrote a one-argument
  `normalizePath(x)`, which does not compile now that `normalizePath` takes `{ within }`. `--fix`
  leaves the call alone; the editor suggestion writes `normalizePath(x, { within: undefined })`,
  which fails the typecheck until you name the tree the path is crawled in.
- **`@vibe-agent-toolkit/no-child-process-execSync` no longer autofixes.** Its fix turned
  `execSync('ls -la')` into `safeExecSync('ls -la')`, which compiles but runs a binary named
  `ls -la`: `safeExecSync` takes a binary and an argument array, not a shell string. Re-check any
  call an earlier `--fix` rewrote. The editor suggestion appends `ARGV_FROM_SHELL_STRING`, which
  fails the typecheck until you split the command.
- **`@vibe-agent-toolkit/no-fs-mkdirSync` autofixes only a call whose result is discarded.**
  `mkdirSyncReal()` returns the directory's real path, where `mkdirSync()` returns the first
  directory it created or `undefined`, so `const r = mkdirSync(…)` now gets an editor suggestion
  instead. Re-check any such call an earlier `--fix` rewrote.
- **No fix or suggestion from the pack's call rules removes a `node:*` import any more.** An
  `eslint-disable-next-line` on a call AFTER a fixed one used to have its import deleted by the fixed
  call's fix: `--fix` output linted clean and threw `ReferenceError` at run time (`no-raw-node-path`,
  `no-os-tmpdir`, `no-fs-mkdirSync`). The import, or just the dead specifier beside a live one
  (`join` in `import { join, dirname } from 'node:path'`), is now removed on the next `--fix` pass,
  once nothing references it. A single `--fix` pass, and an editor's single fix, leave both imports.
- **`no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync` and `no-child-process-execSync` report a
  bare call only when it resolves to the `node:*` module's own export** (a named import, aliased or
  not, or a destructured `require()` / `import()`). Matched by name, `import { mkdirSync } from
  'memfs'` and a local `function tmpdir()` were rewritten to the real-fs helpers; they are now left
  alone, and so is an unbound call with no import at all.
